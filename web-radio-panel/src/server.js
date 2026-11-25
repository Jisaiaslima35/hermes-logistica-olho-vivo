const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const multipart = require('@fastify/multipart');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { AccessToken, TrackSource } = require('livekit-server-sdk');

const { pool, initSchema } = require('./db');
const {
  authenticateUser,
  registerCustomer,
  signSessionToken,
  requireAuth,
  verifySessionToken
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
const {
  calculateOrderPricing,
  calculateOrderSplit
} = require('./pricing');
const {
  lockOrderCreditOnStart,
  releaseOrderCreditOnComplete,
  getDriversWalletSummary,
  getDriverWalletStatement,
  createManualAdjustment,
  createPayoutBatch,
  payPayoutBatch
} = require('./wallet');
const {
  VAPID_PUBLIC_KEY,
  saveSubscription,
  notifyDriverPush,
  notifyQueuePush
} = require('./push');
const { runMigrations } = require('./migrations');
const { dvirRoutes, MAX_PHOTO_BYTES } = require('./dvir');
const { telemetryRoutes, startFleetMonitor, decorateVehiclesWithHealth } = require('./telemetry');
const { olhoVivoRoutes } = require('./olho-vivo');
const { isVehicleBlocked, BLOCK_MESSAGE } = require('./fleet-guard');
const { registerNetworkRoutes, validateLiveKitRoomAccess, logPlatformAudit } = require('./networks');

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
fastify.get('/motorista', async (request, reply) => reply.sendFile('motorista.html'));
fastify.get('/motorista/', async (request, reply) => reply.sendFile('motorista.html'));
fastify.get('/r/:token', async (request, reply) => reply.sendFile('track.html'));

// Download leve por streaming do APK assinado (fora da imagem Docker, via volume /app/uploads)
fastify.route({
  method: ['GET', 'HEAD'],
  url: '/downloads/hermes-motorista.apk',
  handler: async (request, reply) => {
    const apkPath = '/app/uploads/downloads/hermes-motorista.apk';
    if (!fs.existsSync(apkPath)) {
      return reply.code(404).send({ error: 'APK ainda não disponível para download.' });
    }
    const stat = fs.statSync(apkPath);
    reply.header('Content-Type', 'application/vnd.android.package-archive');
    reply.header('Content-Disposition', 'attachment; filename="hermes-motorista.apk"');
    reply.header('Content-Length', stat.size);
    if (request.method === 'HEAD') return reply.code(200).send();
    return reply.send(fs.createReadStream(apkPath));
  }
});

// ─── GEO & ROTA (PHOTON / NOMINATIM + OSRM + HAVERSINE x 1.35) ──────────────
fastify.get('/api/geo/search', async (request, reply) => {
  const { q, number, city, state } = request.query || {};
  const results = await searchAddresses(q, { number, city, state });
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
  const { points, extra_stops_count, requires_return } = request.body || {};
  if (!Array.isArray(points) || points.length < 2) {
    return reply.code(400).send({ error: 'Informe origem e pelo menos um destino.' });
  }
  const route = await calculateRoute(points);
  const [tariffs] = await pool.query('SELECT * FROM hermes_tariffs');
  const estimates = {};
  const details = {};
  const extraStops = extra_stops_count !== undefined ? Number(extra_stops_count) : Math.max(0, points.length - 2);
  for (const t of tariffs) {
    const calc = calculateOrderPricing(t, {
      distance_km: route.distance_km,
      extra_stops_count: extraStops,
      requires_return: Boolean(requires_return)
    });
    estimates[t.fleet_type] = calc.valor_total_cliente;
    details[t.fleet_type] = calc.snapshot;
  }
  return reply.send({ ...route, estimates, details });
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
    let driver = null;
    let stops = [];
    if (osId) {
      const [orders] = await pool.query(
        'SELECT id, status, origin_address, origin_lat, origin_lon, destinations_json, driver_id, vehicle_id, driver_name, fleet_type, updated_at FROM hermes_orders WHERE id = ? LIMIT 1',
        [osId]
      );
      if (orders.length) {
        order = orders[0];
        order.destinations = parseJsonField(order.destinations_json, []);
        if (order.driver_id) {
          const [drvs] = await pool.query(
            'SELECT id, name, plate, lat, lon, online, status FROM hermes_drivers WHERE id = ? LIMIT 1',
            [order.driver_id]
          );
          if (drvs.length) driver = { ...drvs[0], updated_at: order.updated_at || new Date().toISOString() };

          // Outras paradas ativas do mesmo motorista para compor a rota #1, #2...
          const [activeOrders] = await pool.query(
            `SELECT id, destinations_json FROM hermes_orders
             WHERE driver_id = ? AND status IN ('aceito', 'coletando', 'em_rota')
             ORDER BY created_at ASC LIMIT 8`,
            [order.driver_id]
          );
          activeOrders.forEach((ao) => {
            const ds = parseJsonField(ao.destinations_json, []);
            ds.forEach((d) => {
              if (d && d.lat != null && d.lon != null) {
                stops.push({ order_id: ao.id, address: d.address, lat: Number(d.lat), lon: Number(d.lon) });
              }
            });
          });
        }
      }
      const vehId = order?.vehicle_id || verified?.data?.veiculo_id;
      if (vehId) {
        const [vehs] = await pool.query('SELECT id, plate, model, lat, lon, speed_kph, updated_at FROM hermes_vehicles WHERE id = ? LIMIT 1', [vehId]);
        if (vehs.length) vehicle = vehs[0];
      } else if (order?.driver_id) {
        const [vehs] = await pool.query('SELECT id, plate, model, lat, lon, speed_kph, updated_at FROM hermes_vehicles WHERE driver_id = ? LIMIT 1', [order.driver_id]);
        if (vehs.length) vehicle = vehs[0];
      }
    }
    return reply.send({ valid: true, data: verified.data, order, vehicle, driver, stops });
  } catch {
    return reply.code(500).send({ valid: false, error: 'Falha ao validar token de rastreio' });
  }
});

