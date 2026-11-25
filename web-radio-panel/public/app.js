const TOKEN_KEY = 'hermes_admin_token';
let authToken = localStorage.getItem(TOKEN_KEY) || '';
let currentUser = null;
let DEMO_MODE = false;

let map = null;
let markersLayer = null;
let placesLayer = null;
let selectedVehicle = null;
let vehiclesCache = [];
let driversCache = [];
let ordersCache = [];

// LiveKit
let lkRoom = null;
let pttActive = false;
let currentFacing = 'back';
let cameraActive = false;

// ─── CANAIS DE RÁDIO (REDES SEPARADAS) ──────────────────────────────────────
// radio-cooperativa-geral → Rede Geral da Cooperativa (todos + Central)
// radio-cliente-<uuid>    → Rede da Empresa/Cliente
const RADIO_ROOM_GENERAL = 'radio-cooperativa-geral';
let currentRadioRoom = RADIO_ROOM_GENERAL;
let radioChannels = [];

function escHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function api(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (opts.body && typeof opts.body === 'object' && !(opts.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && !url.includes('/api/auth/')) {
    logout();
    throw new Error('Sessão expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro HTTP ${res.status}`);
  return data;
}

function showEl(el) {
  if (!el) return;
  el.hidden = false;
  el.classList.remove('is-hidden', 'hidden');
}

function hideEl(el) {
  if (!el) return;
  el.hidden = true;
  el.classList.add('is-hidden');
}

// ─── DEMO_MODE ESTRITO ──────────────────────────────────────────────────────
// O servidor publica `demo_mode` em /health. Os atalhos de demonstração
// ("Entrar como Admin Teste" / "Acesso Rápido Demo") SÓ são renderizados
// quando DEMO_MODE=true. Com DEMO_MODE=false sobra apenas o login real —
// e o backend também responde 403 em /api/auth/admin/demo(|-live).
function applyDemoMode(demoMode) {
  DEMO_MODE = !!demoMode;
  const box = document.getElementById('demo-access');
  if (box) {
    if (DEMO_MODE) showEl(box);
    else {
      // REMOVE do DOM (não só esconde): com DEMO_MODE=false os botões de
      // demonstração não são renderizados — sobra apenas o login real.
      box.remove();
    }
  }
  document.querySelectorAll('[data-demo-only]').forEach(el => {
    if (DEMO_MODE) showEl(el);
    else el.remove();
  });
}

async function loadServerFlags() {
  try {
    const res = await fetch('/health');
    const h = await res.json();
    applyDemoMode(h.demo_mode);
  } catch {
    applyDemoMode(false);
  }
}

function logout() {
  authToken = '';
  localStorage.removeItem(TOKEN_KEY);
  hideEl(document.getElementById('app-shell'));
  showEl(document.getElementById('login-screen'));
}

function updateClocks() {
  const now = new Date();
  const fmt = (tz) => new Intl.DateTimeFormat('pt-BR', {
    timeZone: tz, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).format(now);
  const elBrt = document.getElementById('clock-brt');
  const elCst = document.getElementById('clock-cst');
  if (elBrt) elBrt.textContent = fmt('America/Sao_Paulo');
  if (elCst) elCst.textContent = fmt('America/Tegucigalpa');
}
setInterval(updateClocks, 1000);
updateClocks();

// ─── LOGIN ───────────────────────────────────────────────────────────────────
document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errBox = document.getElementById('login-error');
  hideEl(errBox);
  try {
    const data = await api('/api/auth/admin/login', {
      method: 'POST',
      body: {
        identifier: document.getElementById('login-identifier').value,
        password: document.getElementById('login-password').value
      }
    });
    onLoginSuccess(data);
  } catch (err) {
    errBox.textContent = err.message;
    showEl(errBox);
  }
});

document.getElementById('btn-demo-live')?.addEventListener('click', async () => {
  const errBox = document.getElementById('login-error');
  hideEl(errBox);
  try {
    const data = await api('/api/auth/admin/demo-live', { method: 'POST', body: {} });
    onLoginSuccess(data);
  } catch (err) {
    errBox.textContent = err.message;
    showEl(errBox);
  }
});

document.getElementById('btn-demo-admin').addEventListener('click', async () => {
  const errBox = document.getElementById('login-error');
  hideEl(errBox);
  try {
    const data = await api('/api/auth/admin/demo', { method: 'POST', body: {} });
    onLoginSuccess(data);
  } catch (err) {
    errBox.textContent = err.message;
    showEl(errBox);
  }
});

document.getElementById('btn-logout').addEventListener('click', logout);

let demoRefreshTimer = null;

function onLoginSuccess(data) {
  authToken = data.token;
  currentUser = data.user;
  localStorage.setItem(TOKEN_KEY, authToken);
  const orgTag = currentUser.is_demo ? ' [DEMO VIVA]' : '';
  document.getElementById('admin-user-name').textContent = (currentUser.name || currentUser.email) + orgTag;
  const platNav = document.getElementById('nav-plataforma');
  if (platNav) {
    if (currentUser.type === 'super_admin') showEl(platNav);
    else hideEl(platNav);
  }
  hideEl(document.getElementById('login-screen'));
  showEl(document.getElementById('app-shell'));
  initApp();
  if (demoRefreshTimer) clearInterval(demoRefreshTimer);
  demoRefreshTimer = setInterval(() => {
    if (document.getElementById('tab-operacao')?.classList.contains('active')) {
      loadVehicles();
      loadStatusBar();
    }
    // Kanban em tempo real: o status CONCLUÍDO do motorista aparece aqui
    // poucos segundos depois do "Encerrar Corrida" no PWA.
    if (document.getElementById('tab-kanban')?.classList.contains('active')) {
      loadOrders();
    }
  }, currentUser.is_demo ? 4000 : 5000);
}

// ─── DRAWER MOBILE & NAVEGAÇÃO LATERAL ──────────────────────────────────────
const sidebarEl = document.getElementById('sidebar');
const overlayEl = document.getElementById('drawer-overlay');
function closeDrawer() {
  sidebarEl?.classList.remove('open');
  overlayEl?.classList.remove('open');
}
document.getElementById('mobile-menu-btn')?.addEventListener('click', () => {
  sidebarEl?.classList.toggle('open');
  overlayEl?.classList.toggle('open');
});
overlayEl?.addEventListener('click', closeDrawer);

document.querySelectorAll('.nav-item').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.nav-item').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
    btn.classList.add('active');
    const tab = btn.dataset.tab;
    const titleEl = document.getElementById('topbar-title');
    if (titleEl && btn.dataset.title) titleEl.textContent = btn.dataset.title;
    document.getElementById(`tab-${tab}`).classList.add('active');
    closeDrawer();
    if (tab === 'operacao' && map) setTimeout(() => map.invalidateSize(), 150);
    if (tab === 'kanban') loadOrders();
    if (tab === 'frota') loadFleetData();
    if (tab === 'financeiro') loadSettlements();
    if (tab === 'dvir') loadDvirAndAlerts();
    if (tab === 'clientes') loadClientsAndTariffs();
    if (tab === 'redes') loadNetworksTab();
    if (tab === 'plataforma') loadPlatformTab();
  });
});

let currentNetworkUuid = 'all';
let sessionNetworks = [];
let routeLayer = null;

// ─── INICIALIZAÇÃO ───────────────────────────────────────────────────────────
async function initApp() {
  initMap();
  await loadSessionNetworks();
  initLiveKit();
  await Promise.all([loadVehicles(), loadStatusBar(), loadPlaces(), loadDrivers(), loadOrders()]);
}

