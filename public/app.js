const $ = selector => document.querySelector(selector);

const elements = {
  video: $("#cameraPreview"), placeholder: $("#cameraPlaceholder"), cameraButton: $("#cameraButton"),
  replayButton: $("#replayButton"), settingsButton: $("#settingsButton"), settingsDialog: $("#settingsDialog"),
  watchDialog: $("#watchDialog"), watchSetupButton: $("#watchSetupButton"), closeWatchDialog: $("#closeWatchDialog"),
  copyUrlButton: $("#copyUrlButton"), testWatchButton: $("#testWatchButton"), watchUrl: $("#watchUrl"),
  cameraStatus: $("#cameraStatus"), watchStatus: $("#watchStatus"), recordDot: $("#recordDot"),
  bufferLabel: $("#bufferLabel"), buttonSeconds: $("#buttonSeconds"), buttonPostSeconds: $("#buttonPostSeconds"), toast: $("#toast"),
  captureInfo: $("#captureInfo"), lensSwitcher: $("#lensSwitcher"),
  queueStatus: $("#queueStatus"), queueText: $("#queueText"), queueCount: $("#queueCount"),
  gallery: $("#gallery"), emptyGallery: $("#emptyGallery"), replayCount: $("#replayCount"),
  durationSelect: $("#durationSelect"), postRollSelect: $("#postRollSelect"), qualitySelect: $("#qualitySelect"), cameraSelect: $("#cameraSelect"),
  cameraDiagnostic: $("#cameraDiagnostic"), resolutionDiagnostic: $("#resolutionDiagnostic"),
  orientationSelect: $("#orientationSelect"), audioToggle: $("#audioToggle"), saveSettingsButton: $("#saveSettingsButton")
};

const state = {
  stream: null,
  recorder: null,
  running: false,
  saving: false,
  upscaling: false,
  replayQueue: [],
  currentReplayJob: null,
  segments: [],
  initSegment: null,
  chunkStartedAt: null,
  chunkChain: Promise.resolve(),
  boundaryResolver: null,
  activeLens: "",
  captureDetails: null,
  cameraDiagnostic: "A lente será confirmada quando a câmera iniciar.",
  resolutionDiagnostic: "O replay será salvo sem ampliação. Depois, você poderá gerar uma cópia em 1080p.",
  settings: loadSettings(),
  controllerKey: getControllerKey(),
  db: null
};

const socket = window.io({ transports: ["websocket", "polling"] });

boot();

async function boot() {
  applySettingsToUI();
  registerEvents();
  state.db = await openDatabase();
  await renderGallery();
  registerServiceWorker();
  registerController();
}

function registerEvents() {
  elements.cameraButton.addEventListener("click", toggleCamera);
  elements.replayButton.addEventListener("click", () => requestReplay("iphone"));
  elements.settingsButton.addEventListener("click", () => elements.settingsDialog.showModal());
  elements.watchSetupButton.addEventListener("click", openWatchSetup);
  elements.closeWatchDialog.addEventListener("click", () => elements.watchDialog.close());
  elements.copyUrlButton.addEventListener("click", copyWatchUrl);
  elements.watchDialog.querySelectorAll("[data-copy-camera]").forEach(button => {
    button.addEventListener("click", () => copyCameraUrl(button.dataset.copyCamera));
  });
  elements.testWatchButton.addEventListener("click", async () => {
    const response = await fetch(watchTriggerUrl());
    if (!response.ok) showToast("Inicie a câmera primeiro");
  });
  elements.saveSettingsButton.addEventListener("click", saveSettings);
  elements.qualitySelect.addEventListener("change", updateQualityPreview);
  elements.lensSwitcher.querySelectorAll("[data-camera]").forEach(button => {
    button.addEventListener("click", () => switchCamera(button.dataset.camera));
  });
  window.addEventListener("beforeunload", event => {
    if (hasPendingWork()) {
      event.preventDefault();
      event.returnValue = "";
      return;
    }
    stopCamera(true);
  });

  socket.on("connect", registerController);
  socket.on("controller:ready", () => {
    elements.watchStatus.textContent = state.running ? "Conectado e pronto" : "Conectado — inicie a câmera";
  });
  socket.on("replay:trigger", () => requestReplay("watch"));
  socket.on("camera:switch", async (payload, acknowledge) => {
    const result = await switchCamera(payload?.mode, { remote: true });
    if (typeof acknowledge === "function") acknowledge(result);
  });
  socket.on("disconnect", () => {
    elements.watchStatus.textContent = "Reconectando…";
  });
}

function registerController() {
  if (socket.connected) socket.emit("controller:register", { key: state.controllerKey });
}

