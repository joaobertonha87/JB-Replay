const $ = selector => document.querySelector(selector);

const elements = {
  video: $("#cameraPreview"), placeholder: $("#cameraPlaceholder"), cameraButton: $("#cameraButton"),
  replayButton: $("#replayButton"), settingsButton: $("#settingsButton"), settingsDialog: $("#settingsDialog"),
  watchDialog: $("#watchDialog"), watchSetupButton: $("#watchSetupButton"), closeWatchDialog: $("#closeWatchDialog"),
  copyUrlButton: $("#copyUrlButton"), testWatchButton: $("#testWatchButton"), watchUrl: $("#watchUrl"),
  cameraStatus: $("#cameraStatus"), watchStatus: $("#watchStatus"), recordDot: $("#recordDot"),
  bufferLabel: $("#bufferLabel"), buttonSeconds: $("#buttonSeconds"), toast: $("#toast"),
  gallery: $("#gallery"), emptyGallery: $("#emptyGallery"), replayCount: $("#replayCount"),
  durationSelect: $("#durationSelect"), qualitySelect: $("#qualitySelect"), cameraSelect: $("#cameraSelect"),
  cameraDiagnostic: $("#cameraDiagnostic"), resolutionDiagnostic: $("#resolutionDiagnostic"),
  orientationSelect: $("#orientationSelect"), audioToggle: $("#audioToggle"), saveSettingsButton: $("#saveSettingsButton")
};

const state = {
  stream: null,
  recorder: null,
  running: false,
  saving: false,
  segments: [],
  initSegment: null,
  chunkStartedAt: null,
  chunkChain: Promise.resolve(),
  boundaryResolver: null,
  activeLens: "",
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
  elements.testWatchButton.addEventListener("click", async () => {
    const response = await fetch(watchTriggerUrl());
    if (!response.ok) showToast("Inicie a câmera primeiro");
  });
  elements.saveSettingsButton.addEventListener("click", saveSettings);
  window.addEventListener("beforeunload", stopCamera);

  socket.on("connect", registerController);
  socket.on("controller:ready", () => {
    elements.watchStatus.textContent = state.running ? "Conectado e pronto" : "Conectado — inicie a câmera";
  });
  socket.on("replay:trigger", () => requestReplay("watch"));
  socket.on("disconnect", () => {
    elements.watchStatus.textContent = "Reconectando…";
  });
}

function registerController() {
  if (socket.connected) socket.emit("controller:register", { key: state.controllerKey });
}

async function toggleCamera() {
  if (state.running) stopCamera();
  else await startCamera();
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
  } catch (error) {
    console.error(error);
    showToast("Autorize o acesso à câmera e ao microfone");
  }
}