// ─── AUTENTICAÇÃO ────────────────────────────────────────────────────────────
fastify.post('/api/auth/admin/login', async (request, reply) => {
  const { identifier, email, username, password } = request.body || {};
  const loginId = identifier || email || username;
  const user = await authenticateUser(loginId, password, ['super_admin', 'admin', 'staff', 'user']);
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
    `SELECT uuid, company_uuid, username, email, name, type FROM users WHERE type IN ('super_admin', 'admin') AND deleted_at IS NULL ORDER BY FIELD(type, 'super_admin', 'admin'), created_at ASC LIMIT 1`
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
//
// ─── CANAIS DE RÁDIO (REDES SEPARADAS) ──────────────────────────────────────
//   • Rede Geral da Cooperativa : radio-cooperativa-geral
//     (todos os motoristas online + a Central se falam)
//   • Rede por Empresa/Cliente  : radio-cliente-<uuid do cliente>
//   O nome da sala legado (radio-frota-geral) continua aceito para não
//   quebrar APK/sessões antigas em produção.
const RADIO_ROOM_GENERAL = 'radio-cooperativa-geral';
const RADIO_ROOM_LEGACY = 'radio-frota-geral';

function radioRoomForClient(uuid) {
  return `radio-cliente-${uuid}`;
}

function bearerToken(request) {
  const auth = request.headers.authorization || '';
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : null;
}

// Lista de canais: geral + um por cliente/empresa.
// Clientes vêm de users(type=customer) e também de hermes_orders
// (client_user_uuid/client_name) — um cliente que só aparece em corridas
// ainda precisa de um canal próprio.
async function listRadioChannels() {
  const channels = [{
    id: 'general',
    name: 'Rede Geral (Todos os Motoboys)',
    room: RADIO_ROOM_GENERAL,
    general: true
  }];

  const seen = new Map();
  try {
    const [users] = await pool.query(
      `SELECT uuid, name FROM users
       WHERE type = 'customer' AND deleted_at IS NULL AND status = 'active'
       ORDER BY name ASC`
    );
    for (const u of users) {
      if (u.uuid && !seen.has(u.uuid)) {
        seen.set(u.uuid, { id: u.uuid, name: u.name || u.uuid, room: radioRoomForClient(u.uuid), general: false });
      }
    }
  } catch {}

  try {
    const [orders] = await pool.query(
      `SELECT client_user_uuid, MAX(client_name) AS client_name
       FROM hermes_orders
       WHERE client_user_uuid IS NOT NULL AND client_user_uuid <> ''
       GROUP BY client_user_uuid
       ORDER BY client_name ASC`
    );
    for (const o of orders) {
      if (o.client_user_uuid && !seen.has(o.client_user_uuid)) {
        seen.set(o.client_user_uuid, { id: o.client_user_uuid, name: o.client_name || o.client_user_uuid, room: radioRoomForClient(o.client_user_uuid), general: false });
      }
    }
  } catch {}

  for (const c of seen.values()) channels.push(c);
  return channels;
}

// Só libera salas conhecidas: a geral, a legada ou a de um cliente cadastrado.
async function isAllowedRadioRoom(roomName) {
  if (roomName === RADIO_ROOM_GENERAL || roomName === RADIO_ROOM_LEGACY) return true;
  if (!String(roomName).startsWith('radio-cliente-')) return false;
  const uuid = String(roomName).slice('radio-cliente-'.length);
  if (!/^[a-zA-Z0-9-]{8,64}$/.test(uuid)) return false;
  try {
    const [rows] = await pool.query('SELECT uuid FROM users WHERE uuid = ? LIMIT 1', [uuid]);
    if (rows.length) return true;
    const [orders] = await pool.query('SELECT client_user_uuid FROM hermes_orders WHERE client_user_uuid = ? LIMIT 1', [uuid]);
    return orders.length > 0;
  } catch {
    return false;
  }
}

async function handleLiveKitToken(request, reply) {
  const user = await requireAuth(request, reply);
  if (!user) return;
  const identity = request.query.identity || `${user.type || 'gestor'}_${user.sub || Math.floor(Math.random() * 1000)}`;
  const roomName = request.params?.room || request.query.room || RADIO_ROOM_GENERAL;
  const purpose = String(request.query.purpose || 'central').toLowerCase();

  const SCOPES = {
    vision: [TrackSource.CAMERA],
    ptt: [TrackSource.MICROPHONE],
    central: [TrackSource.MICROPHONE],
    driver: [TrackSource.MICROPHONE, TrackSource.CAMERA]
  };
  const canPublishSources = SCOPES[purpose] || SCOPES.central;

  const access = await validateLiveKitRoomAccess(user, roomName);
  if (!access.allowed) {
    if (!(await isAllowedRadioRoom(roomName))) {
      return reply.code(403).send({ error: access.error || 'Acesso negado ao canal de rádio.', room: roomName });
    }
  }

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
      purpose
    });
  } catch (err) {
    fastify.log.error(err);
    return reply.code(500).send({ error: 'Erro ao gerar token LiveKit' });
  }
}

