const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const multipart = require('@fastify/multipart');
const path = require('path');
const crypto = require('crypto');
const { AccessToken } = require('livekit-server-sdk');

const { pool, initSchema } = require('./db');
const {
  authenticateUser,
  registerCustomer,
  signSessionToken,
  requireAuth
} = require('./auth');
const {
  signTrackingLink,
  emitBridgeEvent,
  mirrorPlaceToFleetbase
} = require('./integrations');
const {
  searchAddresses,
  geocodeAddress,
  reverseGeocode,
  calculateRoute
} = require('./geo');
const {
  DEMO_COMPANY,
  demoState,
  startDemoSimulator
} = require('./demo');
const { runMigrations } = require('./migrations');
const { dvirRoutes, MAX_PHOTO_BYTES } = require('./dvir');
const { telemetryRoutes, startFleetMonitor, decorateVehiclesWithHealth } = require('./telemetry');
const { olhoVivoRoutes } = require('./olho-vivo');
const { isVehicleBlocked, BLOCK_MESSAGE } = require('./fleet-guard');

const PORT = parseInt(process.env.PORT || '8601', 10);
const HOST = process.env.HOST || '0.0.0.0';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://livekit.automacaojs.us';
const BRIDGE_URL = (process.env.BRIDGE_URL || 'http://fleetbase-bridge-whatsapp:8600').replace(/\/$/, '');
const DEMO_MODE = String(process.env.DEMO_MODE || 'true').toLowerCase() === 'true';

const fastify = Fastify({
  maxParamLength: 1024,
  logger: { level: process.env.LOG_LEVEL || 'info' }
});

fastify.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
  index: false
});

// Upload de fotos da vistoria: SEMPRE por streaming para o disco.
// O limite do plugin é o teto por foto; o teto de RAM do container (128 MB)
// é garantido porque o corpo NUNCA é acumulado em memória.
fastify.register(multipart, {
  limits: {
    fileSize: MAX_PHOTO_BYTES,
    files: 12,
    fields: 40,
    fieldSize: 128 * 1024,
    parts: 60
  }
});

// ─── MÓDULOS DE DOMÍNIO (rotas próprias) ────────────────────────────────────
// dvir       → vistoria fotográfica blindada (prompt 2)
// telemetry  → fila offline de posições + monitor de frota (prompt 1)
// olho-vivo  → auditoria LGPD do acionamento de câmera (prompt 1)
fastify.register(dvirRoutes);
fastify.register(telemetryRoutes);
fastify.register(olhoVivoRoutes);

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

function parseJsonField(val, fallback = []) {
  if (typeof val === 'string') {
    try { return JSON.parse(val); } catch { return fallback; }
  }
  return val || fallback;
}

// ─── PÁGINAS & HEALTH ────────────────────────────────────────────────────────
fastify.get('/health', async () => ({
  status: 'ok',
  service: 'web-radio-panel',
  demo_mode: DEMO_MODE,
  uptime: process.uptime(),
  timestamp: new Date().toISOString()
}));

fastify.get('/', async (request, reply) => {
  const host = (request.headers.host || '').toLowerCase();
  if (host.startsWith('track.') || host.includes('track.automacaojs.us')) {
    return reply.sendFile('track-landing.html');
  }
  return reply.sendFile('index.html');
});

fastify.get('/solicitar', async (request, reply) => reply.sendFile('solicitar.html'));
fastify.get('/solicitar/', async (request, reply) => reply.sendFile('solicitar.html'));
fastify.get('/r/:token', async (request, reply) => reply.sendFile('track.html'));

// ─── GEO & ROTA (PHOTON / NOMINATIM + OSRM + HAVERSINE x 1.35) ──────────────
fastify.get('/api/geo/search', async (request, reply) => {
  const { q } = request.query || {};
  const results = await searchAddresses(q);
  return reply.send(results);
});

fastify.get('/api/geo/reverse', async (request, reply) => {
  const lat = Number(request.query?.lat);
  const lon = Number(request.query?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return reply.code(400).send({ error: 'lat e lon inválidos' });
  }
  const address = await reverseGeocode(lat, lon);
  return reply.send({ address: address || `${lat.toFixed(5)}, ${lon.toFixed(5)}`, lat, lon });
});

fastify.post('/api/geo/route', async (request, reply) => {
  const { points } = request.body || {};
  if (!Array.isArray(points) || points.length < 2) {
    return reply.code(400).send({ error: 'Informe origem e pelo menos um destino.' });
  }
  const route = await calculateRoute(points);
  const [tariffs] = await pool.query('SELECT fleet_type, label, base_fee, per_km_fee FROM hermes_tariffs');
  const estimates = {};
  for (const t of tariffs) {
    estimates[t.fleet_type] = Number((Number(t.base_fee) + Number(t.per_km_fee) * route.distance_km).toFixed(2));
  }
  return reply.send({ ...route, estimates });
});

