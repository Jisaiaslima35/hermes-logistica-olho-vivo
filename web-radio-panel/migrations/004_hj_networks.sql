-- 004_hj_networks.sql — Enxames / Redes (reaproveitando core `fleets` sem alterar seu DDL)

CREATE TABLE IF NOT EXISTS hj_network_members (
  id VARCHAR(64) PRIMARY KEY,
  network_uuid CHAR(36) NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  subject_type ENUM('driver', 'vehicle', 'user') NOT NULL,
  subject_id VARCHAR(64) NOT NULL,
  role ENUM('manager', 'member') NOT NULL DEFAULT 'member',
  status ENUM('active', 'paused') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_hnm_net (network_uuid, status),
  INDEX idx_hnm_comp (company_uuid, subject_type),
  UNIQUE KEY uq_hnm_member (network_uuid, subject_type, subject_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hj_network_sessions (
  id VARCHAR(64) PRIMARY KEY,
  network_uuid CHAR(36) NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  livekit_room VARCHAR(128) NOT NULL,
  vision_room VARCHAR(128) NOT NULL,
  status ENUM('open', 'closed') NOT NULL DEFAULT 'open',
  features_json JSON NULL,
  started_by VARCHAR(64) NULL,
  started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME NULL,
  INDEX idx_hns_net (network_uuid, status),
  INDEX idx_hns_comp (company_uuid, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hj_network_chat (
  id VARCHAR(64) PRIMARY KEY,
  network_uuid CHAR(36) NOT NULL,
  company_uuid CHAR(36) NOT NULL,
  sender_uuid VARCHAR(64) NOT NULL,
  sender_name VARCHAR(128) NOT NULL,
  sender_role VARCHAR(32) NOT NULL DEFAULT 'member',
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hnc_net_time (network_uuid, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
