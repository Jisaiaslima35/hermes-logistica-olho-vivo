const CLIENT_TOKEN_KEY = 'hermes_client_token';
let clientToken = localStorage.getItem(CLIENT_TOKEN_KEY) || '';
let clientUser = null;
let tariffsCache = [];
let selectedFleet = 'moto';
let currentFilter = 'todos';

// Geo & Rota
let miniMap = null;
let originMarker = null;
let destMarker = null;
let routeLine = null;
let originCoords = { lat: -5.7945, lon: -35.2084 };
let destCoords = { lat: -5.8400, lon: -35.2100 };
let calculatedKm = 6.5;
let calculatedMin = 15;

const FLEET_SVGS = {
  moto: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" stroke-width="2"><circle cx="5.5" cy="17.5" r="3.5"/><circle cx="18.5" cy="17.5" r="3.5"/><path d="M15 6h3l2 5.5"/><path d="M5.5 17.5L10 11h5l-2 6.5"/></svg>',
  utilitario: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" stroke-width="2"><rect x="1" y="6" width="16" height="11" rx="2"/><path d="M17 9h3l3 4v4h-6V9z"/><circle cx="5.5" cy="17.5" r="2.5"/><circle cx="19.5" cy="17.5" r="2.5"/></svg>',
  bau: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" stroke-width="2"><path d="M14 18V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v11a1 1 0 0 0 1 1h2"/><path d="M15 18H9"/><path d="M19 18h2a1 1 0 0 0 1-1v-3.65a1 1 0 0 0-.22-.624l-3.48-4.35A1 1 0 0 0 17.52 8H14"/><circle cx="17" cy="18" r="2"/><circle cx="7" cy="18" r="2"/></svg>',
  carreta: '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60A5FA" stroke-width="2"><rect x="1" y="4" width="14" height="12" rx="1"/><path d="M15 8h5l3 4v4h-8V8z"/><circle cx="5" cy="18" r="2"/><circle cx="11" cy="18" r="2"/><circle cx="19" cy="18" r="2"/></svg>'
};

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

// Máscara automática de WhatsApp (84) 99999-9999
function applyPhoneMask(val) {
  const digits = String(val || '').replace(/\D/g, '').slice(0, 11);
  if (digits.length <= 2) return digits;
  if (digits.length <= 7) return `(${digits.slice(0, 2)}) ${digits.slice(2)}`;
  if (digits.length <= 10) return `(${digits.slice(0, 2)}) ${digits.slice(2, 6)}-${digits.slice(6)}`;
  return `(${digits.slice(0, 2)}) ${digits.slice(2, 7)}-${digits.slice(7)}`;
}

document.addEventListener('input', (e) => {
  if (e.target.classList && e.target.classList.contains('phone-mask')) {
    e.target.value = applyPhoneMask(e.target.value);
  }
});

