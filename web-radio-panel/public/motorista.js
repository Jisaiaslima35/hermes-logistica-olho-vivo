const DRV_STORAGE_KEY = 'hermes_driver_session';
const DRV_TOKEN_KEY = 'hermes_driver_token';
const DRV_ONLINE_KEY = 'hermes_driver_online';
const RADIO_ROOM_GENERAL = 'radio-cooperativa-geral';
let driverSession = null;
let driverToken = localStorage.getItem(DRV_TOKEN_KEY) || '';
let driverOnline = localStorage.getItem(DRV_ONLINE_KEY) !== '0';
let currentPos = { lat: -5.7945, lon: -35.2084, speed_kph: 0, heading_deg: 0 };
let lastQueueIds = new Set();
let lkRoom = null;
let qrStream = null;
let qrTimer = null;
let currentRadioRoom = RADIO_ROOM_GENERAL;
let radioChannelOptions = [];
let activeRun = null;

function showEl(el) { if (el) { el.hidden = false; el.classList.remove('is-hidden', 'hidden'); } }
function hideEl(el) { if (el) { el.hidden = true; el.classList.add('is-hidden'); } }

async function dapi(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (driverToken) headers['Authorization'] = `Bearer ${driverToken}`;
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `Erro HTTP ${res.status}`);
    err.status = res.status;
    err.payload = data;
    throw err;
  }
  return data;
}

// Alerta sonoro WebAudio (bipe curto)
function playBeep(freq = 880, durationMs = 220) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.value = 0.15;
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    setTimeout(() => { osc.stop(); ctx.close(); }, durationMs);
  } catch {}
}