function initMap() {
  if (map) return;
  map = L.map('map').setView([-5.7945, -35.2084], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(map);
  markersLayer = L.layerGroup().addTo(map);
  placesLayer = L.layerGroup().addTo(map);
  routeLayer = L.layerGroup().addTo(map);
}

// ─── ABA 1: OPERAÇÃO AO VIVO & LIVEKIT ───────────────────────────────────────
async function loadVehicles() {
  try {
    const q = currentNetworkUuid && currentNetworkUuid !== 'all' ? `?network_uuid=${encodeURIComponent(currentNetworkUuid)}` : '';
    vehiclesCache = await api(`/api/vehicles${q}`);
    document.getElementById('veh-count').textContent = vehiclesCache.length;
    const list = document.getElementById('vehicles-list');
    list.innerHTML = '';
    if (markersLayer) markersLayer.clearLayers();

    if (!vehiclesCache.length) {
      list.innerHTML = '<small style="color:var(--muted);">Nenhum veículo cadastrado ainda. Cadastre na aba 3.</small>';
    }

    vehiclesCache.forEach(v => {
      const card = document.createElement('div');
      card.className = `veh-item ${selectedVehicle?.id === v.id ? 'selected' : ''}`;
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;font-weight:700;">
          <span>${v.plate} — ${v.model}</span>
          <span class="badge badge-${v.status === 'em_rota' ? 'em_rota' : 'pendente'}">${v.status}</span>
        </div>
        <div style="font-size:0.78rem;color:var(--muted);margin-top:4px;">
          Motorista: ${v.driver_name || 'Sem vínculo'} · ${v.fleet_type}
        </div>
      `;
      card.onclick = () => selectVehicle(v);
      list.appendChild(card);

      if (v.lat && v.lon && markersLayer) {
        const pinColor = v.status === 'em_rota' ? '#3B82F6' : (v.signal_ok === false || v.status === 'offline' ? '#64748B' : '#10B981');
        L.circleMarker([v.lat, v.lon], {
          radius: 9,
          color: '#ffffff',
          weight: 2,
          fillColor: pinColor,
          fillOpacity: 0.95
        }).addTo(markersLayer)
          .bindPopup(`<b>${v.plate}</b><br>${v.model}<br>Motorista: ${v.driver_name || '-'}<br>Status: ${v.status}`);
      }
    });
  } catch (err) {
    console.error(err);
  }
}

async function loadPlaces() {
  try {
    const places = await api('/api/places');
    if (!placesLayer) return;
    placesLayer.clearLayers();
    places.forEach(p => {
      const color = p.place_type === 'cerca' ? '#F59E0B' : '#10B981';
      L.circle([p.lat, p.lon], {
        radius: p.radius_m || 300,
        color,
        weight: 2,
        fillColor: color,
        fillOpacity: 0.14
      })
        .addTo(placesLayer)
        .bindPopup(`<b>${p.name}</b><br>Tipo: ${p.place_type} · Raio: ${p.radius_m || 300}m<br>${p.address || ''}`);
      L.circleMarker([p.lat, p.lon], {
        radius: 5,
        color,
        fillColor: color,
        fillOpacity: 1
      }).addTo(placesLayer);
    });
  } catch {}
}

function selectVehicle(v) {
  selectedVehicle = v;
  document.getElementById('vision-veh-name').textContent = `${v.plate} (${v.driver_name || v.model})`;
  document.getElementById('btn-camera-toggle').disabled = false;
  document.getElementById('btn-camera-switch').disabled = false;
  if (v.lat && v.lon && map) map.setView([v.lat, v.lon], 15);
  loadVehicles();
  drawCentralVehicleRoute(v);
}

async function drawCentralVehicleRoute(v) {
  if (!routeLayer || !map) return;
  routeLayer.clearLayers();
  const activeOrders = (ordersCache || []).filter(o =>
    (o.driver_id === v.driver_id || o.vehicle_id === v.id) &&
    ['aceito', 'coletando', 'em_rota', 'pendente'].includes(o.status)
  );
  if (!activeOrders.length) return;
  const firstOrder = activeOrders[0];
  const waypoints = [];
  if (v.lat != null && v.lon != null) waypoints.push({ lat: Number(v.lat), lon: Number(v.lon) });
  if (firstOrder.origin_lat != null && firstOrder.origin_lon != null) {
    const oLat = Number(firstOrder.origin_lat);
    const oLon = Number(firstOrder.origin_lon);
    waypoints.push({ lat: oLat, lon: oLon });
    const pickupIcon = L.divIcon({
      className: 'custom-store-icon',
      html: `<div style="background:#b91c1c;color:#fff;width:28px;height:28px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;box-shadow:0 3px 8px rgba(0,0,0,.35);">C</div>`,
      iconSize: [28, 28],
      iconAnchor: [14, 14]
    });
    L.marker([oLat, oLon], { icon: pickupIcon }).addTo(routeLayer).bindPopup(`<b>Coleta</b><br>${escHtml(firstOrder.origin_address || '')}`);
  }
  let stopNum = 0;
  activeOrders.forEach(o => {
    (o.destinations || []).forEach(d => {
      if (d && d.lat != null && d.lon != null) {
        stopNum++;
        const dLat = Number(d.lat);
        const dLon = Number(d.lon);
        waypoints.push({ lat: dLat, lon: dLon });
        const stopIcon = L.divIcon({
          className: 'custom-dest-icon',
          html: `<div style="background:#15803d;color:#fff;width:28px;height:28px;border-radius:50%;border:2px solid #fff;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:11px;box-shadow:0 3px 8px rgba(0,0,0,.35);">#${stopNum}</div>`,
          iconSize: [28, 28],
          iconAnchor: [14, 14]
        });
        L.marker([dLat, dLon], { icon: stopIcon }).addTo(routeLayer).bindPopup(`<b>Parada #${stopNum}</b><br>${escHtml(d.address || '')}`);
      }
    });
  });
  if (waypoints.length < 2) return;
  try {
    const coordsStr = waypoints.map(p => `${p.lon},${p.lat}`).join(';');
    const res = await fetch(`https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`);
    let latLngs = waypoints.map(p => [p.lat, p.lon]);
    if (res.ok) {
      const json = await res.json();
      const coords = json?.routes?.[0]?.geometry?.coordinates;
      if (Array.isArray(coords) && coords.length) latLngs = coords.map(([lon, lat]) => [lat, lon]);
    }
    L.polyline(latLngs, { color: '#0284c7', weight: 4, opacity: 0.85, dashArray: '8, 8' }).addTo(routeLayer);
    map.fitBounds(L.latLngBounds(latLngs).pad(0.2));
  } catch {}
}

async function loadRadioChannels() {
  try {
    const data = await api('/api/radio/channels');
    radioChannels = (data && data.channels) || [];
  } catch {
    radioChannels = [{ id: 'general', name: 'Rede Geral (Todos os Motoboys)', room: RADIO_ROOM_GENERAL, general: true }];
  }
  (sessionNetworks || []).forEach(n => {
    const room = `px-${n.uuid}`;
    if (!radioChannels.some(c => c.room === room)) {
      radioChannels.push({ id: n.uuid, name: n.name, room });
    }
  });
  renderRadioNetworkSelect();
}

function renderRadioNetworkSelect() {
  const sel = document.getElementById('ptt-network');
  if (!sel) return;
  const list = radioChannels.slice();
  if (!list.some(c => c.room === currentRadioRoom)) {
    list.push({ id: 'atual', name: 'Canal atual', room: currentRadioRoom });
  }
  sel.innerHTML = list.map(c => {
    const label = c.general ? 'Rede Geral (Todos os Motoboys)' : c.name;
    const selected = c.room === currentRadioRoom ? ' selected' : '';
    return `<option value="${escHtml(c.room)}"${selected}>${escHtml(label)}</option>`;
  }).join('');
  const titleEl = document.getElementById('ptt-room-title');
  if (titleEl) titleEl.textContent = `Rádio PTT (${currentRadioRoom})`;
}

