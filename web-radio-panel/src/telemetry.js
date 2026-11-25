/**
 * src/telemetry.js — telemetria do app motorista + fila store-and-forward.
 *
 *  - POST /api/driver/telemetry        (ponto único, tempo real)
 *  - POST /api/driver/telemetry/batch  (lote retroativo da fila offline)
 *  - monitor de frota: "sem sinal há X min" e "bateria <= 15%"
 *
 * O lote é SEMPRE gravado na ordem cronológica ORIGINAL (recorded_at do
 * dispositivo), mesmo que o app reenvie fora de ordem após voltar o 4G.
 */
const { pool } = require('./db');
const { emitBridgeEvent } = require('./integrations');
const { publishNtfy } = require('./notify');

const SIGNAL_TIMEOUT_SECONDS = parseInt(process.env.SIGNAL_TIMEOUT_SECONDS || '180', 10); // 3 min
const BATTERY_LOW_PCT = parseInt(process.env.BATTERY_LOW_PCT || '15', 10);
const ALERT_COOLDOWN_SECONDS = parseInt(process.env.ALERT_COOLDOWN_SECONDS || '600', 10);
const MONITOR_INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS || '60000', 10);

function genId(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 12)}`;
}

/** Normaliza um ponto do app (aceita string ISO ou epoch ms). */
function normalizePoint(p) {
  const lat = Number(p?.lat);
  const lon = Number(p?.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  let recordedAt = p?.recorded_at || p?.timestamp || p?.ts;
  let ms;
  if (recordedAt === undefined || recordedAt === null || recordedAt === '') {
    ms = Date.now();
  } else if (typeof recordedAt === 'number') {
    ms = recordedAt > 1e12 ? recordedAt : recordedAt * 1000;
  } else {
    ms = Date.parse(recordedAt);
    if (Number.isNaN(ms)) ms = Date.now();
  }
  const num = (v) => {
    if (v === undefined || v === null || v === '') return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    lat,
    lon,
    speed_kph: num(p?.speed_kph),
    heading_deg: num(p?.heading_deg),
    battery_pct: num(p?.battery_pct),
    deviation_m: num(p?.deviation_m),
    stopped_s: num(p?.stopped_s),
    recorded_at: new Date(ms),
    recorded_ms: ms
  };
}

async function upsertVehiclePosition(point, vehicleId, driverId) {
  await pool.query(
    `UPDATE hermes_vehicles
        SET lat = ?, lon = ?,
            speed_kph = COALESCE(?, speed_kph),
            heading_deg = COALESCE(?, heading_deg),
            battery_pct = COALESCE(?, battery_pct),
            last_ping_at = NOW()
      WHERE id = ?`,
    [point.lat, point.lon, point.speed_kph, point.heading_deg, point.battery_pct, vehicleId]
  );
  if (driverId) {
    // hermes_drivers não tem updated_at no schema — só atualiza o que existe.
    await pool.query(
      `UPDATE hermes_drivers SET lat = ?, lon = ?, online = 1 WHERE id = ?`,
      [point.lat, point.lon, driverId]
    );
  }
}

async function raiseOperationalAlerts({ point, vehicleId, driverId, orderId }) {
  const alertId = genId('alt');

  if (Number(point.deviation_m || 0) >= 300) {
    await pool.query(
      `INSERT INTO hermes_alerts (id, order_id, vehicle_id, driver_id, alert_type, message, details_json)
       VALUES (?, ?, ?, ?, 'desvio_rota', ?, ?)`,
      [alertId, orderId || null, vehicleId || null, driverId || null, `Desvio de ${point.deviation_m}m detectado`, JSON.stringify({ deviation_m: point.deviation_m, lat: point.lat, lon: point.lon })]
    );
    await emitBridgeEvent('desvio.detectado', orderId || vehicleId || alertId, {
      ordem_servico_id: orderId,
      veiculo_id: vehicleId,
      deslocamento_m: Number(point.deviation_m),
      duracao_s: 600
    });
  }

  if (Number(point.stopped_s || 0) >= 900) {
    const alertId2 = genId('alt');
    await pool.query(
      `INSERT INTO hermes_alerts (id, order_id, vehicle_id, driver_id, alert_type, message, details_json)
       VALUES (?, ?, ?, ?, 'parada_prolongada', ?, ?)`,
      [alertId2, orderId || null, vehicleId || null, driverId || null, `Parada prolongada de ${Math.round(point.stopped_s / 60)} min`, JSON.stringify({ stopped_s: point.stopped_s, lat: point.lat, lon: point.lon })]
    );
    await emitBridgeEvent('parada.prolongada', orderId || vehicleId || alertId2, {
      ordem_servico_id: orderId,
      veiculo_id: vehicleId,
      duracao_s: Number(point.stopped_s),
      local: { lat: point.lat, endereco: 'Posição GPS' }
    });
  }
}

async function telemetryRoutes(fastify) {
  // ── ponto único (tempo real) ─────────────────────────────────────────────
  fastify.post('/api/driver/telemetry', async (request, reply) => {
    const body = request.body || {};
    const { vehicle_id, driver_id, order_id } = body;
    const point = normalizePoint(body);
    if (!point) return reply.code(400).send({ error: 'lat/lon inválidos.' });

    if (vehicle_id) {
      await upsertVehiclePosition(point, vehicle_id, driver_id);
    } else if (driver_id) {
      await pool.query(
        `UPDATE hermes_drivers SET lat = ?, lon = ?, online = 1 WHERE id = ?`,
        [point.lat, point.lon, driver_id]
      );
    }

    await pool.query(
      `INSERT INTO hj_telemetry_points
         (organization_id, vehicle_id, driver_id, order_id, lat, lon, speed_kph, heading_deg,
          battery_pct, deviation_m, stopped_s, recorded_at)
       VALUES ((SELECT uuid FROM companies ORDER BY created_at ASC LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [vehicle_id || null, driver_id || null, order_id || null, point.lat, point.lon, point.speed_kph,
       point.heading_deg, point.battery_pct, point.deviation_m, point.stopped_s, point.recorded_at]
    );

    await raiseOperationalAlerts({ point, vehicleId: vehicle_id, driverId: driver_id, orderId: order_id });
    return reply.send({ ok: true, recorded_at: point.recorded_at.toISOString() });
  });

  // ── LOTE da fila offline (store-and-forward) ──────────────────────────────
  fastify.post('/api/driver/telemetry/batch', async (request, reply) => {
    const body = request.body || {};
    const vehicle_id = body.vehicle_id ? String(body.vehicle_id) : null;
    const driver_id = body.driver_id ? String(body.driver_id) : null;
    const order_id = body.order_id ? String(body.order_id) : null;
    const rawPoints = Array.isArray(body.points) ? body.points : [];

    if (!rawPoints.length) {
      return reply.code(400).send({ error: 'points vazio — nada a descarregar.' });
    }
    if (rawPoints.length > 5000) {
      return reply.code(413).send({ error: 'Lote acima do limite de 5000 pontos. Divida a fila.' });
    }

    const points = rawPoints.map(normalizePoint).filter(Boolean);
    if (!points.length) {
      return reply.code(400).send({ error: 'Nenhum ponto válido no lote.' });
    }

    // ORDENAÇÃO PELO TIMESTAMP ORIGINAL do dispositivo (não pela ordem de chegada)
    points.sort((a, b) => a.recorded_ms - b.recorded_ms);

    const batchId = require('crypto').randomUUID();
    const first = points[0].recorded_at;
    const last = points[points.length - 1].recorded_at;

    await pool.query(
      `INSERT INTO hj_telemetry_batches (id, organization_id, vehicle_id, driver_id, points_count, first_recorded_at, last_recorded_at)
       VALUES (?, (SELECT uuid FROM companies ORDER BY created_at ASC LIMIT 1), ?, ?, ?, ?, ?)`,
      [batchId, vehicle_id, driver_id, points.length, first, last]
    );

    const conn = await pool.getConnection();
    let inserted = 0;
    try {
      await conn.beginTransaction();
      for (const p of points) {
        await conn.query(
          `INSERT INTO hj_telemetry_points
             (organization_id, vehicle_id, driver_id, order_id, lat, lon, speed_kph, heading_deg,
              battery_pct, deviation_m, stopped_s, recorded_at, batch_id)
           VALUES ((SELECT uuid FROM companies ORDER BY created_at ASC LIMIT 1), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [vehicle_id, driver_id, order_id, p.lat, p.lon, p.speed_kph, p.heading_deg,
           p.battery_pct, p.deviation_m, p.stopped_s, p.recorded_at, batchId]
        );
        inserted++;
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback();
      fastify.log.error({ err: err.message }, 'Falha ao gravar lote de telemetria');
      return reply.code(500).send({ error: 'Falha ao gravar lote de telemetria.' });
    } finally {
      conn.release();
    }

    // o estado corrente do veículo = ponto MAIS RECENTE do lote
    const latest = points[points.length - 1];
    if (vehicle_id) {
      await upsertVehiclePosition(latest, vehicle_id, driver_id);
    } else if (driver_id) {
      await pool.query(
        `UPDATE hermes_drivers SET lat = ?, lon = ?, online = 1 WHERE id = ?`,
        [latest.lat, latest.lon, driver_id]
      );
    }
    await raiseOperationalAlerts({ point: latest, vehicleId: vehicle_id, driverId: driver_id, orderId: order_id });

    return reply.send({
      ok: true,
      batch_id: batchId,
      received: rawPoints.length,
      inserted,
      first_recorded_at: first.toISOString(),
      last_recorded_at: last.toISOString(),
      ordered_by: 'recorded_at'
    });
  });

  // ── histórico de posições (gestor) ────────────────────────────────────────
  fastify.get('/api/driver/telemetry/history', async (request, reply) => {
    const { vehicle_id, limit } = request.query || {};
    const lim = Math.min(parseInt(limit || '200', 10), 2000);
    const params = [];
    let sql = `SELECT id, vehicle_id, driver_id, lat, lon, speed_kph, heading_deg, battery_pct, recorded_at, batch_id
                 FROM hj_telemetry_points WHERE 1=1`;
    if (vehicle_id) { sql += ' AND vehicle_id = ?'; params.push(String(vehicle_id)); }
    sql += ' ORDER BY recorded_at DESC LIMIT ' + lim;
    const [rows] = await pool.query(sql, params);
    return reply.send(rows);
  });
}

// ─── MONITOR DE FROTA (sem sinal / bateria baixa) ───────────────────────────
async function checkFleetHealth() {
  const [rows] = await pool.query(
    `SELECT v.id, v.plate, v.model, v.status, v.battery_pct, v.last_ping_at,
            v.last_signal_alert_at, v.last_battery_alert_at,
            d.name AS driver_name, d.id AS driver_id,
            o.id AS order_id, o.status AS order_status
       FROM hermes_vehicles v
       LEFT JOIN hermes_drivers d ON d.id = v.driver_id
       LEFT JOIN hermes_orders o ON o.vehicle_id = v.id AND o.status IN ('pendente','em_rota')
      WHERE v.status = 'em_rota' OR o.id IS NOT NULL`
  );

  const now = Date.now();
  const cooldownMs = ALERT_COOLDOWN_SECONDS * 1000;
  const signalTimeoutMs = SIGNAL_TIMEOUT_SECONDS * 1000;

  for (const v of rows) {
    // ── sem sinal ──────────────────────────────────────────────────────────
    const lastPing = v.last_ping_at ? new Date(v.last_ping_at).getTime() : null;
    const silentMs = lastPing === null ? Infinity : now - lastPing;
    const alertCooled = !v.last_signal_alert_at || (now - new Date(v.last_signal_alert_at).getTime()) > cooldownMs;
    if (silentMs > signalTimeoutMs && alertCooled) {
      const minutes = lastPing === null ? null : Math.floor(silentMs / 60000);
      const message = minutes === null
        ? `Veículo ${v.plate} nunca reportou posição`
        : `Sem sinal há ${minutes} min`;
      const alertId = genId('alt');
      await pool.query(
        `INSERT INTO hermes_alerts (id, order_id, vehicle_id, driver_id, alert_type, message, details_json)
         VALUES (?, ?, ?, ?, 'sem_sinal', ?, ?)`,
        [alertId, v.order_id || null, v.id, v.driver_id || null, message,
         JSON.stringify({ vehicle: v.plate, minutes, last_ping_at: v.last_ping_at })]
      );
      await pool.query('UPDATE hermes_vehicles SET last_signal_alert_at = NOW() WHERE id = ?', [v.id]);
      await publishNtfy('Veículo sem sinal', `${message}\nVeículo: ${v.plate} — ${v.model}\nMotorista: ${v.driver_name || '-'}`, { priority: 'high', tags: 'satellite' });
      await emitBridgeEvent('alerta.sem_sinal', v.id, {
        veiculo_id: v.id,
        placa: v.plate,
        minutos_sem_sinal: minutes,
        telefone_notificacao: null
      });
    }

    // ── bateria baixa ──────────────────────────────────────────────────────
    const battery = v.battery_pct === null || v.battery_pct === undefined ? null : Number(v.battery_pct);
    const battCooled = !v.last_battery_alert_at || (now - new Date(v.last_battery_alert_at).getTime()) > cooldownMs;
    if (battery !== null && battery <= BATTERY_LOW_PCT && battCooled) {
      const alertId = genId('alt');
      await pool.query(
        `INSERT INTO hermes_alerts (id, order_id, vehicle_id, driver_id, alert_type, message, details_json)
         VALUES (?, ?, ?, ?, 'bateria_baixa', ?, ?)`,
        [alertId, v.order_id || null, v.id, v.driver_id || null, `Bateria do veículo ${v.plate} em ${battery}%`, JSON.stringify({ vehicle: v.plate, battery_pct: battery })]
      );
      await pool.query('UPDATE hermes_vehicles SET last_battery_alert_at = NOW() WHERE id = ?', [v.id]);
      await publishNtfy('Bateria do veículo baixa', `Veículo: ${v.plate} — ${v.model}\nBateria: ${battery}%\nMotorista: ${v.driver_name || '-'}`, { priority: 'high', tags: 'battery' });
      await emitBridgeEvent('alerta.bateria_baixa', v.id, {
        veiculo_id: v.id,
        placa: v.plate,
        battery_pct: battery,
        telefone_notificacao: null
      });
    }
  }
}

function startFleetMonitor(fastify) {
  const timer = setInterval(() => {
    checkFleetHealth().catch(err => fastify.log.warn({ err: err.message }, 'Falha no monitor de frota'));
  }, MONITOR_INTERVAL_MS);
  timer.unref?.();
  // primeira checagem 10s após subir
  setTimeout(() => checkFleetHealth().catch(() => {}), 10000).unref?.();
  return timer;
}

/** Badge de sinal/bateria para o mapa e a lista da Central. */
async function decorateVehiclesWithHealth(rows) {
  const now = Date.now();
  const timeoutMs = SIGNAL_TIMEOUT_SECONDS * 1000;
  return rows.map(v => {
    const lastPing = v.last_ping_at ? new Date(v.last_ping_at).getTime() : null;
    const silentMs = lastPing === null ? Infinity : now - lastPing;
    const battery = v.battery_pct === null || v.battery_pct === undefined ? null : Number(v.battery_pct);
    const noSignal = silentMs > timeoutMs;
    const lowBattery = battery !== null && battery <= BATTERY_LOW_PCT;
    return {
      ...v,
      signal_ok: !noSignal,
      minutes_without_signal: lastPing === null ? null : Math.floor(silentMs / 60000),
      battery_low: lowBattery,
      dvir_blocked: !!v.dvir_blocked,
      health_badge: v.dvir_blocked ? 'bloqueado_dvir' : noSignal ? 'sem_sinal' : lowBattery ? 'bateria_baixa' : 'ok'
    };
  });
}

module.exports = {
  telemetryRoutes,
  startFleetMonitor,
  checkFleetHealth,
  decorateVehiclesWithHealth,
  SIGNAL_TIMEOUT_SECONDS,
  BATTERY_LOW_PCT
};
