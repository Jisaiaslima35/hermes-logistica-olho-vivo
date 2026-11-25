/**
 * 003_fleet_alterations.js
 *
 * Alterações idempotentes em tabelas JÁ EXISTENTES (o MySQL 8 não tem
 * `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, então a checagem é feita
 * contra information_schema antes de cada DDL).
 *
 * Roda dentro de migrations/ e é aplicado pelo runner (src/migrations.js).
 */
module.exports = async function up(conn) {
  const columns = [
    ['hermes_vehicles', 'dvir_blocked', 'TINYINT(1) NOT NULL DEFAULT 0'],
    ['hermes_vehicles', 'dvir_blocked_reason', 'VARCHAR(255) NULL'],
    ['hermes_vehicles', 'dvir_blocked_at', 'DATETIME NULL'],
    ['hermes_vehicles', 'dvir_blocked_by', 'CHAR(36) NULL'],
    ['hermes_vehicles', 'last_ping_at', 'DATETIME NULL'],
    ['hermes_vehicles', 'last_signal_alert_at', 'DATETIME NULL'],
    ['hermes_vehicles', 'last_battery_alert_at', 'DATETIME NULL'],
    ['hermes_vehicles', 'camera_active', 'TINYINT(1) NOT NULL DEFAULT 0']
  ];

  for (const [table, column, def] of columns) {
    const [rows] = await conn.query(
      `SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`,
      [table, column]
    );
    if (!rows.length) {
      await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${def}`);
    }
  }

  // Pontos de telemetria store-and-forward (fila offline do app motorista).
  await conn.query(`
    CREATE TABLE IF NOT EXISTS hj_telemetry_points (
      id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
      organization_id  CHAR(36)    NULL,
      vehicle_id       VARCHAR(64) NULL,
      driver_id        VARCHAR(64) NULL,
      order_id         VARCHAR(64) NULL,
      lat              DOUBLE      NULL,
      lon              DOUBLE      NULL,
      speed_kph        DOUBLE      NULL,
      heading_deg      DOUBLE      NULL,
      battery_pct      INT         NULL,
      deviation_m      DOUBLE      NULL,
      stopped_s        DOUBLE      NULL,
      recorded_at      DATETIME    NOT NULL,
      received_at      TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      batch_id         CHAR(36)    NULL,
      PRIMARY KEY (id),
      KEY idx_hj_tp_veh_time (vehicle_id, recorded_at),
      KEY idx_hj_tp_batch (batch_id),
      KEY idx_hj_tp_org (organization_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  // Fila store-and-forward do app (estado persistido no device).
  await conn.query(`
    CREATE TABLE IF NOT EXISTS hj_telemetry_batches (
      id                CHAR(36)    NOT NULL,
      organization_id   CHAR(36)    NULL,
      vehicle_id        VARCHAR(64) NULL,
      driver_id         VARCHAR(64) NULL,
      points_count      INT         NOT NULL DEFAULT 0,
      first_recorded_at DATETIME    NULL,
      last_recorded_at  DATETIME    NULL,
      received_at       TIMESTAMP   NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY idx_hj_tb_veh (vehicle_id, received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
};
