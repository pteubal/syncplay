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

// ── Ready coordination ────────────────────────────────────────────────────────
let readySession = null; // active "waiting for ready" session

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

  // Clock sync
  socket.on("ping_time", (clientT0, callback) => {
    callback(Date.now());
  });

  // Host presses Play → tell everyone to prepare
  socket.on("play", () => {
    if (!currentTrack()) return;

    const resumeFrom = state.pausedAt || 0;
    const trackId = currentTrack().id;
    const connectedSockets = [...io.sockets.sockets.keys()];

    // Cancel any previous ready session
    if (readySession) {
      clearTimeout(readySession.timeout);
    }

    readySession = {
      trackId,
      resumeFrom,
      ready: new Set(),
      total: connectedSockets.length,
      timeout: null,
    };

    // Tell all clients to prepare (preload audio)
    io.emit("prepare", { trackId, resumeFrom });

    // Function to fire when everyone is ready (or timeout)
    const firePlay = () => {
      clearTimeout(readySession.timeout);
      readySession = null;
      // Schedule playback 800ms in the future so all devices get the message
      const startAt = Date.now() + 800;
      state.playing = true;
      state.startedAt = startAt - resumeFrom * 1000;
      state.pausedAt = null;
      io.emit("go", { startAt });
      broadcastState();
    };

    // Wait max 5 seconds for all devices, then fire anyway
    readySession.timeout = setTimeout(firePlay, 5000);

    // If solo (only 1 device) fire immediately after short buffer
    if (connectedSockets.length <= 1) {
      clearTimeout(readySession.timeout);
      readySession.timeout = setTimeout(firePlay, 500);
    }
  });

  // Client reports it's ready to play
  socket.on("ready", ({ trackId }) => {
    if (!readySession || readySession.trackId !== trackId) return;
    readySession.ready.add(socket.id);
    // Fire as soon as all connected clients are ready
    if (readySession.ready.size >= readySession.total) {
      clearTimeout(readySession.timeout);
      const firePlay = () => {
        readySession = null;
        const startAt = Date.now() + 800;
        state.playing = true;
        state.startedAt = startAt - readySession?.resumeFrom * 1000 || startAt - (state.pausedAt || 0) * 1000;
        state.pausedAt = null;
        io.emit("go", { startAt });
        broadcastState();
      };
      // Use closure to capture resumeFrom before clearing
      const resumeFrom = readySession.resumeFrom;
      readySession = null;
      const startAt = Date.now() + 800;
      state.playing = true;
      state.startedAt = startAt - resumeFrom * 1000;
      state.pausedAt = null;
      io.emit("go", { startAt });
      broadcastState();
    }
  });

  socket.on("pause", () => {
    if (!state.playing) return;
    if (readySession) {
      clearTimeout(readySession.timeout);
      readySession = null;
    }
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
      broadcastState();
    } else {
      state.playing = false;
      broadcastState();
    }
  });

  socket.on("disconnect", () => {
    // If this socket was part of a ready session, recount
    if (readySession) {
      readySession.total = Math.max(1, readySession.total - 1);
      if (readySession.ready.size >= readySession.total) {
        clearTimeout(readySession.timeout);
        const resumeFrom = readySession.resumeFrom;
        readySession = null;
        const startAt = Date.now() + 800;
        state.playing = true;
        state.startedAt = startAt - resumeFrom * 1000;
        state.pausedAt = null;
        io.emit("go", { startAt });
        broadcastState();
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`SyncPlay running on port ${PORT}`));
