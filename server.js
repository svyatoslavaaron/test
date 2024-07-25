const express = require("express");
const { spawn } = require("child_process");
const app = express();
const port = 4002;

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

// Endpoint to start streaming audio
app.get("/audio", (req, res) => {
  const videoId = req.query.videoId;
  if (!videoId) {
    return res.status(400).send("Video ID is required");
  }

  const audioUrl = `https://www.youtube.com/watch?v=${videoId}`;
  console.log(audioUrl);
  // Spawn yt-dlp process to fetch live audio
  ytDlpProcess = spawn("yt-dlp", [
    "-f",
    "bestaudio",
    "--no-playlist",
    "--output",
    "-",
    audioUrl,
  ]);

  // Spawn ffmpeg process to convert audio format to a streamable format
  ffmpegProcess = spawn("ffmpeg", [
    "-i",
    "pipe:0",
    "-f",
    "mp3",
    "-b:a",
    "160k", // Moderate bitrate for balance between quality and resource usage
    "-",
  ]);

  // Set headers for audio streaming
  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Transfer-Encoding", "chunked");

  // Pipe yt-dlp output to ffmpeg input
  ytDlpProcess.stdout.pipe(ffmpegProcess.stdin);

  // Stream ffmpeg output to client
  ffmpegProcess.stdout.on("data", (chunk) => {
    res.write(chunk);
  });

  // End response when ffmpeg stream ends
  ffmpegProcess.stdout.on("end", () => {
    res.end();
    cleanup();
  });

  // Handle errors from yt-dlp
  ytDlpProcess.on("error", (err) => {
    //console.error("yt-dlp error:", err);
    res.status(500).send("Failed to fetch audio");
    cleanup();
  });

  // Handle errors from ffmpeg
  ffmpegProcess.on("error", (err) => {
    //console.error("FFmpeg error:", err);
    res.status(500).send("Failed to process audio");
    cleanup();
  });

  // Minimal logging of yt-dlp errors
  ytDlpProcess.stderr.on("data", (chunk) => {
    //console.error(`yt-dlp error: ${chunk.toString()}`);
  });

  // Minimal logging of ffmpeg errors
  ffmpegProcess.stderr.on("data", (chunk) => {
    //console.error(`FFmpeg error: ${chunk.toString()}`);
  });

  // Cleanup on client disconnect
  req.on("close", () => {
    cleanup();
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
      }
    };

    stopProcess(ytDlpProcess, "yt-dlp");
    stopProcess(ffmpegProcess, "ffmpeg");

    res.json({ message: "Stream stopped." });
  } catch (error) {
    console.error("Error stopping stream:", error);
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
  console.log(`Server running at http://localhost:${port}`);
});
