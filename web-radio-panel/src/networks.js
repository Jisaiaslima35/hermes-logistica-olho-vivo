const crypto = require('crypto');
const { AccessToken, TrackSource } = require('livekit-server-sdk');
const { pool } = require('./db');
const { requireAuth } = require('./auth');
const { demoState } = require('./demo');

const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://livekit.automacaojs.us';

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(6).toString('hex')}`;
}

async function logPlatformAudit({ actor = null, companyUuid = null, networkUuid = null, action, targetType = null, targetId = null, details = null, ip = null }) {
  try {
    await pool.query(
      `INSERT INTO hj_platform_audit (actor_uuid, actor_name, actor_role, company_uuid, network_uuid, action, target_type, target_id, details_json, ip_address)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        actor?.sub || actor?.uuid || null,
        actor?.name || actor?.username || null,
        actor?.type || null,
        companyUuid || actor?.company_uuid || null,
        networkUuid || null,
        action,
        targetType,
        targetId,
        details ? JSON.stringify(details) : null,
        ip || null
      ]
    );
  } catch {}
}

async function validateLiveKitRoomAccess(user, roomName) {
  const room = String(roomName || '').trim();
  if (!room) return { ok: false, status: 400, error: 'Sala LiveKit inválida.' };

  // Aliases legados
  if (room === 'radio-frota-geral' || room === 'radio-cooperativa-geral') {
    return { ok: true, room };
  }
  if (room.startsWith('radio-cliente-')) {
    const target = room.slice('radio-cliente-'.length);
    if (user.type === 'super_admin' || user.type === 'admin' || user.sub === target || user.company_uuid === target) {
      return { ok: true, room };
    }
    return { ok: false, status: 403, error: 'Sem permissão para esta sala de cliente.' };
  }

  // Salas por enxame: px-<uuid> ou vision-<uuid>
  let netUuid = null;
  if (room.startsWith('px-')) netUuid = room.slice(3);
  else if (room.startsWith('vision-')) netUuid = room.slice(7);

  if (!netUuid) {
    if (user.type === 'super_admin') return { ok: true, room };
    return { ok: false, status: 403, error: 'Nome de sala LiveKit não autorizado.' };
  }

  const [nets] = await pool.query(
    `SELECT f.uuid, f.company_uuid, f.status AS net_status, c.status AS comp_status
       FROM fleets f
       LEFT JOIN companies c ON c.uuid = f.company_uuid
      WHERE f.uuid = ? AND f.deleted_at IS NULL AND (c.deleted_at IS NULL OR c.uuid IS NULL)
      LIMIT 1`,
    [netUuid]
  );

  if (!nets.length) {
    return { ok: false, status: 404, error: 'Enxame/Rede não encontrado.' };
  }
  const net = nets[0];
  if (net.comp_status === 'paused' || net.net_status === 'paused') {
    return { ok: false, status: 403, error: 'Organização ou Enxame pausado pela administração.' };
  }
  if (user.type === 'super_admin') return { ok: true, room, network: net };

  if (user.company_uuid && user.company_uuid === net.company_uuid) {
    return { ok: true, room, network: net };
  }

  const [mems] = await pool.query(
    `SELECT id FROM hj_network_members WHERE network_uuid = ? AND subject_id = ? AND status = 'active' LIMIT 1`,
    [netUuid, user.sub]
  );
  if (mems.length) return { ok: true, room, network: net };

  return { ok: false, status: 403, error: 'Usuário não pertence a este enxame/organização.' };
}

async function issueNetworkLiveKitToken(user, roomName, purpose) {
  const SCOPES = {
    vision: [TrackSource.CAMERA],
    ptt: [TrackSource.MICROPHONE],
    central: [TrackSource.MICROPHONE],
    driver: [TrackSource.MICROPHONE, TrackSource.CAMERA]
  };
  const canPublishSources = SCOPES[purpose] || SCOPES.central;
  const identity = `${user.type === 'driver' ? 'drv' : 'usr'}_${user.sub || crypto.randomBytes(3).toString('hex')}`;

  const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
    identity,
    name: user.name || user.username || identity,
    ttl: '1h'
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
    canPublishSources
  });
  const token = await at.toJwt();
  return { token, url: LIVEKIT_URL, room: roomName, identity, purpose };
}

