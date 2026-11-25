/**
 * src/olho-vivo.js — auditoria do Olho Vivo (conformidade LGPD).
 *
 * Regras dure:
 *  1. TODO acionamento de câmera vira linha em `olho_vivo_audit_logs`
 *     (quem acionou, qual veículo, início, fim e duração).
 *  2. O stream de VÍDEO nunca transporta áudio ambiente:
 *     - o grant LiveKit de visão é `canPublishSources: ['camera']` — o
 *       participante de visão NÃO consegue publicar microfone (garantia de
 *       servidor, não só de app);
 *     - o áudio existe só no canal PTT explícito, com grant separado
 *       (`canPublishSources: ['microphone']`);
 *     - o app mantém o microfone fechado enquanto a câmera está ligada
 *       (ver VisionController.startStream).
 *  3. NÃO há gravação em disco por padrão (`recorded_on_disk = 0`).
 */
const crypto = require('crypto');
const { pool } = require('./db');
const { requireAuth } = require('./auth');
const { publishNtfy } = require('./notify');

function orgOf(user) {
  return (user && (user.company_uuid || user.organization_id)) || null;
}

async function startAudit({ organizationId, userId, vehicleId, driverId, commandSource = 'central', notes = null }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO olho_vivo_audit_logs
       (id, organization_id, user_id, vehicle_id, driver_id, started_at,
        audio_channel, video_audio_on, recorded_on_disk, command_source, notes)
     VALUES (?, ?, ?, ?, ?, NOW(), 'ptt_explicito', 0, 0, ?, ?)`,
    [id, organizationId, userId, vehicleId || null, driverId || null, commandSource, notes]
  );
  return id;
}

async function stopAudit({ auditId, organizationId = null }) {
  const [rows] = await pool.query(
    `SELECT id, started_at FROM olho_vivo_audit_logs
      WHERE id = ? AND ended_at IS NULL ${organizationId ? 'AND organization_id = ?' : ''}`,
    organizationId ? [auditId, organizationId] : [auditId]
  );
  if (!rows.length) return null;
  await pool.query(
    `UPDATE olho_vivo_audit_logs
        SET ended_at = NOW(),
            duration_seconds = TIMESTAMPDIFF(SECOND, started_at, NOW())
      WHERE id = ?`,
    [auditId]
  );
  const [after] = await pool.query(
    `SELECT id, started_at, ended_at, duration_seconds FROM olho_vivo_audit_logs WHERE id = ?`,
    [auditId]
  );
  return after[0] || null;
}

async function olhoVivoRoutes(fastify) {
  // ── Central liga a câmera ────────────────────────────────────────────────
  fastify.post('/api/olho-vivo/camera/start', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const body = request.body || {};
    const org = orgOf(user);
    if (!org) return reply.code(400).send({ error: 'Sessão sem organização.' });

    const auditId = await startAudit({
      organizationId: org,
      userId: user.sub || null,
      vehicleId: body.vehicle_id ? String(body.vehicle_id) : null,
      driverId: body.driver_id ? String(body.driver_id) : null,
      commandSource: 'central',
      notes: body.notes ? String(body.notes).slice(0, 255) : null
    });

    await pool.query(
      `UPDATE hermes_vehicles SET camera_active = 1 WHERE id = ?`,
      [body.vehicle_id ? String(body.vehicle_id) : '__none__']
    );

    await publishNtfy('Olho Vivo ativado', `Vistoria de câmera iniciada\nVeículo: ${body.vehicle_id || '-'}\nAuditoria: ${auditId}`, { priority: 'default', tags: 'camera' });

    return reply.code(201).send({
      audit_id: auditId,
      organization_id: org,
      vehicle_id: body.vehicle_id || null,
      driver_id: body.driver_id || null,
      started_at: new Date().toISOString(),
      audio_channel: 'ptt_explicito',
      video_audio_on: false,
      recorded_on_disk: false
    });
  });

  // ── Central desliga a câmera ─────────────────────────────────────────────
  fastify.post('/api/olho-vivo/camera/stop', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const body = request.body || {};
    const org = orgOf(user);

    let auditId = body.audit_id ? String(body.audit_id) : null;
    if (!auditId && body.vehicle_id) {
      const [rows] = await pool.query(
        `SELECT id FROM olho_vivo_audit_logs
          WHERE vehicle_id = ? AND ended_at IS NULL
          ORDER BY started_at DESC LIMIT 1`,
        [String(body.vehicle_id)]
      );
      auditId = rows[0]?.id || null;
    }
    if (!auditId) return reply.code(404).send({ error: 'Nenhuma sessão de câmera ativa.' });

    const closed = await stopAudit({ auditId, organizationId: org });
    if (!closed) return reply.code(404).send({ error: 'Sessão de câmera não encontrada ou já encerrada.' });

    if (body.vehicle_id) {
      await pool.query(`UPDATE hermes_vehicles SET camera_active = 0 WHERE id = ?`, [String(body.vehicle_id)]);
    }

    return reply.send({
      audit_id: auditId,
      ended_at: closed.ended_at,
      duration_seconds: closed.duration_seconds
    });
  });

  // ── Motorista confirma o estado real no aparelho ─────────────────────────
  fastify.post('/api/driver/olho-vivo/camera-state', async (request, reply) => {
    const body = request.body || {};
    const active = body.active === true || body.active === '1' || body.active === 1;
    const vehicleId = body.vehicle_id ? String(body.vehicle_id) : null;
    const driverId = body.driver_id ? String(body.driver_id) : null;

    if (active) {
      let auditId = body.audit_id ? String(body.audit_id) : null;
      if (!auditId) {
        const [rows] = await pool.query(
          `SELECT id FROM olho_vivo_audit_logs
            WHERE vehicle_id <=> ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
          [vehicleId]
        );
        auditId = rows[0]?.id || null;
      }
      if (!auditId) {
        const [org] = await pool.query('SELECT uuid FROM companies ORDER BY created_at ASC LIMIT 1');
        auditId = await startAudit({
          organizationId: org[0]?.uuid || null,
          userId: null,
          vehicleId,
          driverId,
          commandSource: 'dispositivo'
        });
      }
      if (vehicleId) {
        await pool.query(`UPDATE hermes_vehicles SET camera_active = 1 WHERE id = ?`, [vehicleId]);
      }
      return reply.send({ ok: true, active: true, audit_id: auditId, audio_channel: 'ptt_explicito', video_audio_on: false });
    }

    // desligando
    let auditId = body.audit_id ? String(body.audit_id) : null;
    if (!auditId && vehicleId) {
      const [rows] = await pool.query(
        `SELECT id FROM olho_vivo_audit_logs WHERE vehicle_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`,
        [vehicleId]
      );
      auditId = rows[0]?.id || null;
    }
    let closed = null;
    if (auditId) closed = await stopAudit({ auditId });
    if (vehicleId) {
      await pool.query(`UPDATE hermes_vehicles SET camera_active = 0 WHERE id = ?`, [vehicleId]);
    }
    return reply.send({
      ok: true,
      active: false,
      audit_id: auditId,
      duration_seconds: closed?.duration_seconds ?? null
    });
  });

  // ── trilha de auditoria ──────────────────────────────────────────────────
  fastify.get('/api/olho-vivo/audit', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const q = request.query || {};
    const params = [];
    let sql = `SELECT a.*, v.plate AS vehicle_plate FROM olho_vivo_audit_logs a
               LEFT JOIN hermes_vehicles v ON v.id = a.vehicle_id WHERE 1=1`;
    const org = orgOf(user);
    if (org) { sql += ' AND a.organization_id = ?'; params.push(org); }
    if (q.vehicle_id) { sql += ' AND a.vehicle_id = ?'; params.push(String(q.vehicle_id)); }
    if (q.active === '1' || q.active === 'true') { sql += ' AND a.ended_at IS NULL'; }
    sql += ' ORDER BY a.started_at DESC LIMIT ' + Math.min(parseInt(q.limit || '200', 10), 500);
    const [rows] = await pool.query(sql, params);
    return reply.send(rows);
  });

  // ── sessões ativas (badge na Central) ────────────────────────────────────
  fastify.get('/api/olho-vivo/audit/active', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const [rows] = await pool.query(
      `SELECT a.id, a.vehicle_id, a.driver_id, a.started_at, v.plate AS vehicle_plate
         FROM olho_vivo_audit_logs a
         LEFT JOIN hermes_vehicles v ON v.id = a.vehicle_id
        WHERE a.ended_at IS NULL ORDER BY a.started_at DESC`
    );
    return reply.send(rows);
  });
}

module.exports = { olhoVivoRoutes, startAudit, stopAudit };