async function toggleCamera() {
  if (state.running) {
    if (hasPendingWork()) {
      showToast("Aguarde os replays pendentes antes de encerrar");
      return;
    }
    stopCamera();
  }
  else await startCamera();
}

async function switchCamera(mode, { remote = false } = {}) {
  if (!["ultrawide", "main", "front"].includes(mode)) {
    return { ok: false, message: "Câmera inválida." };
  }
  if (hasPendingWork()) {
    showToast("Aguarde a fila terminar para trocar a câmera");
    return { ok: false, message: "Há replays pendentes. Aguarde a fila terminar." };
  }
  if (remote && !state.running) {
    showToast("Inicie a câmera no iPhone primeiro");
    return { ok: false, message: "Inicie a câmera no iPhone primeiro." };
  }
  if (state.running && state.settings.camera === mode) {
    showToast("Essa câmera já está ativa");
    return { ok: true, message: "Essa câmera já está ativa.", mode };
  }

  state.settings.camera = mode;
  localStorage.setItem("jb-replay-settings", JSON.stringify(state.settings));
  applySettingsToUI();
  updateQuickCameraUI();

  if (!state.running) {
    showToast("Câmera selecionada — toque em Iniciar câmera");
    return { ok: true, message: "Câmera selecionada.", mode };
  }

  elements.lensSwitcher.querySelectorAll("button").forEach(button => { button.disabled = true; });
  showToast("Trocando câmera…");
  stopCamera(true);
  await delay(180);
  const started = await startCamera();
  elements.lensSwitcher.querySelectorAll("button").forEach(button => { button.disabled = false; });
  if (!started) return { ok: false, message: "O iPhone não conseguiu abrir essa câmera." };
  return { ok: true, message: "Câmera alterada.", mode };
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    showToast("Este navegador não permite gravação");
    return;
  }

  try {
    // A frontal é solicitada diretamente por facingMode. Isso evita a
    // identificação instável dos nomes das lentes no Safari do iPhone.
    let camera = state.settings.camera === "front"
      ? null
      : await resolveCamera(state.settings.camera);
    const capture = await openCameraStream(camera, state.settings.audio);
    state.stream = capture.stream;
    if (!capture.usedSelectedCamera) camera = null;

    const selectedLens = await applyLensPreference(state.stream, state.settings.camera, camera);
    const resolution = reportCaptureResolution(state.stream.getVideoTracks()[0]);

    elements.video.srcObject = state.stream;
    await elements.video.play();
    state.running = true;
    state.segments = [];
    state.initSegment = null;
    state.chunkStartedAt = Date.now();
    setCameraUI(true, `${selectedLens} • ${resolution.label}`);
    startRecorder();
    registerController();
    showToast("Câmera e replay ativados");
    return true;
  } catch (error) {
    console.error(error);
    showToast("Autorize o acesso à câmera e ao microfone");
    return false;
  }
}

async function openCameraStream(camera, audio) {
  const wantsFront = state.settings.camera === "front";
  const highFrameRate = state.settings.quality === "1080p60";
  const source = wantsFront
    ? { facingMode: { exact: "user" } }
    : camera?.deviceId
    ? { deviceId: { exact: camera.deviceId } }
    : { facingMode: { ideal: wantsFront ? "user" : "environment" } };
  const constraints = {
    ...source,
    width: { ideal: highFrameRate ? 1920 : 1280 },
    height: { ideal: highFrameRate ? 1080 : 720 },
    frameRate: { ideal: highFrameRate ? 60 : 30, max: highFrameRate ? 60 : 30 },
    aspectRatio: { ideal: 16 / 9 }
  };

  try {
    return {
      stream: await navigator.mediaDevices.getUserMedia({ video: constraints, audio }),
      usedSelectedCamera: Boolean(camera?.deviceId)
    };
  } catch (error) {
    if (wantsFront) {
      // Alguns iPhones não aceitam `exact`, mas respeitam a preferência
      // `ideal`. Em nenhuma das tentativas pedimos a câmera traseira.
      delete constraints.deviceId;
      constraints.facingMode = { ideal: "user" };
      return {
        stream: await navigator.mediaDevices.getUserMedia({ video: constraints, audio }),
        usedSelectedCamera: false
      };
    }
    if (!camera?.deviceId) throw error;
    delete constraints.deviceId;
    constraints.facingMode = { ideal: wantsFront ? "user" : "environment" };
    return {
      stream: await navigator.mediaDevices.getUserMedia({ video: constraints, audio }),
      usedSelectedCamera: false
    };
  }
}