// ─── INDEXEDDB OFFLINE QUEUES (GPS & DVIR) ───────────────────────────────────
function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('hermes_driver_offline', 1);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('telemetry')) db.createObjectStore('telemetry', { autoIncrement: true });
      if (!db.objectStoreNames.contains('dvir')) db.createObjectStore('dvir', { autoIncrement: true });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPush(storeName, item) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).add(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAllAndClear(storeName) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const getReq = store.getAll();
    getReq.onsuccess = () => {
      const items = getReq.result || [];
      if (items.length) store.clear();
      resolve(items);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

// ─── LOGIN ───────────────────────────────────────────────────────────────────
document.getElementById('drv-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideEl(document.getElementById('drv-login-err'));
  try {
    const data = await dapi('/api/driver/login', {
      method: 'POST',
      body: { identifier: document.getElementById('drv-id-input').value }
    });
    onDriverLogin(data.driver, data.token);
  } catch (err) {
    const box = document.getElementById('drv-login-err');
    box.textContent = err.message;
    showEl(box);
  }
});

document.getElementById('drv-btn-demo').addEventListener('click', async () => {
  hideEl(document.getElementById('drv-login-err'));
  try {
    const data = await dapi('/api/driver/login', { method: 'POST', body: { demo: true } });
    onDriverLogin(data.driver, data.token);
  } catch (err) {
    const box = document.getElementById('drv-login-err');
    box.textContent = err.message;
    showEl(box);
  }
});

document.getElementById('drv-logout').addEventListener('click', () => {
  localStorage.removeItem(DRV_STORAGE_KEY);
  localStorage.removeItem(DRV_TOKEN_KEY);
  driverSession = null;
  driverToken = '';
  hideEl(document.getElementById('drv-app'));
  showEl(document.getElementById('drv-login-screen'));
});

function onDriverLogin(driver, token) {
  driverSession = driver;
  if (token) {
    driverToken = token;
    localStorage.setItem(DRV_TOKEN_KEY, token);
  }
  localStorage.setItem(DRV_STORAGE_KEY, JSON.stringify(driver));
  document.getElementById('drv-name').textContent = driver.name;
  document.getElementById('drv-meta').textContent = `Placa: ${driver.plate || '-'} · Frota: ${driver.fleet_type || 'moto'}`;
  hideEl(document.getElementById('drv-login-screen'));
  showEl(document.getElementById('drv-app'));

  applyPresenceUI();
  registerPwaAndPush();
  startGpsTracking();
  initDriverLiveKit();
  syncPresenceWithServer();
  loadRadioChannels();
  refreshOrdersAndQueue();
  setInterval(refreshOrdersAndQueue, 12000);
}

// ─── PRESENÇA: ONLINE / OFFLINE ──────────────────────────────────────────────
// Botão grande no topo. Offline pausa o rastreio (telemetria) e esconde a
// fila de corridas — o motorista some da Central e não recebe novas corridas.
function applyPresenceUI() {
  const btn = document.getElementById('btn-presence');
  const title = document.getElementById('btn-presence-title');
  const sub = document.getElementById('btn-presence-sub');
  const banner = document.getElementById('drv-offline-banner');
  if (!btn) return;

  if (driverOnline) {
    btn.classList.remove('is-offline');
    btn.classList.add('is-online');
    title.textContent = 'ESTOU ONLINE (Recebendo Corridas)';
    sub.textContent = 'Toque para pausar o rastreio e sair da fila';
    hideEl(banner);
  } else {
    btn.classList.remove('is-online');
    btn.classList.add('is-offline');
    title.textContent = 'ESTOU OFFLINE (Pausado)';
    sub.textContent = 'Toque para voltar a receber corridas';
    showEl(banner);
  }
}

async function setDriverPresence(online) {
  if (!driverSession) return;
  const previous = driverOnline;
  driverOnline = !!online;
  applyPresenceUI();
  try {
    await dapi('/api/driver/status', {
      method: 'POST',
      body: { driver_id: driverSession.id, status: driverOnline ? 'online' : 'offline' }
    });
    localStorage.setItem(DRV_ONLINE_KEY, driverOnline ? '1' : '0');
    playBeep(driverOnline ? 980 : 420, 180);
  } catch (err) {
    // Falhou no servidor: devolve o estado anterior (a Central não mente).
    driverOnline = previous;
    applyPresenceUI();
    alert('Não foi possível mudar seu status: ' + err.message);
    return;
  }
  refreshOrdersAndQueue();
}

// Sincroniza o estado local com o servidor no login (o celular pode ter
// ficado offline com o botão em Offline).
async function syncPresenceWithServer() {
  if (!driverSession) return;
  try {
    const r = await fetch(`/api/driver/status?driver_id=${encodeURIComponent(driverSession.id)}`, {
      headers: driverToken ? { Authorization: `Bearer ${driverToken}` } : {}
    });
    if (r.ok) {
      const data = await r.json();
      if (data && typeof data.online === 'boolean') {
        driverOnline = data.online;
        localStorage.setItem(DRV_ONLINE_KEY, driverOnline ? '1' : '0');
        applyPresenceUI();
      }
    }
  } catch {}
}

document.getElementById('btn-presence').addEventListener('click', () => {
  setDriverPresence(!driverOnline);
});

// ─── NAVEGAÇÃO INFERIOR ──────────────────────────────────────────────────────
document.querySelectorAll('[data-dtab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-dtab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.dtab;
    ['corridas', 'radio', 'dvir', 'carteira'].forEach(t => {
      const el = document.getElementById(`dtab-${t}`);
      if (t === tab) showEl(el); else hideEl(el);
    });
    if (tab === 'carteira') loadDriverWallet();
  });
});

// ─── PWA SERVICE WORKER & WEB PUSH ───────────────────────────────────────────
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

async function registerPwaAndPush() {
  if ('serviceWorker' in navigator) {
    try {
      // updateViaCache 'none': o celular busca o sw.js novo (v3) em vez de
      // usar o cache antigo do HTTP — é o que quebra o "app velho" no celular.
      await navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' });
      const reg = await navigator.serviceWorker.getRegistration('/sw.js');
      if (reg) reg.update().catch(() => {});
    } catch {}
  }
}

document.getElementById('btn-enable-push').addEventListener('click', async () => {
  if (!('Notification' in window) || !('serviceWorker' in navigator)) {
    return alert('Web Push não suportado neste navegador.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') return alert('Permissão de notificação negada.');
  try {
    const reg = await navigator.serviceWorker.ready;
    const { publicKey } = await dapi('/api/push/vapid-public-key');
    if (!publicKey) return alert('Chave VAPID não configurada no servidor.');
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey)
    });
    await dapi('/api/push/subscribe', {
      method: 'POST',
      body: {
        driver_id: driverSession.id,
        organization_id: driverSession.organization_id || 'default',
        subscription: sub.toJSON()
      }
    });
    playBeep(980, 180);
    alert('Notificações Push ativadas com sucesso!');
  } catch (err) {
    alert('Erro ao ativar Push: ' + err.message);
  }
});

