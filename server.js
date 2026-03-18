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

const HOST_PIN = process.env.HOST_PIN || "5555";
let hostSocketId = null;

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
    ], (err) => {
      if (err) reject(err);
      else resolve(outputPath);
    });
  });
}

function getDuration(filePath) {
  return new Promise((resolve) => {
    execFile("ffprobe", [
      "-v", "quiet",
      "-print_format", "json",
      "-show_format",
      filePath
    ], (err, stdout) => {
      if (err) { resolve(null); return; }
      try {
        const data = JSON.parse(stdout);
        resolve(parseFloat(data.format.duration) || null);
      } catch { resolve(null); }
    });
  });
}

// ── Auto-advance timer ────────────────────────────────────────────────────────
let autoAdvanceTimer = null;

function scheduleAutoAdvance() {
  clearTimeout(autoAdvanceTimer);
  const track = currentTrack();
  if (!track || !state.playing || !state.startedAt || !track.duration) return;

  const elapsed = (Date.now() - state.startedAt) / 1000;
  const remaining = track.duration - elapsed;
  if (remaining <= 0) {
    doAutoAdvance();
    return;
  }

  autoAdvanceTimer = setTimeout(doAutoAdvance, remaining * 1000 + 500);
}

function doAutoAdvance() {
  if (!state.playing) return;
  if (state.currentIndex < state.playlist.length - 1) {
    state.currentIndex++;
    state.playing = false;
    state.startedAt = null;
    state.pausedAt = null;
    broadcastState();
    // Trigger play for next track
    setTimeout(() => triggerPlay(), 500);
  } else {
    state.playing = false;
    broadcastState();
  }
}

function triggerPlay() {
  if (!currentTrack()) return;
  const connectedCount = io.sockets.sockets.size;
  if (readySession) clearTimeout(readySession.timeout);
  readySession = { trackId: currentTrack().id, resumeFrom: 0, ready: new Set(), total: connectedCount };
  io.emit("prepare", { trackId: currentTrack().id, resumeFrom: 0 });
  const firePlay = () => {
    if (!readySession) return;
    const rs = readySession; readySession = null;
    const startAt = Date.now() + 800;
    state.playing = true;
    state.startedAt = startAt - rs.resumeFrom * 1000;
    state.pausedAt = null;
    io.emit("go", { startAt });
    broadcastState();
    scheduleAutoAdvance();
  };
  readySession.timeout = setTimeout(firePlay, 6000);
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
      fs.unlinkSync(rawPath);
      const size = fs.statSync(outPath).size;
      const duration = await getDuration(outPath);
      added.push({
        id: outName,
        name: f.originalname.replace(/\.[^.]+$/, ""),
        filename: outName,
        size,
        duration,
      });
    } catch (e) {
      console.error("ffmpeg error, using original:", e.message);
      fs.renameSync(rawPath, rawPath.replace("_raw_", "_"));
      const fallbackName = f.filename.replace("_raw_", "_");
      const size = fs.statSync(path.join(uploadDir, fallbackName)).size;
      const duration = await getDuration(path.join(uploadDir, fallbackName));
      added.push({
        id: fallbackName,
        name: f.originalname.replace(/\.[^.]+$/, ""),
        filename: fallbackName,
        size,
        duration,
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
  // Tell new clients if host slot is taken
  socket.emit("host_status", { taken: hostSocketId !== null });

  socket.on("claim_host", ({ pin }, callback) => {
    if (pin !== HOST_PIN) return callback({ ok: false, reason: "PIN incorrecto" });
    if (hostSocketId !== null && hostSocketId !== socket.id) return callback({ ok: false, reason: "Ya hay un organizador activo" });
    hostSocketId = socket.id;
    socket.isHost = true;
    io.emit("host_status", { taken: true });
    callback({ ok: true });
  });

  socket.on("ping_time", (clientT0, callback) => {
    callback(Date.now());
  });

  socket.on("play", () => {
    if (!socket.isHost) return;
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
      scheduleAutoAdvance();
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
      scheduleAutoAdvance();
    }
  });

  socket.on("pause", () => {
    if (!socket.isHost) return;
    if (!state.playing) return;
    if (readySession) { clearTimeout(readySession.timeout); readySession = null; }
    clearTimeout(autoAdvanceTimer);
    state.pausedAt = (Date.now() - state.startedAt) / 1000;
    state.playing = false;
    state.startedAt = null;
    broadcastState();
  });

  socket.on("next", () => {
    if (!socket.isHost) return;
    if (state.currentIndex < state.playlist.length - 1) {
      state.currentIndex++;
      state.playing = false;
      state.startedAt = null;
      state.pausedAt = null;
      broadcastState();
    }
  });

  socket.on("prev", () => {
    if (!socket.isHost) return;
    if (state.currentIndex > 0) {
      state.currentIndex--;
      state.playing = false;
      state.startedAt = null;
      state.pausedAt = null;
      broadcastState();
    }
  });

  socket.on("select", (index) => {
    if (!socket.isHost) return;
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
      // Auto-advance: prepare all devices then fire go
      setTimeout(() => {
        if (!currentTrack()) return;
        const nextTrackId = currentTrack().id;
        const connectedCount = io.sockets.sockets.size;
        if (readySession) clearTimeout(readySession.timeout);
        readySession = { trackId: nextTrackId, resumeFrom: 0, ready: new Set(), total: connectedCount };
        io.emit("prepare", { trackId: nextTrackId, resumeFrom: 0 });
        const firePlay = () => {
          if (!readySession) return;
          const rs = readySession; readySession = null;
          const startAt = Date.now() + 800;
          state.playing = true;
          state.startedAt = startAt;
          state.pausedAt = null;
          io.emit("go", { startAt });
          broadcastState();
        };
        readySession.timeout = setTimeout(firePlay, 6000);
      }, 500);
    } else {
      state.playing = false;
      broadcastState();
    }
  });

  socket.on("disconnect", () => {
    if (socket.isHost) {
      hostSocketId = null;
      io.emit("host_status", { taken: false });
    }
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