function stopCamera(force = false) {
  if (!force && hasPendingWork()) return false;
  state.running = false;
  if (state.recorder?.state === "recording") state.recorder.stop();
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
  state.segments = [];
  setCameraUI(false);
  return true;
}

function setCameraUI(active, lensLabel = "") {
  state.activeLens = active ? lensLabel : "";
  elements.video.classList.toggle("active", active);
  elements.placeholder.classList.toggle("hidden", active);
  elements.recordDot.classList.toggle("live", active);
  elements.lensSwitcher.hidden = !active;
  elements.cameraStatus.textContent = active ? `Buffer ativo${lensLabel ? ` • ${lensLabel}` : ""}` : "Em espera";
  elements.cameraButton.innerHTML = active ? "<span>■</span> Encerrar câmera" : "<span>●</span> Iniciar câmera";
  elements.replayButton.disabled = !active;
  elements.watchStatus.textContent = active ? "Conectado e pronto" : "Conectado — inicie a câmera";
  if (!active) elements.captureInfo.textContent = "Aguardando câmera";
  updateQuickCameraUI();
}

function updateQuickCameraUI() {
  const activeMode = state.settings.camera === "auto" ? "main" : state.settings.camera;
  elements.lensSwitcher.querySelectorAll("[data-camera]").forEach(button => {
    const isActive = button.dataset.camera === activeMode;
    button.classList.toggle("active", isActive);
    button.setAttribute("aria-pressed", String(isActive));
  });
}

async function resolveCamera(mode) {
  if (mode === "auto" || !navigator.mediaDevices?.enumerateDevices) return null;

  // No iPhone, os nomes e identificadores completos aparecem somente depois
  // que a página recebeu permissão para usar a câmera.
  let permissionStream;
  let devices = await navigator.mediaDevices.enumerateDevices();
  if (!devices.some(device => device.kind === "videoinput" && device.label)) {
    permissionStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" } },
      audio: false
    });
    devices = await navigator.mediaDevices.enumerateDevices();
    permissionStream.getTracks().forEach(track => track.stop());
  }

  const cameras = devices.filter(device => device.kind === "videoinput");
  const isFront = label => /front|frontal|face|user/i.test(label);
  const isUltra = label => /ultra|0[.,]5|0\.5/i.test(label);
  const rear = cameras.filter(device => !isFront(device.label));
  const front = cameras.filter(device => isFront(device.label));
  const choice = (device, strategy) => device
    ? { deviceId: device.deviceId, label: device.label, strategy }
    : null;

  if (mode === "front") {
    return choice(front[0] || null, "front");
  }

  if (mode === "ultrawide") {
    const physicalUltra = rear.find(device => isUltra(device.label));
    if (physicalUltra) return choice(physicalUltra, "physical-ultrawide");

    // iPhones Pro podem expor o conjunto de lentes como uma única câmera
    // virtual (Dual/Triple/Back Camera). Nela, o zoom interno mínimo seleciona
    // o maior campo de visão disponível.
    const virtualRear = rear.find(device => /triple|dual|virtual/i.test(device.label))
      || rear.find(device => /back|rear|traseira|wide/i.test(device.label));
    return choice(virtualRear, "virtual-rear");
  }

  return choice(rear.find(device => !isUltra(device.label) && /back|rear|traseira|principal|main|wide/i.test(device.label))
    || rear.find(device => !isUltra(device.label))
    || null, "main");
}

async function applyLensPreference(stream, mode, matchedCamera) {
  elements.video.classList.remove("mirrored");
  if (mode === "auto") {
    updateCameraDiagnostic("Câmera traseira escolhida automaticamente pelo iPhone.");
    return "automática";
  }
  const track = stream.getVideoTracks()[0];

  if (mode === "front") {
    const facingMode = track.getSettings?.().facingMode;
    updateCameraDiagnostic(`Câmera frontal ativa${facingMode ? ` • modo ${facingMode}` : "."}`);
    elements.video.classList.add("mirrored");
    return "frontal";
  }

  if (mode === "ultrawide" && matchedCamera?.strategy === "physical-ultrawide") {
    updateCameraDiagnostic(`Ultra-angular física selecionada${matchedCamera.label ? `: ${matchedCamera.label}` : "."}`);
    return "0,5×";
  }

  if (mode === "ultrawide") {
    // Na câmera virtual dos iPhones Pro, o valor mínimo costuma ser 1, embora
    // corresponda à lente mostrada como 0,5× no aplicativo Câmera. A V1.3
    // exigia incorretamente um valor menor que 1.
    try {
      const capabilities = track.getCapabilities?.() || {};
      const minimumZoom = Number(capabilities.zoom?.min);
      const maximumZoom = Number(capabilities.zoom?.max);
      if (Number.isFinite(minimumZoom) && Number.isFinite(maximumZoom) && maximumZoom > minimumZoom) {
        await track.applyConstraints({ advanced: [{ zoom: minimumZoom }] });
        await delay(180);
        const appliedZoom = track.getSettings?.().zoom;
        updateCameraDiagnostic(`Ultra-angular solicitada • zoom interno ${appliedZoom ?? minimumZoom} • faixa ${minimumZoom}–${maximumZoom}`);
        return "0,5×";
      }
    } catch (error) {
      console.warn("Ultra-wide zoom unavailable", error);
    }
    updateCameraDiagnostic("O Safari expôs somente a câmera traseira 1× e não ofereceu controle de lente.");
    showToast("Safari manteve a câmera 1×; veja o diagnóstico nas configurações");
    return "traseira";
  }

  updateCameraDiagnostic(`Câmera principal selecionada${matchedCamera?.label ? `: ${matchedCamera.label}` : "."}`);
  return "1×";
}