// Proxy público de verificação de rastreio + dados da OS ao vivo
fastify.get('/api/tracking/verify/:token', async (request, reply) => {
  const { token } = request.params;
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/tracking/verify/${encodeURIComponent(token)}`);
    if (!res.ok) {
      return reply.code(401).send({ valid: false, error: 'Token inválido ou expirado' });
    }
    const verified = await res.json();
    const osId = verified?.data?.os_id;
    let order = null;
    let vehicle = null;
    if (osId) {
      const [orders] = await pool.query('SELECT id, status, origin_address, origin_lat, origin_lon, destinations_json, driver_name, fleet_type, updated_at FROM hermes_orders WHERE id = ? LIMIT 1', [osId]);
      if (orders.length) {
        order = orders[0];
        order.destinations = parseJsonField(order.destinations_json, []);
      }
      if (verified?.data?.veiculo_id) {
        const [vehs] = await pool.query('SELECT id, plate, model, lat, lon, speed_kph, updated_at FROM hermes_vehicles WHERE id = ? LIMIT 1', [verified.data.veiculo_id]);
        if (vehs.length) vehicle = vehs[0];
      }
    }
    return reply.send({ valid: true, data: verified.data, order, vehicle });
  } catch {
    return reply.code(500).send({ valid: false, error: 'Falha ao validar token de rastreio' });
  }
});

// ─── AUTENTICAÇÃO ────────────────────────────────────────────────────────────
fastify.post('/api/auth/admin/login', async (request, reply) => {
  const { identifier, email, username, password } = request.body || {};
  const loginId = identifier || email || username;
  const user = await authenticateUser(loginId, password, ['admin', 'staff', 'user']);
  if (!user) {
    return reply.code(401).send({ error: 'Credenciais inválidas para acesso administrativo.' });
  }
  const token = signSessionToken(user);
  return reply.send({
    token,
    user: { uuid: user.uuid, name: user.name, email: user.email, username: user.username, type: user.type, company_uuid: user.company_uuid, is_demo: false }
  });
});

fastify.post('/api/auth/admin/demo', async (request, reply) => {
  if (!DEMO_MODE) {
    return reply.code(403).send({ error: 'Acesso de demonstração desativado neste ambiente (DEMO_MODE=false). Use o login real.' });
  }
  const [rows] = await pool.query(
    `SELECT uuid, company_uuid, username, email, name, type FROM users WHERE type = 'admin' AND deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`
  );
  if (!rows.length) {
    return reply.code(404).send({ error: 'Administrador piloto não encontrado.' });
  }
  const user = rows[0];
  const token = signSessionToken(user);
  return reply.send({ token, user: { ...user, is_demo: false } });
});

fastify.post('/api/auth/admin/demo-live', async (request, reply) => {
  if (!DEMO_MODE) {
    return reply.code(403).send({ error: 'Modo demonstração desativado neste ambiente.' });
  }
  const demoUser = {
    uuid: 'demo_admin_01',
    username: 'demo_vendas',
    email: 'demo@automacaojs.us',
    name: 'Gestor Demo (Dados Vivos)',
    type: 'admin',
    company_uuid: DEMO_COMPANY.uuid,
    company_name: DEMO_COMPANY.name,
    is_demo: true
  };
  const token = require('jsonwebtoken').sign(
    { ...demoUser, sub: demoUser.uuid },
    process.env.JWT_SECRET || process.env.TRACKING_SIGNING_KEY || 'hermes_panel_secret_key_2026',
    { algorithm: 'HS256', expiresIn: '12h' }
  );
  return reply.send({ token, user: demoUser });
});

// ─── LOGIN DO MOTORISTA (app Navigator) ──────────────────────────────────────
// Reusa a MESMA tabela `users` do Fleetbase (mesmo banco), então as
// credenciais que já funcionam no core funcionam aqui.
fastify.post('/api/auth/driver/login', async (request, reply) => {
  const { identifier, email, username, password } = request.body || {};
  const loginId = identifier || email || username;
  if (!loginId || !password) {
    return reply.code(400).send({ error: 'Informe usuário e senha.' });
  }
  const user = await authenticateUser(loginId, password, ['driver', 'admin', 'staff']);
  if (!user) {
    return reply.code(401).send({ error: 'Usuário ou senha inválidos.' });
  }
  const token = signSessionToken(user);
  return reply.send({
    token,
    user: {
      uuid: user.uuid,
      name: user.name,
      email: user.email,
      username: user.username,
      phone: user.phone,
      type: user.type,
      company_uuid: user.company_uuid
    }
  });
});

fastify.post('/api/auth/client/login', async (request, reply) => {
  const { identifier, email, username, password } = request.body || {};
  const loginId = identifier || email || username;
  const user = await authenticateUser(loginId, password, ['customer', 'admin']);
  if (!user) {
    return reply.code(401).send({ error: 'Usuário ou senha inválidos.' });
  }
  const token = signSessionToken(user);
  return reply.send({
    token,
    user: { uuid: user.uuid, name: user.name, email: user.email, username: user.username, phone: user.phone, type: user.type, company_uuid: user.company_uuid }
  });
});

fastify.post('/api/auth/client/register', async (request, reply) => {
  try {
    const created = await registerCustomer(request.body || {});
    const token = signSessionToken(created);
    return reply.code(201).send({ token, user: created });
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

fastify.get('/api/auth/client/google', async () => {
  const configured = Boolean(process.env.GOOGLE_CLIENT_ID);
  return {
    configured,
    provider: 'google',
    message: configured ? 'OAuth Google ativo' : 'Estrutura OAuth Google pronta para ativação com GOOGLE_CLIENT_ID.'
  };
});

fastify.get('/api/auth/me', async (request, reply) => {
  const user = await requireAuth(request, reply);
  if (!user) return;
  return reply.send({ user });
});

// ─── LIVEKIT PTT & OLHO VIVO ─────────────────────────────────────────────────
// Escopo por finalidade (garantia de servidor, não só de app):
//   purpose=vision  → só pode publicar CÂMERA. NÃO pode publicar microfone,
//                     logo o stream de vídeo é mudo por construção.
//   purpose=ptt     → só pode publicar MICROFONE (canal de rádio explícito).
//   purpose=central → gestão: só microfone (fala com a equipe).
fastify.get('/api/livekit/token', async (request, reply) => {
  const identity = request.query.identity || `gestor_${Math.floor(Math.random() * 1000)}`;
  const roomName = request.query.room || 'radio-frota-geral';
  const purpose = String(request.query.purpose || 'central').toLowerCase();

  const SCOPES = {
    vision: ['camera'],
    ptt: ['microphone'],
    central: ['microphone']
  };
  const canPublishSources = SCOPES[purpose] || SCOPES.central;

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, { identity, ttl: '1h' });
    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true,
      canPublishSources
    });
    const token = await at.toJwt();
    return reply.send({
      token,
      url: LIVEKIT_URL,
      room: roomName,
      identity,
      purpose,
      can_publish_sources: canPublishSources
    });
  } catch (err) {
    fastify.log.error(err);
    return reply.code(500).send({ error: 'Erro ao gerar token LiveKit' });
  }
});

// ─── TARIFAS & PREÇOS ────────────────────────────────────────────────────────
fastify.get('/api/tariffs', async (request, reply) => {
  const [rows] = await pool.query('SELECT id, fleet_type, label, base_fee, per_km_fee, coop_fee_pct, active FROM hermes_tariffs ORDER BY id ASC');
  return reply.send(rows);
});

fastify.put('/api/tariffs/:fleet_type', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { fleet_type } = request.params;
  const { base_fee, per_km_fee, coop_fee_pct, label } = request.body || {};

  if (user.is_demo) {
    const t = demoState.tariffs.find(x => x.fleet_type === fleet_type);
    if (t) {
      if (base_fee !== undefined) t.base_fee = Number(base_fee);
      if (per_km_fee !== undefined) t.per_km_fee = Number(per_km_fee);
      if (coop_fee_pct !== undefined) t.coop_fee_pct = Number(coop_fee_pct);
      if (label) t.label = label;
    }
    return reply.send(t || {});
  }

  await pool.query(
    `UPDATE hermes_tariffs SET
      base_fee = COALESCE(?, base_fee),
      per_km_fee = COALESCE(?, per_km_fee),
      coop_fee_pct = COALESCE(?, coop_fee_pct),
      label = COALESCE(?, label)
     WHERE fleet_type = ?`,
    [base_fee ?? null, per_km_fee ?? null, coop_fee_pct ?? null, label ?? null, fleet_type]
  );
  const [rows] = await pool.query('SELECT * FROM hermes_tariffs WHERE fleet_type = ?', [fleet_type]);
  return reply.send(rows[0] || {});
});

// ─── FROTA: VEÍCULOS, MOTORISTAS E PONTOS ────────────────────────────────────
fastify.get('/api/vehicles', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) return reply.send(demoState.vehicles);
  const [rows] = await pool.query(`
    SELECT v.*, d.name AS driver_name, d.whatsapp AS driver_whatsapp
    FROM hermes_vehicles v
    LEFT JOIN hermes_drivers d ON v.driver_id = d.id
    ORDER BY v.updated_at DESC
  `);
  // Badge de saúde: sem sinal / bateria baixa / bloqueado por DVIR
  return reply.send(await decorateVehiclesWithHealth(rows));
});

fastify.post('/api/vehicles', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { plate, model, fleet_type, driver_id, lat, lon } = request.body || {};
  if (!plate || !model) return reply.code(400).send({ error: 'Placa e modelo são obrigatórios.' });
  const id = genId('veh');

  if (user.is_demo) {
    const drv = demoState.drivers.find(d => d.id === driver_id);
    const v = { id, plate: plate.toUpperCase(), model, fleet_type: fleet_type || 'moto', driver_id: driver_id || null, driver_name: drv?.name || null, status: 'disponivel', lat: lat ?? -5.7945, lon: lon ?? -35.2084, speed_kph: 0, angle: 0 };
    demoState.vehicles.unshift(v);
    return reply.code(201).send(v);
  }

  await pool.query(
    `INSERT INTO hermes_vehicles (id, plate, model, fleet_type, driver_id, status, lat, lon)
     VALUES (?, ?, ?, ?, ?, 'disponivel', ?, ?)`,
    [id, plate.toUpperCase(), model, fleet_type || 'moto', driver_id || null, lat ?? -5.7945, lon ?? -35.2084]
  );
  const [rows] = await pool.query('SELECT * FROM hermes_vehicles WHERE id = ?', [id]);
  return reply.code(201).send(rows[0]);
});

fastify.delete('/api/vehicles/:id', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) {
    demoState.vehicles = demoState.vehicles.filter(v => v.id !== request.params.id);
    return reply.send({ ok: true });
  }
  await pool.query('DELETE FROM hermes_vehicles WHERE id = ?', [request.params.id]);
  return reply.send({ ok: true });
});

fastify.get('/api/drivers', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) return reply.send(demoState.drivers);
  const [rows] = await pool.query('SELECT * FROM hermes_drivers ORDER BY created_at DESC');
  return reply.send(rows);
});

fastify.post('/api/drivers', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { name, whatsapp, plate, fleet_type, commission_pct, online } = request.body || {};
  if (!name || !whatsapp || !plate) return reply.code(400).send({ error: 'Nome, WhatsApp e placa são obrigatórios.' });
  const id = genId('mot');

  if (user.is_demo) {
    const d = { id, name, whatsapp, plate: plate.toUpperCase(), fleet_type: fleet_type || 'moto', commission_pct: commission_pct ?? 80, online: online ? 1 : 0, status: 'disponivel', lat: -5.7945, lon: -35.2084 };
    demoState.drivers.unshift(d);
    return reply.code(201).send(d);
  }

  await pool.query(
    `INSERT INTO hermes_drivers (id, name, whatsapp, plate, fleet_type, commission_pct, online, status, lat, lon)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'disponivel', -5.7945, -35.2084)`,
    [id, name, whatsapp, plate.toUpperCase(), fleet_type || 'moto', commission_pct ?? 80, online ? 1 : 0]
  );
  const [rows] = await pool.query('SELECT * FROM hermes_drivers WHERE id = ?', [id]);
  return reply.code(201).send(rows[0]);
});

fastify.patch('/api/drivers/:id', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { online, commission_pct, status } = request.body || {};
  if (user.is_demo) {
    const d = demoState.drivers.find(x => x.id === request.params.id);
    if (d) {
      if (online !== undefined) d.online = online ? 1 : 0;
      if (commission_pct !== undefined) d.commission_pct = Number(commission_pct);
      if (status) d.status = status;
    }
    return reply.send(d || {});
  }
  await pool.query(
    `UPDATE hermes_drivers SET
      online = COALESCE(?, online),
      commission_pct = COALESCE(?, commission_pct),
      status = COALESCE(?, status)
     WHERE id = ?`,
    [online !== undefined ? (online ? 1 : 0) : null, commission_pct ?? null, status ?? null, request.params.id]
  );
  const [rows] = await pool.query('SELECT * FROM hermes_drivers WHERE id = ?', [request.params.id]);
  return reply.send(rows[0] || {});
});

fastify.delete('/api/drivers/:id', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) {
    demoState.drivers = demoState.drivers.filter(d => d.id !== request.params.id);
    return reply.send({ ok: true });
  }
  await pool.query('DELETE FROM hermes_drivers WHERE id = ?', [request.params.id]);
  return reply.send({ ok: true });
});

fastify.get('/api/places', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) return reply.send(demoState.places);
  const [rows] = await pool.query('SELECT * FROM hermes_places ORDER BY created_at DESC');
  return reply.send(rows);
});

fastify.post('/api/places', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { name, place_type, address, lat, lon, radius_m } = request.body || {};
  if (!name || lat === undefined || lon === undefined) {
    return reply.code(400).send({ error: 'Nome, latitude e longitude são obrigatórios.' });
  }
  const id = genId('plc');
  if (user.is_demo) {
    const p = { id, name, place_type: place_type || 'base', address: address || '', lat: Number(lat), lon: Number(lon), radius_m: Number(radius_m || 300) };
    demoState.places.unshift(p);
    return reply.code(201).send(p);
  }
  const fbUuid = await mirrorPlaceToFleetbase({ name, address, lat, lon });
  await pool.query(
    `INSERT INTO hermes_places (id, fleetbase_place_uuid, name, place_type, address, lat, lon, radius_m)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, fbUuid, name, place_type || 'base', address || '', lat, lon, radius_m || 300]
  );
  const [rows] = await pool.query('SELECT * FROM hermes_places WHERE id = ?', [id]);
  return reply.code(201).send(rows[0]);
});

