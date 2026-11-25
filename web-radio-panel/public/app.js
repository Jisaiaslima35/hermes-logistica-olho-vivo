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
  hideEl(document.getElementById('login-screen'));
  showEl(document.getElementById('app-shell'));
  initApp();
  if (demoRefreshTimer) clearInterval(demoRefreshTimer);
  if (currentUser.is_demo) {
    demoRefreshTimer = setInterval(() => {
      if (document.getElementById('tab-operacao')?.classList.contains('active')) {
        loadVehicles();
      }
    }, 4000);
  }
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
  });
});

// ─── INICIALIZAÇÃO ───────────────────────────────────────────────────────────
async function initApp() {
  initMap();
  initLiveKit();
  await Promise.all([loadVehicles(), loadPlaces(), loadDrivers(), loadOrders()]);
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
}

// ─── ABA 1: OPERAÇÃO AO VIVO & LIVEKIT ───────────────────────────────────────
async function loadVehicles() {
  try {
    vehiclesCache = await api('/api/vehicles');
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
        L.marker([v.lat, v.lon]).addTo(markersLayer)
          .bindPopup(`<b>${v.plate}</b><br>${v.model}<br>Motorista: ${v.driver_name || '-'}`);
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
}

async function initLiveKit() {
  const indicator = document.getElementById('ptt-indicator');
  const pttText = document.getElementById('ptt-text');
  try {
    const { token, url } = await api(`/api/livekit/token?identity=central_${encodeURIComponent(currentUser?.username || 'admin')}&room=radio-frota-geral`);
    if (!window.LivekitClient) {
      pttText.textContent = 'SDK LiveKit indisponível';
      return;
    }
    lkRoom = new LivekitClient.Room({ adaptiveStream: true, dynacast: true });
    lkRoom.on(LivekitClient.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind === 'video') {
        const videoEl = document.getElementById('remote-video');
        track.attach(videoEl);
        showEl(videoEl);
        hideEl(document.getElementById('video-placeholder'));
      } else if (track.kind === 'audio') {
        const audioEl = track.attach();
        document.body.appendChild(audioEl);
      }
    });
    await lkRoom.connect(url, token);
    pttText.textContent = 'ESCUTA ATIVA';
  } catch (err) {
    pttText.textContent = 'RÁDIO STANDBY (OFFLINE)';
  }

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
      <input type="text" name="origin_address" class="form-control" placeholder="Endereço de Origem" required />
      <input type="text" name="dest_address" class="form-control" placeholder="Endereço de Destino" required />
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
  document.getElementById('admin-new-order-form').onsubmit = async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/orders', {
      method: 'POST',
      body: {
        fleet_type: fd.get('fleet_type'),
        origin_address: fd.get('origin_address'),
        destinations: [{ address: fd.get('dest_address') }],
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

// ─── ABA 4: ACERTO FINANCEIRO ────────────────────────────────────────────────
async function loadSettlements() {
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
    <div class="order-card">
      <strong>${t.label} (${t.fleet_type})</strong>
      <div style="display:flex;gap:6px;margin-top:6px;">
        <input type="number" step="0.01" id="base-${t.fleet_type}" class="form-control" value="${t.base_fee}" title="Taxa Base (R$)" />
        <input type="number" step="0.01" id="km-${t.fleet_type}" class="form-control" value="${t.per_km_fee}" title="R$/km" />
        <input type="number" step="0.1" id="coop-${t.fleet_type}" class="form-control" value="${t.coop_fee_pct}" title="% Cooperativa" />
        <button class="btn btn-primary btn-sm" onclick="saveTariff('${t.fleet_type}')">Salvar</button>
      </div>
      <small style="color:var(--muted);">Taxa Base (R$) | Valor/km (R$) | Taxa Central (%)</small>
    </div>
  `).join('');
}

window.saveTariff = async (fleetType) => {
  await api(`/api/tariffs/${fleetType}`, {
    method: 'PUT',
    body: {
      base_fee: Number(document.getElementById(`base-${fleetType}`).value),
      per_km_fee: Number(document.getElementById(`km-${fleetType}`).value),
      coop_fee_pct: Number(document.getElementById(`coop-${fleetType}`).value)
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
    const { user } = await api('/api/auth/me');
    if (user && ['admin', 'staff', 'user'].includes(user.type)) {
      onLoginSuccess({ token: authToken, user });
    } else {
      logout();
    }
  } catch {
    logout();
  }
})();
