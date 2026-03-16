const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const multer = require("multer");
const { execFile } = require("child_process");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "_raw_" + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024 } });

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  playlist: [],
  currentIndex: -1,
  playing: false,
  startedAt: null,
  pausedAt: null,
};

let readySession = null;

function currentTrack() {
  return state.playlist[state.currentIndex] || null;
}

function broadcastState() {
  io.emit("state", sanitizedState());
}

function sanitizedState() {
  return {
    playlist: state.playlist.map((t) => ({ id: t.id, name: t.name, size: t.size })),
    currentIndex: state.currentIndex,
    playing: state.playing,
    serverTime: Date.now(),
    startedAt: state.startedAt,
    pausedAt: state.pausedAt,
  };
}

// ── FFmpeg conversion ─────────────────────────────────────────────────────────
function convertToLowBitrate(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    execFile("ffmpeg", [
      "-i", inputPath,
      "-codec:a", "libmp3lame",
      "-b:a", "96k",
      "-ar", "44100",
      "-ac", "2",
      "-y",
      outputPath
    ], (err, stdout, stderr) => {
      if (err) reject(err);
      else resolve(outputPath);
    });
  });
}

// ── REST ──────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.post("/upload", upload.array("tracks"), async (req, res) => {
  const added = [];

  for (const f of req.files) {
    const rawPath = path.join(uploadDir, f.filename);
    const outName = f.filename.replace("_raw_", "_") + ".mp3";
    const outPath = path.join(uploadDir, outName);

    try {
      await convertToLowBitrate(rawPath, outPath);
      fs.unlinkSync(rawPath); // delete original
      const size = fs.statSync(outPath).size;
      added.push({
        id: outName,
        name: f.originalname.replace(/\.[^.]+$/, ""),
        filename: outName,
        size,
      });
    } catch (e) {
      // ffmpeg failed — use original file as fallback
      console.error("ffmpeg error, using original:", e.message);
      fs.renameSync(rawPath, rawPath.replace("_raw_", "_"));
      const fallbackName = f.filename.replace("_raw_", "_");
      const size = fs.statSync(path.join(uploadDir, fallbackName)).size;
      added.push({
        id: fallbackName,
        name: f.originalname.replace(/\.[^.]+$/, ""),
        filename: fallbackName,
        size,
      });
    }
  }

  state.playlist.push(...added);
  if (state.currentIndex === -1 && state.playlist.length > 0) {
    state.currentIndex = 0;
  }
  broadcastState();
  res.json({ ok: true });
});

app.get("/track/:id", (req, res) => {
  const track = state.playlist.find((t) => t.id === req.params.id);
  if (!track) return res.status(404).send("Not found");
  res.sendFile(path.join(uploadDir, track.filename));
});

app.delete("/track/:id", (req, res) => {
  const idx = state.playlist.findIndex((t) => t.id === req.params.id);
  if (idx === -1) return res.status(404).send("Not found");
  const [removed] = state.playlist.splice(idx, 1);
  try { fs.unlinkSync(path.join(uploadDir, removed.filename)); } catch (_) {}
  if (state.currentIndex >= state.playlist.length) {
    state.currentIndex = Math.max(0, state.playlist.length - 1);
  }
  state.playing = false;
  state.startedAt = null;
  broadcastState();
  res.json({ ok: true });
});

// ── Sockets ───────────────────────────────────────────────────────────────────
io.on("connection", (socket) => {
  socket.emit("state", sanitizedState());

  socket.on("ping_time", (clientT0, callback) => {
    callback(Date.now());
  });

  socket.on("play", () => {
    if (!currentTrack()) return;
    const resumeFrom = state.pausedAt || 0;
    const trackId = currentTrack().id;
    const connectedCount = io.sockets.sockets.size;

    if (readySession) clearTimeout(readySession.timeout);

    readySession = {
      trackId,
      resumeFrom,
      ready: new Set(),
      total: connectedCount,
    };

    io.emit("prepare", { trackId, resumeFrom });

    const firePlay = () => {
      if (!readySession) return;
      const rs = readySession;
      readySession = null;
      const startAt = Date.now() + 1000;
      state.playing = true;
      state.startedAt = startAt - rs.resumeFrom * 1000;
      state.pausedAt = null;
      io.emit("go", { startAt });
      broadcastState();
    };

    // Fire when all ready OR after 6s timeout
    readySession.timeout = setTimeout(firePlay, 6000);
  });

  socket.on("ready", ({ trackId }) => {
    if (!readySession || readySession.trackId !== trackId) return;
    readySession.ready.add(socket.id);
    if (readySession.ready.size >= readySession.total) {
      clearTimeout(readySession.timeout);
      const rs = readySession;
      readySession = null;
      const startAt = Date.now() + 800;
      state.playing = true;
      state.startedAt = startAt - rs.resumeFrom * 1000;
      state.pausedAt = null;
      io.emit("go", { startAt });
      broadcastState();
    }
  });

  socket.on("pause", () => {
    if (!state.playing) return;
    if (readySession) { clearTimeout(readySession.timeout); readySession = null; }
    state.pausedAt = (Date.now() - state.startedAt) / 1000;
    state.playing = false;
    state.startedAt = null;
    broadcastState();
  });

  socket.on("next", () => {
    if (state.currentIndex < state.playlist.length - 1) {
      state.currentIndex++;
      state.playing = false;
      state.startedAt = null;
      state.pausedAt = null;
      broadcastState();
    }
  });

  socket.on("prev", () => {
    if (state.currentIndex > 0) {
      state.currentIndex--;
      state.playing = false;
      state.startedAt = null;
      state.pausedAt = null;
      broadcastState();
    }
  });

  socket.on("select", (index) => {
    if (index < 0 || index >= state.playlist.length) return;
    state.currentIndex = index;
    state.playing = false;
    state.startedAt = null;
    state.pausedAt = null;
    broadcastState();
  });

  socket.on("ended", (trackId) => {
    if (currentTrack()?.id !== trackId) return;
    if (state.currentIndex < state.playlist.length - 1) {
      state.currentIndex++;
      state.playing = false;
      state.startedAt = null;
      state.pausedAt = null;
    } else {
      state.playing = false;
    }
    broadcastState();
  });

  socket.on("disconnect", () => {
    if (!readySession) return;
    readySession.total = Math.max(1, readySession.total - 1);
    if (readySession.ready.size >= readySession.total) {
      clearTimeout(readySession.timeout);
      const rs = readySession;
      readySession = null;
      const startAt = Date.now() + 800;
      state.playing = true;
      state.startedAt = startAt - rs.resumeFrom * 1000;
      state.pausedAt = null;
      io.emit("go", { startAt });
      broadcastState();
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncPlay running on port ${PORT}`));