fastify.delete('/api/places/:id', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) {
    demoState.places = demoState.places.filter(p => p.id !== request.params.id);
    return reply.send({ ok: true });
  }
  await pool.query('DELETE FROM hermes_places WHERE id = ?', [request.params.id]);
  return reply.send({ ok: true });
});

// ─── CLIENTES (ADMIN) ────────────────────────────────────────────────────────
fastify.get('/api/clients', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) return reply.send(demoState.clients);
  const [rows] = await pool.query(`
    SELECT u.uuid, u.name, u.username, u.email, u.phone, u.status, u.meta, u.created_at
    FROM users u
    WHERE u.type = 'customer' AND u.deleted_at IS NULL
    ORDER BY u.created_at DESC
  `);
  return reply.send(rows.map(r => ({ ...r, meta: parseJsonField(r.meta, {}) })));
});

fastify.post('/api/clients', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) {
    const c = { uuid: genId('demo_cli'), ...request.body, meta: { cpf_cnpj: request.body?.cpf_cnpj || '' } };
    demoState.clients.unshift(c);
    return reply.code(201).send(c);
  }
  try {
    const created = await registerCustomer(request.body || {});
    return reply.code(201).send(created);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

// ─── DVIR & ALERTAS ──────────────────────────────────────────────────────────
fastify.get('/api/dvir', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) return reply.send(demoState.dvir);
  const [rows] = await pool.query('SELECT * FROM hermes_dvir ORDER BY created_at DESC LIMIT 100');
  return reply.send(rows.map(r => ({ ...r, items: parseJsonField(r.items_json, []) })));
});