fastify.get('/api/livekit/token', handleLiveKitToken);
fastify.get('/api/livekit/token/:room', handleLiveKitToken);

// Canais de rádio: geral da cooperativa + um por empresa/cliente.
// Central (admin/staff) e Motorista (token de driver) consomem o mesmo catálogo.
fastify.get('/api/radio/channels', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const channels = await listRadioChannels();
  return reply.send({ general: RADIO_ROOM_GENERAL, legacy: RADIO_ROOM_LEGACY, channels });
});

fastify.get('/api/driver/radio-channels', async (request, reply) => {
  const token = bearerToken(request);
  if (token) {
    const decoded = verifySessionToken(token);
    if (!decoded) return reply.code(401).send({ error: 'Sessão expirada. Faça login novamente.' });
  }
  const channels = await listRadioChannels();
  return reply.send({ general: RADIO_ROOM_GENERAL, legacy: RADIO_ROOM_LEGACY, channels });
});

// ─── TARIFAS & PREÇOS ────────────────────────────────────────────────────────
fastify.get('/api/tariffs', async (request, reply) => {
  const [rows] = await pool.query(
    `SELECT id, organization_id, fleet_type, label, base_fee, km_franquia, per_km_fee,
            adicional_retorno, adicional_parada_extra, adicional_noturno_ou_clima,
            adicional_noturno_ativo, coop_fee_pct, active
     FROM hermes_tariffs ORDER BY id ASC`
  );
  return reply.send(rows);
});

fastify.put('/api/tariffs/:fleet_type', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { fleet_type } = request.params;
  const {
    base_fee, km_franquia, per_km_fee,
    adicional_retorno, adicional_parada_extra,
    adicional_noturno_ou_clima, adicional_noturno_ativo,
    coop_fee_pct, label
  } = request.body || {};

  if (user.is_demo) {
    const t = demoState.tariffs.find(x => x.fleet_type === fleet_type);
    if (t) {
      if (base_fee !== undefined) t.base_fee = Number(base_fee);
      if (km_franquia !== undefined) t.km_franquia = Number(km_franquia);
      if (per_km_fee !== undefined) t.per_km_fee = Number(per_km_fee);
      if (adicional_retorno !== undefined) t.adicional_retorno = Number(adicional_retorno);
      if (adicional_parada_extra !== undefined) t.adicional_parada_extra = Number(adicional_parada_extra);
      if (adicional_noturno_ou_clima !== undefined) t.adicional_noturno_ou_clima = Number(adicional_noturno_ou_clima);
      if (adicional_noturno_ativo !== undefined) t.adicional_noturno_ativo = adicional_noturno_ativo ? 1 : 0;
      if (coop_fee_pct !== undefined) t.coop_fee_pct = Number(coop_fee_pct);
      if (label) t.label = label;
    }
    return reply.send(t || {});
  }

  await pool.query(
    `UPDATE hermes_tariffs SET
      base_fee = COALESCE(?, base_fee),
      km_franquia = COALESCE(?, km_franquia),
      per_km_fee = COALESCE(?, per_km_fee),
      adicional_retorno = COALESCE(?, adicional_retorno),
      adicional_parada_extra = COALESCE(?, adicional_parada_extra),
      adicional_noturno_ou_clima = COALESCE(?, adicional_noturno_ou_clima),
      adicional_noturno_ativo = COALESCE(?, adicional_noturno_ativo),
      coop_fee_pct = COALESCE(?, coop_fee_pct),
      label = COALESCE(?, label)
     WHERE fleet_type = ?`,
    [
      base_fee ?? null, km_franquia ?? null, per_km_fee ?? null,
      adicional_retorno ?? null, adicional_parada_extra ?? null,
      adicional_noturno_ou_clima ?? null,
      adicional_noturno_ativo !== undefined ? (adicional_noturno_ativo ? 1 : 0) : null,
      coop_fee_pct ?? null, label ?? null, fleet_type
    ]
  );
  const [rows] = await pool.query('SELECT * FROM hermes_tariffs WHERE fleet_type = ?', [fleet_type]);
  return reply.send(rows[0] || {});
});

