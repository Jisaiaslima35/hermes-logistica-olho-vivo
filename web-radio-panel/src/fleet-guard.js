/**
 * src/fleet-guard.js — regras de bloqueio de veículo por vistoria DVIR.
 *
 * Um veículo reprovado na vistoria (ou bloqueado pelo gerente no painel)
 * fica com `dvir_blocked = 1` em `hermes_vehicles`. Com isso:
 *   - GET  /api/driver/queue?vehicle_id=...  -> 403
 *   - POST /api/driver/orders/:id/accept     -> 403
 *   - POST /api/driver/orders/:id/complete   -> 403 (corrida não pode seguir)
 *
 * O desbloqueio é sempre explícito (gerente) e auditado.
 */
const { pool } = require('./db');

const BLOCK_MESSAGE = 'Veículo bloqueado por vistoria DVIR. Liberação pendente do gerente.';

async function isVehicleBlocked(vehicleId) {
  if (!vehicleId) return null;
  const [rows] = await pool.query(
    `SELECT id, plate, model, dvir_blocked, dvir_blocked_reason, dvir_blocked_at
       FROM hermes_vehicles WHERE id = ? LIMIT 1`,
    [vehicleId]
  );
  if (!rows.length) return null;
  const v = rows[0];
  return v.dvir_blocked ? v : null;
}

async function blockVehicle({ vehicleId, reason, userId = null }) {
  await pool.query(
    `UPDATE hermes_vehicles
        SET dvir_blocked = 1,
            dvir_blocked_reason = ?,
            dvir_blocked_at = NOW(),
            dvir_blocked_by = COALESCE(?, dvir_blocked_by),
            status = 'bloqueado_dvir'
      WHERE id = ?`,
    [String(reason || '').slice(0, 255), userId, vehicleId]
  );
}

async function unblockVehicle({ vehicleId, userId = null }) {
  await pool.query(
    `UPDATE hermes_vehicles
        SET dvir_blocked = 0,
            dvir_blocked_reason = NULL,
            dvir_blocked_at = NULL,
            dvir_blocked_by = NULL,
            status = CASE WHEN status = 'bloqueado_dvir' THEN 'disponivel' ELSE status END
      WHERE id = ?`,
    [vehicleId]
  );
}

module.exports = { isVehicleBlocked, blockVehicle, unblockVehicle, BLOCK_MESSAGE };