function updateCameraDiagnostic(message) {
  state.cameraDiagnostic = message;
  if (elements.cameraDiagnostic) elements.cameraDiagnostic.textContent = message;
}

function reportCaptureResolution(track) {
  const actual = track.getSettings?.() || {};
  const width = actual.width || "automática";
  const height = actual.height || "automática";
  const fps = Math.round(actual.frameRate || 30);
  const requestedHighFrameRate = state.settings.quality === "1080p60";
  const isFullHd = Math.max(Number(width) || 0, Number(height) || 0) >= 1920
    && Math.min(Number(width) || 0, Number(height) || 0) >= 1080;
  const is60Fps = fps >= 55;
  const targetReached = !requestedHighFrameRate || (isFullHd && is60Fps);
  const message = requestedHighFrameRate && !targetReached
    ? `Modo 1080p · 60 solicitado; o iPhone entregou ${width} × ${height} • ${fps} fps.`
    : `Captura original: ${width} × ${height} • ${fps} fps`;
  updateResolutionDiagnostic(message);
  elements.captureInfo.textContent = `${width} × ${height} • ${fps} fps`;
  state.captureDetails = { width, height, fps, targetReached, mode: state.settings.quality };
  if (requestedHighFrameRate && !targetReached) {
    showToast(`Limite desta câmera: ${width} × ${height} • ${fps} fps`);
  }
  return { label: requestedHighFrameRate ? (targetReached ? "1080p · 60 fps" : "modo adaptado") : "original", settings: actual };
}

function updateResolutionDiagnostic(message) {
  state.resolutionDiagnostic = message;
  if (elements.resolutionDiagnostic) elements.resolutionDiagnostic.textContent = message;
}

function startRecorder() {
  if (!state.running || !state.stream) return;
  const mimeType = chooseMimeType();

  const highFrameRate = state.settings.quality === "1080p60";
  const recorderOptions = {
    ...(mimeType ? { mimeType } : {}),
    ...(highFrameRate ? { videoBitsPerSecond: 16_000_000, audioBitsPerSecond: 192_000 } : {})
  };

  try {
    state.recorder = new MediaRecorder(state.stream, recorderOptions);
  } catch {
    state.recorder = new MediaRecorder(state.stream);
  }

  state.recorder.ondataavailable = event => {
    if (!event.data?.size) return;
    const endedAt = Date.now();
    const startedAt = state.chunkStartedAt || endedAt;
    state.chunkStartedAt = endedAt;
    state.chunkChain = state.chunkChain
      .then(() => storeContinuousChunk(event.data, startedAt, endedAt))
      .finally(() => {
        state.boundaryResolver?.();
        state.boundaryResolver = null;
      });
  };
  state.recorder.onstop = () => {
    state.boundaryResolver?.();
    state.boundaryResolver = null;
  };
  state.recorder.onerror = event => {
    console.error("MediaRecorder error", event.error || event);
    showToast("A gravação foi interrompida pelo iPhone");
  };

  // Um único gravador permanece ativo. Os dados são liberados em pequenos
  // fragmentos, sem parar e reiniciar a câmera entre eles.
  state.recorder.start(1000);
}

async function storeContinuousChunk(blob, startedAt, endedAt) {
  const parts = await splitMp4Chunk(blob);
  if (parts.init?.size && !state.initSegment) state.initSegment = parts.init;
  if (parts.media?.size) {
    state.segments.push({ blob: parts.media, startedAt, endedAt });
    trimSegments();
  }
}