// ─── GPS CONTÍNUO + WAKELOCK + BATCH OFFLINE ─────────────────────────────────
async function startGpsTracking() {
  try {
    if ('wakeLock' in navigator) await navigator.wakeLock.request('screen');
  } catch {}

  if ('geolocation' in navigator) {
    navigator.geolocation.watchPosition(async (pos) => {
      currentPos = {
        lat: Number(pos.coords.latitude.toFixed(6)),
        lon: Number(pos.coords.longitude.toFixed(6)),
        speed_kph: pos.coords.speed ? Number((pos.coords.speed * 3.6).toFixed(1)) : 0,
        heading_deg: pos.coords.heading || 0,
        ts: new Date().toISOString()
      };
      document.getElementById('drv-meta').textContent = `Placa: ${driverSession.plate || '-'} · GPS: ${currentPos.lat}, ${currentPos.lon}`;
      await idbPush('telemetry', currentPos).catch(() => {});
    }, () => {}, { enableHighAccuracy: true, maximumAge: 10000 });
  }

  setInterval(flushTelemetryBatch, 20000);
}

async function flushTelemetryBatch() {
  if (!driverSession) return;
  // Offline = rastreio pausado: não envia telemetria para a Central.
  if (!driverOnline) {
    // Descarta o que acumulou para não "descarregar" o histórico ao voltar.
    await idbGetAllAndClear('telemetry').catch(() => []);
    return;
  }
  const points = await idbGetAllAndClear('telemetry').catch(() => []);
  if (!points.length) return;
  try {
    await dapi('/api/driver/telemetry/batch', {
      method: 'POST',
      body: {
        organization_id: driverSession.organization_id || 'default',
        driver_id: driverSession.id,
        vehicle_id: driverSession.vehicle_id || null,
        points
      }
    });
  } catch {
    for (const p of points) await idbPush('telemetry', p).catch(() => {});
  }
}

function buildNavLinks(label, lat, lon, address) {
  const hasCoords = Number.isFinite(Number(lat)) && Number.isFinite(Number(lon)) && lat !== null && lon !== null;
  const gmaps = hasCoords
    ? `https://www.google.com/maps/dir/?api=1&destination=${lat},${lon}`
    : `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(address || '')}`;
  const waze = hasCoords
    ? `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`
    : `https://waze.com/ul?q=${encodeURIComponent(address || '')}&navigate=yes`;
  return `
    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;margin-top:4px;">
      <small style="color:var(--muted);min-width:58px;">${label}:</small>
      <a href="${gmaps}" target="_blank" rel="noopener" class="btn btn-primary btn-sm">Google Maps</a>
      <a href="${waze}" target="_blank" rel="noopener" class="btn btn-ghost btn-sm">Waze</a>
    </div>
  `;
}