fastify.post('/api/dvir', async (request, reply) => {
  const { vehicle_id, driver_id, driver_name, order_id, result, blocks_departure, items } = request.body || {};
  if (!vehicle_id || !result) return reply.code(400).send({ error: 'vehicle_id e result obrigatórios.' });
  const id = genId('dvir');
  await pool.query(
    `INSERT INTO hermes_dvir (id, vehicle_id, driver_id, driver_name, order_id, result, blocks_departure, items_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, vehicle_id, driver_id || null, driver_name || null, order_id || null, result, blocks_departure ? 1 : 0, JSON.stringify(items || [])]
  );
  await pool.query('UPDATE hermes_vehicles SET dvir_status = ? WHERE id = ?', [result, vehicle_id]);
  if (result === 'reprovado' || blocks_departure) {
    await emitBridgeEvent('dvir.registrada', id, { veiculo_id: vehicle_id, motorista_id: driver_id, resultado: result, bloqueia_saida: true });
  }
  return reply.code(201).send({ id, result });
});

fastify.get('/api/alerts', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) return reply.send(demoState.alerts);
  const [rows] = await pool.query('SELECT * FROM hermes_alerts ORDER BY created_at DESC LIMIT 100');
  return reply.send(rows.map(r => ({ ...r, details: parseJsonField(r.details_json, {}) })));
});

fastify.patch('/api/alerts/:id/ack', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) {
    const a = demoState.alerts.find(x => x.id === request.params.id);
    if (a) a.acknowledged = 1;
    return reply.send({ ok: true });
  }
  await pool.query('UPDATE hermes_alerts SET acknowledged = 1 WHERE id = ?', [request.params.id]);
  return reply.send({ ok: true });
});

// ─── CORRIDAS & ROMANEIOS (CENTRAL + PORTAL CLIENTE + ANTI-FRAUDE) ──────────
fastify.get('/api/orders', async (request, reply) => {
  const user = await requireAuth(request, reply);
  if (!user) return;
  const { status } = request.query || {};

  if (user.is_demo) {
    let list = demoState.orders;
    if (status && status !== 'todos') list = list.filter(o => o.status === status);
    return reply.send(list);
  }

  const params = [];
  let sql = 'SELECT * FROM hermes_orders WHERE 1=1';

  if (user.type === 'customer') {
    sql += ' AND client_user_uuid = ?';
    params.push(user.sub);
  }
  if (status && status !== 'todos') {
    sql += ' AND status = ?';
    params.push(status);
  }
  sql += ' ORDER BY created_at DESC LIMIT 200';

  const [rows] = await pool.query(sql, params);
  return reply.send(rows.map(o => ({ ...o, destinations: parseJsonField(o.destinations_json, []) })));
});

fastify.post('/api/orders', async (request, reply) => {
  const user = await requireAuth(request, reply);
  if (!user) return;

  const {
    fleet_type,
    origin_address,
    origin_lat,
    origin_lon,
    destinations,
    recipient_name,
    recipient_whatsapp,
    invoice_number,
    notes,
    schedule_mode,
    scheduled_at,
    payment_method,
    cargo_weight_kg,
    cargo_volume,
    cargo_type,
    client_user_uuid,
    client_name
  } = request.body || {};

  if (!fleet_type || !origin_address) {
    return reply.code(400).send({ error: 'Tipo de frota e endereço de origem são obrigatórios.' });
  }

  // Validação de carga pesada obrigatória para Caminhão Baú e Carreta Pesada
  if (['bau', 'carreta'].includes(fleet_type)) {
    if (!Number(cargo_weight_kg) || Number(cargo_weight_kg) <= 0 || !String(cargo_type || '').trim()) {
      return reply.code(400).send({ error: 'Para Caminhão Baú e Carreta Pesada, Peso (kg) e Tipo de Carga são obrigatórios.' });
    }
  }

  const allowedPayments = ['pix', 'dinheiro', 'faturado'];
  const validPayment = allowedPayments.includes(payment_method) ? payment_method : 'pix';

  const destList = Array.isArray(destinations) && destinations.length > 0
    ? destinations.map(d => (typeof d === 'string' ? { address: d.trim() } : d)).filter(d => d && d.address)
    : [];

  if (!destList.length) {
    return reply.code(400).send({ error: 'Informe pelo menos um endereço de destino.' });
  }

  // Validação de agendamento futuro
  const isScheduled = schedule_mode === 'agendar';
  if (isScheduled) {
    const schedMs = new Date(scheduled_at).getTime();
    if (!scheduled_at || Number.isNaN(schedMs) || schedMs <= Date.now()) {
      return reply.code(400).send({ error: 'Para agendamento, informe uma data e hora futura válida.' });
    }
  }

  // Cálculo de rota & distância obrigatório no servidor (ignora qualquer preço/km do frontend)
  let oLat = Number.isFinite(Number(origin_lat)) && origin_lat !== null && origin_lat !== '' ? Number(origin_lat) : null;
  let oLon = Number.isFinite(Number(origin_lon)) && origin_lon !== null && origin_lon !== '' ? Number(origin_lon) : null;
  if (oLat === null || oLon === null) {
    const g = await geocodeAddress(origin_address);
    if (g) { oLat = g.lat; oLon = g.lon; }
  }

  const routePoints = [];
  if (oLat !== null && oLon !== null) routePoints.push({ lat: oLat, lon: oLon });

  for (const d of destList) {
    let dLat = Number.isFinite(Number(d.lat)) && d.lat !== null && d.lat !== '' ? Number(d.lat) : null;
    let dLon = Number.isFinite(Number(d.lon)) && d.lon !== null && d.lon !== '' ? Number(d.lon) : null;
    if (dLat === null || dLon === null) {
      const gd = await geocodeAddress(d.address);
      if (gd) { dLat = gd.lat; dLon = gd.lon; d.lat = dLat; d.lon = dLon; }
    }
    if (dLat !== null && dLon !== null) routePoints.push({ lat: dLat, lon: dLon });
  }

  const routeInfo = await calculateRoute(routePoints);
  const km = routeInfo.distance_km;

  // Busca tarifa oficial no banco (Anti-Fraude: ignora qualquer valor enviado pelo frontend)
  const [tariffs] = await pool.query('SELECT * FROM hermes_tariffs WHERE fleet_type = ? LIMIT 1', [fleet_type]);
  if (!tariffs.length) {
    return reply.code(400).send({ error: 'Categoria de frota inválida na tabela de preços.' });
  }
  const tariff = tariffs[0];
  const calculatedPrice = Number((Number(tariff.base_fee) + Number(tariff.per_km_fee) * km).toFixed(2));
  const coopFeePct = Number(tariff.coop_fee_pct || 15);
  const driverCommPct = Number((100 - coopFeePct).toFixed(2));

  const initialStatus = isScheduled ? 'agendado' : 'pendente';
  const orderId = `${user.is_demo ? 'DEMO' : 'OS'}-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  if (user.is_demo) {
    const demoOrder = {
      id: orderId,
      client_name: client_name || user.name,
      fleet_type,
      status: initialStatus,
      queue_mode: 'direto',
      origin_address,
      destinations: destList,
      distance_km: km,
      duration_min: routeInfo.duration_min,
      route_source: routeInfo.source,
      final_price: calculatedPrice,
      estimated_price: calculatedPrice,
      payment_method: validPayment,
      cargo_weight_kg: cargo_weight_kg ? Number(cargo_weight_kg) : null,
      cargo_volume: cargo_volume || null,
      cargo_type: cargo_type || null,
      scheduled_at: isScheduled ? new Date(scheduled_at).toISOString() : null,
      created_at: new Date().toISOString()
    };
    demoState.orders.unshift(demoOrder);
    return reply.code(201).send(demoOrder);
  }

  const ownerUuid = (user.type === 'admin' && client_user_uuid) ? client_user_uuid : user.sub;
  const ownerName = (user.type === 'admin' && client_name) ? client_name : user.name;

  const trackData = await signTrackingLink({ orderId, companyUuid: user.company_uuid });
  const trackingToken = trackData ? trackData.token : null;

  await pool.query(
    `INSERT INTO hermes_orders (
      id, client_user_uuid, client_name, fleet_type, status, queue_mode,
      origin_address, origin_lat, origin_lon, destinations_json, distance_km, duration_min, route_source,
      recipient_name, recipient_whatsapp, invoice_number, notes,
      payment_method, cargo_weight_kg, cargo_volume, cargo_type,
      estimated_price, final_price, coop_fee_pct, driver_commission_pct,
      scheduled_at, tracking_token
    ) VALUES (?, ?, ?, ?, ?, 'direto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId, ownerUuid, ownerName, fleet_type, initialStatus,
      origin_address, oLat, oLon, JSON.stringify(destList), km, routeInfo.duration_min, routeInfo.source,
      recipient_name || null, recipient_whatsapp || null, invoice_number || null, notes || null,
      validPayment, cargo_weight_kg ? Number(cargo_weight_kg) : null, cargo_volume || null, cargo_type || null,
      calculatedPrice, calculatedPrice, coopFeePct, driverCommPct,
      isScheduled ? new Date(scheduled_at) : null, trackingToken
    ]
  );

  const [created] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [orderId]);
  const order = { ...created[0], destinations: parseJsonField(created[0].destinations_json, []) };
  return reply.code(201).send(order);
});

fastify.post('/api/orders/:id/assign', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { id } = request.params;
  const { driver_id } = request.body || {};
  if (!driver_id) return reply.code(400).send({ error: 'Selecione um motorista.' });

  if (user.is_demo) {
    const drv = demoState.drivers.find(d => d.id === driver_id);
    const ord = demoState.orders.find(o => o.id === id);
    if (!drv || !ord) return reply.code(404).send({ error: 'Motorista ou corrida não encontrado.' });
    ord.driver_id = drv.id;
    ord.driver_name = drv.name;
    ord.status = 'em_rota';
    return reply.send(ord);
  }

  const [drivers] = await pool.query('SELECT * FROM hermes_drivers WHERE id = ? LIMIT 1', [driver_id]);
  if (!drivers.length) return reply.code(404).send({ error: 'Motorista não encontrado.' });
  const driver = drivers[0];

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });

  await pool.query(
    `UPDATE hermes_orders SET driver_id = ?, driver_name = ?, status = 'em_rota', queue_mode = 'direto', accepted_at = NOW(), driver_commission_pct = ? WHERE id = ?`,
    [driver.id, driver.name, driver.commission_pct, id]
  );

  await emitBridgeEvent('corrida.atribuida', id, {
    ordem_servico_id: id,
    motorista_nome: driver.name,
    telefone_motorista: driver.whatsapp,
    telefone_cliente: orders[0].recipient_whatsapp,
    origem: orders[0].origin_address,
    valor: orders[0].final_price
  });

  const [updated] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [id]);
  return reply.send({ ...updated[0], destinations: parseJsonField(updated[0].destinations_json, []) });
});

fastify.post('/api/orders/:id/release-queue', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { id } = request.params;

  if (user.is_demo) {
    const ord = demoState.orders.find(o => o.id === id);
    if (!ord) return reply.code(404).send({ error: 'Corrida não encontrada.' });
    ord.status = 'pendente';
    ord.queue_mode = 'fila_aberta';
    ord.driver_id = null;
    ord.driver_name = null;
    return reply.send(ord);
  }

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });

  await pool.query(
    `UPDATE hermes_orders SET status = 'pendente', queue_mode = 'fila_aberta', driver_id = NULL, driver_name = NULL WHERE id = ?`,
    [id]
  );

  await emitBridgeEvent('corrida.fila_aberta', id, {
    ordem_servico_id: id,
    fleet_type: orders[0].fleet_type,
    origem: orders[0].origin_address,
    valor: orders[0].final_price
  });

  const [updated] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [id]);
  return reply.send({ ...updated[0], destinations: parseJsonField(updated[0].destinations_json, []) });
});

fastify.post('/api/orders/:id/problem', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { id } = request.params;
  const { reason } = request.body || {};
  const problemReason = String(reason || 'Ocorrência operacional registrada').trim();

  if (user.is_demo) {
    const ord = demoState.orders.find(o => o.id === id);
    if (!ord) return reply.code(404).send({ error: 'Corrida não encontrada.' });
    ord.status = 'problema';
    ord.problem_reason = problemReason;
    return reply.send(ord);
  }

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });

  await pool.query(`UPDATE hermes_orders SET status = 'problema', problem_reason = ? WHERE id = ?`, [problemReason, id]);
  await pool.query(
    `INSERT INTO hermes_alerts (id, order_id, driver_id, alert_type, message) VALUES (?, ?, ?, 'ocorrencia', ?)`,
    [genId('alt'), id, orders[0].driver_id || null, `${id}: ${problemReason}`]
  );

  await emitBridgeEvent('corrida.problema', id, {
    ordem_servico_id: id,
    motivo: problemReason,
    telefone_cliente: orders[0].recipient_whatsapp
  });

  const [updated] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [id]);
  return reply.send({ ...updated[0], destinations: parseJsonField(updated[0].destinations_json, []) });
});

fastify.post('/api/orders/:id/complete', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { id } = request.params;
  const { proof_photo_url, proof_notes } = request.body || {};

  if (user.is_demo) {
    const ord = demoState.orders.find(o => o.id === id);
    if (!ord) return reply.code(404).send({ error: 'Corrida não encontrada.' });
    ord.status = 'concluido';
    ord.completed_at = new Date().toISOString();
    ord.proof_notes = proof_notes || 'Concluído (Demo)';
    return reply.send(ord);
  }

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });

  await pool.query(
    `UPDATE hermes_orders SET status = 'concluido', completed_at = NOW(), proof_photo_url = ?, proof_notes = ? WHERE id = ?`,
    [proof_photo_url || null, proof_notes || 'Entrega concluída com sucesso', id]
  );

  await emitBridgeEvent('corrida.concluida', id, {
    ordem_servico_id: id,
    telefone_cliente: orders[0].recipient_whatsapp
  });

  const [updated] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [id]);
  return reply.send({ ...updated[0], destinations: parseJsonField(updated[0].destinations_json, []) });
});

fastify.post('/api/orders/:id/cancel', async (request, reply) => {
  const user = await requireAuth(request, reply);
  if (!user) return;
  const { id } = request.params;
  const { reason } = request.body || {};

  if (user.is_demo) {
    const ord = demoState.orders.find(o => o.id === id);
    if (!ord) return reply.code(404).send({ error: 'Corrida não encontrada.' });
    ord.status = 'cancelado';
    ord.problem_reason = reason || 'Cancelado (Demo)';
    return reply.send(ord);
  }

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });
  const order = orders[0];

  if (user.type === 'customer') {
    if (order.client_user_uuid !== user.sub) return reply.code(403).send({ error: 'Pedido não pertence a este cliente.' });
    if (!['agendado', 'pendente'].includes(order.status)) {
      return reply.code(400).send({ error: 'Somente pedidos agendados ou pendentes podem ser cancelados pelo cliente.' });
    }
  }

  await pool.query(
    `UPDATE hermes_orders SET status = 'cancelado', problem_reason = COALESCE(?, problem_reason) WHERE id = ?`,
    [reason || 'Cancelado pelo solicitante', id]
  );

  const [updated] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [id]);
  return reply.send({ ...updated[0], destinations: parseJsonField(updated[0].destinations_json, []) });
});

// ─── ACERTO FINANCEIRO & COMISSÕES ───────────────────────────────────────────
fastify.get('/api/settlements/preview', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;

  if (user.is_demo) {
    const mapDrv = new Map();
    for (const o of demoState.orders) {
      if (o.status === 'concluido' && !o.settlement_id && o.driver_id) {
        const cur = mapDrv.get(o.driver_id) || { driver_id: o.driver_id, driver_name: o.driver_name, total_deliveries: 0, gross_amount: 0, coop_fee_amount: 0 };
        cur.total_deliveries += 1;
        cur.gross_amount += Number(o.final_price || 0);
        cur.coop_fee_amount += Number(o.final_price || 0) * (Number(o.coop_fee_pct || 15) / 100);
        mapDrv.set(o.driver_id, cur);
      }
    }
    return reply.send(Array.from(mapDrv.values()).map(r => ({
      ...r,
      gross_amount: Number(r.gross_amount.toFixed(2)),
      coop_fee_amount: Number(r.coop_fee_amount.toFixed(2)),
      net_amount: Number((r.gross_amount - r.coop_fee_amount).toFixed(2))
    })));
  }

  const { driver_id, start, end } = request.query || {};
  const params = [];
  let sql = `
    SELECT driver_id, driver_name, COUNT(*) AS total_deliveries,
           COALESCE(SUM(final_price), 0) AS gross_amount,
           COALESCE(SUM(final_price * (coop_fee_pct / 100)), 0) AS coop_fee_amount
    FROM hermes_orders
    WHERE status = 'concluido' AND settlement_id IS NULL AND driver_id IS NOT NULL
  `;
  if (driver_id) { sql += ' AND driver_id = ?'; params.push(driver_id); }
  if (start) { sql += ' AND DATE(completed_at) >= ?'; params.push(start); }
  if (end) { sql += ' AND DATE(completed_at) <= ?'; params.push(end); }
  sql += ' GROUP BY driver_id, driver_name';

  const [rows] = await pool.query(sql, params);
  return reply.send(rows.map(r => ({
    ...r,
    gross_amount: Number(Number(r.gross_amount).toFixed(2)),
    coop_fee_amount: Number(Number(r.coop_fee_amount).toFixed(2)),
    net_amount: Number((Number(r.gross_amount) - Number(r.coop_fee_amount)).toFixed(2))
  })));
});

fastify.get('/api/settlements', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) return reply.send(demoState.settlements);
  const [rows] = await pool.query('SELECT * FROM hermes_settlements ORDER BY closed_at DESC LIMIT 100');
  return reply.send(rows);
});

fastify.post('/api/settlements/close', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { driver_id, start, end } = request.body || {};
  if (!driver_id) return reply.code(400).send({ error: 'driver_id é obrigatório.' });

  const periodStart = start || new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const periodEnd = end || new Date().toISOString().slice(0, 10);

  if (user.is_demo) {
    const pend = demoState.orders.filter(o => o.status === 'concluido' && !o.settlement_id && o.driver_id === driver_id);
    if (!pend.length) return reply.code(400).send({ error: 'Sem entregas pendentes na demo.' });
    let gross = 0, fee = 0;
    pend.forEach(o => { gross += Number(o.final_price); fee += Number(o.final_price) * (Number(o.coop_fee_pct || 15) / 100); });
    const sid = genId('DEMO-SET');
    pend.forEach(o => { o.settlement_id = sid; });
    const s = { id: sid, driver_id, driver_name: pend[0].driver_name, period_start: periodStart, period_end: periodEnd, total_deliveries: pend.length, gross_amount: Number(gross.toFixed(2)), coop_fee_amount: Number(fee.toFixed(2)), net_amount: Number((gross - fee).toFixed(2)), status: 'fechado', closed_at: new Date().toISOString() };
    demoState.settlements.unshift(s);
    return reply.code(201).send(s);
  }

  const [orders] = await pool.query(
    `SELECT id, driver_name, final_price, coop_fee_pct FROM hermes_orders
     WHERE status = 'concluido' AND settlement_id IS NULL AND driver_id = ?
       AND DATE(completed_at) >= ? AND DATE(completed_at) <= ?`,
    [driver_id, periodStart, periodEnd]
  );

  if (!orders.length) {
    return reply.code(400).send({ error: 'Não há entregas concluídas pendentes de acerto para este motorista/período.' });
  }

  let gross = 0;
  let coopFee = 0;
  for (const o of orders) {
    const val = Number(o.final_price || 0);
    gross += val;
    coopFee += val * (Number(o.coop_fee_pct || 15) / 100);
  }
  const net = Number((gross - coopFee).toFixed(2));
  const settlementId = genId('set');

  await pool.query(
    `INSERT INTO hermes_settlements (id, driver_id, driver_name, period_start, period_end, total_deliveries, gross_amount, coop_fee_amount, net_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [settlementId, driver_id, orders[0].driver_name || driver_id, periodStart, periodEnd, orders.length, gross.toFixed(2), coopFee.toFixed(2), net.toFixed(2)]
  );

  const orderIds = orders.map(o => o.id);
  await pool.query(`UPDATE hermes_orders SET settlement_id = ? WHERE id IN (?)`, [settlementId, orderIds]);

  const [saved] = await pool.query('SELECT * FROM hermes_settlements WHERE id = ?', [settlementId]);
  return reply.code(201).send(saved[0]);
});

// ─── ENDPOINTS APP MOTORISTA (MOBILE-NAVIGATOR) ──────────────────────────────
fastify.get('/api/driver/queue', async (request, reply) => {
  const { fleet_type, vehicle_id } = request.query || {};

  // Blindagem DVIR: se o motorista informa o veículo e ele está bloqueado
  // por vistoria reprovada, a fila NÃO é entregue (403).
  if (vehicle_id) {
    const blocked = await isVehicleBlocked(String(vehicle_id));
    if (blocked) {
      return reply.code(403).send({
        error: BLOCK_MESSAGE,
        code: 'VEICULO_BLOQUEADO_DVIR',
        vehicle_id: blocked.id,
        vehicle_plate: blocked.plate,
        blocked_at: blocked.dvir_blocked_at,
        blocked_reason: blocked.dvir_blocked_reason
      });
    }
  }

  const params = [];
  let sql = `SELECT id, fleet_type, origin_address, origin_lat, origin_lon, destinations_json, distance_km, estimated_price, final_price, payment_method, cargo_weight_kg, cargo_type, recipient_name, notes, created_at
             FROM hermes_orders
             WHERE status = 'pendente' AND queue_mode = 'fila_aberta' AND driver_id IS NULL`;
  if (fleet_type) {
    sql += ' AND fleet_type = ?';
    params.push(fleet_type);
  }
  sql += ' ORDER BY created_at ASC LIMIT 50';
  const [rows] = await pool.query(sql, params);
  return reply.send(rows.map(o => ({ ...o, destinations: parseJsonField(o.destinations_json, []) })));
});

fastify.post('/api/driver/orders/:id/accept', async (request, reply) => {
  const { id } = request.params;
  const { driver_id, driver_name, vehicle_id } = request.body || {};
  if (!driver_id) return reply.code(400).send({ error: 'driver_id é obrigatório.' });

  // Blindagem DVIR: veículo reprovado/bloqueado não aceita corrida nova.
  if (vehicle_id) {
    const blocked = await isVehicleBlocked(String(vehicle_id));
    if (blocked) {
      return reply.code(403).send({
        error: BLOCK_MESSAGE,
        code: 'VEICULO_BLOQUEADO_DVIR',
        vehicle_id: blocked.id,
        vehicle_plate: blocked.plate,
        blocked_at: blocked.dvir_blocked_at,
        blocked_reason: blocked.dvir_blocked_reason
      });
    }
  }

  const [result] = await pool.query(
    `UPDATE hermes_orders
     SET driver_id = ?, driver_name = ?, vehicle_id = COALESCE(?, vehicle_id), status = 'em_rota', accepted_at = NOW()
     WHERE id = ? AND status = 'pendente' AND driver_id IS NULL`,
    [driver_id, driver_name || driver_id, vehicle_id || null, id]
  );

  if (result.affectedRows === 0) {
    return reply.code(409).send({ error: 'Corrida já foi aceita por outro motorista ou não está mais disponível.' });
  }

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  const order = orders[0];
  await emitBridgeEvent('corrida.atribuida', id, {
    ordem_servico_id: id,
    motorista_nome: driver_name || driver_id,
    telefone_cliente: order.recipient_whatsapp,
    origem: order.origin_address,
    valor: order.final_price
  });

  return reply.send({ ...order, destinations: parseJsonField(order.destinations_json, []) });
});

fastify.post('/api/driver/orders/:id/complete', async (request, reply) => {
  const { id } = request.params;
  const { driver_id, proof_photo_url, proof_notes } = request.body || {};

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });
  if (driver_id && orders[0].driver_id && orders[0].driver_id !== driver_id) {
    return reply.code(403).send({ error: 'Corrida atribuída a outro motorista.' });
  }

  await pool.query(
    `UPDATE hermes_orders SET status = 'concluido', completed_at = NOW(), proof_photo_url = ?, proof_notes = ? WHERE id = ?`,
    [proof_photo_url || null, proof_notes || 'Baixa realizada via Navigator', id]
  );

  await emitBridgeEvent('corrida.concluida', id, {
    ordem_servico_id: id,
    telefone_cliente: orders[0].recipient_whatsapp
  });

  const [updated] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [id]);
  return reply.send({ ...updated[0], destinations: parseJsonField(updated[0].destinations_json, []) });
});