function forceBoundary() {
  return new Promise(resolve => {
    if (!state.recorder || state.recorder.state !== "recording") return resolve();
    const safetyTimer = setTimeout(() => {
      if (state.boundaryResolver === done) state.boundaryResolver = null;
      resolve();
    }, 1800);
    const done = () => {
      clearTimeout(safetyTimer);
      resolve();
    };
    state.boundaryResolver = done;
    state.recorder.requestData();
  });
}

async function splitMp4Chunk(blob) {
  if (!blob.type.includes("mp4")) return { init: null, media: blob };

  const bytes = new Uint8Array(await blob.arrayBuffer());
  const view = new DataView(bytes.buffer);
  let offset = 0;

  while (offset + 8 <= bytes.byteLength) {
    let size = view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    let headerSize = 8;
    if (size === 1 && offset + 16 <= bytes.byteLength) {
      size = Number(view.getBigUint64(offset + 8));
      headerSize = 16;
    } else if (size === 0) {
      size = bytes.byteLength - offset;
    }
    if (size < headerSize || offset + size > bytes.byteLength) break;

    if (type === "moof") {
      return {
        init: offset ? blob.slice(0, offset, blob.type) : null,
        media: blob.slice(offset, blob.size, blob.type)
      };
    }
    offset += size;
  }

  // Compatibilidade: se o navegador entregar cada trecho como MP4 completo,
  // ele continua sendo enviado como um segmento independente.
  return { init: null, media: blob };
}

function trimSegments() {
  let keepAfter = Date.now() - ((state.settings.duration + state.settings.postRoll + 12) * 1000);
  const waitingJobs = [state.currentReplayJob, ...state.replayQueue]
    .filter(job => job && !job.captureComplete);
  if (waitingJobs.length) {
    const earliestRequired = Math.min(...waitingJobs.map(job => job.triggerAt - (job.duration * 1000) - 2500));
    keepAfter = Math.min(keepAfter, earliestRequired);
  }
  state.segments = state.segments.filter(segment => segment.endedAt >= keepAfter);
}

function requestReplay(source) {
  if (!state.running) {
    showToast("Inicie a câmera primeiro");
    return;
  }
  if (state.replayQueue.length + (state.currentReplayJob ? 1 : 0) >= 6) {
    showToast("Fila cheia — aguarde um replay terminar");
    return;
  }

  const job = {
    id: crypto.randomUUID(),
    source,
    triggerAt: Date.now(),
    duration: state.settings.duration,
    postRoll: state.settings.postRoll,
    captureComplete: false
  };
  state.replayQueue.push(job);
  updateQueueUI();
  if (navigator.vibrate) navigator.vibrate([90, 50, 90]);
  const queued = state.replayQueue.length + (state.currentReplayJob ? 1 : 0);
  const suffix = job.postRoll ? ` • +${job.postRoll}s` : "";
  showToast(source === "watch" ? `Relógio recebido • fila ${queued}${suffix}` : `Replay na fila ${queued}${suffix}`);
  processReplayQueue();
}

async function processReplayQueue() {
  if (state.saving || state.upscaling || !state.running) return;
  state.saving = true;

  while (state.replayQueue.length && state.running) {
    const job = state.replayQueue.shift();
    state.currentReplayJob = job;
    updateQueueUI();

    try {
      await processReplayJob(job);
      showToast("Replay salvo com sucesso!");
    } catch (error) {
      console.error(error);
      showToast(error.message || "Não foi possível salvar o replay");
    } finally {
      state.currentReplayJob = null;
      updateQueueUI();
      trimSegments();
    }
  }

  state.saving = false;
  updateQueueUI();
  restoreCameraStatus();
}

async function processReplayJob(job) {
  const captureEnd = job.triggerAt + (job.postRoll * 1000);
  const remaining = captureEnd - Date.now();
  if (remaining > 0) {
    elements.cameraStatus.textContent = `Gravando +${job.postRoll}s depois…`;
    await delay(remaining);
  }

  await forceBoundary();
  await state.chunkChain;
  const captureStart = job.triggerAt - (job.duration * 1000);
  const selected = state.segments.filter(segment => segment.endedAt >= captureStart && segment.startedAt <= captureEnd);
  if (!selected.length) throw new Error("Ainda não há vídeo suficiente.");
  job.captureComplete = true;

  const totalDuration = job.duration + job.postRoll;
  elements.cameraStatus.textContent = "Enviando replay…";
  const replayBlob = await renderReplay(selected, totalDuration, state.initSegment);
  elements.cameraStatus.textContent = "Salvando no iPhone…";
  const replay = {
    id: crypto.randomUUID(),
    createdAt: job.triggerAt,
    duration: Math.min(totalDuration, Math.max(1, Math.round((selected.at(-1).endedAt - selected[0].startedAt) / 1000))),
    preDuration: job.duration,
    postDuration: job.postRoll,
    camera: state.settings.camera,
    captureMode: state.captureDetails?.mode || state.settings.quality,
    captureWidth: state.captureDetails?.width,
    captureHeight: state.captureDetails?.height,
    captureFps: state.captureDetails?.fps,
    blob: replayBlob
  };
  await saveReplay(replay);
  await renderGallery();
}