// Conecta numa sala específica. O áudio LOCAL próprio é mutado no playback
// (track.isLocal) para não voltar ao fone da Central (eco).
async function connectRadioRoom(room) {
  const indicator = document.getElementById('ptt-indicator');
  const pttText = document.getElementById('ptt-text');

  if (lkRoom) {
    try { await lkRoom.disconnect(); } catch {}
    lkRoom = null;
  }

  try {
    const { token, url } = await api(`/api/livekit/token?identity=central_${encodeURIComponent(currentUser?.username || 'admin')}&room=${encodeURIComponent(room)}`);
    if (!window.LivekitClient) {
      pttText.textContent = 'SDK LiveKit indisponível';
      return;
    }
    lkRoom = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
    lkRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'video') {
        const videoEl = document.getElementById('remote-video');
        videoEl.autoplay = true;
        videoEl.playsInline = true;
        videoEl.muted = true;
        track.attach(videoEl);
        showEl(videoEl);
        hideEl(document.getElementById('video-placeholder'));
        videoEl.play?.().catch(() => {});
      } else if (track.kind === 'audio') {
        const audioEl = track.attach();
        if (track.isLocal && audioEl) audioEl.muted = true;
        document.body.appendChild(audioEl);
      }
    });
    lkRoom.on(LivekitClient.RoomEvent.TrackUnsubscribed, (track) => {
      if (track.kind === 'video') {
        const videoEl = document.getElementById('remote-video');
        try { track.detach(videoEl); } catch {}
        hideEl(videoEl);
        showEl(document.getElementById('video-placeholder'));
      }
    });
    lkRoom.on(LivekitClient.RoomEvent.DataReceived, (payload, participant, kind, topic) => {
      if (topic && topic !== 'network-chat') return;
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload));
        if (msg && msg.text) appendNetworkChatLine(msg.sender || participant?.identity || 'Rede', msg.text, false);
      } catch {}
    });
    lkRoom.on(LivekitClient.RoomEvent.ParticipantConnected, (p) => {
      appendNetworkChatLine('Sistema', `${p.identity} entrou na rede`, true);
    });
    lkRoom.on(LivekitClient.RoomEvent.ParticipantDisconnected, (p) => {
      appendNetworkChatLine('Sistema', `${p.identity} ficou offline`, true);
    });
    // Publicação local (nosso próprio microfone): muta o playback.
    lkRoom.on(LivekitClient.RoomEvent.LocalTrackPublished, (publication, track) => {
      if (track.kind !== 'audio') return;
      try {
        const el = track.attach();
        if (el) el.muted = true;
      } catch {}
    });
    await lkRoom.connect(url, token);
    pttText.textContent = 'ESCUTA ATIVA';
  } catch (err) {
    pttText.textContent = 'RÁDIO STANDBY (OFFLINE)';
  }
}