fastify.post('/api/driver/orders/:id/problem', async (request, reply) => {
  const { id } = request.params;
  const { driver_id, reason } = request.body || {};
  const problemReason = String(reason || 'Ocorrência reportada pelo motorista').trim();

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });

  await pool.query(`UPDATE hermes_orders SET status = 'problema', problem_reason = ? WHERE id = ?`, [problemReason, id]);
  await pool.query(
    `INSERT INTO hermes_alerts (id, order_id, driver_id, alert_type, message) VALUES (?, ?, ?, 'ocorrencia', ?)`,
    [genId('alt'), id, driver_id || orders[0].driver_id || null, `${id}: ${problemReason}`]
  );

  await emitBridgeEvent('corrida.problema', id, {
    ordem_servico_id: id,
    motivo: problemReason,
    telefone_cliente: orders[0].recipient_whatsapp
  });

  const [updated] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [id]);
  return reply.send({ ...updated[0], destinations: parseJsonField(updated[0].destinations_json, []) });
});

// NOTA: POST /api/driver/telemetry e POST /api/driver/telemetry/batch foram
// movidos para src/telemetry.js (fila offline store-and-forward + monitor de
// frota). Não duplicar aqui — o Fastify rejeita rota repetida no boot.

// ─── DISPARO AUTOMÁTICO DE PEDIDOS AGENDADOS ─────────────────────────────────
async function processScheduledOrders() {
  try {
    const [due] = await pool.query(
      `SELECT id, fleet_type, origin_address, final_price FROM hermes_orders
       WHERE status = 'agendado' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
       LIMIT 20`
    );
    for (const order of due) {
      const [res] = await pool.query(
        `UPDATE hermes_orders SET status = 'pendente', queue_mode = 'fila_aberta' WHERE id = ? AND status = 'agendado'`,
        [order.id]
      );
      if (res.affectedRows > 0) {
        fastify.log.info({ orderId: order.id }, 'Pedido agendado disparado automaticamente para fila aberta');
        await emitBridgeEvent('corrida.fila_aberta', order.id, {
          ordem_servico_id: order.id,
          fleet_type: order.fleet_type,
          origem: order.origin_address,
          valor: order.final_price
        });
      }
    }
  } catch (err) {
    fastify.log.warn({ err: err.message }, 'Erro ao processar pedidos agendados');
  }
}

async function start() {
  try {
    await initSchema();
    // Migrações próprias (prefixo hj_ / olho_vivo_*) — idempotentes, ledger
    // em hj_schema_migrations. Nunca tocam em tabelas do core Fleetbase.
    await runMigrations(fastify.log);
    if (DEMO_MODE) startDemoSimulator();
    setInterval(processScheduledOrders, 15000);
    // Monitor de frota: sem sinal > 3 min / bateria <= 15% -> alerta + NTFY
    startFleetMonitor(fastify);
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Hermes Central & Portal ativo em http://${HOST}:${PORT} (DEMO_MODE=${DEMO_MODE})`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