function updateQueueUI() {
  const total = state.replayQueue.length + (state.currentReplayJob ? 1 : 0);
  elements.queueStatus.hidden = total === 0;
  elements.queueCount.textContent = String(total);
  elements.queueText.textContent = total === 1 ? "1 replay sendo preparado" : `${total} replays na fila`;
}

function hasPendingWork() {
  return state.saving || state.upscaling || state.replayQueue.length > 0 || Boolean(state.currentReplayJob);
}

async function renderReplay(segments, duration, initSegment) {
  let lastError;

  // Uma nova requisição é criada em cada tentativa, pois FormData com vídeos
  // não deve ser reaproveitado depois de uma falha de rede no Safari.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const form = new FormData();
    form.append("duration", String(duration));
    if (initSegment) {
      const recording = new Blob([initSegment, ...segments.map(segment => segment.blob)], { type: "video/mp4" });
      form.append("segments", recording, "continuous-buffer.mp4");
    } else {
      segments.forEach((segment, index) => {
        const extension = segment.blob.type.includes("webm") ? "webm" : "mp4";
        form.append("segments", segment.blob, `segment-${String(index).padStart(3, "0")}.${extension}`);
      });
    }

    const controller = new AbortController();
    const timeoutMs = state.settings.quality === "1080p60" ? 180000 : 90000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch("/api/render", {
        method: "POST",
        body: form,
        signal: controller.signal
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "Falha ao montar o vídeo.");
      }
      const blob = await response.blob();
      if (!blob.size) throw new Error("O servidor devolveu um vídeo vazio.");
      return blob;
    } catch (error) {
      lastError = error;
      if (attempt === 1) {
        elements.cameraStatus.textContent = "Tentando salvar novamente…";
        await delay(700);
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError?.name === "AbortError") {
    throw new Error("A conexão demorou demais. Use Original do Safari ou confira o Wi-Fi.");
  }
  throw new Error(lastError?.message || "Não foi possível salvar o replay.");
}

async function renderGallery() {
  const replays = await getReplays();
  elements.gallery.innerHTML = "";
  elements.replayCount.textContent = String(replays.length);
  elements.emptyGallery.hidden = replays.length > 0;

  replays.forEach((replay, index) => {
    const url = URL.createObjectURL(replay.blob);
    const card = document.createElement("article");
    card.className = "replay-card";
    card.dataset.replayId = replay.id;
    const date = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(replay.createdAt);
    const durationLabel = replay.postDuration
      ? `${replay.duration}s (${replay.preDuration}+${replay.postDuration})`
      : `${replay.duration}s`;
    const captureLabel = replay.quality === "1080p"
      ? "1080p ampliado"
      : replay.captureMode === "1080p60"
        ? `${replay.captureWidth || "1080p"}×${replay.captureHeight || ""} • ${replay.captureFps || 60} fps`.replace("× •", "")
        : "Original";
    card.innerHTML = `
      <video src="${url}" controls playsinline preload="metadata"></video>
      <div class="replay-meta">
        <div><strong>Replay ${replays.length - index}</strong><small>${date} · ${durationLabel} · ${captureLabel}</small></div>
        <div class="replay-actions">
          ${replay.quality === "1080p"
            ? '<button type="button" data-action="share" class="upscale-action ready-action" title="Salvar o vídeo 1080p no iPhone">Salvar 1080p</button>'
            : '<button type="button" data-action="upscale" class="upscale-action" title="Gerar uma nova cópia ampliada para 1080p">Gerar 1080p</button>'}
          ${replay.quality === "1080p" ? "" : '<button type="button" data-action="share" title="Compartilhar original">↗</button>'}
          <button type="button" data-action="delete" title="Excluir">⌫</button>
        </div>
      </div>`;
    card.querySelector('[data-action="share"]').addEventListener("click", () => shareReplay(replay));
    card.querySelector('[data-action="upscale"]')?.addEventListener("click", event => upscaleReplay(replay, event.currentTarget));
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      await deleteReplay(replay.id);
      URL.revokeObjectURL(url);
      renderGallery();
    });
    elements.gallery.appendChild(card);
  });
}