// ─── CORRIDAS & FILA ABERTA ──────────────────────────────────────────────────
async function refreshOrdersAndQueue() {
  if (!driverSession) return;
  try {
    const active = await dapi(`/api/driver/orders/active?driver_id=${encodeURIComponent(driverSession.id)}`);
    activeRun = active && active.length ? active[0] : null;
    // A lista de redes muda conforme a empresa da corrida ativa.
    renderRadioChannelSelect();

    const activeEl = document.getElementById('drv-active-orders');
    activeEl.innerHTML = active.length ? active.map(o => {
      const dest0 = (o.destinations || [])[0] || {};
      const destAddr = dest0.address || (typeof dest0 === 'string' ? dest0 : '');
      return `
      <div class="order-card" style="margin-bottom:8px;">
        <div style="display:flex;justify-content:space-between;">
          <strong>${o.id}</strong>
          <span class="badge badge-em_rota">EM ROTA</span>
        </div>
        <div><strong>Origem:</strong> ${o.origin_address}</div>
        <div><strong>Destino:</strong> ${(o.destinations || []).map(d => d.address || d).join(' -> ')}</div>
        <div><strong>Valor:</strong> R$ ${Number(o.final_price).toFixed(2)} (${(o.payment_method || 'pix').toUpperCase()})</div>
        ${o.client_name ? `<div><strong>Cliente:</strong> ${o.client_name}</div>` : ''}
        ${buildNavLinks('Coleta', o.origin_lat, o.origin_lon, o.origin_address)}
        ${buildNavLinks('Entrega', dest0.lat, dest0.lon, destAddr)}
        <div class="run-actions">
          <button type="button" class="btn-run-finish" onclick="finishRun('${o.id}')">ENCERRAR CORRIDA</button>
          <button type="button" class="btn-run-photo" onclick="pickPhoto('${o.id}')">Anexar Foto (Opcional)</button>
        </div>
        <div class="run-actions-minor">
          <button class="btn btn-ghost btn-sm" onclick="markArrived('${o.id}')">Cheguei na Coleta</button>
          <button class="btn btn-danger btn-sm" onclick="reportIssue('${o.id}')">Ocorrência</button>
        </div>
      </div>
    `;
    }).join('') : '<small style="color:var(--muted);">Nenhuma corrida em andamento.</small>';

    // ─── FILA: escondida quando o motorista está OFFLINE ───
    const qEl = document.getElementById('drv-queue-list');
    if (!driverOnline) {
      qEl.innerHTML = '<small style="color:var(--muted);">Fila suspensa — você está OFFLINE. Toque em “ESTOU ONLINE” para voltar a receber corridas.</small>';
      lastQueueIds = new Set();
      return;
    }

    const queue = await dapi('/api/driver/queue');
    const newIds = new Set(queue.map(q => q.id));
    for (const id of newIds) {
      if (!lastQueueIds.has(id) && lastQueueIds.size > 0) {
        playBeep(1046, 280);
      }
    }
    lastQueueIds = newIds;

    qEl.innerHTML = queue.length ? queue.map(q => `
      <div class="order-card">
        <div style="display:flex;justify-content:space-between;">
          <strong>${q.id} · ${q.fleet_type.toUpperCase()}</strong>
          <strong style="color:#10B981;">R$ ${Number(q.final_price).toFixed(2)}</strong>
        </div>
        <div><strong>Origem:</strong> ${q.origin_address}</div>
        <div><strong>Destino:</strong> ${(q.destinations || []).map(d => d.address || d).join(' -> ')}</div>
        <button class="btn btn-primary btn-sm" onclick="acceptQueueOrder('${q.id}')">Aceitar Corrida</button>
      </div>
    `).join('') : '<small style="color:var(--muted);">Nenhuma corrida na fila aberta no momento.</small>';
  } catch {}
}

document.getElementById('btn-refresh-queue').addEventListener('click', refreshOrdersAndQueue);

window.acceptQueueOrder = async (orderId) => {
  if (!driverOnline) {
    return alert('Você está OFFLINE. Toque em “ESTOU ONLINE” para voltar a receber corridas.');
  }
  try {
    await dapi(`/api/driver/orders/${orderId}/accept`, {
      method: 'POST',
      body: { driver_id: driverSession.id, driver_name: driverSession.name, vehicle_id: driverSession.vehicle_id || null }
    });
    playBeep(880, 150);
    refreshOrdersAndQueue();
  } catch (err) {
    if (err.status === 403) {
      alert(`BLOQUEIO DVIR: ${err.message}\nFaça a vistoria na aba Vistoria antes de aceitar corridas.`);
    } else {
      alert(err.message);
    }
    refreshOrdersAndQueue();
  }
};

window.markArrived = async (orderId) => {
  await dapi(`/api/driver/orders/${orderId}/arrived`, { method: 'POST', body: {} });
  alert('Chegada na coleta registrada!');
};

// ─── ENCERRAR CORRIDA (botão grande) ─────────────────────────────────────────
// Conclui na hora com o GPS atual + nome opcional de quem recebeu.
// O status vira 'concluido' no banco → o Kanban da Central muda em tempo real.
window.finishRun = async (orderId) => {
  let recipient = '';
  try {
    const answer = prompt('Nome de quem recebeu (opcional — deixe em branco para concluir direto):', '');
    if (answer === null) return; // Cancelado: não encerra.
    recipient = String(answer).trim();
  } catch {
    recipient = '';
  }

  try {
    await dapi(`/api/driver/orders/${orderId}/complete`, {
      method: 'POST',
      body: {
        driver_id: driverSession.id,
        recipient_name: recipient || null,
        lat: currentPos.lat,
        lon: currentPos.lon,
        proof_notes: 'Corrida encerrada pelo motorista (PWA)'
      }
    });
    playBeep(1174, 200);
    alert(`Corrida ${orderId} encerrada! Status CONCLUÍDO no Kanban da Central.`);
    refreshOrdersAndQueue();
  } catch (err) {
    alert(err.message);
  }
};