async function initLiveKit() {
  const indicator = document.getElementById('ptt-indicator');
  const pttText = document.getElementById('ptt-text');

  await loadRadioChannels();
  await connectRadioRoom(currentRadioRoom);

  const pttBtn = document.getElementById('ptt-button');
  const startTx = async () => {
    if (pttActive || !lkRoom) return;
    pttActive = true;
    pttBtn.classList.add('active');
    pttBtn.textContent = 'TRANSMITINDO...';
    indicator.classList.add('tx');
    pttText.textContent = 'TRANSMITINDO ÁUDIO';
    try { await lkRoom.localParticipant.setMicrophoneEnabled(true); } catch {}
  };
  const stopTx = async () => {
    if (!pttActive) return;
    pttActive = false;
    pttBtn.classList.remove('active');
    pttBtn.textContent = 'SEGURAR PARA FALAR';
    indicator.classList.remove('tx');
    pttText.textContent = 'ESCUTA ATIVA';
    if (lkRoom) { try { await lkRoom.localParticipant.setMicrophoneEnabled(false); } catch {} }
  };

  pttBtn.addEventListener('mousedown', startTx);
  pttBtn.addEventListener('mouseup', stopTx);
  pttBtn.addEventListener('mouseleave', stopTx);
  window.addEventListener('keydown', (e) => {
    if (e.code === 'Space' && !['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName)) {
      e.preventDefault();
      startTx();
    }
  });
  window.addEventListener('keyup', (e) => { if (e.code === 'Space') stopTx(); });

  const networkSel = document.getElementById('ptt-network');
  if (networkSel && networkSel.dataset.bound !== '1') {
    networkSel.dataset.bound = '1';
    networkSel.addEventListener('change', async (e) => {
      const room = e.target.value;
      if (!room || room === currentRadioRoom) return;
      currentRadioRoom = room;
      renderRadioNetworkSelect();
      pttActive = false;
      await connectRadioRoom(room);
    });
  }
}

function sendControlCommand(payload) {
  if (!lkRoom || lkRoom.state !== 'connected') return;
  const encoder = new TextEncoder();
  lkRoom.localParticipant.publishData(encoder.encode(JSON.stringify(payload)), { reliable: true, topic: 'fleetbase-control' });
}

document.getElementById('btn-camera-toggle').addEventListener('click', () => {
  cameraActive = !cameraActive;
  document.getElementById('btn-camera-toggle').textContent = cameraActive ? 'Desligar Câmera' : 'Ligar Câmera';
  sendControlCommand({ action: 'stream_video', state: cameraActive, facing: currentFacing });
  if (!cameraActive) {
    hideEl(document.getElementById('remote-video'));
    showEl(document.getElementById('video-placeholder'));
  }
});

document.getElementById('btn-camera-switch').addEventListener('click', () => {
  currentFacing = currentFacing === 'back' ? 'front' : 'back';
  sendControlCommand({ action: 'stream_video', state: cameraActive, facing: currentFacing });
});

// ─── ABA 2: KANBAN DE CORRIDAS ───────────────────────────────────────────────
async function loadOrders() {
  try {
    ordersCache = await api('/api/orders');
    renderKanban();
  } catch (err) {
    console.error(err);
  }
}

function renderKanban() {
  const cols = [
    { key: 'agendado', title: 'Agendados', items: ordersCache.filter(o => o.status === 'agendado') },
    { key: 'pendente', title: 'Pendentes / Fila Aberta', items: ordersCache.filter(o => o.status === 'pendente') },
    { key: 'em_rota', title: 'Em Rota', items: ordersCache.filter(o => o.status === 'em_rota') },
    { key: 'concluido', title: 'Concluídos', items: ordersCache.filter(o => o.status === 'concluido') },
    { key: 'problemas', title: 'Problemas / Cancelados', items: ordersCache.filter(o => ['problema', 'cancelado'].includes(o.status)) }
  ];

  const board = document.getElementById('kanban-board');
  board.innerHTML = '';

  cols.forEach(col => {
    const colEl = document.createElement('div');
    colEl.className = 'kanban-col';
    colEl.innerHTML = `<div class="kanban-col-header"><span>${col.title}</span><span class="col-count">${col.items.length}</span></div>`;

    col.items.forEach(o => {
      const dests = (o.destinations || []).map(d => d.address || d).join(' → ');
      const card = document.createElement('div');
      card.className = 'order-card';
      card.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <strong>${o.id}</strong>
          <span class="badge badge-${o.status}">${o.status.replace('_', ' ')}</span>
        </div>
        <div><strong>Cliente:</strong> ${o.client_name || '-'}</div>
        <div><strong>Frota:</strong> ${o.fleet_type} · <strong>R$ ${Number(o.final_price).toFixed(2)}</strong> · ${(o.payment_method || 'pix').toUpperCase()}</div>
        ${o.cargo_type ? `<div style="color:var(--muted);"><strong>Carga:</strong> ${o.cargo_type} (${o.cargo_weight_kg || '-'} kg)</div>` : ''}
        <div style="color:var(--muted);"><strong>Origem:</strong> ${o.origin_address}</div>
        <div style="color:var(--muted);"><strong>Destino:</strong> ${dests}</div>
        ${o.driver_name ? `<div><strong>Motorista:</strong> ${o.driver_name}</div>` : ''}
        ${o.queue_mode === 'fila_aberta' && o.status === 'pendente' ? '<small style="color:#fcd34d;">📢 Na Fila Aberta da Cooperativa</small>' : ''}
        ${o.problem_reason ? `<div style="color:#fca5a5;"><strong>Motivo:</strong> ${o.problem_reason}</div>` : ''}
        <div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:4px;">
          ${['agendado', 'pendente'].includes(o.status) ? `<button class="btn btn-primary btn-sm" onclick="openAssignModal('${o.id}')">Atribuir</button>` : ''}
          ${['agendado', 'pendente'].includes(o.status) ? `<button class="btn btn-warning btn-sm" onclick="releaseQueue('${o.id}')">Fila Aberta</button>` : ''}
          ${o.status === 'em_rota' ? `<button class="btn btn-success btn-sm" onclick="completeOrder('${o.id}')">Concluir</button>` : ''}
          ${!['concluido', 'cancelado'].includes(o.status) ? `<button class="btn btn-danger btn-sm" onclick="reportProblem('${o.id}')">Problema</button>` : ''}
          ${!['concluido', 'cancelado'].includes(o.status) ? `<button class="btn btn-secondary btn-sm" onclick="cancelOrder('${o.id}')">Cancelar</button>` : ''}
        </div>
      `;
      colEl.appendChild(card);
    });

    board.appendChild(colEl);
  });
}

document.getElementById('btn-refresh-kanban').addEventListener('click', loadOrders);

window.openAssignModal = async (orderId) => {
  await loadDrivers();
  const body = document.getElementById('modal-body');
  document.getElementById('modal-title').textContent = `Atribuir Motorista — ${orderId}`;
  const opts = driversCache.map(d => `<option value="${d.id}">${d.name} (${d.plate} - ${d.fleet_type})</option>`).join('');
  body.innerHTML = `
    <div class="form-group">
      <label>Selecione o Motorista</label>
      <select id="assign-driver-select" class="form-control">${opts || '<option value="">Cadastre um motorista na aba 3</option>'}</select>
    </div>
    <div style="display:flex;gap:8px;justify-content:flex-end;">
      <button class="btn btn-secondary" onclick="closeModal()">Fechar</button>
      <button class="btn btn-primary" onclick="confirmAssign('${orderId}')">Confirmar Despacho</button>
    </div>
  `;
  showEl(document.getElementById('modal-backdrop'));
};

window.confirmAssign = async (orderId) => {
  const driver_id = document.getElementById('assign-driver-select').value;
  if (!driver_id) return alert('Selecione um motorista.');
  await api(`/api/orders/${orderId}/assign`, { method: 'POST', body: { driver_id } });
  closeModal();
  loadOrders();
};

window.releaseQueue = async (orderId) => {
  await api(`/api/orders/${orderId}/release-queue`, { method: 'POST', body: {} });
  loadOrders();
};

window.completeOrder = async (orderId) => {
  await api(`/api/orders/${orderId}/complete`, { method: 'POST', body: { proof_notes: 'Concluído pela Central' } });
  loadOrders();
};

window.reportProblem = async (orderId) => {
  const reason = prompt('Descreva o motivo da ocorrência/problema:');
  if (!reason) return;
  await api(`/api/orders/${orderId}/problem`, { method: 'POST', body: { reason } });
  loadOrders();
};

window.cancelOrder = async (orderId) => {
  if (!confirm(`Cancelar a corrida ${orderId}?`)) return;
  await api(`/api/orders/${orderId}/cancel`, { method: 'POST', body: { reason: 'Cancelado pela Central' } });
  loadOrders();
};

window.closeModal = () => hideEl(document.getElementById('modal-backdrop'));

document.getElementById('btn-new-order-admin').addEventListener('click', () => {
  document.getElementById('modal-title').textContent = 'Nova Corrida pela Central';
  document.getElementById('modal-body').innerHTML = `
    <form id="admin-new-order-form" style="display:flex;flex-direction:column;gap:10px;">
      <select name="fleet_type" class="form-control">
        <option value="moto">Moto / Mototáxi</option>
        <option value="utilitario">Utilitário / Fiorino</option>
        <option value="bau">Caminhão Baú</option>
        <option value="carreta">Carreta Pesada</option>
      </select>
      <div style="display:grid;grid-template-columns:1fr 95px;gap:6px;">
        <input type="text" name="origin_address" id="modal-origin-input" list="modal-origin-datalist" class="form-control" placeholder="Rua / Av. de Origem" autocomplete="off" required />
        <input type="text" name="origin_number" id="modal-origin-number" class="form-control" placeholder="Nº" />
      </div>
      <datalist id="modal-origin-datalist"></datalist>
      <div id="modal-origin-precision" style="font-size:0.72rem;color:var(--muted);"></div>
      <div style="display:grid;grid-template-columns:1fr 95px;gap:6px;">
        <input type="text" name="dest_address" id="modal-dest-input" list="modal-dest-datalist" class="form-control" placeholder="Rua / Av. de Destino" autocomplete="off" required />
        <input type="text" name="dest_number" id="modal-dest-number" class="form-control" placeholder="Nº" />
      </div>
      <datalist id="modal-dest-datalist"></datalist>
      <div id="modal-dest-precision" style="font-size:0.72rem;color:var(--muted);"></div>
      <input type="number" name="distance_km" class="form-control" value="8" placeholder="Distância estimada (km)" />
      <input type="text" name="recipient_name" class="form-control" placeholder="Nome do Destinatário" />
      <input type="text" name="recipient_whatsapp" class="form-control" placeholder="WhatsApp Destinatário" />
      <div style="display:flex;gap:8px;justify-content:flex-end;">
        <button type="button" class="btn btn-ghost" onclick="closeModal()">Cancelar</button>
        <button type="submit" class="btn btn-primary">Criar Corrida</button>
      </div>
    </form>
  `;
  showEl(document.getElementById('modal-backdrop'));
  bindAddressAutocomplete('modal-origin-input', 'modal-origin-datalist', 'modal-origin-number', 'modal-origin-precision');
  bindAddressAutocomplete('modal-dest-input', 'modal-dest-datalist', 'modal-dest-number', 'modal-dest-precision');
  document.getElementById('admin-new-order-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const oInp = document.getElementById('modal-origin-input');
    const dInp = document.getElementById('modal-dest-input');
    const oNum = String(fd.get('origin_number') || '').trim();
    const dNum = String(fd.get('dest_number') || '').trim();
    const oAddr = oNum && !String(fd.get('origin_address')).includes(oNum) ? `${fd.get('origin_address')}, ${oNum}` : fd.get('origin_address');
    const dAddr = dNum && !String(fd.get('dest_address')).includes(dNum) ? `${fd.get('dest_address')}, ${dNum}` : fd.get('dest_address');
    await api('/api/orders', {
      method: 'POST',
      body: {
        fleet_type: fd.get('fleet_type'),
        origin_address: oAddr,
        origin_lat: oInp?.dataset.lat ? Number(oInp.dataset.lat) : null,
        origin_lon: oInp?.dataset.lon ? Number(oInp.dataset.lon) : null,
        destinations: [{
          address: dAddr,
          lat: dInp?.dataset.lat ? Number(dInp.dataset.lat) : null,
          lon: dInp?.dataset.lon ? Number(dInp.dataset.lon) : null
        }],
        distance_km: Number(fd.get('distance_km') || 8),
        recipient_name: fd.get('recipient_name'),
        recipient_whatsapp: fd.get('recipient_whatsapp')
      }
    });
    closeModal();
    loadOrders();
  };
});

// ─── ABA 3: FROTA, MOTORISTAS & PONTOS ───────────────────────────────────────
async function loadDrivers() {
  driversCache = await api('/api/drivers');
  const sel = document.getElementById('vehicle-driver-select');
  if (sel) {
    sel.innerHTML = '<option value="">Sem motorista vinculado</option>' +
      driversCache.map(d => `<option value="${d.id}">${d.name} (${d.plate})</option>`).join('');
  }
  const list = document.getElementById('drivers-list');
  if (list) {
    list.innerHTML = driversCache.map(d => `
      <div class="order-card">
        <div style="display:flex;justify-content:space-between;">
          <strong>${d.name}</strong>
          <button class="btn btn-sm ${d.online ? 'btn-success' : 'btn-secondary'}" onclick="toggleDriverOnline('${d.id}', ${!d.online})">
            ${d.online ? 'Online' : 'Offline'}
          </button>
        </div>
        <small style="color:var(--muted);">WhatsApp: ${d.whatsapp} · Placa: ${d.plate} · Comissão: ${d.commission_pct}%</small>
      </div>
    `).join('');
  }
}

window.toggleDriverOnline = async (id, online) => {
  await api(`/api/drivers/${id}`, { method: 'PATCH', body: { online } });
  loadDrivers();
};

async function loadFleetData() {
  await loadDrivers();
  const vehicles = await api('/api/vehicles');
  document.getElementById('fleet-vehicles-list').innerHTML = vehicles.map(v => `
    <div class="order-card">
      <strong>${v.plate} — ${v.model}</strong>
      <small style="color:var(--muted);">Frota: ${v.fleet_type} · Motorista: ${v.driver_name || 'Livre'}</small>
    </div>
  `).join('');

  const places = await api('/api/places');
  document.getElementById('places-list').innerHTML = places.map(p => `
    <div class="order-card">
      <strong>📍 ${p.name} (${p.place_type})</strong>
      <small style="color:var(--muted);">${p.address || ''} · Raio: ${p.radius_m}m</small>
    </div>
  `).join('');
}

document.getElementById('form-driver').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/drivers', {
    method: 'POST',
    body: {
      name: fd.get('name'), whatsapp: fd.get('whatsapp'), plate: fd.get('plate'),
      pix_key: fd.get('pix_key') || null,
      commission_pct: Number(fd.get('commission_pct')), fleet_type: fd.get('fleet_type'), online: true
    }
  });
  e.target.reset();
  loadFleetData();
});

document.getElementById('form-vehicle').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/vehicles', {
    method: 'POST',
    body: { plate: fd.get('plate'), model: fd.get('model'), fleet_type: fd.get('fleet_type'), driver_id: fd.get('driver_id') || null }
  });
  e.target.reset();
  loadFleetData();
  loadVehicles();
});

document.getElementById('form-place').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/places', {
    method: 'POST',
    body: {
      name: fd.get('name'), address: fd.get('address'),
      lat: Number(fd.get('lat')), lon: Number(fd.get('lon')),
      place_type: fd.get('place_type'), radius_m: Number(fd.get('radius_m') || 300)
    }
  });
  e.target.reset();
  loadFleetData();
  loadPlaces();
});

// ─── ABA 4: ACERTO FINANCEIRO, SPLIT & CARTEIRA ──────────────────────────────
async function loadSettlements() {
  await loadDrivers();
  const adjSel = document.getElementById('adj-driver-select');
  const splitSel = document.getElementById('split-driver-select');
  const drvOpts = driversCache.map(d => `<option value="${d.id}">${d.name} (${d.plate})</option>`).join('');
  if (adjSel) adjSel.innerHTML = drvOpts || '<option value="">Sem motoristas</option>';
  if (splitSel) splitSel.innerHTML = '<option value="">Regra Geral da Organização</option>' + drvOpts;

  const summary = await api('/api/wallet/summary');
  const wBody = document.getElementById('wallet-summary-body');
  if (wBody) {
    wBody.innerHTML = summary.length ? summary.map(d => `
      <tr>
        <td><input type="checkbox" class="wallet-drv-chk" value="${d.id}" ${d.saldo_disponivel > 0 ? 'checked' : ''} /></td>
        <td><strong>${d.name}</strong><br><small style="color:var(--muted);">${d.plate}</small></td>
        <td>${d.pix_key || '<span style="color:var(--muted);">Não cadastrada</span>'}</td>
        <td style="color:var(--success);font-weight:700;">R$ ${Number(d.saldo_disponivel).toFixed(2)}</td>
        <td style="color:#FCD34D;">R$ ${Number(d.saldo_bloqueado).toFixed(2)}</td>
        <td style="color:var(--muted);">R$ ${Number(d.saldo_pago).toFixed(2)}</td>
      </tr>
    `).join('') : '<tr><td colspan="6" style="color:var(--muted);">Nenhum cooperado cadastrado.</td></tr>';
  }

  const batches = await api('/api/wallet/batches').catch(() => []);
  const bBody = document.getElementById('wallet-batches-body');
  if (bBody) {
    bBody.innerHTML = batches.length ? batches.map(b => `
      <tr>
        <td><strong>${b.id}</strong></td>
        <td>${b.drivers_count}</td>
        <td><strong>R$ ${Number(b.total_amount).toFixed(2)}</strong></td>
        <td><span class="badge badge-${b.status === 'pago' ? 'concluido' : 'pendente'}">${b.status}</span></td>
        <td>${b.status === 'pago' ? 'Liquidado' : `<button class="btn btn-success btn-sm" onclick="payBatch('${b.id}')">Dar Baixa (Pix)</button>`}</td>
      </tr>
    `).join('') : '<tr><td colspan="5" style="color:var(--muted);">Nenhum lote gerado ainda.</td></tr>';
  }

  const start = document.getElementById('fin-start').value;
  const end = document.getElementById('fin-end').value;
  const qs = new URLSearchParams();
  if (start) qs.set('start', start);
  if (end) qs.set('end', end);

  const preview = await api(`/api/settlements/preview?${qs.toString()}`);
  document.getElementById('settlement-preview-body').innerHTML = preview.length ? preview.map(r => `
    <tr>
      <td>${r.driver_name || r.driver_id}</td>
      <td>${r.total_deliveries}</td>
      <td>R$ ${r.gross_amount.toFixed(2)}</td>
      <td>R$ ${r.coop_fee_amount.toFixed(2)}</td>
      <td><strong>R$ ${r.net_amount.toFixed(2)}</strong></td>
      <td><button class="btn btn-success btn-sm" onclick="closeSettlement('${r.driver_id}')">Fechar Acerto</button></td>
    </tr>
  `).join('') : '<tr><td colspan="6" style="color:var(--muted);">Nenhuma entrega pendente de acerto.</td></tr>';

  const history = await api('/api/settlements');
  document.getElementById('settlement-history-body').innerHTML = history.length ? history.map(s => `
    <tr>
      <td>${s.driver_name}</td>
      <td>${String(s.period_start).slice(0,10)} a ${String(s.period_end).slice(0,10)}</td>
      <td>${s.total_deliveries}</td>
      <td>R$ ${Number(s.gross_amount).toFixed(2)}</td>
      <td><strong>R$ ${Number(s.net_amount).toFixed(2)}</strong></td>
    </tr>
  `).join('') : '<tr><td colspan="5" style="color:var(--muted);">Nenhum acerto fechado ainda.</td></tr>';
}

document.getElementById('btn-generate-batch')?.addEventListener('click', async () => {
  const checked = Array.from(document.querySelectorAll('.wallet-drv-chk:checked')).map(el => el.value);
  try {
    const batch = await api('/api/wallet/batches', { method: 'POST', body: { driver_ids: checked } });
    alert(`Lote ${batch.id} gerado no valor de R$ ${Number(batch.total_amount).toFixed(2)}.`);
    loadSettlements();
  } catch (err) {
    alert(err.message);
  }
});

window.payBatch = async (id) => {
  if (!confirm(`Confirmar pagamento Pix e dar baixa no lote ${id}?`)) return;
  await api(`/api/wallet/batches/${id}/pay`, { method: 'POST', body: {} });
  loadSettlements();
};

document.getElementById('form-wallet-adj')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/wallet/adjustments', {
      method: 'POST',
      body: {
        driver_id: fd.get('driver_id'),
        tipo: fd.get('tipo'),
        valor: Number(fd.get('valor')),
        descricao: fd.get('descricao')
      }
    });
    e.target.reset();
    loadSettlements();
  } catch (err) {
    alert(err.message);
  }
});

document.getElementById('form-split-rule')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/split-rules', {
    method: 'PUT',
    body: {
      driver_id: fd.get('driver_id') || null,
      split_type: fd.get('split_type'),
      coop_value: Number(fd.get('coop_value')),
      extras_to_driver_100: Boolean(fd.get('extras_to_driver_100'))
    }
  });
  alert('Regra de Split salva com sucesso!');
});

window.closeSettlement = async (driverId) => {
  const start = document.getElementById('fin-start').value || undefined;
  const end = document.getElementById('fin-end').value || undefined;
  await api('/api/settlements/close', { method: 'POST', body: { driver_id: driverId, start, end } });
  loadSettlements();
};

document.getElementById('btn-load-settlements').addEventListener('click', loadSettlements);

// ─── ABA 5: DVIR & ALERTAS ───────────────────────────────────────────────────
// ── GALERIA COMPARATIVA (entrada x saída) ───────────────────────────────────
const DVIR_SLOTS = ['frente', 'lateral_esquerda', 'lateral_direita', 'pneus', 'velocimetro', 'avaria'];
const DVIR_SLOT_LABEL = {
  frente: 'Frente',
  lateral_esquerda: 'Lateral Esq.',
  lateral_direita: 'Lateral Dir.',
  pneus: 'Pneus',
  velocimetro: 'Velocímetro (KM)',
  avaria: 'Avarias'
};
let dvirFilter = 'all';

function dvirFilterQuery() {
  const p = new URLSearchParams();
  if (dvirFilter === 'entrada') p.set('shift_type', 'entrada');
  else if (dvirFilter === 'saida') p.set('shift_type', 'saida');
  else if (dvirFilter === 'dano') p.set('has_damage', '1');
  else if (dvirFilter === 'duplicada') p.set('duplicate', '1');
  else if (dvirFilter === 'reprovado') p.set('status', 'reprovado');
  return p.toString();
}

function dvirFmtDate(value) {
  if (!value) return '-';
  const d = new Date(value);
  if (isNaN(d.getTime())) return String(value);
  return d.toLocaleString('pt-BR');
}

async function loadDvirGallery() {
  const box = document.getElementById('dvir-gallery');
  if (!box) return;
  let items = [];
  try {
    items = await api(`/api/dvir/inspections?${dvirFilterQuery()}`);
  } catch (err) {
    box.innerHTML = `<small style="color:var(--muted);">Erro ao carregar vistorias: ${err.message}</small>`;
    return;
  }
  if (!items.length) {
    box.innerHTML = '<small style="color:var(--muted);">Nenhuma vistoria encontrada com este filtro.</small>';
    return;
  }
  box.innerHTML = items.map(i => {
    const photos = i.photos || [];
    const dup = photos.some(p => p.is_duplicate_hash);
    const cls = i.status === 'reprovado' ? 'is-reprovado' : (dup ? 'is-duplicada' : '');
    const badge = i.status === 'reprovado' ? 'badge-problema'
      : i.status === 'aprovado' ? 'badge-concluido' : 'badge-pendente';
    const shift = i.shift_type === 'entrada' ? 'Entrada / Início Turno' : 'Saída / Fim Turno';
    return `<div class="dvir-card ${cls}">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;">
        <strong style="font-size:0.85rem;">${i.vehicle_id}</strong>
        <span class="badge ${badge}">${i.status}</span>
      </div>
      <small style="color:var(--muted);">${shift}</small>
      <small style="color:var(--muted);">${i.odometer_km ?? '-'} km · ${dvirFmtDate(i.server_recorded_at)}</small>
      <small style="color:var(--muted);">${photos.length} foto(s)</small>
      ${dup ? '<div class="dvir-warn">⚠ Foto duplicada — hash repetido na organização</div>' : ''}
      ${i.has_damage ? '<div class="dvir-alert">Avaria registrada</div>' : ''}
      <button type="button" class="btn btn-primary btn-sm" onclick="openDvirComparison('${i.id}')">Comparar Antes/Depois</button>
    </div>`;
  }).join('');
}

document.getElementById('dvir-filters')?.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-dvir-filter]');
  if (!btn) return;
  dvirFilter = btn.dataset.dvirFilter;
  document.querySelectorAll('#dvir-filters [data-dvir-filter]').forEach(b => {
    b.classList.toggle('is-active', b === btn);
  });
  loadDvirGallery();
});

/** Carrega imagem autenticada (o /api/dvir/photos/:id exige Bearer). */
async function authedImg(url) {
  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${authToken}` } });
    if (!res.ok) return null;
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}

function dvirSideHtml(side, label) {
  if (!side) {
    return `<div class="dvir-side"><h4>${label}</h4>
      <div class="dvir-slot-empty">Sem vistoria pareada para este turno</div></div>`;
  }
  const photos = side.photos || [];
  const bySlot = {};
  photos.forEach(p => { bySlot[p.slot_name] = p; });
  const rows = DVIR_SLOTS.map(slot => {
    const p = bySlot[slot];
    const dup = p && p.is_duplicate_hash;
    return `<div class="dvir-slot">
      <div>
        <strong style="font-size:0.72rem;">${DVIR_SLOT_LABEL[slot] || slot}</strong>
        ${dup ? '<div class="dvir-warn" style="margin-top:4px;">⚠ hash repetido</div>' : ''}
        ${p ? `<small style="color:var(--muted);font-size:0.65rem;">${(p.file_size_bytes / 1024).toFixed(0)} KB</small>` : ''}
      </div>
      <div data-slot-img="${side.insp.id}|${slot}" data-src="${p ? p.url : ''}">
        ${p ? '<small style="color:var(--muted);">carregando…</small>' : '<div class="dvir-slot-empty">sem foto</div>'}
      </div>
    </div>`;
  }).join('');

  return `<div class="dvir-side">
    <h4>${label} · ${side.insp.vehicle_id} · ${side.insp.odometer_km ?? '-'} km</h4>
    <small style="color:var(--muted);">${dvirFmtDate(side.insp.server_recorded_at)} · status ${side.insp.status}</small>
    <div style="margin-top:8px;">${rows}</div>
  </div>`;
}

window.openDvirComparison = async (id) => {
  let data;
  try {
    data = await api(`/api/dvir/inspections/${id}/pair`);
  } catch (err) {
    alert(`Erro ao abrir a comparação: ${err.message}`);
    return;
  }
  const cur = data.inspection;
  const curPhotos = data.photos || [];
  const pair = data.paired;
  const pairPhotos = (pair && pair.photos) || [];

  let left = null;   // ENTRADA
  let right = null;  // SAÍDA
  if (cur.shift_type === 'entrada') {
    left = { insp: cur, photos: curPhotos };
    right = pair ? { insp: pair, photos: pairPhotos } : null;
  } else {
    left = pair ? { insp: pair, photos: pairPhotos } : null;
    right = { insp: cur, photos: curPhotos };
  }

  const kmDiff = data.km_diff === null || data.km_diff === undefined ? null : Math.abs(Number(data.km_diff));
  const dupAny = [...curPhotos, ...pairPhotos].some(p => p.is_duplicate_hash);

  document.getElementById('modal-title').textContent = `Vistoria Comparativa — ${cur.vehicle_id}`;
  document.getElementById('modal-body').innerHTML = `
    ${dupAny ? '<div class="dvir-alert">🚨 Hash repetido detectado nesta vistoria — possível reuso indevido de foto (alerta de fraude).</div>' : ''}
    ${kmDiff !== null ? `<div class="dvir-warn">Diferença de quilometragem entre entrada e saída: <strong>${kmDiff.toFixed(2)} km</strong></div>` : ''}
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-top:10px;">
      ${dvirSideHtml(left, 'ENTRADA / Início Turno')}
      ${dvirSideHtml(right, 'SAÍDA / Fim Turno')}
    </div>
    <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
      <button type="button" class="btn btn-success btn-sm" onclick="reviewDvir('${cur.id}','liberar')">Aprovar Liberação</button>
      <button type="button" class="btn btn-danger btn-sm" onclick="reviewDvir('${cur.id}','bloquear')">Bloquear Veículo</button>
      <button type="button" class="btn btn-ghost btn-sm" onclick="closeModal()">Fechar</button>
    </div>`;

  const box = document.getElementById('modal-box');
  if (box) box.classList.add('is-wide');
  showEl(document.getElementById('modal-backdrop'));

  // carrega as fotos autenticadas (fora do <img src> para levar o Bearer)
  document.querySelectorAll('[data-slot-img]').forEach(async holder => {
    const src = holder.getAttribute('data-src');
    if (!src) return;
    const objUrl = await authedImg(src);
    if (objUrl) holder.innerHTML = `<img src="${objUrl}" alt="foto da vistoria" />`;
    else holder.innerHTML = '<div class="dvir-slot-empty">sem acesso à foto</div>';
  });
};

window.reviewDvir = async (id, action) => {
  const notes = action === 'bloquear'
    ? prompt('Motivo do bloqueio do veículo:')
    : prompt('Observação da liberação (opcional):');
  if (action === 'bloquear' && (notes === null || !String(notes).trim())) return;
  try {
    const res = await api(`/api/dvir/inspections/${id}/review`, {
      method: 'POST',
      body: { action, notes: notes || '' }
    });
    alert(action === 'bloquear'
      ? `Veículo bloqueado (${res.vehicle_blocked ? 'confirmado' : 'sem veículo vinculado'}).`
      : 'Vistoria aprovada e veículo liberado.');
  } catch (err) {
    alert(`Falha na revisão: ${err.message}`);
    return;
  }
  const box = document.getElementById('modal-box');
  if (box) box.classList.remove('is-wide');
  closeModal();
  loadDvirGallery();
  loadDvirAndAlerts();
};

async function loadDvirAndAlerts() {
  let dvirs = [];
  try {
    dvirs = await api('/api/dvir');
  } catch {
    dvirs = [];
  }
  document.getElementById('dvir-list').innerHTML = dvirs.length ? dvirs.map(d => `
    <div class="order-card">
      <div style="display:flex;justify-content:space-between;">
        <strong>Veículo: ${d.vehicle_id}</strong>
        <span class="badge badge-${d.result === 'reprovado' ? 'problema' : 'concluido'}">${d.result}</span>
      </div>
      <small style="color:var(--muted);">Motorista: ${d.driver_name || d.driver_id || '-'}</small>
    </div>
  `).join('') : '<small style="color:var(--muted);">Nenhuma vistoria DVIR registrada.</small>';

  const alerts = await api('/api/alerts');
  document.getElementById('alerts-list').innerHTML = alerts.length ? alerts.map(a => `
    <div class="order-card">
      <div style="display:flex;justify-content:space-between;">
        <strong>${a.alert_type.toUpperCase()}</strong>
        ${a.acknowledged ? '<span class="badge badge-concluido">OK</span>' : `<button class="btn btn-warning btn-sm" onclick="ackAlert('${a.id}')">Reconhecer</button>`}
      </div>
      <div>${a.message}</div>
    </div>
  `).join('') : '<small style="color:var(--muted);">Nenhum alerta operacional ativo.</small>';

  await loadDvirGallery();
}

window.ackAlert = async (id) => {
  await api(`/api/alerts/${id}/ack`, { method: 'PATCH', body: {} });
  loadDvirAndAlerts();
};

// ─── ABA 6: CLIENTES & TABELA DE PREÇOS ──────────────────────────────────────
async function loadClientsAndTariffs() {
  const clients = await api('/api/clients');
  document.getElementById('clients-list').innerHTML = clients.map(c => `
    <div class="order-card">
      <strong>${c.name}</strong>
      <small style="color:var(--muted);">Usuário: ${c.username} · WhatsApp: ${c.phone || '-'} · Doc: ${c.meta?.cpf_cnpj || '-'}</small>
    </div>
  `).join('');

  const tariffs = await api('/api/tariffs');
  document.getElementById('tariffs-list').innerHTML = tariffs.map(t => `
    <div class="order-card" style="gap:8px;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <strong>${t.label} (${t.fleet_type})</strong>
        <label style="display:flex;align-items:center;gap:6px;font-size:0.78rem;cursor:pointer;">
          <input type="checkbox" id="noturno-ativo-${t.fleet_type}" ${t.adicional_noturno_ativo ? 'checked' : ''} /> Adicional Noturno/Clima Ativo
        </label>
      </div>
      <div class="grid-3" style="gap:6px;">
        <div>
          <small style="color:var(--muted);">Taxa Base (R$)</small>
          <input type="number" step="0.01" id="base-${t.fleet_type}" class="form-control" value="${t.base_fee}" />
        </div>
        <div>
          <small style="color:var(--muted);">Km Franquia</small>
          <input type="number" step="0.1" id="franquia-${t.fleet_type}" class="form-control" value="${t.km_franquia ?? 3}" />
        </div>
        <div>
          <small style="color:var(--muted);">R$/km Excedente</small>
          <input type="number" step="0.01" id="km-${t.fleet_type}" class="form-control" value="${t.per_km_fee}" />
        </div>
      </div>
      <div class="grid-3" style="gap:6px;">
        <div>
          <small style="color:var(--muted);">Adic. Retorno (R$)</small>
          <input type="number" step="0.01" id="retorno-${t.fleet_type}" class="form-control" value="${t.adicional_retorno ?? 0}" />
        </div>
        <div>
          <small style="color:var(--muted);">Adic. Parada Extra (R$)</small>
          <input type="number" step="0.01" id="parada-${t.fleet_type}" class="form-control" value="${t.adicional_parada_extra ?? 5}" />
        </div>
        <div>
          <small style="color:var(--muted);">Adic. Noturno/Clima (R$)</small>
          <input type="number" step="0.01" id="noturno-${t.fleet_type}" class="form-control" value="${t.adicional_noturno_ou_clima ?? 0}" />
        </div>
      </div>
      <div style="display:flex;justify-content:flex-end;">
        <button class="btn btn-primary btn-sm" onclick="saveTariff('${t.fleet_type}')">Salvar Regra</button>
      </div>
    </div>
  `).join('');
}

window.saveTariff = async (fleetType) => {
  await api(`/api/tariffs/${fleetType}`, {
    method: 'PUT',
    body: {
      base_fee: Number(document.getElementById(`base-${fleetType}`).value),
      km_franquia: Number(document.getElementById(`franquia-${fleetType}`).value),
      per_km_fee: Number(document.getElementById(`km-${fleetType}`).value),
      adicional_retorno: Number(document.getElementById(`retorno-${fleetType}`).value),
      adicional_parada_extra: Number(document.getElementById(`parada-${fleetType}`).value),
      adicional_noturno_ou_clima: Number(document.getElementById(`noturno-${fleetType}`).value),
      adicional_noturno_ativo: document.getElementById(`noturno-ativo-${fleetType}`).checked
    }
  });
  alert('Tarifa atualizada!');
};

document.getElementById('form-client').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/clients', {
    method: 'POST',
    body: { name: fd.get('name'), whatsapp: fd.get('whatsapp'), cpf_cnpj: fd.get('cpf_cnpj'), username: fd.get('username'), password: fd.get('password') }
  });
  e.target.reset();
  loadClientsAndTariffs();
});