async function upscaleReplay(replay, button) {
  if (state.saving || state.replayQueue.length || state.currentReplayJob) {
    showToast("Aguarde a fila de replays terminar");
    return;
  }
  if (state.upscaling) {
    showToast("Uma versão 1080p já está sendo gerada");
    return;
  }
  state.upscaling = true;
  button.disabled = true;
  const originalLabel = button.textContent;
  let elapsedSeconds = 0;
  button.textContent = "Enviando…";
  button.classList.add("processing");
  elements.cameraStatus.textContent = "Preparando cópia 1080p…";
  showToast("1080p iniciado — aguarde nesta tela");
  const progressTimer = setInterval(() => {
    elapsedSeconds += 1;
    button.textContent = `Processando ${elapsedSeconds}s`;
    elements.cameraStatus.textContent = `Gerando 1080p • ${elapsedSeconds}s`;
  }, 1000);

  try {
    const allReplays = await getReplays();
    let enhanced = allReplays.find(item => item.quality === "1080p" && item.sourceId === replay.id && item.exportVersion === "1.9");

    if (!enhanced) {
      const form = new FormData();
      form.append("video", replay.blob, "JB-Replay-original.mp4");
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 300000);
      let response;
      try {
        response = await fetch("/api/upscale", { method: "POST", body: form, signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.message || "Não foi possível gerar o vídeo 1080p.");
      }

      const blob = await response.blob();
      if (!blob.size) throw new Error("O vídeo 1080p ficou vazio.");
      const dimensions = await readVideoDimensions(blob);
      if (Math.max(dimensions.width, dimensions.height) < 1920 || Math.min(dimensions.width, dimensions.height) < 1080) {
        throw new Error(`O servidor devolveu ${dimensions.width}×${dimensions.height}, não 1080p.`);
      }
      enhanced = {
        id: crypto.randomUUID(),
        sourceId: replay.id,
        createdAt: Date.now(),
        duration: replay.duration,
        quality: "1080p",
        exportVersion: "1.9",
        width: dimensions.width,
        height: dimensions.height,
        blob
      };
      await saveReplay(enhanced);
      await renderGallery();
    }

    showToast("1080p pronto! Toque em Salvar 1080p");
    restoreCameraStatus();
    scrollToEnhancedReplay(enhanced.id);
  } catch (error) {
    console.error(error);
    showToast(error.name === "AbortError" ? "A conversão excedeu 5 minutos" : (error.message || "Falha ao gerar 1080p"));
    restoreCameraStatus();
  } finally {
    clearInterval(progressTimer);
    state.upscaling = false;
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
      button.classList.remove("processing");
    }
    processReplayQueue();
  }
}

function readVideoDimensions(blob) {
  return new Promise((resolve, reject) => {
    const video = document.createElement("video");
    const url = URL.createObjectURL(blob);
    video.preload = "metadata";
    video.onloadedmetadata = () => {
      const dimensions = { width: video.videoWidth, height: video.videoHeight };
      URL.revokeObjectURL(url);
      resolve(dimensions);
    };
    video.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("O iPhone não conseguiu validar o vídeo 1080p."));
    };
    video.src = url;
  });
}

function restoreCameraStatus() {
  elements.cameraStatus.textContent = state.running
    ? `Buffer ativo${state.activeLens ? ` • ${state.activeLens}` : ""}`
    : "Em espera";
}

function scrollToEnhancedReplay(id) {
  requestAnimationFrame(() => {
    const card = [...elements.gallery.querySelectorAll(".replay-card")]
      .find(item => item.dataset.replayId === id);
    if (!card) return;
    card.classList.add("new-1080p");
    card.scrollIntoView({ behavior: "smooth", block: "center" });
    setTimeout(() => card.classList.remove("new-1080p"), 3500);
  });
}

async function shareReplay(replay) {
  const suffix = replay.quality === "1080p" ? "-1080p" : "";
  const file = new File([replay.blob], `JB-Replay-${formatFileDate(replay.createdAt)}${suffix}.mp4`, { type: "video/mp4" });
  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({ title: "JB Replay", files: [file] });
  } else {
    const link = document.createElement("a");
    link.href = URL.createObjectURL(replay.blob);
    link.download = file.name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
  }
}

function openWatchSetup() {
  elements.watchUrl.textContent = watchTriggerUrl();
  elements.watchDialog.querySelectorAll("[data-camera-url]").forEach(code => {
    code.textContent = cameraCommandUrl(code.dataset.cameraUrl);
  });
  elements.watchDialog.showModal();
}