// ─── SPLIT DA COOPERATIVA ────────────────────────────────────────────────────
fastify.get('/api/split-rules', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const [rows] = await pool.query(`
    SELECT r.*, d.name AS driver_name
    FROM hermes_split_rules r
    LEFT JOIN hermes_drivers d ON r.driver_id = d.id
    ORDER BY r.driver_id IS NOT NULL ASC, r.updated_at DESC
  `);
  return reply.send(rows);
});

fastify.put('/api/split-rules', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { organization_id, driver_id, split_type, coop_value, extras_to_driver_100 } = request.body || {};
  const orgId = organization_id || 'default';
  const drvId = driver_id || null;
  const sType = ['percentual', 'taxa_fixa_por_corrida'].includes(split_type) ? split_type : 'percentual';
  const val = Number(coop_value ?? 15);
  const extras100 = extras_to_driver_100 !== undefined ? (extras_to_driver_100 ? 1 : 0) : 1;

  if (drvId) {
    const [existing] = await pool.query('SELECT id FROM hermes_split_rules WHERE organization_id = ? AND driver_id = ? LIMIT 1', [orgId, drvId]);
    if (existing.length) {
      await pool.query(
        'UPDATE hermes_split_rules SET split_type = ?, coop_value = ?, extras_to_driver_100 = ? WHERE id = ?',
        [sType, val, extras100, existing[0].id]
      );
    } else {
      await pool.query(
        'INSERT INTO hermes_split_rules (id, organization_id, driver_id, split_type, coop_value, extras_to_driver_100) VALUES (?, ?, ?, ?, ?, ?)',
        [genId('split'), orgId, drvId, sType, val, extras100]
      );
    }
  } else {
    const [existing] = await pool.query('SELECT id FROM hermes_split_rules WHERE organization_id = ? AND driver_id IS NULL LIMIT 1', [orgId]);
    if (existing.length) {
      await pool.query(
        'UPDATE hermes_split_rules SET split_type = ?, coop_value = ?, extras_to_driver_100 = ? WHERE id = ?',
        [sType, val, extras100, existing[0].id]
      );
    } else {
      await pool.query(
        'INSERT INTO hermes_split_rules (id, organization_id, driver_id, split_type, coop_value, extras_to_driver_100) VALUES (?, ?, NULL, ?, ?, ?)',
        [genId('split'), orgId, sType, val, extras100]
      );
    }
  }
  const [rows] = await pool.query('SELECT * FROM hermes_split_rules ORDER BY driver_id IS NOT NULL ASC');
  return reply.send(rows);
});

