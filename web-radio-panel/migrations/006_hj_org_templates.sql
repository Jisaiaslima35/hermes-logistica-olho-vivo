-- 006_hj_org_templates.sql — Templates "Modelo X" versionados para clonagem de cooperativas

CREATE TABLE IF NOT EXISTS hj_org_templates (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(128) NOT NULL,
  version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
  description VARCHAR(255) NULL,
  config_json JSON NOT NULL,
  created_by VARCHAR(64) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