function watchTriggerUrl() {
  return `${location.origin}/api/trigger?key=${encodeURIComponent(state.controllerKey)}`;
}

function cameraCommandUrl(mode) {
  return `${location.origin}/api/camera?key=${encodeURIComponent(state.controllerKey)}&mode=${encodeURIComponent(mode)}`;
}

async function copyWatchUrl() {
  await navigator.clipboard.writeText(watchTriggerUrl());
  showToast("Endereço copiado");
}

async function copyCameraUrl(mode) {
  await navigator.clipboard.writeText(cameraCommandUrl(mode));
  const labels = { ultrawide: "0,5×", main: "1×", front: "frontal" };
  showToast(`Endereço da câmera ${labels[mode]} copiado`);
}

function saveSettings(event) {
  if (hasPendingWork()) {
    event?.preventDefault();
    showToast("Aguarde a fila terminar para alterar configurações");
    return;
  }
  state.settings = {
    duration: Number(elements.durationSelect.value),
    postRoll: Number(elements.postRollSelect.value),
    quality: elements.qualitySelect.value,
    camera: elements.cameraSelect.value,
    orientation: elements.orientationSelect.value,
    audio: elements.audioToggle.checked
  };
  localStorage.setItem("jb-replay-settings", JSON.stringify(state.settings));
  applySettingsToUI();
  if (state.running) {
    stopCamera();
    showToast("Configuração salva — reinicie a câmera");
  }
}

function loadSettings() {
  const defaults = { duration: 40, postRoll: 3, quality: "original", camera: "auto", orientation: "landscape", audio: true };
  try {
    const saved = JSON.parse(localStorage.getItem("jb-replay-settings")) || {};
    const quality = saved.quality === "1080p60" ? "1080p60" : "original";
    return { ...defaults, ...saved, quality };
  } catch {
    return defaults;
  }
}

function applySettingsToUI() {
  elements.durationSelect.value = state.settings.duration;
  elements.postRollSelect.value = state.settings.postRoll;
  elements.qualitySelect.value = state.settings.quality;
  elements.cameraSelect.value = state.settings.camera || "auto";
  updateCameraDiagnostic(state.cameraDiagnostic);
  updateResolutionDiagnostic(state.resolutionDiagnostic);
  elements.orientationSelect.value = state.settings.orientation;
  elements.audioToggle.checked = state.settings.audio;
  elements.bufferLabel.textContent = `${state.settings.duration}s`;
  elements.buttonSeconds.textContent = state.settings.duration;
  elements.buttonPostSeconds.textContent = state.settings.postRoll;
  updateQuickCameraUI();
  if (!state.running) updateQualityPreview();
}

function updateQualityPreview() {
  if (state.running) return;
  const message = elements.qualitySelect.value === "1080p60"
    ? "Solicita 1920 × 1080 a 60 fps. A resolução real será confirmada ao iniciar a câmera."
    : "O replay será salvo sem ampliação. Depois, você poderá gerar uma cópia em 1080p.";
  updateResolutionDiagnostic(message);
}

function getControllerKey() {
  let key = localStorage.getItem("jb-replay-controller-key");
  if (!key) {
    const bytes = crypto.getRandomValues(new Uint8Array(18));
    key = Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("");
    localStorage.setItem("jb-replay-controller-key", key);
  }
  return key;
}

function chooseMimeType() {
  const options = [
    "video/mp4;codecs=h264,aac",
    "video/mp4;codecs=avc1.42E01E,mp4a.40.2",
    "video/mp4",
    "video/webm;codecs=vp8,opus",
    "video/webm"
  ];
  return options.find(type => MediaRecorder.isTypeSupported(type)) || "";
}

function showToast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("show");
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => elements.toast.classList.remove("show"), 2600);
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }
function formatFileDate(value) { return new Date(value).toISOString().replaceAll(":", "-").replace(/\.\d{3}Z$/, ""); }

function openDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("jb-replay", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("replays", { keyPath: "id" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(mode, action) {
  return new Promise((resolve, reject) => {
    const tx = state.db.transaction("replays", mode);
    const store = tx.objectStore("replays");
    action(store);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function saveReplay(replay) { return transaction("readwrite", store => store.put(replay)); }
function deleteReplay(id) { return transaction("readwrite", store => store.delete(id)); }
function getReplays() {
  return new Promise((resolve, reject) => {
    const request = state.db.transaction("replays", "readonly").objectStore("replays").getAll();
    request.onsuccess = () => resolve(request.result.sort((a, b) => b.createdAt - a.createdAt));
    request.onerror = () => reject(request.error);
  });
}

function registerServiceWorker() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js").catch(console.error);
}