// ─── FROTA: VEÍCULOS, MOTORISTAS E PONTOS ────────────────────────────────────
async function handleFleetLive(request, reply) {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) return reply.send(demoState.vehicles);
  const { network_uuid } = request.query || {};
  const isSuper = user.type === 'super_admin';
  const orgId = user.company_uuid || 'default';

  const vParams = [];
  let vSql = `
    SELECT v.*, d.name AS driver_name, d.whatsapp AS driver_whatsapp
    FROM hermes_vehicles v
    LEFT JOIN hermes_drivers d ON v.driver_id = d.id
    WHERE 1=1
  `;
  if (!isSuper) {
    vSql += ` AND (v.organization_id = ? OR v.organization_id = 'default' OR v.organization_id IS NULL)`;
    vParams.push(orgId);
  }
  if (network_uuid && network_uuid !== 'all') {
    vSql += ` AND v.driver_id IN (SELECT subject_id FROM hj_network_members WHERE subject_type = 'driver' AND status = 'active' AND network_uuid = ?)`;
    vParams.push(network_uuid);
  }
  vSql += ` ORDER BY v.updated_at DESC`;
  const [rows] = await pool.query(vSql, vParams);

  const linkedDriverIds = new Set(rows.map(r => r.driver_id).filter(Boolean));
  const dParams = [];
  let dSql = `
    SELECT id, name, whatsapp, plate, fleet_type, status, lat, lon, online
    FROM hermes_drivers
    WHERE online = 1 AND lat IS NOT NULL AND lon IS NOT NULL
  `;
  if (network_uuid && network_uuid !== 'all') {
    dSql += ` AND id IN (SELECT subject_id FROM hj_network_members WHERE subject_type = 'driver' AND status = 'active' AND network_uuid = ?)`;
    dParams.push(network_uuid);
  }
  const [onlineDrivers] = await pool.query(dSql, dParams);
  const driverPins = onlineDrivers
    .filter(d => !linkedDriverIds.has(d.id))
    .map(d => ({
      id: d.id,
      plate: d.plate,
      model: d.fleet_type || 'moto',
      fleet_type: d.fleet_type || 'moto',
      driver_id: d.id,
      driver_name: d.name,
      driver_whatsapp: d.whatsapp,
      status: d.status || 'disponivel',
      lat: d.lat,
      lon: d.lon,
      speed_kph: 0,
      signal_ok: true,
      health_badge: 'ok'
    }));
  const decorated = await decorateVehiclesWithHealth(rows);
  return reply.send([...decorated, ...driverPins]);
}

fastify.get('/api/vehicles', handleFleetLive);
fastify.get('/api/fleet/live', handleFleetLive);

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
  const { name, whatsapp, plate, fleet_type, commission_pct, online, pix_key } = request.body || {};
  if (!name || !whatsapp || !plate) return reply.code(400).send({ error: 'Nome, WhatsApp e placa são obrigatórios.' });
  const id = genId('mot');

  if (user.is_demo) {
    const d = { id, name, whatsapp, plate: plate.toUpperCase(), fleet_type: fleet_type || 'moto', commission_pct: commission_pct ?? 80, pix_key: pix_key || null, online: online ? 1 : 0, status: 'disponivel', lat: -5.7945, lon: -35.2084 };
    demoState.drivers.unshift(d);
    return reply.code(201).send(d);
  }

  await pool.query(
    `INSERT INTO hermes_drivers (id, name, whatsapp, plate, fleet_type, commission_pct, pix_key, online, status, lat, lon)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'disponivel', -5.7945, -35.2084)`,
    [id, name, whatsapp, plate.toUpperCase(), fleet_type || 'moto', commission_pct ?? 80, pix_key || null, online ? 1 : 0]
  );
  const [rows] = await pool.query('SELECT * FROM hermes_drivers WHERE id = ?', [id]);
  return reply.code(201).send(rows[0]);
});