// Auto-restore session
(async function boot() {
  await loadServerFlags();
  if (!authToken) return;
  try {
    const parts = authToken.split('.');
    if (parts.length === 3) {
      const payload = JSON.parse(atob(parts[1]));
      if (payload.exp && payload.exp * 1000 <= Date.now()) {
        logout();
        return;
      }
    }
    const { user } = await api('/api/auth/me');
    if (user && ['super_admin', 'admin', 'staff', 'user'].includes(user.type)) {
      onLoginSuccess({ token: authToken, user });
    } else {
      logout();
    }
  } catch {
    logout();
  }
})();

// ─── MULTI-REDE, STATUS BAR, CHAT, AUTOCOMPLETE & SUPER-ADMIN ────────────────
function bindAddressAutocomplete(inputId, listId, numberId, precisionId) {
  const inp = document.getElementById(inputId);
  const dl = document.getElementById(listId);
  const numInp = numberId ? document.getElementById(numberId) : null;
  const precEl = precisionId ? document.getElementById(precisionId) : null;
  if (!inp || !dl) return;
  let timer = null;
  let lastItems = [];

  const runSearch = async () => {
    const q = inp.value.trim();
    const num = numInp ? numInp.value.trim() : '';
    if (q.length < 3) return;
    try {
      const qs = new URLSearchParams({ q });
      if (num) qs.set('number', num);
      const items = await api(`/api/geo/search?${qs.toString()}`);
      lastItems = items || [];
      dl.innerHTML = lastItems.slice(0, 6).map(i => `<option value="${escHtml(i.label || i.address || '')}">`).join('');
      const match = lastItems.find(i => i.label === q) || lastItems[0];
      if (match && match.lat != null && match.lon != null) {
        inp.dataset.lat = String(match.lat);
        inp.dataset.lon = String(match.lon);
        if (precEl) {
          const isExact = match.precision === 'exact';
          precEl.innerHTML = isExact
            ? '<span style="color:#10B981;font-weight:700;">● Número exato localizado</span>'
            : '<span style="color:#F59E0B;">● Aproximado na quadra (ajuste o número se necessário)</span>';
        }
      }
    } catch {}
  };

  inp.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(runSearch, 300);
  });
  inp.addEventListener('change', runSearch);
  if (numInp) {
    numInp.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(runSearch, 350);
    });
  }
}