async function capi(url, opts = {}) {
  const headers = { ...(opts.headers || {}) };
  if (clientToken) headers['Authorization'] = `Bearer ${clientToken}`;
  if (opts.body && typeof opts.body === 'object') {
    headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(opts.body);
  }
  const res = await fetch(url, { ...opts, headers });
  if (res.status === 401 && !url.includes('/api/auth/')) {
    clientLogout();
    throw new Error('Sessão expirada');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Erro HTTP ${res.status}`);
  return data;
}

function clientLogout() {
  clientToken = '';
  localStorage.removeItem(CLIENT_TOKEN_KEY);
  hideEl(document.getElementById('client-app'));
  showEl(document.getElementById('client-auth-screen'));
}

// Alternar Login vs Criar Conta
document.getElementById('auth-tab-login').onclick = () => {
  document.getElementById('auth-tab-login').classList.add('active');
  document.getElementById('auth-tab-register').classList.remove('active');
  showEl(document.getElementById('client-login-form'));
  hideEl(document.getElementById('client-register-form'));
  hideEl(document.getElementById('client-auth-error'));
};

document.getElementById('auth-tab-register').onclick = () => {
  document.getElementById('auth-tab-register').classList.add('active');
  document.getElementById('auth-tab-login').classList.remove('active');
  showEl(document.getElementById('client-register-form'));
  hideEl(document.getElementById('client-login-form'));
  hideEl(document.getElementById('client-auth-error'));
};

function showAuthError(msg) {
  const box = document.getElementById('client-auth-error');
  box.textContent = msg;
  showEl(box);
}

document.getElementById('client-login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideEl(document.getElementById('client-auth-error'));
  try {
    const data = await capi('/api/auth/client/login', {
      method: 'POST',
      body: {
        identifier: document.getElementById('c-login-id').value,
        password: document.getElementById('c-login-pass').value
      }
    });
    onClientLogin(data);
  } catch (err) {
    showAuthError(err.message);
  }
});

document.getElementById('client-register-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  hideEl(document.getElementById('client-auth-error'));
  try {
    const data = await capi('/api/auth/client/register', {
      method: 'POST',
      body: {
        name: document.getElementById('r-name').value,
        whatsapp: document.getElementById('r-whatsapp').value.replace(/\D/g, ''),
        cpf_cnpj: document.getElementById('r-doc').value,
        username: document.getElementById('r-username').value,
        password: document.getElementById('r-password').value
      }
    });
    onClientLogin(data);
  } catch (err) {
    showAuthError(err.message);
  }
});

document.getElementById('btn-demo-client').addEventListener('click', async () => {
  hideEl(document.getElementById('client-auth-error'));
  try {
    const data = await capi('/api/auth/client/login', {
      method: 'POST',
      body: { identifier: 'teste', password: 'teste' }
    });
    onClientLogin(data);
  } catch (err) {
    showAuthError(err.message);
  }
});

document.getElementById('btn-google-oauth').addEventListener('click', async () => {
  const res = await capi('/api/auth/client/google');
  alert(res.message);
});

document.getElementById('btn-client-logout').addEventListener('click', clientLogout);

function onClientLogin(data) {
  clientToken = data.token;
  clientUser = data.user;
  localStorage.setItem(CLIENT_TOKEN_KEY, clientToken);
  document.getElementById('client-greeting').textContent = `${clientUser.name} (${clientUser.username})`;
  hideEl(document.getElementById('client-auth-screen'));
  showEl(document.getElementById('client-app'));
  initMiniMap();
  loadTariffs();
  loadClientOrders();
}

// Drawer mobile + Navegação lateral
const cSidebar = document.getElementById('c-sidebar');
const cOverlay = document.getElementById('c-drawer-overlay');
function closeCDrawer() {
  cSidebar?.classList.remove('open');
  cOverlay?.classList.remove('open');
}
document.getElementById('c-mobile-menu-btn')?.addEventListener('click', () => {
  cSidebar?.classList.toggle('open');
  cOverlay?.classList.toggle('open');
});
cOverlay?.addEventListener('click', closeCDrawer);

document.querySelectorAll('[data-ctab]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-ctab]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    const target = btn.dataset.ctab;
    const titleEl = document.getElementById('c-topbar-title');
    if (titleEl && btn.dataset.title) titleEl.textContent = btn.dataset.title;
    if (target === 'solicitar') {
      showEl(document.getElementById('ctab-solicitar'));
      hideEl(document.getElementById('ctab-pedidos'));
      if (miniMap) setTimeout(() => miniMap.invalidateSize(), 150);
    } else {
      hideEl(document.getElementById('ctab-solicitar'));
      showEl(document.getElementById('ctab-pedidos'));
      loadClientOrders();
    }
    closeCDrawer();
  });
});

// ─── MINI-MAPA & ROTA AUTOMÁTICA ─────────────────────────────────────────────
function initMiniMap() {
  if (miniMap) {
    setTimeout(() => miniMap.invalidateSize(), 150);
    return;
  }
  miniMap = L.map('client-mini-map').setView([originCoords.lat, originCoords.lon], 12);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© OpenStreetMap'
  }).addTo(miniMap);

  originMarker = L.marker([originCoords.lat, originCoords.lon], { draggable: true })
    .addTo(miniMap)
    .bindPopup('Origem (arraste para ajustar)');
  destMarker = L.marker([destCoords.lat, destCoords.lon], { draggable: true })
    .addTo(miniMap)
    .bindPopup('Destino (arraste para ajustar)');

  originMarker.on('dragend', async () => {
    const pos = originMarker.getLatLng();
    originCoords = { lat: pos.lat, lon: pos.lng };
    try {
      const rev = await capi(`/api/geo/reverse?lat=${pos.lat}&lon=${pos.lng}`);
      if (rev.address) document.getElementById('o-origin').value = rev.address;
    } catch {}
    recalculateRoute();
  });

  destMarker.on('dragend', async () => {
    const pos = destMarker.getLatLng();
    destCoords = { lat: pos.lat, lon: pos.lng };
    const firstDest = document.querySelector('.dest-input');
    if (firstDest) {
      firstDest.dataset.lat = pos.lat;
      destCoords.lat = pos.lat;
      firstDest.dataset.lon = pos.lng;
      try {
        const rev = await capi(`/api/geo/reverse?lat=${pos.lat}&lon=${pos.lng}`);
        if (rev.address) firstDest.value = rev.address;
      } catch {}
    }
    recalculateRoute();
  });

  recalculateRoute();
}

async function recalculateRoute() {
  const points = [originCoords];
  const destInputs = Array.from(document.querySelectorAll('.dest-input'));
  destInputs.forEach((inp, idx) => {
    if (inp.dataset.lat && inp.dataset.lon) {
      points.push({ lat: Number(inp.dataset.lat), lon: Number(inp.dataset.lon) });
    } else if (idx === 0) {
      points.push(destCoords);
    }
  });
  if (points.length < 2) points.push(destCoords);

  try {
    const res = await capi('/api/geo/route', { method: 'POST', body: { points } });
    calculatedKm = res.distance_km || 5;
    calculatedMin = res.duration_min || 12;
    document.getElementById('route-km').textContent = `${calculatedKm.toFixed(1)} km`;
    document.getElementById('route-min').textContent = `${calculatedMin} min`;

    if (miniMap && Array.isArray(res.geometry) && res.geometry.length >= 2) {
      if (routeLine) miniMap.removeLayer(routeLine);
      routeLine = L.polyline(res.geometry, { color: '#2563EB', weight: 4, opacity: 0.85 }).addTo(miniMap);
      miniMap.fitBounds(routeLine.getBounds(), { padding: [24, 24] });
    }
    renderFleetCards();
    updateEstimatedPrice();
  } catch {}
}

// Autocomplete com debounce
function attachAutocomplete(inputEl, dropdownEl, onSelect) {
  let timer = null;
  inputEl.addEventListener('input', () => {
    clearTimeout(timer);
    const q = inputEl.value.trim();
    if (q.length < 3) {
      hideEl(dropdownEl);
      return;
    }
    timer = setTimeout(async () => {
      try {
        const list = await capi(`/api/geo/search?q=${encodeURIComponent(q)}`);
        if (!list.length) { hideEl(dropdownEl); return; }
        dropdownEl.innerHTML = '';
        list.forEach(item => {
          const div = document.createElement('div');
          div.className = 'ac-item';
          div.textContent = item.label;
          div.onclick = () => {
            inputEl.value = item.label;
            hideEl(dropdownEl);
            onSelect(item);
          };
          dropdownEl.appendChild(div);
        });
        showEl(dropdownEl);
      } catch { hideEl(dropdownEl); }
    }, 350);
  });
  document.addEventListener('click', (e) => {
    if (!inputEl.contains(e.target) && !dropdownEl.contains(e.target)) hideEl(dropdownEl);
  });
}

attachAutocomplete(
  document.getElementById('o-origin'),
  document.getElementById('ac-origin'),
  (item) => {
    originCoords = { lat: item.lat, lon: item.lon };
    if (originMarker) originMarker.setLatLng([item.lat, item.lon]);
    recalculateRoute();
  }
);

function wireDestRow(row) {
  const inp = row.querySelector('.dest-input');
  const dd = row.querySelector('.ac-dropdown');
  attachAutocomplete(inp, dd, (item) => {
    inp.dataset.lat = item.lat;
    inp.dataset.lon = item.lon;
    destCoords = { lat: item.lat, lon: item.lon };
    if (destMarker) destMarker.setLatLng([item.lat, item.lon]);
    recalculateRoute();
  });
}
document.querySelectorAll('.stop-row').forEach(wireDestRow);

document.getElementById('btn-add-stop').addEventListener('click', () => {
  const wrap = document.getElementById('stops-container');
  const row = document.createElement('div');
  row.className = 'ac-wrap stop-row';
  row.innerHTML = `
    <input type="text" class="form-control dest-input" placeholder="Parada adicional #${wrap.children.length + 1}" autocomplete="off" />
    <div class="ac-dropdown is-hidden" hidden></div>
  `;
  wrap.appendChild(row);
  wireDestRow(row);
});

// GPS do navegador
document.getElementById('btn-gps-origin').addEventListener('click', () => {
  if (!navigator.geolocation) return alert('Geolocalização não suportada neste navegador.');
  navigator.geolocation.getCurrentPosition(async (pos) => {
    const { latitude, longitude } = pos.coords;
    originCoords = { lat: latitude, lon: longitude };
    if (originMarker) originMarker.setLatLng([latitude, longitude]);
    try {
      const rev = await capi(`/api/geo/reverse?lat=${latitude}&lon=${longitude}`);
      document.getElementById('o-origin').value = rev.address || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    } catch {
      document.getElementById('o-origin').value = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;
    }
    recalculateRoute();
  }, () => alert('Não foi possível obter sua localização. Verifique a permissão de GPS.'));
});

// ─── TARIFAS & CARGA PESADA ──────────────────────────────────────────────────
async function loadTariffs() {
  tariffsCache = await capi('/api/tariffs');
  renderFleetCards();
  updateEstimatedPrice();
}

function toggleCargoFields() {
  const isHeavy = ['bau', 'carreta'].includes(selectedFleet);
  const sec = document.getElementById('cargo-section');
  const wInp = document.getElementById('o-cargo-weight');
  const tInp = document.getElementById('o-cargo-type');
  if (isHeavy) {
    showEl(sec);
    wInp.required = true;
    tInp.required = true;
  } else {
    hideEl(sec);
    wInp.required = false;
    tInp.required = false;
  }
}

function renderFleetCards() {
  const container = document.getElementById('fleet-cards');
  container.innerHTML = tariffsCache.map(t => {
    const price = Number(t.base_fee) + Number(t.per_km_fee) * calculatedKm;
    return `
      <div class="fleet-card ${selectedFleet === t.fleet_type ? 'selected' : ''}" onclick="selectFleet('${t.fleet_type}')">
        <div style="margin-bottom:4px;">${FLEET_SVGS[t.fleet_type] || FLEET_SVGS.bau}</div>
        <div style="font-weight:600;font-size:0.88rem;color:var(--text);">${t.label}</div>
        <small style="color:var(--muted);font-size:0.75rem;">Base R$ ${Number(t.base_fee).toFixed(2)} + R$ ${Number(t.per_km_fee).toFixed(2)}/km</small>
        <div class="fleet-price">R$ ${price.toFixed(2)}</div>
      </div>
    `;
  }).join('');
  toggleCargoFields();
}

window.selectFleet = (type) => {
  selectedFleet = type;
  renderFleetCards();
  updateEstimatedPrice();
};

function updateEstimatedPrice() {
  const tariff = tariffsCache.find(t => t.fleet_type === selectedFleet);
  const price = tariff ? (Number(tariff.base_fee) + Number(tariff.per_km_fee) * calculatedKm) : 0;
  document.getElementById('o-estimated-total').textContent = `R$ ${price.toFixed(2)}`;
}

document.getElementById('o-schedule-mode').addEventListener('change', (e) => {
  const wrap = document.getElementById('schedule-date-wrap');
  const dtInput = document.getElementById('o-scheduled-at');
  if (e.target.value === 'agendar') {
    showEl(wrap);
    const minDt = new Date(Date.now() + 5 * 60000 - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    dtInput.min = minDt;
    dtInput.required = true;
  } else {
    hideEl(wrap);
    dtInput.required = false;
  }
});

document.getElementById('client-order-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const destinations = Array.from(document.querySelectorAll('.dest-input'))
    .map(el => ({
      address: el.value.trim(),
      lat: el.dataset.lat ? Number(el.dataset.lat) : null,
      lon: el.dataset.lon ? Number(el.dataset.lon) : null
    }))
    .filter(d => d.address);

  const scheduleMode = document.getElementById('o-schedule-mode').value;
  const scheduledAt = document.getElementById('o-scheduled-at').value;
  if (scheduleMode === 'agendar' && (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now())) {
    return alert('Selecione uma data e hora futura válida para o agendamento.');
  }

  try {
    const created = await capi('/api/orders', {
      method: 'POST',
      body: {
        fleet_type: selectedFleet,
        origin_address: document.getElementById('o-origin').value,
        origin_lat: originCoords.lat,
        origin_lon: originCoords.lon,
        destinations,
        recipient_name: document.getElementById('o-rec-name').value,
        recipient_whatsapp: document.getElementById('o-rec-whats').value.replace(/\D/g, ''),
        invoice_number: document.getElementById('o-nf').value,
        notes: document.getElementById('o-notes').value,
        payment_method: document.getElementById('o-payment').value,
        cargo_weight_kg: document.getElementById('o-cargo-weight').value || null,
        cargo_volume: document.getElementById('o-cargo-volume').value || null,
        cargo_type: document.getElementById('o-cargo-type').value || null,
        schedule_mode: scheduleMode,
        scheduled_at: scheduleMode === 'agendar' ? scheduledAt : null
      }
    });
    alert(`Pedido ${created.id} confirmado (${created.distance_km} km · R$ ${Number(created.final_price).toFixed(2)}).`);
    e.target.reset();
    hideEl(document.getElementById('schedule-date-wrap'));
    document.querySelector('[data-ctab="pedidos"]').click();
  } catch (err) {
    alert(err.message);
  }
});

// Meus Pedidos & Filtros
document.querySelectorAll('.filter-pill').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.filter-pill').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    currentFilter = btn.dataset.status;
    loadClientOrders();
  });
});

document.getElementById('btn-refresh-orders').addEventListener('click', loadClientOrders);

async function loadClientOrders() {
  const orders = await capi('/api/orders');
  const filtered = orders.filter(o => {
    if (currentFilter === 'todos') return true;
    if (currentFilter === 'ativos') return ['pendente', 'em_rota'].includes(o.status);
    return o.status === currentFilter;
  });

  const list = document.getElementById('client-orders-list');
  if (!filtered.length) {
    list.innerHTML = '<div style="color:var(--muted);padding:12px 0;">Nenhum pedido encontrado neste filtro.</div>';
    return;
  }

  list.innerHTML = filtered.map(o => {
    const dests = (o.destinations || []).map(d => d.address || d).join(' -> ');
    const trackUrl = o.tracking_token ? `https://track.automacaojs.us/r/${o.tracking_token}` : null;
    return `
      <div class="order-card">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;">
          <strong>${o.id} · ${o.fleet_type.toUpperCase()}</strong>
          <span class="badge badge-${o.status}">${o.status.replace('_', ' ')}</span>
        </div>
        <div><span style="color:var(--muted);">Origem:</span> ${o.origin_address}</div>
        <div><span style="color:var(--muted);">Destino(s):</span> ${dests}</div>
        <div>
          <span style="color:var(--muted);">Valor:</span> <strong>R$ ${Number(o.final_price).toFixed(2)}</strong>
          · <span style="color:var(--muted);">Pagamento:</span> ${(o.payment_method || 'pix').toUpperCase()}
          ${o.distance_km ? `· ${Number(o.distance_km).toFixed(1)} km` : ''}
          ${o.invoice_number ? `· NF: ${o.invoice_number}` : ''}
        </div>
        ${o.cargo_type ? `<small style="color:var(--muted);">Carga: ${o.cargo_type} (${o.cargo_weight_kg || '-'} kg ${o.cargo_volume ? '· ' + o.cargo_volume : ''})</small>` : ''}
        ${o.scheduled_at ? `<small style="color:#C4B5FD;">Agendado para: ${new Date(o.scheduled_at).toLocaleString('pt-BR')}</small>` : ''}
        ${o.completed_at ? `<small style="color:#6EE7B7;">Concluído em: ${new Date(o.completed_at).toLocaleString('pt-BR')} (${o.proof_notes || 'Comprovado'})</small>` : ''}
        ${o.problem_reason ? `<div style="color:#FCA5A5;">Ocorrência: ${o.problem_reason}</div>` : ''}
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:4px;">
          ${['pendente', 'em_rota'].includes(o.status) && trackUrl ? `<a href="${trackUrl}" target="_blank" class="btn btn-primary btn-sm">Rastreamento ao Vivo</a>` : ''}
          ${['agendado', 'pendente'].includes(o.status) ? `<button class="btn btn-danger btn-sm" onclick="cancelClientOrder('${o.id}')">Cancelar Pedido</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

window.cancelClientOrder = async (id) => {
  if (!confirm(`Deseja cancelar o pedido ${id}?`)) return;
  await capi(`/api/orders/${id}/cancel`, { method: 'POST', body: { reason: 'Cancelado pelo cliente no portal' } });
  loadClientOrders();
};

// Auto-restore
(async function boot() {
  if (!clientToken) return;
  try {
    const { user } = await capi('/api/auth/me');
    if (user) onClientLogin({ token: clientToken, user });
  } catch {
    clientLogout();
  }
})();