fastify.patch('/api/drivers/:id', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const { online, commission_pct, status, pix_key } = request.body || {};
  if (user.is_demo) {
    const d = demoState.drivers.find(x => x.id === request.params.id);
    if (d) {
      if (online !== undefined) d.online = online ? 1 : 0;
      if (commission_pct !== undefined) d.commission_pct = Number(commission_pct);
      if (status) d.status = status;
      if (pix_key !== undefined) d.pix_key = pix_key;
    }
    return reply.send(d || {});
  }
  await pool.query(
    `UPDATE hermes_drivers SET
      online = COALESCE(?, online),
      commission_pct = COALESCE(?, commission_pct),
      status = COALESCE(?, status),
      pix_key = COALESCE(?, pix_key)
     WHERE id = ?`,
    [online !== undefined ? (online ? 1 : 0) : null, commission_pct ?? null, status ?? null, pix_key ?? null, request.params.id]
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
  const { status, network_uuid } = request.query || {};

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
  } else if (user.type !== 'super_admin') {
    sql += ` AND organization_id IN (?, 'default')`;
    params.push(user.company_uuid || 'default');
  }
  if (network_uuid && network_uuid !== 'all') {
    sql += ' AND network_uuid = ?';
    params.push(network_uuid);
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
    requires_return,
    network_uuid,
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
  const extraStopsCount = Math.max(0, destList.length - 1);
  const pricing = calculateOrderPricing(tariff, {
    distance_km: km,
    extra_stops_count: extraStopsCount,
    requires_return: Boolean(requires_return)
  });
  const calculatedPrice = pricing.valor_total_cliente;
  const coopFeePct = Number(tariff.coop_fee_pct || 15);
  const driverCommPct = Number((100 - coopFeePct).toFixed(2));
  const orgId = user.company_uuid || 'default';
  let resolvedNetworkUuid = null;
  if (network_uuid) {
    const [netRows] = await pool.query(
      `SELECT uuid FROM fleets WHERE uuid = ? AND deleted_at IS NULL AND (company_uuid = ? OR uuid = 'net_geral_00000000000000000000000001') LIMIT 1`,
      [network_uuid, orgId]
    );
    if (netRows.length) resolvedNetworkUuid = netRows[0].uuid;
  }

  const initialStatus = isScheduled ? 'agendado' : 'pendente';
  const orderId = `${user.is_demo ? 'DEMO' : 'OS'}-${Date.now().toString().slice(-6)}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;

  if (user.is_demo) {
    const demoOrder = {
      id: orderId,
      organization_id: orgId,
      client_name: client_name || user.name,
      fleet_type,
      status: initialStatus,
      queue_mode: 'direto',
      origin_address,
      destinations: destList,
      distance_km: km,
      duration_min: routeInfo.duration_min,
      route_source: routeInfo.source,
      requires_return: Boolean(requires_return),
      extra_stops_count: extraStopsCount,
      pricing_snapshot: pricing.snapshot,
      valor_total_cliente: calculatedPrice,
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
      id, organization_id, network_uuid, client_user_uuid, client_name, fleet_type, status, queue_mode,
      origin_address, origin_lat, origin_lon, destinations_json, distance_km, duration_min, route_source,
      requires_return, extra_stops_count, pricing_snapshot_json,
      recipient_name, recipient_whatsapp, invoice_number, notes,
      payment_method, cargo_weight_kg, cargo_volume, cargo_type,
      estimated_price, final_price, valor_total_cliente, coop_fee_pct, driver_commission_pct,
      scheduled_at, tracking_token
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 'direto', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      orderId, orgId, resolvedNetworkUuid, ownerUuid, ownerName, fleet_type, initialStatus,
      origin_address, oLat, oLon, JSON.stringify(destList), km, routeInfo.duration_min, routeInfo.source,
      requires_return ? 1 : 0, extraStopsCount, JSON.stringify(pricing.snapshot),
      recipient_name || null, recipient_whatsapp || null, invoice_number || null, notes || null,
      validPayment, cargo_weight_kg ? Number(cargo_weight_kg) : null, cargo_volume || null, cargo_type || null,
      calculatedPrice, calculatedPrice, calculatedPrice, coopFeePct, driverCommPct,
      isScheduled ? new Date(scheduled_at) : null, trackingToken
    ]
  );

  const [created] = await pool.query('SELECT * FROM hermes_orders WHERE id = ?', [orderId]);
  const order = {
    ...created[0],
    destinations: parseJsonField(created[0].destinations_json, []),
    pricing_snapshot: parseJsonField(created[0].pricing_snapshot_json, {})
  };
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

  await lockOrderCreditOnStart(id);

  await notifyDriverPush(driver.id, {
    title: 'Nova corrida atribuída',
    body: `${id} · Origem: ${orders[0].origin_address}`,
    url: '/motorista'
  });

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

  await notifyQueuePush(orders[0].organization_id, {
    title: 'Nova corrida na fila aberta',
    body: `${id} (${orders[0].fleet_type}) · ${orders[0].origin_address}`,
    url: '/motorista'
  });

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

  await releaseOrderCreditOnComplete(id);

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

  await lockOrderCreditOnStart(id);

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
  const { driver_id, proof_photo_url, proof_notes, recipient_name, lat, lon } = request.body || {};

  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });
  if (driver_id && orders[0].driver_id && orders[0].driver_id !== driver_id) {
    return reply.code(403).send({ error: 'Corrida atribuída a outro motorista.' });
  }

  const requireDeliveryPhoto = String(process.env.REQUIRE_DELIVERY_PHOTO || 'false').toLowerCase() === 'true';
  if (requireDeliveryPhoto && !proof_photo_url) {
    return reply.code(400).send({ error: 'Esta organização exige foto de comprovação para encerrar a entrega.' });
  }

  const gpsNote = (lat !== undefined && lon !== undefined) ? ` (GPS: ${lat}, ${lon})` : '';
  const recNote = recipient_name ? `Recebido por: ${recipient_name}. ` : '';
  const finalNotes = `${recNote}${proof_notes || 'Entrega concluída via Navigator'}${gpsNote}`.trim();

  await pool.query(
    `UPDATE hermes_orders SET status = 'concluido', completed_at = NOW(), proof_photo_url = ?, proof_notes = ? WHERE id = ?`,
    [proof_photo_url || null, finalNotes, id]
  );

  await releaseOrderCreditOnComplete(id);

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

// ─── PWA DRIVER LOGIN, PUSH & ACTIVE ORDERS ──────────────────────────────────
fastify.post('/api/driver/login', async (request, reply) => {
  const { identifier, plate, demo } = request.body || {};
  if (demo && DEMO_MODE) {
    const drv = demoState.drivers[0];
    const veh = demoState.vehicles.find(v => v.driver_id === drv.id) || demoState.vehicles[0];
    const driverObj = { ...drv, vehicle_id: veh?.id || null, organization_id: DEMO_COMPANY.uuid };
    const token = signSessionToken({ uuid: drv.id, username: drv.plate, email: drv.whatsapp, name: drv.name, type: 'driver', company_uuid: DEMO_COMPANY.uuid });
    return reply.send({ token, driver: driverObj, is_demo: true });
  }
  const cleanId = String(identifier || '').trim();
  const cleanDigits = cleanId.replace(/\D/g, '');
  const cleanPlate = String(plate || cleanId).trim().toUpperCase();
  if (!cleanId) return reply.code(400).send({ error: 'Informe seu WhatsApp ou placa cadastrada.' });

  const [rows] = await pool.query(
    `SELECT d.*, v.id AS vehicle_id
     FROM hermes_drivers d
     LEFT JOIN hermes_vehicles v ON v.driver_id = d.id
     WHERE d.id = ? OR d.plate = ? OR d.whatsapp = ? OR (? <> '' AND REPLACE(REPLACE(REPLACE(d.whatsapp,' ',''),'-',''),'+','') LIKE ?)
     LIMIT 1`,
    [cleanId, cleanPlate, cleanId, cleanDigits, `%${cleanDigits}`]
  );
  if (!rows.length) {
    return reply.code(401).send({ error: 'Motorista não encontrado. Verifique o WhatsApp ou placa.' });
  }
  const d = rows[0];
  const token = signSessionToken({ uuid: d.id, username: d.plate, email: d.whatsapp, name: d.name, type: 'driver', company_uuid: d.organization_id || 'default' });
  return reply.send({ token, driver: d, is_demo: false });
});

fastify.get('/api/driver/orders/active', async (request, reply) => {
  const { driver_id } = request.query || {};
  if (!driver_id) return reply.send([]);
  const [rows] = await pool.query(
    `SELECT * FROM hermes_orders WHERE driver_id = ? AND status = 'em_rota' ORDER BY accepted_at DESC LIMIT 20`,
    [driver_id]
  );
  return reply.send(rows.map(o => ({ ...o, destinations: parseJsonField(o.destinations_json, []) })));
});

fastify.post('/api/driver/orders/:id/arrived', async (request, reply) => {
  const { id } = request.params;
  const [orders] = await pool.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [id]);
  if (!orders.length) return reply.code(404).send({ error: 'Corrida não encontrada.' });
  await pool.query(`UPDATE hermes_orders SET notes = CONCAT(COALESCE(notes,''), ' [Motorista chegou na coleta]') WHERE id = ?`, [id]);
  return reply.send({ ok: true, id });
});

// ─── STATUS ONLINE / OFFLINE DO MOTORISTA ───────────────────────────────────
// Botão grande no PWA do Motorista:
//   online  → volta a receber corridas na fila (online = 1)
//   offline → pausa o rastreio e some da fila (online = 0)
// Só mexe na flag `online`; o status operacional (disponivel/em_rota) é
// preservado para não quebrar o financeiro (saldo bloqueado) da carteira.
// GET: estado atual de presença do motorista (sincroniza o botão do PWA).
fastify.get('/api/driver/status', async (request, reply) => {
  const { driver_id } = request.query || {};
  const driverId = String(driver_id || '').trim();
  if (!driverId) return reply.code(400).send({ error: 'driver_id é obrigatório.' });

  const token = bearerToken(request);
  if (token) {
    const decoded = verifySessionToken(token);
    if (!decoded) return reply.code(401).send({ error: 'Sessão expirada. Faça login novamente.' });
    if (decoded.type === 'driver' && String(decoded.sub) !== driverId) {
      return reply.code(403).send({ error: 'Não é permitido consultar o status de outro motorista.' });
    }
  }

  const [rows] = await pool.query(
    'SELECT id, name, plate, online, status, fleet_type FROM hermes_drivers WHERE id = ?',
    [driverId]
  );
  if (!rows.length) return reply.code(404).send({ error: 'Motorista não encontrado.' });
  return reply.send({ ok: true, driver: rows[0], online: !!rows[0].online });
});

fastify.post('/api/driver/status', async (request, reply) => {
  const { driver_id, status } = request.body || {};
  const desired = String(status || '').trim().toLowerCase();
  const driverId = String(driver_id || '').trim();

  if (!driverId) return reply.code(400).send({ error: 'driver_id é obrigatório.' });
  if (!['online', 'offline'].includes(desired)) {
    return reply.code(400).send({ error: "status deve ser 'online' ou 'offline'." });
  }

  // Se vier token, ele precisa ser de motorista (ou gestão) e bater com o driver_id.
  const token = bearerToken(request);
  if (token) {
    const decoded = verifySessionToken(token);
    if (!decoded) return reply.code(401).send({ error: 'Sessão expirada. Faça login novamente.' });
    if (decoded.type === 'driver' && String(decoded.sub) !== driverId) {
      return reply.code(403).send({ error: 'Não é permitido alterar o status de outro motorista.' });
    }
  }

  const [drivers] = await pool.query('SELECT id FROM hermes_drivers WHERE id = ? LIMIT 1', [driverId]);
  if (!drivers.length) {
    // Motorista de demonstração (não existe na tabela): aceita e devolve o
    // estado sem gravar — a Central em modo demo usa o estado em memória.
    if (DEMO_MODE) {
      return reply.send({ ok: true, demo: true, driver: { id: driverId }, online: desired === 'online', status: desired });
    }
    return reply.code(404).send({ error: 'Motorista não encontrado.' });
  }

  await pool.query('UPDATE hermes_drivers SET online = ? WHERE id = ?', [desired === 'online' ? 1 : 0, driverId]);

  const [rows] = await pool.query(
    'SELECT id, name, plate, online, status, fleet_type FROM hermes_drivers WHERE id = ?',
    [driverId]
  );
  return reply.send({ ok: true, driver: rows[0], online: !!rows[0].online, status: desired });
});

fastify.get('/api/push/vapid-public-key', async () => ({
  publicKey: VAPID_PUBLIC_KEY
}));

fastify.post('/api/push/subscribe', async (request, reply) => {
  const { driver_id, organization_id, subscription } = request.body || {};
  try {
    await saveSubscription({ driverId: driver_id, organizationId: organization_id || 'default', subscription });
    return reply.code(201).send({ ok: true });
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

// ─── CARTEIRA DIGITAL, LEDGER & LOTES DE FECHAMENTO ──────────────────────────
fastify.get('/api/wallet/summary', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  if (user.is_demo) {
    return reply.send(demoState.drivers.map(d => ({
      ...d,
      pix_key: d.pix_key || d.whatsapp,
      saldo_disponivel: d.id === 'demo_drv_1' ? 185.40 : (d.id === 'demo_drv_4' ? 412.80 : 0),
      saldo_bloqueado: d.status === 'em_rota' ? 45.00 : 0,
      saldo_pago: 952.00,
      lancamentos_disponiveis: d.id === 'demo_drv_1' || d.id === 'demo_drv_4' ? 3 : 0
    })));
  }
  const summary = await getDriversWalletSummary(user.company_uuid || 'default');
  return reply.send(summary);
});

fastify.get('/api/wallet/driver/:driver_id', async (request, reply) => {
  const { driver_id } = request.params;
  const statement = await getDriverWalletStatement(driver_id);
  return reply.send(statement);
});

fastify.post('/api/wallet/adjustments', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  try {
    const { driver_id, tipo, valor, descricao } = request.body || {};
    if (!driver_id || !tipo || valor === undefined) {
      return reply.code(400).send({ error: 'driver_id, tipo e valor são obrigatórios.' });
    }
    const tx = await createManualAdjustment({
      organizationId: user.company_uuid || 'default',
      driverId: driver_id,
      tipo,
      valor,
      descricao
    });
    return reply.code(201).send(tx);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

fastify.get('/api/wallet/batches', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  const [rows] = await pool.query('SELECT * FROM payout_batches ORDER BY created_at DESC LIMIT 100');
  return reply.send(rows);
});

fastify.post('/api/wallet/batches', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  try {
    const { driver_ids, notes } = request.body || {};
    const batch = await createPayoutBatch({
      organizationId: user.company_uuid || 'default',
      driverIds: driver_ids || [],
      notes
    });
    return reply.code(201).send(batch);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

fastify.post('/api/wallet/batches/:id/pay', async (request, reply) => {
  const user = await requireAuth(request, reply, ['admin', 'staff']);
  if (!user) return;
  try {
    const batch = await payPayoutBatch(request.params.id);
    return reply.send(batch);
  } catch (err) {
    return reply.code(400).send({ error: err.message });
  }
});

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

registerNetworkRoutes(fastify);

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