// Abre a câmera do celular — SOMENTE quando o motorista toca no botão.
let pendingPhotoOrderId = null;
window.pickPhoto = (orderId) => {
  pendingPhotoOrderId = orderId;
  const input = document.getElementById('run-photo-input');
  if (!input) return;
  input.value = '';
  input.click();
};

window.completeWithoutPhoto = async (orderId) => {
  return window.finishRun(orderId);
};

window.completeWithPhoto = async (event) => {
  const file = event.target.files?.[0];
  const orderId = pendingPhotoOrderId;
  pendingPhotoOrderId = null;
  if (!file || !orderId) return;
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await dapi(`/api/driver/orders/${orderId}/complete`, {
        method: 'POST',
        body: {
          driver_id: driverSession.id,
          proof_photo_url: reader.result,
          lat: currentPos.lat,
          lon: currentPos.lon,
          proof_notes: `Corrida encerrada com foto (GPS: ${currentPos.lat}, ${currentPos.lon})`
        }
      });
      playBeep(1174, 200);
      alert(`Corrida ${orderId} encerrada com foto! Status CONCLUÍDO no Kanban da Central.`);
      refreshOrdersAndQueue();
    } catch (err) {
      alert(err.message);
    }
  };
  reader.readAsDataURL(file);
};

window.reportIssue = async (orderId) => {
  const reason = prompt('Descreva o problema / ocorrência na entrega:');
  if (!reason) return;
  await dapi(`/api/driver/orders/${orderId}/problem`, {
    method: 'POST',
    body: { driver_id: driverSession.id, reason }
  });
  refreshOrdersAndQueue();
};

// ─── SCANNER QR CODE / CÓDIGO DE BARRAS (ANDROID + SAFARI FALLBACK) ──────────
document.getElementById('btn-open-qr').addEventListener('click', async () => {
  showEl(document.getElementById('qr-modal'));
  const video = document.getElementById('qr-video');
  const resEl = document.getElementById('qr-result');
  resEl.textContent = 'Aponte a câmera para o QR Code ou código de barras...';

  try {
    qrStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
    video.srcObject = qrStream;
    await video.play();

    if ('BarcodeDetector' in window) {
      const detector = new window.BarcodeDetector({ formats: ['qr_code', 'ean_13', 'code_128'] });
      qrTimer = setInterval(async () => {
        try {
          const codes = await detector.detect(video);
          if (codes.length) {
            playBeep(1200, 150);
            resEl.textContent = `Código lido: ${codes[0].rawValue}`;
          }
        } catch {}
      }, 400);
    } else {
      // Fallback jsQR para iPhone Safari
      if (!window.jsQR) {
        const s = document.createElement('script');
        s.src = 'https://cdn.jsdelivr.net/npm/jsqr@1.4.0/dist/jsQR.min.js';
        document.head.appendChild(s);
      }
      const canvas = document.getElementById('qr-canvas');
      const ctx = canvas.getContext('2d');
      qrTimer = setInterval(() => {
        if (!window.jsQR || video.readyState !== 4) return;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const code = window.jsQR(img.data, img.width, img.height);
        if (code) {
          playBeep(1200, 150);
          resEl.textContent = `QR lido (Safari): ${code.data}`;
        }
      }, 450);
    }
  } catch (err) {
    resEl.textContent = 'Erro ao abrir câmera: ' + err.message;
  }
});

document.getElementById('btn-close-qr').addEventListener('click', () => {
  clearInterval(qrTimer);
  if (qrStream) qrStream.getTracks().forEach(t => t.stop());
  hideEl(document.getElementById('qr-modal'));
});

// ─── RÁDIO PTT MULTICANAL & OLHO VIVO (LIVEKIT) ──────────────────────────────
// Canais:
//   radio-cooperativa-geral  → Rede Geral da Cooperativa (todos + Central)
//   radio-cliente-<uuid>     → Rede da Empresa/Cliente (corrida ativa)
// O áudio local próprio é mutado no playback (track.isLocal) para não gerar eco.
function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Conecta o áudio de uma track remota/local. O próprio microfone (isLocal)
// é mutado: sem isso o motorista ouve a própria voz com atraso (eco).
function attachRadioAudio(track) {
  let el;
  try {
    el = track.attach();
  } catch {
    return null;
  }
  if (track.kind === 'audio') {
    if (track.isLocal && el) el.muted = true;
    document.body.appendChild(el);
  }
  return el;
}

