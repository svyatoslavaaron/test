const express = require("express");
const { spawn } = require("child_process");
const app = express();
const port = 4002;
const winston = require("winston");

const logger = winston.createLogger({
  level: "info",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.printf(
      ({ timestamp, level, message }) => `${timestamp} [${level}]: ${message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: "combined.log",
      maxsize: 5485760,
      maxFiles: 1,
    }),
  ],
});

let ytDlpProcess = null;
let ffmpegProcess = null;

const cleanup = () => {
  if (ytDlpProcess) {
    ytDlpProcess.stdout.removeAllListeners("data");
    ytDlpProcess.stderr.removeAllListeners("data");
    ytDlpProcess.kill("SIGTERM");
    ytDlpProcess = null;
  }
  if (ffmpegProcess) {
    ffmpegProcess.stdout.removeAllListeners("data");
    ffmpegProcess.stderr.removeAllListeners("data");
    ffmpegProcess.kill("SIGTERM");
    ffmpegProcess = null;
  }
};

const retry = 
  (fn, retries = 3) => 
  async (...args) => {
    for (let i = 0; i < retries; i++) {
      try {
        return await fn(...args);
      } catch (error) {
        logger.error(`Attempt ${i + 1} failed: ${error.message}`);
        if (i === retries - 1) throw error;
      }
    }
  };

const startStreaming = (audioUrl, res) => {
  ytDlpProcess = spawn("yt-dlp", [
    "-f",
    "bestaudio",
    "--no-playlist",
    "--progress",
    "--newline",
    "--output",
    "-",
    audioUrl,
  ]);

  ffmpegProcess = spawn("ffmpeg", [
    "-i",
    "pipe:0",
    "-f",
    "opus",
    "-c:a",
    "libopus",
    "-b:a",
    "256K",
    "-",
  ]);

  res.setHeader("Content-Type", "audio/opus");
  res.setHeader("Transfer-Encoding", "chunked");

  ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

  const parseYtDlpProgress = (line) => {
    const match = line.match(/(\d+(\.\d+)?)%/);
    if (match) {
      return parseFloat(match[1]);
    }
    return null;
  };

  ytDlpProcess.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    lines.forEach(line => {
      const progress = parseYtDlpProgress(line);
      if (progress !== null) {
        logger.info(`yt-dlp progress: ${progress}%`);
      }
    });
  });

  const parseFfmpegProgress = (line) => {
    const match = line.match(/time=(\d+:\d+:\d+\.\d+)/);
    if (match) {
      const time = match[1];
      const parts = time.split(":");
      const seconds = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
      return seconds;
    }
    return null;
  };

  let totalDuration = null;
  ytDlpProcess.stdout.on('data', (chunk) => {
    if (!totalDuration) {
      const match = chunk.toString().match(/Duration: (\d+:\d+:\d+\.\d+)/);
      if (match) {
        const time = match[1];
        const parts = time.split(":");
        totalDuration = (+parts[0]) * 3600 + (+parts[1]) * 60 + (+parts[2]);
      }
    }
  });

  ffmpegProcess.stderr.on("data", (chunk) => {
    const lines = chunk.toString().split("\n");
    lines.forEach(line => {
      const time = parseFfmpegProgress(line);
      if (time !== null && totalDuration !== null) {
        const progress = (time / totalDuration) * 100;
        logger.info(`ffmpeg progress: ${progress.toFixed(2)}%`);
      }
    });
  });

  ffmpegProcess.stdout.on("data", (chunk) => {
    res.write(chunk);
  });

  ffmpegProcess.on("close", () => {
    res.end();
    cleanup();
  });

  ffmpegProcess.on("error", (err) => {
    logger.error(`FFmpeg error: ${err.message}`);
    res.status(500).send("Failed to process audio");
    cleanup();
  });

  ytDlpProcess.on("close", () => {
    if (!res.headersSent) {
      res.status(500).send("Failed to fetch audio");
    }
    cleanup();
  });

  ytDlpProcess.on("error", (err) => {
    logger.error(`yt-dlp error: ${err.message}`);
    res.status(500).send("Failed to fetch audio");
    cleanup();
  });
};

app.get("/audio", (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) {
    return res.status(400).send("Video ID is required");
  }

  const audioUrl = `https://www.youtube.com/watch?v=${videoId}`;
  logger.info(`Starting audio stream for URL: ${audioUrl}`);

  retry(startStreaming)(audioUrl, res).catch((err) => {
    logger.error(`Failed to start streaming after retries: ${err.message}`);
    res.status(500).send("Failed to start streaming");
  });
});

app.get("/stop-stream", (req, res) => {
  try {
    const stopProcess = (process, name) => {
      if (process) {
        process.kill("SIGTERM");
        setTimeout(() => {
          if (process.exitCode === null) {
            process.kill("SIGKILL");
          }
        }, 5000);
        logger.info(`${name} process stopped`);
      }
    };

    stopProcess(ytDlpProcess, "yt-dlp");
    stopProcess(ffmpegProcess, "ffmpeg");

    res.json({ message: "Stream stopped." });
  } catch (error) {
    logger.error(`Error stopping stream: ${error.message}`);
    res.status(500).json({ error: "Failed to stop stream" });
  }
});

app.get("/health", (req, res) => {
  res.json({
    status: "ok",
    ytDlpProcess: ytDlpProcess ? "running" : "stopped",
    ffmpegProcess: ffmpegProcess ? "running" : "stopped",
  });
});

app.listen(port, () => {
  logger.info(`Server running at http://localhost:${port}`);
});
