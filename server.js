import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import express from "express";
import multer from "multer";
import { Server } from "socket.io";
import { createServer } from "node:http";
import ffmpegStatic from "ffmpeg-static";

const app = express();
const server = createServer(app);
const io = new Server(server, { transports: ["websocket", "polling"] });
const port = Number(process.env.PORT || 3000);
const controllers = new Map();

const upload = multer({
  // Grava os segmentos no disco temporário para não ocupar toda a memória do
  // serviço durante uploads em 1080p.
  dest: os.tmpdir(),
  limits: { files: 40, fileSize: 120 * 1024 * 1024, fieldSize: 1024 * 1024 }
});

app.disable("x-powered-by");
app.use(express.json({ limit: "64kb" }));
app.use(express.static("public", {
  maxAge: "1h",
  setHeaders(res, filePath) {
    if (filePath.endsWith("sw.js") || filePath.endsWith("index.html")) {
      res.setHeader("Cache-Control", "no-cache");
    }
  }
}));

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, service: "JB Replay", controllers: controllers.size });
});

app.all("/api/trigger", (req, res) => {
  const key = String(req.query.key || req.body?.key || "").trim();
  const target = controllers.get(key);

  if (!key || !target) {
    return res.status(404).json({ ok: false, message: "JB Replay não está conectado." });
  }

  io.to(target.socketId).emit("replay:trigger", { at: Date.now(), source: "watch" });
  return res.json({ ok: true, message: "Replay solicitado!", at: new Date().toISOString() });
});

app.post("/api/render", upload.array("segments", 40), async (req, res) => {
  if (!req.files?.length) {
    return res.status(400).json({ ok: false, message: "Nenhum segmento recebido." });
  }

  const jobId = crypto.randomUUID();
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), `jb-replay-${jobId}-`));
  const joinedPath = path.join(workDir, "joined.mp4");
  const outputPath = path.join(workDir, "JB-Replay.mp4");
  const uploadedPaths = req.files.map(file => file.path).filter(Boolean);
  const requestedDuration = Math.max(1, Math.min(60, Number(req.body.duration) || 15));

  try {
    const inputPaths = [];
    for (let index = 0; index < req.files.length; index += 1) {
      const file = req.files[index];
      const ext = file.mimetype.includes("webm") ? "webm" : "mp4";
      const inputPath = path.join(workDir, `segment-${String(index).padStart(3, "0")}.${ext}`);
      await fs.rename(file.path, inputPath);
      inputPaths.push(inputPath);
    }

    const listPath = path.join(workDir, "segments.txt");
    const list = inputPaths.map(file => `file '${file.replaceAll("'", "'\\''")}'`).join("\n");
    await fs.writeFile(listPath, list);

    let renderMode = "copy";
    try {
      // Caminho rápido: apenas une os trechos H.264/AAC, sem recodificar cada
      // quadro. Em iPhone esse costuma ser o formato nativo do MediaRecorder.
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-map", "0:v:0", "-map", "0:a?",
        "-c", "copy", "-movflags", "+faststart", joinedPath
      ]);
    } catch {
      // Compatibilidade para aparelhos/navegadores que entregarem WebM ou
      // segmentos que precisem ser normalizados.
      renderMode = "transcode";
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-y",
        "-f", "concat", "-safe", "0", "-i", listPath,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "23",
        "-c:a", "aac", "-b:a", "128k",
        "-movflags", "+faststart", joinedPath
      ]);
    }

    try {
      // Conserva somente os segundos finais escolhidos. A cópia de stream é
      // rápida e também normaliza os timestamps do buffer fragmentado.
      await runFfmpeg([
        "-hide_banner", "-loglevel", "error", "-y",
        "-sseof", `-${requestedDuration}`, "-i", joinedPath,
        "-map", "0:v:0", "-map", "0:a?", "-t", String(requestedDuration),
        "-c", "copy", "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart", outputPath
      ]);
    } catch {
      await fs.copyFile(joinedPath, outputPath);
    }

    const stamp = new Date().toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, "");
    res.setHeader("X-JB-Render-Mode", renderMode);
    res.download(outputPath, `JB-Replay-${stamp}.mp4`, async () => {
      await fs.rm(workDir, { recursive: true, force: true });
    });
  } catch (error) {
    await fs.rm(workDir, { recursive: true, force: true });
    await Promise.allSettled(uploadedPaths.map(file => fs.rm(file, { force: true })));
    console.error("Replay render failed", error);
    res.status(500).json({ ok: false, message: "Não foi possível montar o replay." });
  }
});

app.use((error, _req, res, _next) => {
  console.error("Upload failed", error);
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") {
    return res.status(413).json({ ok: false, message: "Trecho muito grande. Selecione 720p e tente novamente." });
  }
  return res.status(500).json({ ok: false, message: "Falha ao receber os trechos do replay." });
});

io.on("connection", socket => {
  socket.on("controller:register", payload => {
    const key = String(payload?.key || "").trim();
    if (!/^[a-zA-Z0-9_-]{16,80}$/.test(key)) return;

    for (const [storedKey, value] of controllers.entries()) {
      if (value.socketId === socket.id) controllers.delete(storedKey);
    }

    controllers.set(key, { socketId: socket.id, connectedAt: Date.now() });
    socket.emit("controller:ready", { ok: true });
  });

  socket.on("disconnect", () => {
    for (const [key, value] of controllers.entries()) {
      if (value.socketId === socket.id) controllers.delete(key);
    }
  });
});

function runFfmpeg(args) {
  const executable = ffmpegStatic && existsSync(ffmpegStatic) ? ffmpegStatic : "ffmpeg";
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", chunk => { stderr += chunk.toString(); });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(stderr || `ffmpeg saiu com código ${code}`));
    });
  });
}

server.listen(port, "0.0.0.0", () => {
  console.log(`JB Replay ativo na porta ${port}`);
});
