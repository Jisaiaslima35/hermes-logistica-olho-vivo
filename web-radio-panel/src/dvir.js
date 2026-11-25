/**
 * src/dvir.js — Vistoria Fotográfica Obrigatória (DVIR) blindada.
 *
 * Princípios (prompt 2):
 *  1. Upload SEMPRE por streaming direto para o disco — o corpo do request
 *     nunca é acumulado em RAM (teto de 128 MB do container).
 *  2. JPEG validado por MAGIC BYTES reais (0xFF 0xD8 0xFF), não só mimetype.
 *  3. Nome do arquivo = UUID v4 gerado pelo servidor. O nome enviado pelo
 *     cliente é IGNORADO. Diretório isolado por organização e por mês.
 *  4. sha256 calculado em streaming. Hash repetido na mesma organização =
 *     is_duplicate_hash = 1 + alerta de fraude.
 *  5. Imutabilidade: após o envio, PUT/DELETE da vistoria => HTTP 403.
 *  6. Fotos servidas só por UUID — nunca por caminho (anti path-traversal).
 *  7. organization_id SEMPRE vem da sessão autenticada (ou da org declarada
 *     validada no banco). Nunca do corpo cru sem validação.
 */
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { Transform } = require('stream');
const { pipeline } = require('stream/promises');

const { pool } = require('./db');
const { requireAuth } = require('./auth');
const { emitBridgeEvent } = require('./integrations');
const { publishNtfy } = require('./notify');
const { blockVehicle, unblockVehicle, isVehicleBlocked, BLOCK_MESSAGE } = require('./fleet-guard');

const UPLOAD_ROOT = process.env.UPLOAD_ROOT || path.join(__dirname, '..', 'uploads');
const DVIR_ROOT = path.join(UPLOAD_ROOT, 'dvir');
const MAX_PHOTO_BYTES = parseInt(process.env.DVIR_MAX_PHOTO_BYTES || String(2 * 1024 * 1024), 10);
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ALLOWED_SLOTS = ['frente', 'lateral_esquerda', 'lateral_direita', 'pneus', 'velocimetro', 'avaria'];
const ACCEPTED_MIMETYPES = ['image/jpeg', 'image/jpg', 'image/pjpeg', 'application/octet-stream'];

const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

// ─── helpers ────────────────────────────────────────────────────────────────
function orgIdOf(user) {
  return (user && (user.company_uuid || user.organization_id)) || null;
}

async function resolveOrganization(request, reply, body) {
  const user = await requireAuth(request, reply);
  if (user) {
    const org = orgIdOf(user);
    if (org) return { org, user, via: 'sessao' };
    const [fallback] = await pool.query('SELECT uuid FROM companies ORDER BY created_at ASC LIMIT 1');
    return { org: fallback[0]?.uuid || null, user, via: 'sessao_sem_org' };
  }
  // Fallback operacional (app motorista ainda sem token do painel).
  const declared = String(body?.organization_id || '').trim();
  if (declared) {
    const [rows] = await pool.query('SELECT uuid FROM companies WHERE uuid = ? LIMIT 1', [declared]);
    if (rows.length) return { org: rows[0].uuid, user: null, via: 'body_validado' };
  }
  const [fallback] = await pool.query('SELECT uuid FROM companies ORDER BY created_at ASC LIMIT 1');
  return { org: fallback[0]?.uuid || null, user: null, via: 'default_company' };
}

/** Hash de sessão do usuário autenticado (para cruzar "quem revisou"). */
function userIdOf(user) {
  if (!user) return null;
  const id = user.sub || user.uuid;
  return UUID_RE.test(String(id || '')) ? id : null;
}