async function loadSessionNetworks() {
  try {
    const data = await api('/api/session/networks');
    sessionNetworks = data.networks || [];
    const mapSel = document.getElementById('map-network-selector');
    if (mapSel) {
      mapSel.innerHTML = '<option value="all">Todas as Redes / Enxames</option>' +
        sessionNetworks.map(n => `<option value="${escHtml(n.uuid)}">${escHtml(n.name)}</option>`).join('');
      if (mapSel.dataset.bound !== '1') {
        mapSel.dataset.bound = '1';
        mapSel.addEventListener('change', async (e) => {
          currentNetworkUuid = e.target.value || 'all';
          await Promise.all([loadVehicles(), loadStatusBar()]);
          const targetRoom = currentNetworkUuid === 'all' ? RADIO_ROOM_GENERAL : `px-${currentNetworkUuid}`;
          if (targetRoom !== currentRadioRoom) {
            currentRadioRoom = targetRoom;
            renderRadioNetworkSelect();
            await connectRadioRoom(targetRoom);
            loadNetworkChatHistory();
          }
        });
      }
    }
  } catch {}
}

async function loadStatusBar() {
  try {
    const q = currentNetworkUuid && currentNetworkUuid !== 'all' ? `?network_uuid=${encodeURIComponent(currentNetworkUuid)}` : '';
    const sb = await api(`/api/fleet/status-bar${q}`);
    const onEl = document.getElementById('sb-online');
    const rtEl = document.getElementById('sb-rota');
    const offEl = document.getElementById('sb-offline');
    const chEl = document.getElementById('sb-drivers-chips');
    if (onEl) onEl.textContent = sb.online ?? 0;
    if (rtEl) rtEl.textContent = sb.em_rota ?? 0;
    if (offEl) offEl.textContent = sb.offline ?? 0;
    if (chEl) {
      chEl.textContent = (sb.items || []).slice(0, 5).map(d => `${d.name} (${d.status})`).join(' · ');
    }
  } catch {}
}