function registerNetworkRoutes(fastify) {
  // ─── SESSÃO & SELETOR DE REDE ──────────────────────────────────────────────
  fastify.get('/api/session/networks', async (request, reply) => {
    const user = await requireAuth(request, reply);
    if (!user) return;

    if (user.is_demo) {
      return reply.send({
        is_demo: true,
        scope: 'demo',
        organizations: [{ uuid: 'demo_coop_transportes', name: 'Demo Cooperativa & Transportes', status: 'active' }],
        networks: [{ uuid: 'demo_net_geral', company_uuid: 'demo_coop_transportes', name: 'Rede Geral Demo', slug: 'rede-geral-demo', status: 'active', color: '#2563EB' }]
      });
    }

    if (user.type === 'super_admin') {
      const [orgs] = await pool.query(`SELECT uuid, name, status FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC`);
      const [nets] = await pool.query(`SELECT uuid, company_uuid, name, slug, status, color FROM fleets WHERE deleted_at IS NULL ORDER BY created_at ASC`);
      return reply.send({ scope: 'all', organizations: orgs, networks: nets });
    }

    if (['admin', 'staff', 'user'].includes(user.type)) {
      const [orgs] = await pool.query(`SELECT uuid, name, status FROM companies WHERE uuid = ? AND deleted_at IS NULL`, [user.company_uuid]);
      const [nets] = await pool.query(`SELECT uuid, company_uuid, name, slug, status, color FROM fleets WHERE company_uuid = ? AND deleted_at IS NULL ORDER BY created_at ASC`, [user.company_uuid]);
      return reply.send({ scope: 'company', organizations: orgs, networks: nets });
    }

    // Operador / Motorista: enxames vinculados (ou da própria org se não tiver vínculo exclusivo)
    const [nets] = await pool.query(
      `SELECT DISTINCT f.uuid, f.company_uuid, f.name, f.slug, f.status, f.color
         FROM fleets f
         LEFT JOIN hj_network_members m ON m.network_uuid = f.uuid AND m.subject_id = ? AND m.status = 'active'
        WHERE f.deleted_at IS NULL AND f.status = 'active'
          AND (m.id IS NOT NULL OR f.company_uuid = ?)
        ORDER BY f.created_at ASC`,
      [user.sub, user.company_uuid || '']
    );
    return reply.send({ scope: 'member', organizations: [], networks: nets });
  });

  fastify.post('/api/session/network', async (request, reply) => {
    const user = await requireAuth(request, reply);
    if (!user) return;
    const { network_uuid } = request.body || {};
    if (!network_uuid) return reply.code(400).send({ error: 'network_uuid obrigatório.' });

    const [nets] = await pool.query(
      `SELECT f.*, c.status AS comp_status FROM fleets f LEFT JOIN companies c ON c.uuid = f.company_uuid WHERE f.uuid = ? AND f.deleted_at IS NULL LIMIT 1`,
      [network_uuid]
    );
    if (!nets.length) return reply.code(404).send({ error: 'Enxame não encontrado.' });
    const net = nets[0];
    if (user.type !== 'super_admin' && net.company_uuid !== user.company_uuid) {
      return reply.code(403).send({ error: 'Sem acesso a este enxame.' });
    }
    if (net.status === 'paused' || net.comp_status === 'paused') {
      return reply.code(403).send({ error: 'Enxame ou organização pausada.' });
    }

    await pool.query(
      `UPDATE hj_network_sessions SET status = 'closed', ended_at = NOW() WHERE started_by = ? AND status = 'open'`,
      [user.sub]
    );

    const sessionId = genId('nsess');
    const livekitRoom = `px-${net.uuid}`;
    const visionRoom = `vision-${net.uuid}`;
    await pool.query(
      `INSERT INTO hj_network_sessions (id, network_uuid, company_uuid, livekit_room, vision_room, status, started_by)
       VALUES (?, ?, ?, ?, ?, 'open', ?)`,
      [sessionId, net.uuid, net.company_uuid, livekitRoom, visionRoom, user.sub]
    );

    await logPlatformAudit({
      actor: user,
      companyUuid: net.company_uuid,
      networkUuid: net.uuid,
      action: 'network.session.switch',
      targetType: 'network',
      targetId: net.uuid,
      ip: request.ip
    });

    const [members] = await pool.query(
      `SELECT COUNT(*) AS total FROM hj_network_members WHERE network_uuid = ? AND status = 'active'`,
      [net.uuid]
    );

    return reply.send({
      network: net,
      live_session: { id: sessionId, livekit_room: livekitRoom, vision_room: visionRoom, status: 'open' },
      counters: { members: members[0]?.total || 0 }
    });
  });

  fastify.get('/api/session/audit', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const limit = Math.min(parseInt(request.query?.limit || '50', 10), 200);
    if (user.type === 'super_admin') {
      const [rows] = await pool.query(`SELECT * FROM hj_platform_audit ORDER BY created_at DESC LIMIT ?`, [limit]);
      return reply.send(rows);
    }
    const [rows] = await pool.query(
      `SELECT * FROM hj_platform_audit WHERE company_uuid = ? ORDER BY created_at DESC LIMIT ?`,
      [user.company_uuid || '', limit]
    );
    return reply.send(rows);
  });

  // ─── SUPER-ADMIN: ORGANIZAÇÕES & MODELO X ──────────────────────────────────
  fastify.get('/api/admin/organizations', async (request, reply) => {
    const user = await requireAuth(request, reply, ['super_admin']);
    if (!user) return;
    const [rows] = await pool.query(`
      SELECT c.uuid, c.name, c.status, c.type, c.created_at,
             (SELECT COUNT(*) FROM fleets f WHERE f.company_uuid = c.uuid AND f.deleted_at IS NULL) AS networks_count
        FROM companies c
       WHERE c.deleted_at IS NULL
       ORDER BY c.created_at DESC
    `);
    return reply.send(rows);
  });

  fastify.post('/api/admin/organizations', async (request, reply) => {
    const user = await requireAuth(request, reply, ['super_admin']);
    if (!user) return;
    const { name, type } = request.body || {};
    if (!name) return reply.code(400).send({ error: 'Nome da organização obrigatório.' });
    const uuid = crypto.randomUUID();
    await pool.query(
      `INSERT INTO companies (uuid, owner_uuid, name, type, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'paused', NOW(), NOW())`,
      [uuid, user.sub, String(name).trim(), type || 'logistics']
    );
    await logPlatformAudit({ actor: user, companyUuid: uuid, action: 'org.create', targetType: 'company', targetId: uuid, details: { name, status: 'paused' }, ip: request.ip });
    return reply.code(201).send({ uuid, name, status: 'paused', type: type || 'logistics' });
  });

  fastify.post('/api/admin/organizations/:uuid/pause', async (request, reply) => {
    const user = await requireAuth(request, reply, ['super_admin']);
    if (!user) return;
    const { uuid } = request.params;
    await pool.query(`UPDATE companies SET status = 'paused', updated_at = NOW() WHERE uuid = ?`, [uuid]);
    await pool.query(`UPDATE hj_network_sessions SET status = 'closed', ended_at = NOW() WHERE company_uuid = ? AND status = 'open'`, [uuid]);
    await logPlatformAudit({ actor: user, companyUuid: uuid, action: 'org.pause', targetType: 'company', targetId: uuid, ip: request.ip });
    return reply.send({ ok: true, uuid, status: 'paused' });
  });

  fastify.post('/api/admin/organizations/:uuid/reactivate', async (request, reply) => {
    const user = await requireAuth(request, reply, ['super_admin']);
    if (!user) return;
    const { uuid } = request.params;
    await pool.query(`UPDATE companies SET status = 'active', updated_at = NOW() WHERE uuid = ?`, [uuid]);
    await logPlatformAudit({ actor: user, companyUuid: uuid, action: 'org.reactivate', targetType: 'company', targetId: uuid, ip: request.ip });
    return reply.send({ ok: true, uuid, status: 'active' });
  });

  fastify.delete('/api/admin/organizations/:uuid', async (request, reply) => {
    const user = await requireAuth(request, reply, ['super_admin']);
    if (!user) return;
    const { uuid } = request.params;
    await pool.query(`UPDATE companies SET deleted_at = NOW(), status = 'deleted' WHERE uuid = ?`, [uuid]);
    await pool.query(`UPDATE hj_network_sessions SET status = 'closed', ended_at = NOW() WHERE company_uuid = ? AND status = 'open'`, [uuid]);
    await logPlatformAudit({ actor: user, companyUuid: uuid, action: 'org.soft_delete', targetType: 'company', targetId: uuid, ip: request.ip });
    return reply.send({ ok: true, uuid, deleted: true });
  });

  fastify.get('/api/admin/templates', async (request, reply) => {
    const user = await requireAuth(request, reply, ['super_admin']);
    if (!user) return;
    const [rows] = await pool.query(`SELECT * FROM hj_org_templates ORDER BY created_at DESC`);
    return reply.send(rows);
  });

  fastify.post('/api/admin/templates', async (request, reply) => {
    const user = await requireAuth(request, reply, ['super_admin']);
    if (!user) return;
    const { name, version, description, config_json } = request.body || {};
    if (!name || !config_json) return reply.code(400).send({ error: 'name e config_json obrigatórios.' });
    const id = genId('tpl');
    await pool.query(
      `INSERT INTO hj_org_templates (id, name, version, description, config_json, created_by) VALUES (?, ?, ?, ?, ?, ?)`,
      [id, name, version || '1.0.0', description || '', typeof config_json === 'string' ? config_json : JSON.stringify(config_json), user.sub]
    );
    return reply.code(201).send({ id, name, version: version || '1.0.0' });
  });

  fastify.post('/api/admin/templates/:id/clone', async (request, reply) => {
    const user = await requireAuth(request, reply, ['super_admin']);
    if (!user) return;
    const { id } = request.params;
    const { organization_name } = request.body || {};
    if (!organization_name) return reply.code(400).send({ error: 'organization_name obrigatório.' });

    const [tpls] = await pool.query(`SELECT * FROM hj_org_templates WHERE id = ? LIMIT 1`, [id]);
    if (!tpls.length) return reply.code(404).send({ error: 'Template não encontrado.' });
    const cfg = typeof tpls[0].config_json === 'string' ? JSON.parse(tpls[0].config_json) : (tpls[0].config_json || {});

    const orgUuid = crypto.randomUUID();
    await pool.query(
      `INSERT INTO companies (uuid, owner_uuid, name, type, status, created_at, updated_at)
       VALUES (?, ?, ?, 'logistics', 'paused', NOW(), NOW())`,
      [orgUuid, user.sub, String(organization_name).trim()]
    );

    const createdNetworks = [];
    for (const n of (cfg.networks || [{ name: 'Rede Geral', slug: 'rede-geral', color: '#2563EB' }])) {
      const netUuid = crypto.randomUUID();
      await pool.query(
        `INSERT INTO fleets (uuid, public_id, company_uuid, name, slug, status, color, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, NOW(), NOW())`,
        [netUuid, `flt_${crypto.randomBytes(4).toString('hex')}`, orgUuid, n.name, n.slug || 'rede', n.color || '#2563EB']
      );
      createdNetworks.push({ uuid: netUuid, name: n.name });
    }

    await logPlatformAudit({
      actor: user,
      companyUuid: orgUuid,
      action: 'template.clone',
      targetType: 'template',
      targetId: id,
      details: { organization_name, networks_created: createdNetworks.length },
      ip: request.ip
    });

    return reply.code(201).send({
      organization: { uuid: orgUuid, name: organization_name, status: 'paused' },
      networks: createdNetworks
    });
  });

  // ─── CRUD DE ENXAMES / REDES ───────────────────────────────────────────────
  fastify.get('/api/networks', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const sql = user.type === 'super_admin'
      ? `SELECT f.*, c.name AS company_name,
                (SELECT COUNT(*) FROM hj_network_members m WHERE m.network_uuid = f.uuid AND m.status = 'active') AS members_count
           FROM fleets f LEFT JOIN companies c ON c.uuid = f.company_uuid
          WHERE f.deleted_at IS NULL ORDER BY f.created_at DESC`
      : `SELECT f.*,
                (SELECT COUNT(*) FROM hj_network_members m WHERE m.network_uuid = f.uuid AND m.status = 'active') AS members_count
           FROM fleets f
          WHERE f.company_uuid = ? AND f.deleted_at IS NULL ORDER BY f.created_at DESC`;
    const [rows] = await pool.query(sql, user.type === 'super_admin' ? [] : [user.company_uuid]);
    const [members] = await pool.query(
      `SELECT m.network_uuid, m.subject_type, m.subject_id, m.role, d.name, d.plate
         FROM hj_network_members m
         LEFT JOIN hermes_drivers d ON m.subject_type = 'driver' AND m.subject_id = d.id
        WHERE m.status = 'active'`
    );
    const byNet = {};
    for (const m of members) {
      if (!byNet[m.network_uuid]) byNet[m.network_uuid] = [];
      byNet[m.network_uuid].push(m);
    }
    const enriched = rows.map(r => ({
      ...r,
      members: byNet[r.uuid] || [],
      members_count: (byNet[r.uuid] || []).length
    }));
    return reply.send(enriched);
  });

  fastify.post('/api/networks', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { name, color, company_uuid } = request.body || {};
    if (!name) return reply.code(400).send({ error: 'Nome do enxame é obrigatório.' });
    const targetComp = (user.type === 'super_admin' && company_uuid) ? company_uuid : user.company_uuid;
    const uuid = crypto.randomUUID();
    const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'rede';

    await pool.query(
      `INSERT INTO fleets (uuid, public_id, company_uuid, name, slug, status, color, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, NOW(), NOW())`,
      [uuid, `flt_${crypto.randomBytes(4).toString('hex')}`, targetComp, String(name).trim(), slug, color || '#2563EB']
    );
    await logPlatformAudit({ actor: user, companyUuid: targetComp, networkUuid: uuid, action: 'network.create', targetType: 'network', targetId: uuid, details: { name }, ip: request.ip });
    return reply.code(201).send({ uuid, company_uuid: targetComp, name, slug, status: 'active', color: color || '#2563EB' });
  });

  fastify.patch('/api/networks/:uuid', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { uuid } = request.params;
    const { name, color } = request.body || {};
    await pool.query(
      `UPDATE fleets SET name = COALESCE(?, name), color = COALESCE(?, color), updated_at = NOW() WHERE uuid = ?`,
      [name || null, color || null, uuid]
    );
    return reply.send({ ok: true, uuid });
  });

  fastify.post('/api/networks/:uuid/pause', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { uuid } = request.params;
    await pool.query(`UPDATE fleets SET status = 'paused', updated_at = NOW() WHERE uuid = ?`, [uuid]);
    await pool.query(`UPDATE hj_network_sessions SET status = 'closed', ended_at = NOW() WHERE network_uuid = ? AND status = 'open'`, [uuid]);
    await logPlatformAudit({ actor: user, networkUuid: uuid, action: 'network.pause', targetType: 'network', targetId: uuid, ip: request.ip });
    return reply.send({ ok: true, uuid, status: 'paused' });
  });

  fastify.post('/api/networks/:uuid/reactivate', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { uuid } = request.params;
    await pool.query(`UPDATE fleets SET status = 'active', updated_at = NOW() WHERE uuid = ?`, [uuid]);
    await logPlatformAudit({ actor: user, networkUuid: uuid, action: 'network.reactivate', targetType: 'network', targetId: uuid, ip: request.ip });
    return reply.send({ ok: true, uuid, status: 'active' });
  });

  fastify.post('/api/networks/:uuid/members', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { uuid } = request.params;
    const { subject_type = 'driver', subject_id, role = 'member' } = request.body || {};
    if (!subject_id) return reply.code(400).send({ error: 'subject_id obrigatório.' });

    const [nets] = await pool.query(`SELECT company_uuid FROM fleets WHERE uuid = ? AND deleted_at IS NULL LIMIT 1`, [uuid]);
    if (!nets.length) return reply.code(404).send({ error: 'Enxame não encontrado.' });

    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      // Regra: um motorista tem no máximo 1 enxame ativo por vez
      if (subject_type === 'driver') {
        await conn.query(
          `UPDATE hj_network_members SET status = 'paused' WHERE subject_type = 'driver' AND subject_id = ? AND status = 'active'`,
          [subject_id]
        );
      }
      const id = genId('mem');
      await conn.query(
        `INSERT INTO hj_network_members (id, network_uuid, company_uuid, subject_type, subject_id, role, status)
         VALUES (?, ?, ?, ?, ?, ?, 'active')
         ON DUPLICATE KEY UPDATE status = 'active', role = VALUES(role)`,
        [id, uuid, nets[0].company_uuid, subject_type, subject_id, role]
      );
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      return reply.code(500).send({ error: err.message });
    } finally {
      conn.release();
    }

    await logPlatformAudit({ actor: user, companyUuid: nets[0].company_uuid, networkUuid: uuid, action: 'network.member.add', targetType: subject_type, targetId: subject_id, ip: request.ip });
    return reply.code(201).send({ ok: true, network_uuid: uuid, subject_type, subject_id });
  });

  fastify.delete('/api/networks/:uuid/members', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { uuid } = request.params;
    const { subject_type = 'driver', subject_id } = request.body || request.query || {};
    if (!subject_id) return reply.code(400).send({ error: 'subject_id obrigatório.' });
    await pool.query(
      `UPDATE hj_network_members SET status = 'paused' WHERE network_uuid = ? AND subject_type = ? AND subject_id = ?`,
      [uuid, subject_type, subject_id]
    );
    return reply.send({ ok: true });
  });

  // ─── BARRA DE STATUS EM TEMPO REAL ─────────────────────────────────────────
  fastify.get('/api/fleet/status-bar', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { network_uuid } = request.query || {};

    if (user.is_demo) {
      const items = demoState.vehicles.map(v => ({
        id: v.id,
        plate: v.plate,
        name: v.driver_name || v.model,
        status: v.status === 'em_rota' ? 'em_rota' : 'online',
        lat: v.lat,
        lon: v.lon
      }));
      return reply.send({
        online: items.filter(i => i.status === 'online').length,
        em_rota: items.filter(i => i.status === 'em_rota').length,
        offline: 0,
        items
      });
    }

    let sql = `SELECT d.id, d.name, d.plate, d.fleet_type, d.online, d.status, d.lat, d.lon
                 FROM hermes_drivers d`;
    const params = [];
    if (network_uuid) {
      sql += ` INNER JOIN hj_network_members m ON m.subject_type = 'driver' AND m.subject_id = d.id AND m.network_uuid = ? AND m.status = 'active'`;
      params.push(network_uuid);
    }
    sql += ` WHERE 1=1`;
    if (user.type !== 'super_admin') {
      sql += ` AND d.organization_id IN (?, 'default')`;
      params.push(user.company_uuid || '');
    }

    const [drivers] = await pool.query(sql, params);
    let online = 0, emRota = 0, offline = 0;
    const items = drivers.map(d => {
      let st = 'offline';
      if (d.online) {
        st = d.status === 'em_rota' ? 'em_rota' : 'online';
      }
      if (st === 'online') online++;
      else if (st === 'em_rota') emRota++;
      else offline++;
      return { id: d.id, plate: d.plate, name: d.name, status: st, lat: d.lat, lon: d.lon };
    });

    return reply.send({ online, em_rota: emRota, offline, items });
  });

  // ─── TOKENS LIVEKIT POR ENXAME & CHAT AO VIVO ──────────────────────────────
  fastify.get('/api/network/livekit-token/:networkUuid', async (request, reply) => {
    const user = await requireAuth(request, reply);
    if (!user) return;
    const { networkUuid } = request.params;
    const roomName = `px-${networkUuid}`;
    if (!user.is_demo) {
      const check = await validateLiveKitRoomAccess(user, roomName);
      if (!check.ok) return reply.code(check.status).send({ error: check.error });
    }
    const purpose = user.type === 'driver' ? 'driver' : 'central';
    const data = await issueNetworkLiveKitToken(user, roomName, purpose);
    await logPlatformAudit({ actor: user, networkUuid, action: 'livekit.ptt.token', targetType: 'room', targetId: roomName, ip: request.ip });
    return reply.send(data);
  });

  fastify.get('/api/network/vision-token/:networkUuid', async (request, reply) => {
    const user = await requireAuth(request, reply);
    if (!user) return;
    const { networkUuid } = request.params;
    const roomName = `vision-${networkUuid}`;
    if (!user.is_demo) {
      const check = await validateLiveKitRoomAccess(user, roomName);
      if (!check.ok) return reply.code(check.status).send({ error: check.error });
    }
    const data = await issueNetworkLiveKitToken(user, roomName, 'vision');
    await logPlatformAudit({ actor: user, networkUuid, action: 'livekit.vision.token', targetType: 'room', targetId: roomName, ip: request.ip });
    return reply.send(data);
  });

  fastify.get('/api/network/chat/:networkUuid', async (request, reply) => {
    const user = await requireAuth(request, reply);
    if (!user) return;
    const { networkUuid } = request.params;
    if (user.is_demo) return reply.send([]);
    const [rows] = await pool.query(
      `SELECT id, network_uuid, sender_uuid, sender_name, sender_role, message, created_at
         FROM hj_network_chat WHERE network_uuid = ? ORDER BY created_at DESC LIMIT 50`,
      [networkUuid]
    );
    return reply.send(rows.reverse());
  });

  fastify.post('/api/network/chat/:networkUuid', async (request, reply) => {
    const user = await requireAuth(request, reply);
    if (!user) return;
    const { networkUuid } = request.params;
    const { message } = request.body || {};
    if (!String(message || '').trim()) return reply.code(400).send({ error: 'Mensagem vazia.' });
    if (user.is_demo) {
      return reply.code(201).send({ id: genId('msg'), network_uuid: networkUuid, sender_name: user.name, message, created_at: new Date().toISOString() });
    }
    const id = genId('msg');
    await pool.query(
      `INSERT INTO hj_network_chat (id, network_uuid, company_uuid, sender_uuid, sender_name, sender_role, message)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [id, networkUuid, user.company_uuid || 'default', user.sub || 'sys', user.name || user.username || 'Operador', user.type || 'member', String(message).trim()]
    );
    return reply.code(201).send({
      id,
      network_uuid: networkUuid,
      sender_uuid: user.sub,
      sender_name: user.name || user.username,
      sender_role: user.type,
      message: String(message).trim(),
      created_at: new Date().toISOString()
    });
  });
}

module.exports = {
  registerNetworkRoutes,
  validateLiveKitRoomAccess,
  logPlatformAudit
};
