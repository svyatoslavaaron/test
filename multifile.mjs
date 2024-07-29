import express from "express";
import { spawn } from "child_process";
import winston from "winston";
import pLimit from "p-limit";
import fs from "fs";
import path from "path";

const app = express();
const port = 4002;

const cacheDir = path.join(process.cwd(), 'cache');

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

const limit = pLimit(1);

const cleanup = (processes) => {
  processes.forEach((process) => {
    if (process) {
      process.stdout.removeAllListeners("data");
      process.stderr.removeAllListeners("data");
      process.kill("SIGTERM");
    }
  });
};

const processVideo = async (videoUrl, cacheFilePath) => {
  return new Promise((resolve, reject) => {
    ytDlpProcess = spawn("yt-dlp", [
      "-f",
      "bestaudio",
      "--no-playlist",
      "--output",
      "-",
      videoUrl,
    ]);

    const writeStream = fs.createWriteStream(cacheFilePath);

    ytDlpProcess.stdout.pipe(writeStream);

    let ytDlpOutput = '';

    ytDlpProcess.stdout.on("data", (chunk) => {
      ytDlpOutput += chunk.toString();
      if (ytDlpOutput.includes('[download]')) {
        logger.info(`yt-dlp download progress: ${ytDlpOutput}`);
        ytDlpOutput = '';
      }
    });

    ytDlpProcess.stderr.on("data", (chunk) => {
      logger.error(`yt-dlp stderr: ${chunk.toString()}`);
    });

    ytDlpProcess.on("error", (err) => {
      reject(err);
    });

    ytDlpProcess.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`yt-dlp process exited with code ${code}`));
      } else {
        resolve(cacheFilePath);
      }
    });
  });
};

const startStreaming = async (videoUrls, res) => {
  for (const videoUrl of videoUrls) {
    await limit(async () => {
      try {
        const videoId = new URL(videoUrl).searchParams.get("v");
        const cacheFilePath = path.join(cacheDir, `${videoId}.opus`);

        if (fs.existsSync(cacheFilePath)) {
          logger.info(`Serving from cache: ${cacheFilePath}`);
          const readStream = fs.createReadStream(cacheFilePath);
          res.setHeader("Content-Type", "audio/opus");
          readStream.pipe(res);
          return;
        }

        const ytDlpStream = await processVideo(videoUrl, cacheFilePath);

        ffmpegProcess = spawn("ffmpeg", [
          "-i",
          ytDlpStream,
          "-f",
          "opus",
          "-c:a",
          "libopus",
          "-b:a",
          "256K",
          cacheFilePath,
        ]);

        ffmpegProcess.stdout.on("data", (chunk) => {
          logger.info(`FFmpeg progress: ${chunk.toString()}`);
        });

        ffmpegProcess.stderr.on("data", (chunk) => {
          logger.error(`FFmpeg stderr: ${chunk.toString()}`);
        });

        ffmpegProcess.on("close", (code) => {
          if (code === 0) {
            const readStream = fs.createReadStream(cacheFilePath);
            res.setHeader("Content-Type", "audio/opus");
            readStream.pipe(res);
          } else {
            res.status(500).send("Failed to process audio");
          }
          cleanup([ytDlpProcess, ffmpegProcess]);
        });

        ffmpegProcess.on("error", (err) => {
          logger.error(`FFmpeg error: ${err.message}`);
          res.status(500).send("Failed to process audio");
          cleanup([ytDlpProcess, ffmpegProcess]);
        });

        res.on("close", () => {
          logger.info("Client disconnected, cleaning up processes");
          cleanup([ytDlpProcess, ffmpegProcess]);
        });

      } catch (error) {
        logger.error(`Failed to process video ${videoUrl}: ${error.message}`);
        res.status(500).send(`Failed to process video: ${videoUrl}`);
      }
    });
  }
};

app.get("/audio", async (req, res) => {
  const videoIds = req.query.videoId;
  if (!videoIds) {
    return res.status(400).send("Video IDs are required");
  }

  const ids = videoIds.split(",");
  if (ids.length < 1) {
    return res.status(400).send("At least one Video ID is required");
  }

  const videoUrls = ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
  logger.info(`Starting audio stream for URLs: ${videoUrls.join(", ")}`);

  await startStreaming(videoUrls, res);
});

app.get("/stop-stream", (req, res) => {
  try {
    logger.info("Stopping all streams");

    if (ytDlpProcess || ffmpegProcess) {
      cleanup([ytDlpProcess, ffmpegProcess]);
      res.json({ message: "Stream stopped." });
    } else {
      res.json({ message: "No active streams to stop." });
    }
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
