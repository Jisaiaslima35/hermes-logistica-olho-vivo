const mysql = require('mysql2/promise');

const DB_HOST = process.env.DB_HOST || 'fleetbase-mysql';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'fleetbase';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'fleetbase_db';

const pool = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 6,
  queueLimit: 0,
  timezone: 'Z'
});

async function initSchema() {
  const conn = await pool.getConnection();
  try {
    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_tariffs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        fleet_type VARCHAR(32) NOT NULL UNIQUE,
        label VARCHAR(64) NOT NULL,
        base_fee DECIMAL(10,2) NOT NULL DEFAULT 10.00,
        per_km_fee DECIMAL(10,2) NOT NULL DEFAULT 2.50,
        coop_fee_pct DECIMAL(5,2) NOT NULL DEFAULT 15.00,
        active TINYINT(1) NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_drivers (
        id VARCHAR(64) PRIMARY KEY,
        fleetbase_driver_uuid VARCHAR(64) NULL,
        name VARCHAR(128) NOT NULL,
        whatsapp VARCHAR(32) NOT NULL,
        plate VARCHAR(20) NOT NULL,
        fleet_type VARCHAR(32) NOT NULL DEFAULT 'moto',
        commission_pct DECIMAL(5,2) NOT NULL DEFAULT 80.00,
        online TINYINT(1) NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'disponivel',
        lat DOUBLE NULL,
        lon DOUBLE NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_vehicles (
        id VARCHAR(64) PRIMARY KEY,
        fleetbase_vehicle_uuid VARCHAR(64) NULL,
        plate VARCHAR(20) NOT NULL,
        model VARCHAR(128) NOT NULL,
        fleet_type VARCHAR(32) NOT NULL DEFAULT 'moto',
        driver_id VARCHAR(64) NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'disponivel',
        lat DOUBLE NULL,
        lon DOUBLE NULL,
        speed_kph DOUBLE DEFAULT 0,
        heading_deg DOUBLE DEFAULT 0,
        battery_pct INT DEFAULT 100,
        dvir_status VARCHAR(32) DEFAULT 'pendente',
        camera_active TINYINT(1) DEFAULT 0,
        facing VARCHAR(16) DEFAULT 'back',
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_places (
        id VARCHAR(64) PRIMARY KEY,
        fleetbase_place_uuid VARCHAR(64) NULL,
        name VARCHAR(128) NOT NULL,
        place_type VARCHAR(32) DEFAULT 'base',
        address VARCHAR(255) NULL,
        lat DOUBLE NOT NULL,
        lon DOUBLE NOT NULL,
        radius_m INT DEFAULT 300,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_orders (
        id VARCHAR(64) PRIMARY KEY,
        fleetbase_order_uuid VARCHAR(64) NULL,
        client_user_uuid VARCHAR(64) NOT NULL,
        client_name VARCHAR(128) NULL,
        driver_id VARCHAR(64) NULL,
        driver_name VARCHAR(128) NULL,
        vehicle_id VARCHAR(64) NULL,
        fleet_type VARCHAR(32) NOT NULL,
        status VARCHAR(32) NOT NULL DEFAULT 'pendente',
        queue_mode VARCHAR(32) NOT NULL DEFAULT 'direto',
        origin_address VARCHAR(255) NOT NULL,
        origin_lat DOUBLE NULL,
        origin_lon DOUBLE NULL,
        destinations_json JSON NOT NULL,
        distance_km DECIMAL(8,2) DEFAULT 5.00,
        recipient_name VARCHAR(128) NULL,
        recipient_whatsapp VARCHAR(32) NULL,
        invoice_number VARCHAR(64) NULL,
        notes TEXT NULL,
        estimated_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        final_price DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        coop_fee_pct DECIMAL(5,2) NOT NULL DEFAULT 15.00,
        driver_commission_pct DECIMAL(5,2) NOT NULL DEFAULT 85.00,
        scheduled_at DATETIME NULL,
        accepted_at DATETIME NULL,
        completed_at DATETIME NULL,
        proof_photo_url VARCHAR(512) NULL,
        proof_notes TEXT NULL,
        problem_reason TEXT NULL,
        tracking_token VARCHAR(512) NULL,
        settlement_id VARCHAR(64) NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        INDEX idx_client (client_user_uuid),
        INDEX idx_status (status),
        INDEX idx_driver (driver_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_dvir (
        id VARCHAR(64) PRIMARY KEY,
        vehicle_id VARCHAR(64) NOT NULL,
        driver_id VARCHAR(64) NULL,
        driver_name VARCHAR(128) NULL,
        order_id VARCHAR(64) NULL,
        result VARCHAR(32) NOT NULL,
        blocks_departure TINYINT(1) DEFAULT 0,
        items_json JSON NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_alerts (
        id VARCHAR(64) PRIMARY KEY,
        order_id VARCHAR(64) NULL,
        vehicle_id VARCHAR(64) NULL,
        driver_id VARCHAR(64) NULL,
        alert_type VARCHAR(64) NOT NULL,
        message TEXT NOT NULL,
        details_json JSON NULL,
        acknowledged TINYINT(1) DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_settlements (
        id VARCHAR(64) PRIMARY KEY,
        driver_id VARCHAR(64) NOT NULL,
        driver_name VARCHAR(128) NULL,
        period_start DATE NOT NULL,
        period_end DATE NOT NULL,
        total_deliveries INT NOT NULL DEFAULT 0,
        gross_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        coop_fee_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        net_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        status VARCHAR(32) NOT NULL DEFAULT 'fechado',
        closed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const extraOrderCols = [
      ['organization_id', "VARCHAR(64) NOT NULL DEFAULT 'default'"],
      ['payment_method', "VARCHAR(32) NOT NULL DEFAULT 'pix'"],
      ['cargo_weight_kg', 'DECIMAL(10,2) NULL'],
      ['cargo_volume', 'VARCHAR(64) NULL'],
      ['cargo_type', 'VARCHAR(128) NULL'],
      ['duration_min', 'INT DEFAULT 15'],
      ['route_source', "VARCHAR(32) DEFAULT 'osrm'"],
      ['requires_return', 'TINYINT(1) NOT NULL DEFAULT 0'],
      ['extra_stops_count', 'INT NOT NULL DEFAULT 0'],
      ['pricing_snapshot_json', 'JSON NULL'],
      ['valor_total_cliente', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
      ['valor_taxa_cooperativa', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
      ['valor_liquido_motoboy', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00']
    ];
    for (const [col, def] of extraOrderCols) {
      const [cols] = await conn.query(`SHOW COLUMNS FROM hermes_orders LIKE ?`, [col]);
      if (!cols.length) {
        await conn.query(`ALTER TABLE hermes_orders ADD COLUMN ${col} ${def}`);
      }
    }

    const extraTariffCols = [
      ['organization_id', "VARCHAR(64) NOT NULL DEFAULT 'default'"],
      ['km_franquia', 'DECIMAL(8,2) NOT NULL DEFAULT 3.00'],
      ['adicional_retorno', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
      ['adicional_parada_extra', 'DECIMAL(10,2) NOT NULL DEFAULT 5.00'],
      ['adicional_noturno_ou_clima', 'DECIMAL(10,2) NOT NULL DEFAULT 0.00'],
      ['adicional_noturno_ativo', 'TINYINT(1) NOT NULL DEFAULT 0']
    ];
    for (const [col, def] of extraTariffCols) {
      const [cols] = await conn.query(`SHOW COLUMNS FROM hermes_tariffs LIKE ?`, [col]);
      if (!cols.length) {
        await conn.query(`ALTER TABLE hermes_tariffs ADD COLUMN ${col} ${def}`);
      }
    }

    const extraDriverCols = [
      ['organization_id', "VARCHAR(64) NOT NULL DEFAULT 'default'"],
      ['pix_key', 'VARCHAR(128) NULL']
    ];
    for (const [col, def] of extraDriverCols) {
      const [cols] = await conn.query(`SHOW COLUMNS FROM hermes_drivers LIKE ?`, [col]);
      if (!cols.length) {
        await conn.query(`ALTER TABLE hermes_drivers ADD COLUMN ${col} ${def}`);
      }
    }

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hermes_split_rules (
        id VARCHAR(64) PRIMARY KEY,
        organization_id VARCHAR(64) NOT NULL DEFAULT 'default',
        driver_id VARCHAR(64) NULL,
        split_type ENUM('percentual', 'taxa_fixa_por_corrida') NOT NULL DEFAULT 'percentual',
        coop_value DECIMAL(10,2) NOT NULL DEFAULT 15.00,
        extras_to_driver_100 TINYINT(1) NOT NULL DEFAULT 1,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
        UNIQUE KEY uq_org_driver_split (organization_id, driver_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS payout_batches (
        id VARCHAR(64) PRIMARY KEY,
        organization_id VARCHAR(64) NOT NULL DEFAULT 'default',
        total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
        drivers_count INT NOT NULL DEFAULT 0,
        status VARCHAR(32) NOT NULL DEFAULT 'aberto',
        notes TEXT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        paid_at DATETIME NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS driver_wallet_transactions (
        id VARCHAR(64) PRIMARY KEY,
        organization_id VARCHAR(64) NOT NULL DEFAULT 'default',
        driver_id VARCHAR(64) NOT NULL,
        order_id VARCHAR(64) NULL,
        payout_batch_id VARCHAR(64) NULL,
        tipo ENUM('credito_corrida', 'bonus', 'ajuste_manual', 'desconto_mensalidade', 'repasse_saque') NOT NULL,
        status ENUM('bloqueado', 'disponivel', 'pago') NOT NULL DEFAULT 'disponivel',
        valor DECIMAL(10,2) NOT NULL,
        valor_bruto_os DECIMAL(10,2) NULL,
        taxa_cooperativa_os DECIMAL(10,2) NULL,
        descricao VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_wallet_driver (driver_id, status),
        INDEX idx_wallet_batch (payout_batch_id),
        UNIQUE KEY uq_wallet_order_credit (order_id, tipo)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    await conn.query(`
      CREATE TABLE IF NOT EXISTS hj_driver_push_subscriptions (
        id VARCHAR(64) PRIMARY KEY,
        driver_id VARCHAR(64) NOT NULL,
        organization_id VARCHAR(64) NOT NULL DEFAULT 'default',
        endpoint TEXT NOT NULL,
        p256dh VARCHAR(255) NOT NULL,
        auth VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_push_driver (driver_id),
        UNIQUE KEY uq_push_endpoint (endpoint(255))
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `);

    const [splitRows] = await conn.query("SELECT COUNT(*) AS cnt FROM hermes_split_rules WHERE driver_id IS NULL");
    if (splitRows[0].cnt === 0) {
      await conn.query(`
        INSERT INTO hermes_split_rules (id, organization_id, driver_id, split_type, coop_value, extras_to_driver_100)
        VALUES ('split_org_default', 'default', NULL, 'percentual', 15.00, 1)
      `);
    }

    const [rows] = await conn.query('SELECT COUNT(*) AS cnt FROM hermes_tariffs');
    if (rows[0].cnt === 0) {
      await conn.query(`
        INSERT INTO hermes_tariffs (fleet_type, label, base_fee, per_km_fee, coop_fee_pct) VALUES
        ('moto', 'Moto / Mototáxi', 8.00, 2.20, 15.00),
        ('utilitario', 'Utilitário / Fiorino', 25.00, 3.80, 15.00),
        ('bau', 'Caminhão Baú', 85.00, 6.50, 12.00),
        ('carreta', 'Carreta Pesada', 180.00, 11.00, 10.00)
      `);
    }

    const [places] = await conn.query('SELECT COUNT(*) AS cnt FROM hermes_places');
    if (places[0].cnt === 0) {
      await conn.query(`
        INSERT INTO hermes_places (id, name, place_type, address, lat, lon, radius_m) VALUES
        ('plc_base_natal', 'Base Central Natal', 'base', 'Av. Prudente de Morais, 1000 - Natal/RN', -5.794512, -35.208456, 300)
      `);
    }
  } finally {
    conn.release();
  }
}

module.exports = { pool, initSchema };