async function loadRadioChannels() {
  try {
    const data = await dapi('/api/driver/radio-channels');
    radioChannelOptions = (data && data.channels) || [];
  } catch {
    radioChannelOptions = [{ id: 'general', name: 'Rede Geral da Cooperativa', room: RADIO_ROOM_GENERAL, general: true }];
  }
  try {
    const netData = await dapi('/api/session/networks');
    const nets = (netData && netData.networks) || [];
    nets.forEach(n => {
      const room = `px-${n.uuid}`;
      if (!radioChannelOptions.some(c => c.room === room)) {
        radioChannelOptions.push({ id: n.uuid, name: n.name, room });
      }
    });
  } catch {}
  renderRadioChannelSelect();
}

function renderRadioChannelSelect() {
  const sel = document.getElementById('drv-radio-channel');
  if (!sel) return;

  const activeClientUuid = activeRun && activeRun.client_user_uuid ? activeRun.client_user_uuid : null;
  const list = radioChannelOptions.slice();

  // Garante que a empresa da corrida ativa esteja na lista, mesmo se ainda
  // não for um "cliente" cadastrado (ex.: pedido interno da Central).
  if (activeClientUuid && !list.some(c => c.id === activeClientUuid)) {
    list.push({ id: activeClientUuid, name: (activeRun && activeRun.client_name) || 'Empresa da corrida', room: `radio-cliente-${activeClientUuid}` });
  }

  // Preserva o canal escolhido mesmo que ele não venha no catálogo.
  if (!list.some(c => c.room === currentRadioRoom)) {
    list.push({ id: 'atual', name: 'Canal atual', room: currentRadioRoom });
  }

  sel.innerHTML = list.map(c => {
    const label = c.general
      ? 'Rede Geral da Cooperativa'
      : `${c.name}${c.id === activeClientUuid ? ' (corrida ativa)' : ''}`;
    const selected = c.room === currentRadioRoom ? ' selected' : '';
    return `<option value="${esc(c.room)}"${selected}>${esc(label)}</option>`;
  }).join('');

  updateRadioTitle();
}

function updateRadioTitle() {
  const titleEl = document.getElementById('drv-radio-title');
  if (titleEl) titleEl.textContent = `Rádio PTT (${currentRadioRoom})`;
}

// PTT usa sempre a sala ATUAL (o lkRoom pode ter sido trocado).
const startDriverTx = async () => {
  const pttBtn = document.getElementById('drv-ptt-btn');
  const statusEl = document.getElementById('drv-ptt-status');
  const textEl = document.getElementById('drv-ptt-text');
  if (pttBtn) pttBtn.classList.add('active');
  if (statusEl) statusEl.classList.add('tx');
  if (textEl) textEl.textContent = 'TRANSMITINDO...';
  try { if (lkRoom) await lkRoom.localParticipant.setMicrophoneEnabled(true); } catch {}
};

const stopDriverTx = async () => {
  const pttBtn = document.getElementById('drv-ptt-btn');
  const statusEl = document.getElementById('drv-ptt-status');
  const textEl = document.getElementById('drv-ptt-text');
  if (pttBtn) pttBtn.classList.remove('active');
  if (statusEl) statusEl.classList.remove('tx');
  if (textEl) textEl.textContent = 'ESCUTA ATIVA';
  try { if (lkRoom) await lkRoom.localParticipant.setMicrophoneEnabled(false); } catch {}
};

