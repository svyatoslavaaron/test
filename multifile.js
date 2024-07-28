const express = require("express");
const { spawn } = require("child_process");
const app = express();
const port = 4002;
const winston = require("winston");
const path = require("path");
const fs = require("fs");
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

app.get("/audio", async (req, res) => {
  const videoIds = req.query.videoId;
  const format = req.query.format || "opus";
  if (!videoIds) {
    return res.status(400).send("Video IDs are required");
  }

  const ids = videoIds.split(",");
  if (ids.length < 2) {
    return res.status(400).send("At least two Video IDs are required");
  }

  const audioUrls = ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
  logger.info(`Starting audio stream for URLs: ${audioUrls.join(", ")}`);

  // Download each audio stream
  const audioFiles = await Promise.all(
    audioUrls.map(async (url, index) => {
      return new Promise((resolve, reject) => {
        const ytDlpProcess = spawn("yt-dlp", [
          "-f",
          "bestaudio",
          "--no-playlist",
          "--output",
          `audio${index}.%(ext)s`,
          url,
        ]);

        ytDlpProcesses.push(ytDlpProcess);

        ytDlpProcess.stderr.on("data", (chunk) => {
          logger.error(`yt-dlp stderr: ${chunk.toString()}`);
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
    })
  );

  // Concatenate audio files
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

  res.setHeader("Content-Type", format === "opus" ? "audio/opus" : "audio/mp3");

  pipeline(ffmpegProcess.stdout, res, (err) => {
    if (err) {
      logger.error(`Pipeline error: ${err.message}`);
      cleanup();
    }
    cleanup();
    // Clean up temporary audio files
    audioFiles.forEach((file) => fs.unlinkSync(file));
  });

  ffmpegProcess.stderr.on("data", (chunk) => {
    logger.error(`FFmpeg stderr: ${chunk.toString()}`);
  });

  res.on("close", () => {
    logger.info("Client disconnected, cleaning up processes");
    cleanup();
  });

  res.on("error", (err) => {
    logger.error(`Response stream error: ${err.message}`);
    cleanup();
  });

  ffmpegProcess.on("error", (err) => {
    logger.error(`FFmpeg error: ${err.message}`);
    res.status(500).send("Failed to process audio");
    cleanup();
  });
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
