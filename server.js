const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");
const multer = require("multer");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const uploadDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
    cb(null, Date.now() + "_" + safe);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

// ── State ─────────────────────────────────────────────────────────────────────
let state = {
  playlist: [],
  currentIndex: -1,
  playing: false,
  startedAt: null,
  pausedAt: null,
};

function currentTrack() {
  return state.playlist[state.currentIndex] || null;
}

function broadcastState() {
  io.emit("state", sanitizedState());
}

function sanitizedState() {
  return {
    playlist: state.playlist.map((t) => ({ id: t.id, name: t.name })),
    currentIndex: state.currentIndex,
    playing: state.playing,
    serverTime: Date.now(),
    startedAt: state.startedAt,
    pausedAt: state.pausedAt,
  };
}

// ── REST ──────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, "public")));

app.post("/upload", upload.array("tracks"), (req, res) => {
  const added = req.files.map((f) => ({
    id: f.filename,
    name: f.originalname.replace(/\.[^.]+$/, ""),
    filename: f.filename,
  }));
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
    state.currentIndex = state.playlist.length - 1;
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
    state.playing = true;
    state.startedAt = Date.now() - resumeFrom * 1000;
    state.pausedAt = null;
    broadcastState();
  });

  socket.on("pause", () => {
    if (!state.playing) return;
    state.pausedAt = (Date.now() - state.startedAt) / 1000;
    state.playing = false;
    state.startedAt = null;
    broadcastState();
  });

  socket.on("next", () => {
    if (state.currentIndex < state.playlist.length - 1) {
      state.currentIndex++;
      state.playing = true;
      state.startedAt = Date.now();
      state.pausedAt = null;
      broadcastState();
    }
  });

  socket.on("prev", () => {
    if (state.currentIndex > 0) {
      state.currentIndex--;
      state.playing = true;
      state.startedAt = Date.now();
      state.pausedAt = null;
      broadcastState();
    }
  });

  socket.on("select", (index) => {
    if (index < 0 || index >= state.playlist.length) return;
    state.currentIndex = index;
    state.playing = true;
    state.startedAt = Date.now();
    state.pausedAt = null;
    broadcastState();
  });

  socket.on("ended", (trackId) => {
    if (currentTrack()?.id !== trackId) return;
    if (state.currentIndex < state.playlist.length - 1) {
      state.currentIndex++;
      state.playing = true;
      state.startedAt = Date.now();
      state.pausedAt = null;
    } else {
      state.playing = false;
    }
    broadcastState();
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncPlay running on port ${PORT}`));
