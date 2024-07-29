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

const downloadAudio = (audioUrl, index) => {
  return new Promise((resolve, reject) => {
    const ytDlpProcess = spawn("yt-dlp", [
      "-f",
      "bestaudio",
      "--no-playlist",
      "--output",
      `audio${index}.%(ext)s`,
      audioUrl,
    ]);

    ytDlpProcesses.push(ytDlpProcess);

    ytDlpProcess.stderr.on("data", (chunk) => {
      logger.error(`yt-dlp stderr: ${chunk.toString()}`);
    });

    ytDlpProcess.on("close", (code) => {
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

const startStreaming = async (audioUrls, res) => {
  try {
    // Download each audio stream
    const audioFiles = await Promise.all(
      audioUrls.map((url, index) => retry(downloadAudio)(url, index))
    );

    if (audioFiles.length === 1) {
      // If only one audio file, directly stream it
      const audioFile = audioFiles[0];
      ffmpegProcess = spawn("ffmpeg", [
        "-i",
        audioFile,
        "-f",
        "opus",
        "-c:a",
        "libopus",
        "-b:a",
        "256K",
        "-",
      ]);
    } else {
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
        "opus",
        "-c:a",
        "libopus",
        "-b:a",
        "256K",
        "-",
      ]);
    }

    res.setHeader("Content-Type", "audio/opus");

    ffmpegProcess.stdout.pipe(res);

    ffmpegProcess.stderr.on("data", (chunk) => {
      logger.error(`FFmpeg stderr: ${chunk.toString()}`);
    });

    ffmpegProcess.on("close", () => {
      cleanup();
      // Clean up temporary audio files and list file
      audioFiles.forEach((file) => fs.unlinkSync(file));
      if (audioFiles.length > 1 && fs.existsSync("concat_list.txt")) {
        fs.unlinkSync("concat_list.txt");
      }
    });

    res.on("close", () => {
      cleanup();
      // Clean up temporary audio files and list file if not already deleted
      audioFiles.forEach((file) => fs.unlinkSync(file));
      if (audioFiles.length > 1 && fs.existsSync("concat_list.txt")) {
        fs.unlinkSync("concat_list.txt");
      }
    });

    res.on("error", (err) => {
      logger.error(`Response stream error: ${err.message}`);
      cleanup();
      // Clean up temporary audio files and list file if not already deleted
      audioFiles.forEach((file) => fs.unlinkSync(file));
      if (audioFiles.length > 1 && fs.existsSync("concat_list.txt")) {
        fs.unlinkSync("concat_list.txt");
      }
    });

    ffmpegProcess.on("error", (err) => {
      logger.error(`FFmpeg error: ${err.message}`);
      res.status(500).send("Failed to process audio");
      cleanup();
      // Clean up temporary audio files and list file if not already deleted
      audioFiles.forEach((file) => fs.unlinkSync(file));
      if (audioFiles.length > 1 && fs.existsSync("concat_list.txt")) {
        fs.unlinkSync("concat_list.txt");
      }
    });
  } catch (err) {
    logger.error(`Error processing audio: ${err.message}`);
    res.status(500).send("Failed to process audio");
    cleanup();
  }
};

app.get("/audio", (req, res) => {
  const videoIds = req.query.videoId;
  if (!videoIds) {
    return res.status(400).send("Video IDs are required");
  }

  const ids = videoIds.split(",");
  if (ids.length === 0) {
    return res.status(400).send("At least one Video ID is required");
  }

  const audioUrls = ids.map((id) => `https://www.youtube.com/watch?v=${id}`);
  logger.info(`Starting audio stream for URLs: ${audioUrls.join(", ")}`);

  startStreaming(audioUrls, res).catch((err) => {
    logger.error(`Failed to start streaming after retries: ${err.message}`);
    res.status(500).send("Failed to start streaming");
  });
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