function activeChatNetworkUuid() {
  if (currentNetworkUuid && currentNetworkUuid !== 'all') return currentNetworkUuid;
  return 'net_geral_00000000000000000000000001';
}

function appendNetworkChatLine(sender, text, isSystem) {
  const box = document.getElementById('network-chat-messages');
  if (!box) return;
  const row = document.createElement('div');
  row.style.color = isSystem ? 'var(--muted)' : 'var(--text)';
  row.innerHTML = isSystem
    ? `<em>${escHtml(text)}</em>`
    : `<strong>${escHtml(sender)}:</strong> ${escHtml(text)}`;
  box.appendChild(row);
  box.scrollTop = box.scrollHeight;
}

async function loadNetworkChatHistory() {
  const box = document.getElementById('network-chat-messages');
  if (!box) return;
  try {
    const rows = await api(`/api/network/chat/${encodeURIComponent(activeChatNetworkUuid())}`);
    box.innerHTML = '';
    (rows || []).forEach(r => appendNetworkChatLine(r.sender_name || 'Operador', r.message, false));
  } catch {}
}

async function sendNetworkChat() {
  const inp = document.getElementById('network-chat-input');
  if (!inp) return;
  const text = inp.value.trim();
  if (!text) return;
  inp.value = '';
  const sender = currentUser?.name || currentUser?.username || 'Central';
  appendNetworkChatLine(sender, text, false);
  if (lkRoom && lkRoom.state === 'connected') {
    try {
      lkRoom.localParticipant.publishData(
        new TextEncoder().encode(JSON.stringify({ sender, text })),
        { reliable: true, topic: 'network-chat' }
      );
    } catch {}
  }
  try {
    await api(`/api/network/chat/${encodeURIComponent(activeChatNetworkUuid())}`, {
      method: 'POST',
      body: { message: text }
    });
  } catch {}
}

