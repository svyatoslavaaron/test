const express = require("express");
const { spawn } = require("child_process");
const app = express();
const port = 4002;
const winston = require("winston");
const path = require("path");
const { pipeline } = require("stream");

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

// Utility function for cleanup
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

// Retry mechanism
const retry = (fn, retries = 3) => async (...args) => {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn(...args);
    } catch (error) {
      logger.error(`Attempt ${i + 1} failed: ${error.message}`);
      if (i === retries - 1) throw error;
    }
  }
};

// Start streaming function with automatic reconnection
const startStreaming = (audioUrl, res, attempt = 0) => {
  const maxRetries = 5; // Maximum number of reconnection attempts
  const retryDelay = 1000; // Initial delay before retrying (in milliseconds)

  const attemptStreaming = () => {
    // Spawn yt-dlp and ffmpeg processes
    ytDlpProcess = spawn("yt-dlp", [
      "-f",
      "bestaudio",
      "--no-playlist",
      "--output",
      "-",
      "--download-archive",
      path.join(__dirname, "archive.txt"),
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
      "512K",
      "-",
    ]);

    // Set headers for audio streaming
    res.setHeader("Content-Type", "audio/opus");
    res.setHeader("Transfer-Encoding", "chunked");

    // Pipe yt-dlp output to ffmpeg input and ffmpeg output to response
    pipeline(ytDlpProcess.stdout, ffmpegProcess.stdin, (err) => {
      if (err) {
        logger.error(`Pipeline error: ${err.message}`);
        cleanup();
        if (!res.headersSent) {
          res.status(500).send("Failed to fetch audio");
        }
      }
    });

    ffmpegProcess.stdout.on("data", (chunk) => {
      try {
        if (!res.write(chunk) && !res.headersSent) {
          logger.warn("Pausing ffmpeg stdout due to backpressure");
          ffmpegProcess.stdout.pause();
        }
      } catch (err) {
        if (err.code === "EPIPE") {
          logger.error(`EPIPE error: client disconnected`);
          cleanup();
          if (attempt < maxRetries) {
            setTimeout(() => {
              logger.info(`Retrying stream connection... Attempt ${attempt + 1}`);
              attemptStreaming();
            }, retryDelay * (2 ** attempt)); // Exponential backoff
            attempt++;
          } else {
            if (!res.headersSent) {
              res.status(500).send("Failed to reconnect after multiple attempts");
            }
          }
        } else {
          logger.error(`Write error: ${err.message}`);
          cleanup();
        }
      }
    });

    res.on("drain", () => {
      logger.info("Resuming ffmpeg stdout after backpressure");
      ffmpegProcess.stdout.resume();
    });

    res.on("close", () => {
      logger.info("Client disconnected, cleaning up processes");
      cleanup();
      if (attempt < maxRetries) {
        setTimeout(() => {
          logger.info(`Retrying stream connection... Attempt ${attempt + 1}`);
          attemptStreaming();
        }, retryDelay * (2 ** attempt)); // Exponential backoff
        attempt++;
      } else {
        logger.error("Max retry attempts reached. Giving up.");
      }
    });

    res.on("error", (err) => {
      logger.error(`Response stream error: ${err.message}`);
      cleanup();
    });

    ytDlpProcess.on("error", (err) => {
      logger.error(`yt-dlp error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).send("Failed to fetch audio");
      }
      cleanup();
    });

    ffmpegProcess.on("error", (err) => {
      logger.error(`FFmpeg error: ${err.message}`);
      if (!res.headersSent) {
        res.status(500).send("Failed to process audio");
      }
      cleanup();
    });

    ytDlpProcess.stderr.on("data", (chunk) => {
      logger.error(`yt-dlp stderr: ${chunk.toString()}`);
    });

    ffmpegProcess.stderr.on("data", (chunk) => {
      logger.error(`FFmpeg stderr: ${chunk.toString()}`);
    });

    ffmpegProcess.stdout.on("end", () => {
      if (!res.headersSent) {
        res.end();
      }
      cleanup();
    });
  };

  attemptStreaming();
};

// Endpoint to start streaming audio
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

// Endpoint to stop streaming
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
