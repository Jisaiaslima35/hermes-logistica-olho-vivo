-- 005_hj_platform_audit.sql — Auditoria append-only da plataforma e enxames

CREATE TABLE IF NOT EXISTS hj_platform_audit (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_uuid VARCHAR(64) NULL,
  actor_name VARCHAR(128) NULL,
  actor_role VARCHAR(32) NULL,
  company_uuid CHAR(36) NULL,
  network_uuid CHAR(36) NULL,
  action VARCHAR(64) NOT NULL,
  target_type VARCHAR(64) NULL,
  target_id VARCHAR(64) NULL,
  details_json JSON NULL,
  ip_address VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_hpa_comp_time (company_uuid, created_at),
  INDEX idx_hpa_net_time (network_uuid, created_at),
  INDEX idx_hpa_action (action, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
