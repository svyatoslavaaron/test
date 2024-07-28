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

  try {
    // Download each audio stream
    const audioFiles = await Promise.all(
      audioUrls.map((url, index) => {
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

    // Create a temporary file for ffmpeg concat list
    const concatListFile = "concat_list.txt";
    fs.writeFileSync(concatListFile, audioFiles.map(file => `file '${file}'`).join("\n"));

    // Concatenate audio files
    ffmpegProcess = spawn("ffmpeg", [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListFile,
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
      }
      cleanup();
      // Clean up temporary audio files and list file
      audioFiles.forEach((file) => fs.unlinkSync(file));
      fs.unlinkSync(concatListFile);
    });

    ffmpegProcess.stderr.on("data", (chunk) => {
      logger.error(`FFmpeg stderr: ${chunk.toString()}`);
    });

    res.on("close", () => {
      logger.info("Client disconnected, cleaning up processes");
      cleanup();
      // Clean up temporary audio files and list file if not already deleted
      audioFiles.forEach((file) => fs.unlinkSync(file));
      if (fs.existsSync(concatListFile)) {
        fs.unlinkSync(concatListFile);
      }
    });

    res.on("error", (err) => {
      logger.error(`Response stream error: ${err.message}`);
      cleanup();
      // Clean up temporary audio files and list file if not already deleted
      audioFiles.forEach((file) => fs.unlinkSync(file));
      if (fs.existsSync(concatListFile)) {
        fs.unlinkSync(concatListFile);
      }
    });

    ffmpegProcess.on("error", (err) => {
      logger.error(`FFmpeg error: ${err.message}`);
      res.status(500).send("Failed to process audio");
      cleanup();
      // Clean up temporary audio files and list file if not already deleted
      audioFiles.forEach((file) => fs.unlinkSync(file));
      if (fs.existsSync(concatListFile)) {
        fs.unlinkSync(concatListFile);
      }
    });
  } catch (err) {
    logger.error(`Error processing audio: ${err.message}`);
    res.status(500).send("Failed to process audio");
    cleanup();
  }
});

// Endpoint to stop streaming
app.get("/stop-stream", (req, res) => {
  try {
    const stopProcesses = (processes, name) => {
      processes.forEach((process) => {
        if (process) {
          process.kill("SIGTERM");
          setTimeout(() => {
            if (process.exitCode === null) {
              process.kill("SIGKILL");
            }
          }, 5000);
        }
      });
      logger.info(`${name} processes stopped`);
    };

    stopProcesses(ytDlpProcesses, "yt-dlp");
    stopProcesses([ffmpegProcess], "ffmpeg");

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
