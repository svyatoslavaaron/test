const express = require("express");
const { spawn } = require("child_process");
const app = express();
const port = 4002;
const winston = require("winston");
const fs = require("fs");

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

let ytDlpProcesses = [];
let ffmpegProcess = null;

const cleanup = () => {
  ytDlpProcesses.forEach((ytDlpProcess) => {
    if (ytDlpProcess) {
      ytDlpProcess.stdout.removeAllListeners("data");
      ytDlpProcess.stderr.removeAllListeners("data");
      ytDlpProcess.kill("SIGTERM");
    }
  });
  ytDlpProcesses = [];
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

const downloadAudio = (url, index) => {
  return new Promise((resolve, reject) => {
    const ytDlpProcess = spawn("yt-dlp", [
      "-f",
      "bestaudio",
      "--no-playlist",
      "--progress",
      "--newline",
      "--output",
      `audio${index}.%(ext)s`,
      url,
    ]);

    ytDlpProcesses.push(ytDlpProcess);

    ytDlpProcess.stderr.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");
      lines.forEach((line) => {
        const match = line.match(/(\d+(\.\d+)?)%/);
        if (match) {
          const progress = parseFloat(match[1]);
          logger.info(`yt-dlp progress (audio${index}): ${progress}%`);
        }
      });
    });

    ytDlpProcess.on("exit", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp process exited with code ${code}`));
      } else {
        resolve(`audio${index}.m4a`); // Assuming m4a format is downloaded
      }
    });

    ytDlpProcess.on("error", (err) => {
      reject(err);
    });
  });
};

const startStreaming = async (audioUrls, res, format) => {
  try {
    const audioFiles = await Promise.all(
      audioUrls.map((url, index) => retry(downloadAudio)(url, index))
    );

    const concatFile = `concat:${audioFiles.join("|")}`;
    ffmpegProcess = spawn("ffmpeg", [
      "-i",
      concatFile,
      "-f",
      format,
      "-c:a",
      format === "opus" ? "libopus" : "libmp3lame",
      "-b:a",
      format === "opus" ? "256K" : "192K",
      "-",
    ]);

    res.setHeader(
      "Content-Type",
      format === "opus" ? "audio/opus" : "audio/mp3"
    );
    res.setHeader("Transfer-Encoding", "chunked");

    ffmpegProcess.stdout.on("data", (chunk) => {
      res.write(chunk);
    });

    ffmpegProcess.stderr.on("data", (chunk) => {
      const lines = chunk.toString().split("\n");
      lines.forEach((line) => {
        const match = line.match(/time=(\d+:\d+:\d+\.\d+)/);
        if (match) {
          const time = match[1];
          const parts = time.split(":");
          const seconds =
            +parts[0] * 3600 + +parts[1] * 60 + +parts[2];
          logger.info(`ffmpeg progress: ${seconds} seconds`);
        }
      });
      logger.error(`FFmpeg stderr: ${chunk.toString()}`);
    });

    ffmpegProcess.on("close", () => {
      res.end();
      cleanup();
      // Clean up temporary audio files
      audioFiles.forEach((file) => fs.unlinkSync(file));
    });

    ffmpegProcess.on("error", (err) => {
      logger.error(`FFmpeg error: ${err.message}`);
      res.status(500).send("Failed to process audio");
      cleanup();
    });
  } catch (error) {
    logger.error(`Failed to start streaming: ${error.message}`);
    res.status(500).send("Failed to start streaming");
    cleanup();
  }
};

app.get("/audio", (req, res) => {
  const videoIds = req.query.videoId;
  const format = req.query.format || "opus";
  if (!videoIds) {
    return res.status(400).send("Video IDs are required");
  }

  const ids = videoIds.split(",");
  if (ids.length < 1) {
    return res.status(400).send("At least one Video ID is required");
  }

  const audioUrls = ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
  logger.info(`Starting audio stream for URLs: ${audioUrls.join(", ")}`);

  startStreaming(audioUrls, res, format).catch((err) => {
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
    ytDlpProcesses: ytDlpProcesses.length > 0 ? "running" : "stopped",
    ffmpegProcess: ffmpegProcess ? "running" : "stopped",
  });
});

app.listen(port, () => {
  logger.info(`Server running at http://localhost:${port}`);
});