async function connectRadioRoom(room) {
  const statusEl = document.getElementById('drv-ptt-status');
  const textEl = document.getElementById('drv-ptt-text');
  const identity = driverSession ? (driverSession.vehicle_id || driverSession.id) : 'motorista';

  if (lkRoom) {
    try { await lkRoom.disconnect(); } catch {}
    lkRoom = null;
  }

  try {
    const tokenEndpoint = room.startsWith('px-')
      ? `/api/network/livekit-token/${encodeURIComponent(room.slice(3))}?identity=${encodeURIComponent(identity)}&purpose=driver`
      : `/api/livekit/token?identity=${encodeURIComponent(identity)}&room=${encodeURIComponent(room)}&purpose=driver`;
    const { token, url } = await dapi(tokenEndpoint);
    if (!window.LivekitClient) { if (textEl) textEl.textContent = 'SDK LiveKit indisponível'; return; }
    lkRoom = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });

    lkRoom.on(LivekitClient.RoomEvent.DataReceived, async (payload, participant, kind, topic) => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (topic === 'network-chat' && msg.text) {
          appendDriverChatLine(msg.sender || participant?.identity || 'Rede', msg.text, false);
          return;
        }
        if (msg.action === 'stream_video') {
          const banner = document.getElementById('olho-vivo-banner');
          const vidEl = document.getElementById('drv-local-video');
          if (msg.state) {
            playBeep(660, 350);
            showEl(banner);
            showEl(vidEl);
            await lkRoom.localParticipant.setCameraEnabled(true, {
              resolution: LivekitClient.VideoPresets.h480.resolution,
              facingMode: msg.facing === 'front' ? 'user' : 'environment'
            });
          } else {
            hideEl(banner);
            hideEl(vidEl);
            await lkRoom.localParticipant.setCameraEnabled(false);
          }
        }
      } catch {}
    });

    lkRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
      attachRadioAudio(track);
    });
    lkRoom.on(LivekitClient.RoomEvent.ParticipantConnected, (p) => {
      appendDriverChatLine('Sistema', `${p.identity} entrou na rede`, true);
    });
    lkRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (p) => {
      appendDriverChatLine('Sistema', `${p.identity} ficou offline`, true);
    });

    // Publicação local (nosso próprio microfone): muta o playback para não
    // gerar eco no fone do próprio motorista.
    lkRoom.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication, track) => {
      try {
        const el = track.attach();
        if (el) el.muted = true;
      } catch {}
    });

    await lkRoom.connect(url, token);
    if (textEl) textEl.textContent = 'ESCUTA ATIVA';
    if (statusEl) statusEl.classList.remove('tx');
    loadDriverNetworkChat();
  } catch {
    if (textEl) textEl.textContent = 'Rádio offline';
  }
}

function driverActiveNetworkUuid() {
  return currentRadioRoom.startsWith('px-') ? currentRadioRoom.slice(3) : 'net_geral_00000000000000000000000001';
}

function appendDriverChatLine(sender, text, isSystem) {
  const box = document.getElementById('drv-chat-messages');
  if (!box) return;
  const row = document.createElement('div');
  row.textContent = isSystem ? text : `${sender}: ${text}`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

async function loadDriverNetworkChat() {
  const box = document.getElementById('drv-chat-messages');
  if (!box) return;
  try {
    const rows = await dapi(`/api/network/chat/${encodeURIComponent(driverActiveNetworkUuid())}`);
    box.innerHTML = '';
    (rows || []).forEach(r => appendDriverChatLine(r.sender_name || 'Operador', r.message, false));
  } catch {}
}

async function sendDriverNetworkChat() {
  const inp = document.getElementById('drv-chat-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  const sender = driverSession?.name || 'Motorista';
  appendDriverChatLine(sender, text, false);
  if (lkRoom && lkRoom.state === 'connected') {
    try {
      lkRoom.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ sender, text })),
        { reliable: true, topic: 'network-chat' }
      );
    } catch {}
  }
  try {
    await dapi(`/api/network/chat/${encodeURIComponent(driverActiveNetworkUuid())}`, {
      method: 'POST',
      body: { message: text }
    });
  } catch {}
}

document.getElementById('drv-chat-send')?.addEventListener('click', sendDriverNetworkChat);
document.getElementById('drv-chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendDriverNetworkChat(); }
});

async function initDriverLiveKit() {
  await loadRadioChannels();
  await connectRadioRoom(currentRadioRoom);

  const pttBtn = document.getElementById('drv-ptt-btn');
  if (!pttBtn || pttBtn.dataset.bound === '1') return;
  pttBtn.dataset.bound = '1';
  pttBtn.addEventListener('mousedown', startDriverTx);
  pttBtn.addEventListener('mouseup', stopDriverTx);
  pttBtn.addEventListener('touchstart', (e) => { e.preventDefault(); startDriverTx(); });
  pttBtn.addEventListener('touchend', stopDriverTx);
}

