const $ = selector => document.querySelector(selector);

const elements = {
  video: $("#cameraPreview"), placeholder: $("#cameraPlaceholder"), cameraButton: $("#cameraButton"),
  replayButton: $("#replayButton"), settingsButton: $("#settingsButton"), settingsDialog: $("#settingsDialog"),
  watchDialog: $("#watchDialog"), watchSetupButton: $("#watchSetupButton"), closeWatchDialog: $("#closeWatchDialog"),
  copyUrlButton: $("#copyUrlButton"), testWatchButton: $("#testWatchButton"), watchUrl: $("#watchUrl"),
  cameraStatus: $("#cameraStatus"), watchStatus: $("#watchStatus"), recordDot: $("#recordDot"),
  bufferLabel: $("#bufferLabel"), buttonSeconds: $("#buttonSeconds"), toast: $("#toast"),
  gallery: $("#gallery"), emptyGallery: $("#emptyGallery"), replayCount: $("#replayCount"),
  durationSelect: $("#durationSelect"), qualitySelect: $("#qualitySelect"),
  orientationSelect: $("#orientationSelect"), audioToggle: $("#audioToggle"), saveSettingsButton: $("#saveSettingsButton")
};

const state = {
  stream: null,
  recorder: null,
  running: false,
  saving: false,
  segments: [],
  currentSegment: null,
  segmentTimer: null,
  boundaryResolver: null,
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
    const landscape = state.settings.orientation === "landscape";
    const width = state.settings.quality === 1080 ? 1920 : 1280;
    const height = state.settings.quality === 1080 ? 1080 : 720;
    state.stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: landscape ? width : height },
        height: { ideal: landscape ? height : width },
        frameRate: { ideal: 30, max: 30 }
      },
      audio: state.settings.audio
    });

    elements.video.srcObject = state.stream;
    await elements.video.play();
    state.running = true;
    state.segments = [];
    setCameraUI(true);
    startSegment();
    registerController();
    showToast("Câmera e replay ativados");
  } catch (error) {
    console.error(error);
    showToast("Autorize o acesso à câmera e ao microfone");
  }
}

function stopCamera() {
  state.running = false;
  clearTimeout(state.segmentTimer);
  if (state.recorder?.state === "recording") state.recorder.stop();
  state.stream?.getTracks().forEach(track => track.stop());
  state.stream = null;
  elements.video.srcObject = null;
  state.segments = [];
  setCameraUI(false);
}

function setCameraUI(active) {
  elements.video.classList.toggle("active", active);
  elements.placeholder.classList.toggle("hidden", active);
  elements.recordDot.classList.toggle("live", active);
  elements.cameraStatus.textContent = active ? "Buffer ativo" : "Em espera";
  elements.cameraButton.innerHTML = active ? "<span>■</span> Encerrar câmera" : "<span>●</span> Iniciar câmera";
  elements.replayButton.disabled = !active;
  elements.watchStatus.textContent = active ? "Conectado e pronto" : "Conectado — inicie a câmera";
}

function startSegment() {
  if (!state.running || !state.stream) return;
  const mimeType = chooseMimeType();
  const chunks = [];
  const startedAt = Date.now();

  try {
    state.recorder = new MediaRecorder(state.stream, mimeType ? { mimeType } : undefined);
  } catch {
    state.recorder = new MediaRecorder(state.stream);
  }

  state.currentSegment = { startedAt };
  state.recorder.ondataavailable = event => {
    if (event.data?.size) chunks.push(event.data);
  };
  state.recorder.onstop = () => {
    clearTimeout(state.segmentTimer);
    const endedAt = Date.now();
    if (chunks.length && (state.running || state.saving)) {
      state.segments.push({
        blob: new Blob(chunks, { type: state.recorder.mimeType || mimeType || "video/mp4" }),
        startedAt,
        endedAt
      });
      trimSegments();
    }
    state.currentSegment = null;
    state.boundaryResolver?.();
    state.boundaryResolver = null;
    if (state.running) startSegment();
  };
  state.recorder.start();
  state.segmentTimer = setTimeout(() => stopCurrentSegment(), 4000);
}

function stopCurrentSegment() {
  if (state.recorder?.state === "recording") state.recorder.stop();
}

function forceBoundary() {
  return new Promise(resolve => {
    if (!state.recorder || state.recorder.state !== "recording") return resolve();
    state.boundaryResolver = resolve;
    stopCurrentSegment();
  });
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
    const replayBlob = await renderReplay(selected, state.settings.duration);
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
    elements.cameraStatus.textContent = state.running ? "Buffer ativo" : "Em espera";
  }
}

async function renderReplay(segments, duration) {
  let lastError;

  // Uma nova requisição é criada em cada tentativa, pois FormData com vídeos
  // não deve ser reaproveitado depois de uma falha de rede no Safari.
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const form = new FormData();
    form.append("duration", String(duration));
    segments.forEach((segment, index) => {
      const extension = segment.blob.type.includes("webm") ? "webm" : "mp4";
      form.append("segments", segment.blob, `segment-${String(index).padStart(3, "0")}.${extension}`);
    });

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
    const date = new Intl.DateTimeFormat("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(replay.createdAt);
    card.innerHTML = `
      <video src="${url}" controls playsinline preload="metadata"></video>
      <div class="replay-meta">
        <div><strong>Replay ${replays.length - index}</strong><small>${date} · ${replay.duration}s</small></div>
        <div class="replay-actions">
          <button data-action="share" title="Compartilhar">↗</button>
          <button data-action="delete" title="Excluir">⌫</button>
        </div>
      </div>`;
    card.querySelector('[data-action="share"]').addEventListener("click", () => shareReplay(replay));
    card.querySelector('[data-action="delete"]').addEventListener("click", async () => {
      await deleteReplay(replay.id);
      URL.revokeObjectURL(url);
      renderGallery();
    });
    elements.gallery.appendChild(card);
  });
}

async function shareReplay(replay) {
  const file = new File([replay.blob], `JB-Replay-${formatFileDate(replay.createdAt)}.mp4`, { type: "video/mp4" });
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
    return { duration: 40, quality: 1080, orientation: "landscape", audio: true, ...JSON.parse(localStorage.getItem("jb-replay-settings")) };
  } catch {
    return { duration: 40, quality: 1080, orientation: "landscape", audio: true };
  }
}

function applySettingsToUI() {
  elements.durationSelect.value = state.settings.duration;
  elements.qualitySelect.value = state.settings.quality;
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
