-- Migration 003: Motor de Precificação Dinâmica, Split da Cooperativa e Carteira Digital (Ledger)

CREATE TABLE IF NOT EXISTS hermes_split_rules (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL DEFAULT 'default',
  driver_id VARCHAR(64) NULL,
  split_type ENUM('percentual', 'taxa_fixa_por_corrida') NOT NULL DEFAULT 'percentual',
  coop_value DECIMAL(10,2) NOT NULL DEFAULT 15.00,
  extras_to_driver_100 TINYINT(1) NOT NULL DEFAULT 1,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY uq_org_driver_split (organization_id, driver_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payout_batches (
  id VARCHAR(64) PRIMARY KEY,
  organization_id VARCHAR(64) NOT NULL DEFAULT 'default',
  total_amount DECIMAL(10,2) NOT NULL DEFAULT 0.00,
  drivers_count INT NOT NULL DEFAULT 0,
  status VARCHAR(32) NOT NULL DEFAULT 'aberto',
  notes TEXT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  paid_at DATETIME NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

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
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