async function openCameraStream(camera, audio) {
  const wantsFront = state.settings.camera === "front";
  const source = wantsFront
    ? { facingMode: { exact: "user" } }
    : camera?.deviceId
    ? { deviceId: { exact: camera.deviceId } }
    : { facingMode: { ideal: wantsFront ? "user" : "environment" } };
  const constraints = {
    ...source,
    width: { ideal: 1280 },
    height: { ideal: 720 },
    frameRate: { ideal: 30, max: 30 },
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

function stopCamera() {
  state.running = false;
  if (state.recorder?.state === "recording") state.recorder.stop();
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
  state.segments = [];
  setCameraUI(false);
}

function setCameraUI(active, lensLabel = "") {
  state.activeLens = active ? lensLabel : "";
  elements.video.classList.toggle("active", active);
  elements.placeholder.classList.toggle("hidden", active);
  elements.recordDot.classList.toggle("live", active);
  elements.cameraStatus.textContent = active ? `Buffer ativo${lensLabel ? ` • ${lensLabel}` : ""}` : "Em espera";
  elements.cameraButton.innerHTML = active ? "<span>■</span> Encerrar câmera" : "<span>●</span> Iniciar câmera";
  elements.replayButton.disabled = !active;
  elements.watchStatus.textContent = active ? "Conectado e pronto" : "Conectado — inicie a câmera";
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
  const message = `Captura original: ${actual.width || "automática"} × ${actual.height || "automática"} • ${Math.round(actual.frameRate || 30)} fps`;
  updateResolutionDiagnostic(message);
  return { label: "original", settings: actual };
}

function updateResolutionDiagnostic(message) {
  state.resolutionDiagnostic = message;
  if (elements.resolutionDiagnostic) elements.resolutionDiagnostic.textContent = message;
}

function startRecorder() {
  if (!state.running || !state.stream) return;
  const mimeType = chooseMimeType();

  const recorderOptions = mimeType ? { mimeType } : undefined;

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
  const keepAfter = Date.now() - ((state.settings.duration + 12) * 1000);
  state.segments = state.segments.filter(segment => segment.endedAt >= keepAfter);
}

async function requestReplay(source) {
  if (!state.running) {
    showToast("Inicie a câmera primeiro");
    return;
  }
  if (state.saving) {
    showToast("Um replay já está sendo preparado");
    return;
  }

  state.saving = true;
  elements.replayButton.disabled = true;
  elements.cameraStatus.textContent = "Preparando replay";
  if (navigator.vibrate) navigator.vibrate([90, 50, 90]);
  showToast(source === "watch" ? "Comando recebido do relógio" : "Replay solicitado");

  try {
    // Fecha imediatamente o segmento atual. O lance salvo termina no momento
    // do toque, sem adicionar segundos ocultos ao tempo escolhido.
    await forceBoundary();
    const end = Date.now();
    const start = end - (state.settings.duration * 1000);
    const selected = state.segments.filter(segment => segment.endedAt >= start && segment.startedAt <= end);
    if (!selected.length) throw new Error("Ainda não há vídeo suficiente.");

    elements.cameraStatus.textContent = "Enviando replay…";
    const replayBlob = await renderReplay(selected, state.settings.duration, state.initSegment);
    elements.cameraStatus.textContent = "Salvando no iPhone…";
    const replay = {
      id: crypto.randomUUID(),
      createdAt: Date.now(),
      duration: Math.min(state.settings.duration, Math.round((selected.at(-1).endedAt - selected[0].startedAt) / 1000)),
      blob: replayBlob
    };
    await saveReplay(replay);
    await renderGallery();
    showToast("Replay salvo com sucesso!");
  } catch (error) {
    console.error(error);
    showToast(error.message || "Não foi possível salvar o replay");
  } finally {
    state.saving = false;
    elements.replayButton.disabled = !state.running;
    elements.cameraStatus.textContent = state.running
      ? `Buffer ativo${state.activeLens ? ` • ${state.activeLens}` : ""}`
      : "Em espera";
  }
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
    const timeout = setTimeout(() => controller.abort(), 90000);
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
    throw new Error("A conexão demorou demais. Use 720p ou confira o Wi-Fi.");
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
    card.innerHTML = `
      <video src="${url}" controls playsinline preload="metadata"></video>
      <div class="replay-meta">
        <div><strong>Replay ${replays.length - index}</strong><small>${date} · ${replay.duration}s · ${replay.quality === "1080p" ? "1080p ampliado" : "Original"}</small></div>
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
    if (button.isConnected) {
      button.disabled = false;
      button.textContent = originalLabel;
      button.classList.remove("processing");
    }
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
  elements.watchDialog.showModal();
}

function watchTriggerUrl() {
  return `${location.origin}/api/trigger?key=${encodeURIComponent(state.controllerKey)}`;
}

async function copyWatchUrl() {
  await navigator.clipboard.writeText(watchTriggerUrl());
  showToast("Endereço copiado");
}

function saveSettings() {
  state.settings = {
    duration: Number(elements.durationSelect.value),
    quality: Number(elements.qualitySelect.value),
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
  try {
    return { duration: 40, quality: 720, camera: "auto", orientation: "landscape", audio: true, ...JSON.parse(localStorage.getItem("jb-replay-settings")), quality: 720 };
  } catch {
    return { duration: 40, quality: 720, camera: "auto", orientation: "landscape", audio: true };
  }
}

function applySettingsToUI() {
  elements.durationSelect.value = state.settings.duration;
  elements.qualitySelect.value = state.settings.quality;
  elements.cameraSelect.value = state.settings.camera || "auto";
  updateCameraDiagnostic(state.cameraDiagnostic);
  updateResolutionDiagnostic(state.resolutionDiagnostic);
  elements.orientationSelect.value = state.settings.orientation;
  elements.audioToggle.checked = state.settings.audio;
  elements.bufferLabel.textContent = `${state.settings.duration}s`;
  elements.buttonSeconds.textContent = state.settings.duration;
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