document.getElementById('drv-radio-channel').addEventListener('change', async (e) => {
  const room = e.target.value;
  if (!room || room === currentRadioRoom) return;
  currentRadioRoom = room;
  updateRadioTitle();
  await connectRadioRoom(room);
});

// ─── VISTORIA DVIR (COM FILA OFFLINE) ────────────────────────────────────────
document.getElementById('drv-dvir-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const itens = [
    { codigo: 'PNEU-01', categoria: 'Pneus', aprovado: document.getElementById('dvir-pneus').checked },
    { codigo: 'FREIO-01', categoria: 'Freios', aprovado: document.getElementById('dvir-freios').checked },
    { codigo: 'ILUM-01', categoria: 'Iluminação', aprovado: document.getElementById('dvir-luzes').checked },
    { codigo: 'DOC-01', categoria: 'Documentação', aprovado: document.getElementById('dvir-docs').checked }
  ];
  const allOk = itens.every(i => i.aprovado);
  const payload = {
    organization_id: driverSession.organization_id || 'default',
    vehicle_id: driverSession.vehicle_id || driverSession.plate || driverSession.id,
    driver_id: driverSession.id,
    driver_name: driverSession.name,
    kind: document.getElementById('dvir-kind').value,
    resultado: allOk ? 'aprovado' : 'reprovado',
    bloqueia_saida: !allOk,
    lat: currentPos.lat,
    lon: currentPos.lon,
    observacao: document.getElementById('dvir-notes').value,
    itens
  };

  const fd = new FormData();
  fd.append('organization_id', driverSession.organization_id || 'default');
  fd.append('vehicle_id', driverSession.vehicle_id || driverSession.plate || driverSession.id);
  fd.append('driver_id', driverSession.id);
  fd.append('driver_name', driverSession.name);
  fd.append('shift_type', document.getElementById('dvir-kind').value);
  fd.append('resultado', allOk ? 'aprovado' : 'reprovado');
  fd.append('bloqueia_saida', String(!allOk));
  fd.append('lat', String(currentPos.lat));
  fd.append('lon', String(currentPos.lon));
  fd.append('observacao', document.getElementById('dvir-notes').value);
  fd.append('itens', JSON.stringify(itens));
  const photoFile = document.getElementById('dvir-photo')?.files?.[0];
  if (photoFile) {
    fd.append('frente', photoFile, photoFile.name || 'vistoria.jpg');
  }

  try {
    const res = await fetch('/api/driver/dvir', {
      method: 'POST',
      headers: driverToken ? { Authorization: `Bearer ${driverToken}` } : {},
      body: fd
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Erro HTTP ${res.status}`);
    alert('Vistoria DVIR registrada com sucesso!');
    e.target.reset();
  } catch (err) {
    await idbPush('dvir', payload).catch(() => {});
    showEl(document.getElementById('dvir-offline-badge'));
    alert(`Vistoria salva na fila offline (${err.message}).`);
  }
});

// ─── MINHA CARTEIRA ──────────────────────────────────────────────────────────
async function loadDriverWallet() {
  if (!driverSession) return;
  try {
    const w = await dapi(`/api/wallet/driver/${encodeURIComponent(driverSession.id)}`);
    document.getElementById('w-disp').textContent = `R$ ${Number(w.saldo_disponivel || 0).toFixed(2)}`;
    document.getElementById('w-bloq').textContent = `R$ ${Number(w.saldo_bloqueado || 0).toFixed(2)}`;
    const list = document.getElementById('w-tx-list');
    list.innerHTML = (w.transactions || []).length ? w.transactions.map(t => `
      <div class="order-card">
        <div style="display:flex;justify-content:space-between;">
          <strong>${t.order_id || t.tipo}</strong>
          <strong style="color:${Number(t.valor) >= 0 ? '#10B981' : '#EF4444'};">R$ ${Number(t.valor).toFixed(2)}</strong>
        </div>
        <small style="color:var(--muted);">${t.descricao} · ${t.status.toUpperCase()}</small>
      </div>
    `).join('') : '<small style="color:var(--muted);">Nenhum lançamento na carteira.</small>';
  } catch {}
}
document.getElementById('btn-refresh-wallet').addEventListener('click', loadDriverWallet);

// Auto-restore
(function boot() {
  try {
    const saved = localStorage.getItem(DRV_STORAGE_KEY);
    if (saved) onDriverLogin(JSON.parse(saved));
  } catch {}
})();
