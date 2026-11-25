/**
 * 007_fleet_alterations_networks.js
 * Adiciona organization_id em hermes_vehicles e network_uuid em hermes_orders e hj_telemetry_points,
 * com checagem em information_schema e backfill seguro.
 */
module.exports = async function up(conn) {
  const columns = [
    ['hermes_vehicles', 'organization_id', 'CHAR(36) NULL'],
    ['hermes_orders', 'network_uuid', 'CHAR(36) NULL'],
    ['hj_telemetry_points', 'network_uuid', 'CHAR(36) NULL']
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

  // Backfill seguro para organization_id na empresa piloto padrão
  const [comps] = await conn.query(`SELECT uuid FROM companies WHERE deleted_at IS NULL ORDER BY created_at ASC LIMIT 1`);
  const defaultOrg = comps[0]?.uuid || null;
  if (defaultOrg) {
    await conn.query(`UPDATE hermes_vehicles SET organization_id = ? WHERE organization_id IS NULL`, [defaultOrg]);
    await conn.query(`UPDATE hermes_orders SET organization_id = ? WHERE organization_id = 'default' OR organization_id IS NULL`, [defaultOrg]);
  }
};