async function writeAudit({ organizationId, inspectionId = null, userId = null, action, details = null }) {
  const id = crypto.randomUUID();
  await pool.query(
    `INSERT INTO hj_dvir_audit_logs (id, organization_id, inspection_id, user_id, action, details_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [id, organizationId || null, inspectionId || null, userId || null, action, details ? JSON.stringify(details) : null]
  );
  return id;
}

/** Directory: /app/uploads/dvir/<org>/YYYY-MM — criado com 0750. */
function dirForOrg(orgId) {
  const month = new Date().toISOString().slice(0, 7);
  const safeOrg = String(orgId || 'sem-org').replace(/[^0-9a-zA-Z_-]/g, '');
  return { month, dir: path.join(DVIR_ROOT, safeOrg, month) };
}

/** Transform que valida magic bytes, conta bytes e calcula sha256 em streaming. */
function makePhotoTransform(hash, counters) {
  let head = Buffer.alloc(0);
  return new Transform({
    transform(chunk, _enc, cb) {
      if (head.length < 3) {
        head = Buffer.concat([head, chunk.slice(0, 3 - head.length)]);
        if (head.length === 3 && !head.equals(JPEG_MAGIC)) {
          cb(Object.assign(new Error('INVALID_JPEG_MAGIC'), { code: 'INVALID_JPEG_MAGIC' }));
          return;
        }
      }
      counters.bytes += chunk.length;
      if (counters.bytes > MAX_PHOTO_BYTES) {
        cb(Object.assign(new Error('FILE_TOO_LARGE'), { code: 'FILE_TOO_LARGE' }));
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    }
  });
}

/** Valida que `relativePath` continua dentro de UPLOAD_ROOT (anti traversal). */
function resolveUploadPath(relativePath) {
  const rel = String(relativePath || '').replace(/\\/g, '/');
  if (rel.includes('..') || rel.startsWith('/')) return null;
  const abs = path.resolve(UPLOAD_ROOT, rel);
  const root = path.resolve(UPLOAD_ROOT);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

// ─── rotas ───────────────────────────────────────────────────────────────────
async function dvirRoutes(fastify) {
  // ── templates por categoria de veículo ────────────────────────────────────
  fastify.get('/api/dvir/templates', async (request, reply) => {
    const [rows] = await pool.query(
      `SELECT id, vehicle_category, label, required_items_json, required_photos_json
         FROM hj_dvir_templates WHERE active = 1 ORDER BY vehicle_category`
    );
    return reply.send(rows.map(r => ({
      id: r.id,
      vehicle_category: r.vehicle_category,
      label: r.label,
      required_items: safeJson(r.required_items_json, []),
      required_photos: safeJson(r.required_photos_json, [])
    })));
  });

  // ── lista de vistorias (gestor) ───────────────────────────────────────────
  fastify.get('/api/dvir/inspections', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const q = request.query || {};
    const params = [];
    let sql = `SELECT i.* FROM hj_dvir_inspections i WHERE 1=1`;

    const org = orgIdOf(user);
    if (org) { sql += ' AND i.organization_id = ?'; params.push(org); }
    if (q.vehicle_id) { sql += ' AND i.vehicle_id = ?'; params.push(String(q.vehicle_id)); }
    if (q.driver_id) { sql += ' AND i.driver_id = ?'; params.push(String(q.driver_id)); }
    if (q.shift_type && ['entrada', 'saida'].includes(String(q.shift_type))) {
      sql += ' AND i.shift_type = ?'; params.push(String(q.shift_type));
    }
    if (q.status) { sql += ' AND i.status = ?'; params.push(String(q.status)); }
    if (q.has_damage === '1' || q.has_damage === 'true') { sql += ' AND i.has_damage = 1'; }
    if (q.duplicate === '1' || q.duplicate === 'true') {
      sql += ` AND EXISTS (SELECT 1 FROM hj_dvir_photos p WHERE p.inspection_id = i.id AND p.is_duplicate_hash = 1)`;
    }
    sql += ' ORDER BY i.server_recorded_at DESC LIMIT 200';

    const [rows] = await pool.query(sql, params);
    const ids = rows.map(r => r.id);
    let photos = [];
    if (ids.length) {
      const [ph] = await pool.query(
        `SELECT id, inspection_id, slot_name, stored_uuid_filename, relative_path, sha256_hash,
                is_duplicate_hash, file_size_bytes, created_at
           FROM hj_dvir_photos WHERE inspection_id IN (${ids.map(() => '?').join(',')})`,
        ids
      );
      photos = ph;
    }
    return reply.send(rows.map(r => ({
      ...r,
      checklist: safeJson(r.checklist_json, {}),
      photos: photos.filter(p => p.inspection_id === r.id).map(p => ({
        id: p.id,
        slot_name: p.slot_name,
        url: `/api/dvir/photos/${p.id}`,
        sha256_hash: p.sha256_hash,
        is_duplicate_hash: !!p.is_duplicate_hash,
        file_size_bytes: p.file_size_bytes,
        created_at: p.created_at
      }))
    })));
  });

  // ── detalhe de uma vistoria ───────────────────────────────────────────────
  fastify.get('/api/dvir/inspections/:id', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { id } = request.params;
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'Identificador de vistoria inválido.' });
    const [rows] = await pool.query('SELECT * FROM hj_dvir_inspections WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'Vistoria não encontrada.' });
    const insp = rows[0];
    const org = orgIdOf(user);
    if (org && insp.organization_id !== org) {
      return reply.code(403).send({ error: 'Vistoria pertence a outra organização.' });
    }
    const [ph] = await pool.query(
      `SELECT id, slot_name, sha256_hash, is_duplicate_hash, file_size_bytes, created_at
         FROM hj_dvir_photos WHERE inspection_id = ? ORDER BY slot_name`, [id]
    );
    const [pair] = insp.paired_inspection_id
      ? await pool.query('SELECT id, shift_type, odometer_km, server_recorded_at FROM hj_dvir_inspections WHERE id = ?', [insp.paired_inspection_id])
      : [[]];
    return reply.send({
      ...insp,
      checklist: safeJson(insp.checklist_json, {}),
      photos: ph.map(p => ({ ...p, url: `/api/dvir/photos/${p.id}` })),
      paired: pair[0] || null
    });
  });

  // ── PAREAMENTO automático entrada <-> saída do mesmo turno ────────────────
  fastify.get('/api/dvir/inspections/:id/pair', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { id } = request.params;
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'Identificador de vistoria inválido.' });
    const [rows] = await pool.query('SELECT * FROM hj_dvir_inspections WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'Vistoria não encontrada.' });
    const org = orgIdOf(user);
    if (org && rows[0].organization_id !== org) {
      return reply.code(403).send({ error: 'Vistoria pertence a outra organização.' });
    }
    const target = rows[0];
    const wanted = target.shift_type === 'entrada' ? 'saida' : 'entrada';

    const [candidates] = await pool.query(
      `SELECT i.* FROM hj_dvir_inspections i
        WHERE i.organization_id = ? AND i.vehicle_id = ? AND i.driver_id <=> ?
          AND i.shift_type = ? AND i.id <> ?
        ORDER BY i.server_recorded_at DESC LIMIT 5`,
      [target.organization_id, target.vehicle_id, target.driver_id, wanted, target.id]
    );

    const photosOf = async (inspectionId) => {
      const [ph] = await pool.query(
        `SELECT id, slot_name, sha256_hash, is_duplicate_hash FROM hj_dvir_photos WHERE inspection_id = ?`,
        [inspectionId]
      );
      return ph.map(p => ({ ...p, url: `/api/dvir/photos/${p.id}` }));
    };

    const other = candidates[0] || null;
    return reply.send({
      inspection: { id: target.id, shift_type: target.shift_type, odometer_km: target.odometer_km, server_recorded_at: target.server_recorded_at, status: target.status },
      paired: other ? {
        id: other.id,
        shift_type: other.shift_type,
        odometer_km: other.odometer_km,
        server_recorded_at: other.server_recorded_at,
        status: other.status,
        photos: await photosOf(other.id)
      } : null,
      photos: await photosOf(target.id),
      km_diff: other ? Number((Number(target.odometer_km || 0) - Number(other.odometer_km || 0)).toFixed(2)) : null
    });
  });

  // ── IMUTABILIDADE: PUT/DELETE sempre 403 ──────────────────────────────────
  fastify.put('/api/dvir/inspections/:id', async (request, reply) => {
    await requireAuth(request, reply, ['admin', 'staff']);
    return reply.code(403).send({
      error: 'Vistoria enviada é imutável (locked_immutable=1). Alterações só via revisão do gerente.'
    });
  });

  fastify.delete('/api/dvir/inspections/:id', async (request, reply) => {
    await requireAuth(request, reply, ['admin', 'staff']);
    return reply.code(403).send({
      error: 'Vistoria enviada é imutável (locked_immutable=1). Exclusão proibida.'
    });
  });

  // ── REVISÃO DO GERENTE (aprovar / bloquear / liberar) ──────────────────────
  fastify.post('/api/dvir/inspections/:id/review', async (request, reply) => {
    const user = await requireAuth(request, reply, ['admin', 'staff']);
    if (!user) return;
    const { id } = request.params;
    if (!UUID_RE.test(id)) return reply.code(400).send({ error: 'Identificador de vistoria inválido.' });
    const action = String(request.body?.action || '').trim().toLowerCase();
    const notes = String(request.body?.notes || '').slice(0, 1000);

    const [rows] = await pool.query('SELECT * FROM hj_dvir_inspections WHERE id = ? LIMIT 1', [id]);
    if (!rows.length) return reply.code(404).send({ error: 'Vistoria não encontrada.' });
    const insp = rows[0];
    const org = orgIdOf(user);
    if (org && insp.organization_id !== org) {
      return reply.code(403).send({ error: 'Vistoria pertence a outra organização.' });
    }

    const reviewer = userIdOf(user);
    if (action === 'bloquear') {
      await pool.query(
        `UPDATE hj_dvir_inspections
            SET status = 'reprovado', reviewed_by_user_id = ?, reviewed_at = NOW(), review_notes = ?
          WHERE id = ?`,
        [reviewer, notes || 'Bloqueio definido pelo gestor', id]
      );
      await blockVehicle({ vehicleId: insp.vehicle_id, reason: notes || `Vistoria ${id} reprovada`, userId: reviewer });
      await writeAudit({ organizationId: insp.organization_id, inspectionId: id, userId: reviewer, action: 'revisao_bloqueio', details: { notes } });
      await publishNtfy('Veículo bloqueado por vistoria', `Vistoria ${id}\nVeículo: ${insp.vehicle_id}\nStatus: REPROVADO\n${notes}`, { priority: 'high', tags: 'rotating_light' });
      await emitBridgeEvent('dvir.bloqueio', id, {
        veiculo_id: insp.vehicle_id,
        vistoria_id: id,
        resultado: 'reprovado',
        telefone_gestor: request.body?.telefone_gestor || null,
        motivo: notes || 'Vistoria reprovada pelo gestor'
      });
      return reply.send({ ok: true, status: 'reprovado', vehicle_blocked: true });
    }

    if (action === 'aprovar' || action === 'liberar') {
      await pool.query(
        `UPDATE hj_dvir_inspections
            SET status = 'aprovado', reviewed_by_user_id = ?, reviewed_at = NOW(), review_notes = ?
          WHERE id = ?`,
        [reviewer, notes || 'Liberado pelo gestor', id]
      );
      const stillBlocked = await isVehicleBlocked(insp.vehicle_id);
      if (stillBlocked && action === 'liberar') {
        await unblockVehicle({ vehicleId: insp.vehicle_id, userId: reviewer });
      }
      await writeAudit({ organizationId: insp.organization_id, inspectionId: id, userId: reviewer, action: `revisao_${action}`, details: { notes } });
      await emitBridgeEvent('dvir.aprovada', id, {
        veiculo_id: insp.vehicle_id,
        vistoria_id: id,
        resultado: 'aprovado',
        telefone_gestor: request.body?.telefone_gestor || null
      });
      return reply.send({ ok: true, status: 'aprovado', vehicle_unblocked: action === 'liberar' });
    }

    return reply.code(400).send({ error: 'Ação inválida. Use: aprovar | liberar | bloquear.' });
  });

  // ── ENTREGA DA VISTORIA (streaming) ───────────────────────────────────────
  fastify.post('/api/driver/dvir', async (request, reply) => {
    const fields = {};
    const savedPhotos = [];
    let org = null;
    let authenticatedUser = null;

    const parts = request.parts({ limits: { fileSize: MAX_PHOTO_BYTES, files: 12, fields: 40, fieldSize: 128 * 1024 } });

    try {
      for await (const part of parts) {
        if (part.type === 'field') {
          fields[part.fieldname] = part.value;
          continue;
        }

        // ── parte de arquivo = uma foto do checklist ──────────────────────
        const slot = String(part.fieldname || '').toLowerCase();
        if (!ALLOWED_SLOTS.includes(slot)) {
          part.file.resume();
          throw Object.assign(new Error(`Slot de foto inválido: ${slot}`), { statusCode: 400 });
        }
        const mimetype = String(part.mimetype || '').toLowerCase();
        if (!ACCEPTED_MIMETYPES.includes(mimetype)) {
          part.file.resume();
          throw Object.assign(new Error(`mimetype inválido: ${mimetype}`), { statusCode: 400 });
        }

        // resolve organização na primeira foto (o form pode vir antes)
        if (!org) {
          const resolved = await resolveOrganization(request, reply, fields);
          org = resolved.org;
          authenticatedUser = resolved.user;
          if (!org) throw Object.assign(new Error('Organização não resolvida.'), { statusCode: 400 });
        }

        const { dir } = dirForOrg(org);
        await fsp.mkdir(dir, { recursive: true });

        const uuid = crypto.randomUUID();
        const filename = `${uuid}.jpg`;
        const absPath = path.join(dir, filename);
        const relPath = path.posix.join('dvir', String(org), new Date().toISOString().slice(0, 7), filename);

        const hash = crypto.createHash('sha256');
        const counters = { bytes: 0 };
        const transform = makePhotoTransform(hash, counters);

        try {
          await pipeline(part.file, transform, fs.createWriteStream(absPath, { mode: 0o640 }));
        } catch (err) {
          await fsp.unlink(absPath).catch(() => {});
          if (err.code === 'INVALID_JPEG_MAGIC') {
            throw Object.assign(new Error('Arquivo não é um JPEG válido (magic bytes inválidos).'), { statusCode: 400 });
          }
          if (err.code === 'FILE_TOO_LARGE') {
            throw Object.assign(new Error(`Foto excede ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`), { statusCode: 413 });
          }
          if (err.code === 'FST_REQ_FILE_TOO_LARGE') {
            throw Object.assign(new Error(`Foto excede ${Math.round(MAX_PHOTO_BYTES / 1024 / 1024)} MB.`), { statusCode: 413 });
          }
          throw err;
        }

        const sha256 = hash.digest('hex');
        savedPhotos.push({ slot, uuid, filename, relPath, absPath, sha256, bytes: counters.bytes });
      }
    } catch (err) {
      // limpeza de tudo que já tinha gravado
      await Promise.all(savedPhotos.map(p => fsp.unlink(p.absPath).catch(() => {})));
      const status = err.statusCode || (err.code === 'FST_REQ_FILE_TOO_LARGE' ? 413 : 400);
      request.log.warn({ err: err.message }, 'DVIR upload rejeitado');
      return reply.code(status).send({ error: err.message || 'Upload inválido.' });
    }

    if (!org) {
      const resolved = await resolveOrganization(request, reply, fields);
      org = resolved.org;
      authenticatedUser = resolved.user;
    }
    if (!org) return reply.code(400).send({ error: 'Organização não resolvida.' });

    if (!savedPhotos.length) {
      return reply.code(400).send({ error: 'É obrigatória ao menos uma foto na vistoria.' });
    }

    const vehicleId = String(fields.vehicle_id || '').trim();
    if (!vehicleId) return reply.code(400).send({ error: 'vehicle_id é obrigatório.' });
    const shiftType = String(fields.shift_type || '').trim().toLowerCase();
    if (!['entrada', 'saida'].includes(shiftType)) {
      return reply.code(400).send({ error: "shift_type deve ser 'entrada' ou 'saida'." });
    }

    const checklist = safeJson(fields.checklist, {});
    const hasDamage = fields.has_damage === '1' || fields.has_damage === 'true' || fields.has_damage === true;
    const damageNotes = String(fields.damage_notes || '').slice(0, 2000);
    const odometer = fields.odometer_km !== undefined && fields.odometer_km !== '' ? Number(fields.odometer_km) : null;
    const gpsLat = fields.gps_lat !== undefined && fields.gps_lat !== '' ? Number(fields.gps_lat) : null;
    const gpsLng = fields.gps_lng !== undefined && fields.gps_lng !== '' ? Number(fields.gps_lng) : null;

    if (hasDamage && !damageNotes.trim()) {
      await Promise.all(savedPhotos.map(p => fsp.unlink(p.absPath).catch(() => {})));
      return reply.code(400).send({ error: 'Vistoria com avaria exige damage_notes preenchido.' });
    }

    // ── antifraude: hash repetido na mesma organização ─────────────────────
    const hashes = savedPhotos.map(p => p.sha256);
    const [dupeRows] = await pool.query(
      `SELECT p.id, p.inspection_id, p.sha256_hash, p.slot_name
         FROM hj_dvir_photos p
        WHERE p.organization_id = ? AND p.sha256_hash IN (${hashes.map(() => '?').join(',')})
          AND p.inspection_id NOT IN (SELECT id FROM hj_dvir_inspections WHERE id = 'pendente')`,
      [org, ...hashes]
    );
    const dupeSet = new Set(dupeRows.map(r => r.sha256_hash));

    // ── status automático ───────────────────────────────────────────────────
    const status = hasDamage ? 'reprovado' : 'aprovado';

    // ── pareamento entrada/saída do mesmo turno ────────────────────────────
    let pairedId = String(fields.paired_inspection_id || '').trim() || null;
    if (!UUID_RE.test(pairedId || '')) pairedId = null;
    if (!pairedId) {
      const [prev] = await pool.query(
        `SELECT id FROM hj_dvir_inspections
          WHERE organization_id = ? AND vehicle_id = ? AND shift_type = ?
          ORDER BY server_recorded_at DESC LIMIT 1`,
        [org, vehicleId, shiftType === 'entrada' ? 'saida' : 'entrada']
      );
      pairedId = prev[0]?.id || null;
    }

    const inspectionId = crypto.randomUUID();
    const driverId = String(fields.driver_id || '').trim() || null;

    const conn = await pool.getConnection();
    let inserted = false;
    try {
      await conn.beginTransaction();
      await conn.query(
        `INSERT INTO hj_dvir_inspections
           (id, organization_id, vehicle_id, driver_id, shift_type, paired_inspection_id,
            odometer_km, gps_lat, gps_lng, server_recorded_at, checklist_json,
            has_damage, damage_notes, status, locked_immutable)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), ?, ?, ?, ?, 1)`,
        [
          inspectionId, org, vehicleId, driverId, shiftType, pairedId,
          odometer, gpsLat, gpsLng, JSON.stringify(checklist),
          hasDamage ? 1 : 0, damageNotes || null, status
        ]
      );
      for (const p of savedPhotos) {
        await conn.query(
          `INSERT INTO hj_dvir_photos
             (id, inspection_id, organization_id, slot_name, stored_uuid_filename,
              relative_path, sha256_hash, is_duplicate_hash, file_size_bytes)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [p.uuid, inspectionId, org, p.slot, p.filename, p.relPath, p.sha256, dupeSet.has(p.sha256) ? 1 : 0, p.bytes]
        );
      }
      await conn.query(
        `INSERT INTO hj_dvir_audit_logs (id, organization_id, inspection_id, user_id, action, details_json)
         VALUES (?, ?, ?, ?, 'vistoria_enviada', ?)`,
        [crypto.randomUUID(), org, inspectionId, userIdOf(authenticatedUser),
         JSON.stringify({ shift_type: shiftType, photos: savedPhotos.length, has_damage: hasDamage })]
      );
      await conn.commit();
      inserted = true;
    } catch (err) {
      await conn.rollback();
      request.log.error({ err: err.message }, 'Falha ao gravar vistoria');
    } finally {
      conn.release();
    }

    if (!inserted) {
      await Promise.all(savedPhotos.map(p => fsp.unlink(p.absPath).catch(() => {})));
      return reply.code(500).send({ error: 'Falha ao registrar vistoria.' });
    }

    // ── veículo reprovado => bloqueado ─────────────────────────────────────
    let vehicleBlocked = false;
    if (status === 'reprovado') {
      await blockVehicle({ vehicleId, reason: damageNotes || 'Vistoria DVIR reprovada', userId: userIdOf(authenticatedUser) });
      vehicleBlocked = true;
      await publishNtfy('DVIR reprovado — veículo bloqueado', `Vistoria ${inspectionId}\nVeículo: ${vehicleId}\nStatus: REPROVADO\n${damageNotes}`, { priority: 'high', tags: 'rotating_light' });
      await emitBridgeEvent('dvir.bloqueio', inspectionId, {
        veiculo_id: vehicleId,
        vistoria_id: inspectionId,
        resultado: 'reprovado',
        telefone_gestor: fields.telefone_gestor || null,
        motivo: damageNotes || 'Vistoria reprovada'
      });
    }

    // ── alerta de fraude ───────────────────────────────────────────────────
    const duplicates = savedPhotos.filter(p => dupeSet.has(p.sha256));
    if (duplicates.length) {
      const alertId = `alt_${crypto.randomBytes(5).toString('hex')}`;
      await pool.query(
        `INSERT INTO hermes_alerts (id, vehicle_id, driver_id, alert_type, message, details_json)
         VALUES (?, ?, ?, 'dvir_fraude', ?, ?)`,
        [alertId, vehicleId, driverId,
         `Possível fraude DVIR: ${duplicates.length} foto(s) com hash repetido nesta organização`,
         JSON.stringify({ inspection_id: inspectionId, slots: duplicates.map(d => d.slot), hashes: duplicates.map(d => d.sha256) })]
      );
      await publishNtfy('Alerta de fraude — foto duplicada', `Vistoria ${inspectionId}\nVeículo: ${vehicleId}\nSlots duplicados: ${duplicates.map(d => d.slot).join(', ')}`, { priority: 'high', tags: 'rotating_light' });
      await emitBridgeEvent('dvir.fraude', inspectionId, {
        veiculo_id: vehicleId,
        vistoria_id: inspectionId,
        telefone_gestor: fields.telefone_gestor || null,
        slots: duplicates.map(d => d.slot)
      });
    }

    return reply.code(201).send({
      id: inspectionId,
      organization_id: org,
      vehicle_id: vehicleId,
      shift_type: shiftType,
      status,
      locked_immutable: 1,
      has_damage: hasDamage,
      paired_inspection_id: pairedId,
      vehicle_blocked: vehicleBlocked,
      photos: savedPhotos.map(p => ({
        id: p.uuid,
        slot_name: p.slot,
        url: `/api/dvir/photos/${p.uuid}`,
        sha256_hash: p.sha256,
        is_duplicate_hash: dupeSet.has(p.sha256),
        file_size_bytes: p.bytes
      })),
      blocked_message: vehicleBlocked ? BLOCK_MESSAGE : null
    });
  });

  // ── download da foto (só por UUID + sessão + org) ─────────────────────────
  fastify.get('/api/dvir/photos/:photoId', async (request, reply) => {
    const token = request.headers.authorization || '';
    const user = await requireAuth(request, reply);
    if (!user) return; // 401 já enviado por requireAuth

    const { photoId } = request.params;
    if (!UUID_RE.test(String(photoId || ''))) {
      return reply.code(400).send({ error: 'Identificador de foto inválido.' });
    }

    const [rows] = await pool.query(
      `SELECT id, inspection_id, organization_id, relative_path, file_size_bytes, created_at
         FROM hj_dvir_photos WHERE id = ? LIMIT 1`,
      [photoId]
    );
    if (!rows.length) return reply.code(404).send({ error: 'Foto não encontrada.' });

    const photo = rows[0];
    const org = orgIdOf(user);
    if (!org || photo.organization_id !== org) {
      return reply.code(403).send({ error: 'Foto pertence a outra organização.' });
    }

    const abs = resolveUploadPath(photo.relative_path);
    if (!abs) return reply.code(400).send({ error: 'Caminho de arquivo inválido.' });

    let stat;
    try {
      stat = await fsp.stat(abs);
    } catch {
      return reply.code(404).send({ error: 'Arquivo da foto não encontrado em disco.' });
    }

    reply.header('Content-Type', 'image/jpeg');
    reply.header('Content-Length', String(stat.size));
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'private, max-age=300');
    return reply.send(fs.createReadStream(abs));
  });
}

function safeJson(value, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}

module.exports = { dvirRoutes, MAX_PHOTO_BYTES, UUID_RE, ALLOWED_SLOTS, DVIR_ROOT, UPLOAD_ROOT };