document.getElementById('btn-network-chat-send')?.addEventListener('click', sendNetworkChat);
document.getElementById('network-chat-input')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); sendNetworkChat(); }
});

async function loadNetworksTab() {
  try {
    const nets = await api('/api/networks');
    const listEl = document.getElementById('networks-list');
    const bindNetSel = document.getElementById('bind-network-select');
    const bindDrvSel = document.getElementById('bind-driver-select');
    if (listEl) {
      listEl.innerHTML = (nets || []).map(n => {
        const members = Array.isArray(n.members) ? n.members : [];
        const count = n.members_count ?? members.length ?? 0;
        const membersHtml = members.length
          ? `<div style="margin-top:8px;display:flex;flex-direction:column;gap:4px;">` +
            members.map(m => `
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;padding:4px 8px;background:rgba(255,255,255,0.04);border-radius:6px;">
                <span>${escHtml(m.name || m.subject_id)} · <small style="color:var(--muted);">${escHtml(m.plate || '-')}</small></span>
                <button type="button" class="btn btn-danger btn-sm" style="padding:2px 8px;font-size:0.72rem;" onclick="removeNetworkMember('${escHtml(n.uuid)}','${escHtml(m.subject_id)}')">Remover</button>
              </div>
            `).join('') + `</div>`
          : `<div style="margin-top:6px;font-size:0.75rem;color:var(--muted);">Nenhum motorista vinculado ainda.</div>`;
        return `
        <div class="order-card" style="border-left:4px solid ${escHtml(n.color || '#10B981')};">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong>${escHtml(n.name)}</strong>
            <span class="badge badge-concluido">${count} motorista(s)</span>
          </div>
          <small style="color:var(--muted);">UUID: ${escHtml(n.uuid)} · Sala PTT: px-${escHtml(n.uuid)}</small>
          ${membersHtml}
        </div>
      `;
      }).join('') || '<small style="color:var(--muted);">Nenhuma rede cadastrada.</small>';
    }
    if (bindNetSel) {
      bindNetSel.innerHTML = (nets || []).map(n => `<option value="${escHtml(n.uuid)}">${escHtml(n.name)}</option>`).join('');
    }
    if (bindDrvSel) {
      if (!driversCache.length) await loadDrivers();
      bindDrvSel.innerHTML = (driversCache || []).map(d => `<option value="${escHtml(d.id)}">${escHtml(d.name)} (${escHtml(d.plate || '-')})</option>`).join('');
    }
  } catch {}
}

window.removeNetworkMember = async (netUuid, subjectId) => {
  try {
    await api(`/api/networks/${encodeURIComponent(netUuid)}/members`, {
      method: 'DELETE',
      body: { subject_type: 'driver', subject_id: subjectId }
    });
    await Promise.all([loadNetworksTab(), loadSessionNetworks(), loadVehicles()]);
  } catch (err) {
    alert(`Erro ao remover motorista: ${err.message}`);
  }
};

document.getElementById('form-new-network')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  await api('/api/networks', { method: 'POST', body: { name: fd.get('name'), color: fd.get('color') } });
  e.target.reset();
  await Promise.all([loadNetworksTab(), loadSessionNetworks()]);
});

document.getElementById('form-bind-network-member')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const netUuid = fd.get('network_uuid');
  const driverId = fd.get('driver_id');
  if (!netUuid || !driverId) {
    alert('Selecione a rede e o motorista.');
    return;
  }
  try {
    await api(`/api/networks/${encodeURIComponent(netUuid)}/members`, {
      method: 'POST',
      body: { subject_type: 'driver', subject_id: String(driverId), role: 'member' }
    });
    await Promise.all([loadNetworksTab(), loadSessionNetworks(), loadVehicles()]);
    alert('Motorista vinculado à rede com sucesso!');
  } catch (err) {
    alert(`Erro ao vincular motorista: ${err.message}`);
  }
});

async function loadPlatformTab() {
  if (currentUser?.type !== 'super_admin') return;
  try {
    const [orgs, audits] = await Promise.all([
      api('/api/admin/organizations'),
      api('/api/session/audit?limit=40')
    ]);
    const orgList = document.getElementById('platform-orgs-list');
    if (orgList) {
      orgList.innerHTML = (orgs || []).map(o => `
        <div class="order-card">
          <div style="display:flex;justify-content:space-between;">
            <strong>${escHtml(o.name)}</strong>
            <span class="badge badge-${o.status === 'active' ? 'concluido' : 'problema'}">${escHtml(o.status || 'active')}</span>
          </div>
          <small style="color:var(--muted);">UUID: ${escHtml(o.uuid)} · Redes: ${o.network_count || 0}</small>
        </div>
      `).join('');
    }
    const auditList = document.getElementById('platform-audit-list');
    if (auditList) {
      auditList.innerHTML = (audits || []).map(a => `
        <div style="padding:6px 8px;background:rgba(255,255,255,0.03);border-radius:6px;">
          <strong>${escHtml(a.action)}</strong> · <span style="color:var(--muted);">${escHtml(a.actor_email || a.actor_uuid || '-')}</span>
          <div style="font-size:0.7rem;color:var(--muted);">${escHtml(a.target_type || '')} ${escHtml(a.target_id || '')}</div>
        </div>
      `).join('');
    }
  } catch {}
}

document.getElementById('form-clone-org')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  const resEl = document.getElementById('clone-org-result');
  try {
    const res = await api('/api/admin/templates/tpl_modelo_x_v1/clone', {
      method: 'POST',
      body: {
        name: fd.get('name'),
        admin_name: fd.get('admin_name'),
        admin_email: fd.get('admin_email'),
        admin_password: fd.get('admin_password')
      }
    });
    if (resEl) resEl.textContent = `Empresa criada: ${res.company_uuid} · Rede: ${res.network_uuid}`;
    e.target.reset();
    loadPlatformTab();
  } catch (err) {
    if (resEl) resEl.textContent = `Erro: ${err.message}`;
  }
});
