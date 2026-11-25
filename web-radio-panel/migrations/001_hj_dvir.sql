-- ============================================================================
-- 001_hj_dvir.sql — Vistoria Fotográfica Obrigatória (DVIR) blindada
-- Hermes Logística & Olho Vivo — web-radio-panel (serviço próprio)
--
-- REGRA: tabelas PRÓPRIAS com prefixo `hj_`. Não toca o core Fleetbase (AGPL).
-- Idempotente: pode rodar N vezes sem efeito colateral.
-- Chaves CHAR(36) compatíveis com os UUIDs do Fleetbase (organizations=companies.uuid).
-- ============================================================================

CREATE TABLE IF NOT EXISTS hj_dvir_templates (
  id                   CHAR(36)     NOT NULL,
  vehicle_category     VARCHAR(32)  NOT NULL,
  label                VARCHAR(128) NOT NULL,
  required_items_json  JSON         NOT NULL,
  required_photos_json JSON         NOT NULL,
  active               TINYINT(1)   NOT NULL DEFAULT 1,
  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_hj_dvir_templates_category (vehicle_category)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hj_dvir_inspections (
  id                    CHAR(36)     NOT NULL,
  organization_id       CHAR(36)     NOT NULL,
  vehicle_id            VARCHAR(64)  NOT NULL,
  driver_id             VARCHAR(64)  NULL,
  shift_type            VARCHAR(16)  NOT NULL,
  paired_inspection_id  CHAR(36)     NULL,
  odometer_km           DECIMAL(10,2) NULL,
  gps_lat               DOUBLE       NULL,
  gps_lng               DOUBLE       NULL,
  server_recorded_at    DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checklist_json        JSON         NOT NULL,
  has_damage            TINYINT(1)   NOT NULL DEFAULT 0,
  damage_notes          TEXT         NULL,
  status                VARCHAR(24)  NOT NULL DEFAULT 'aprovado',
  locked_immutable      TINYINT(1)   NOT NULL DEFAULT 1,
  reviewed_by_user_id   CHAR(36)     NULL,
  reviewed_at           DATETIME     NULL,
  review_notes          TEXT         NULL,
  created_at            TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_hj_dvir_insp_org (organization_id),
  KEY idx_hj_dvir_insp_veh (vehicle_id),
  KEY idx_hj_dvir_insp_driver (driver_id),
  KEY idx_hj_dvir_insp_shift (shift_type),
  KEY idx_hj_dvir_insp_status (status),
  KEY idx_hj_dvir_insp_paired (paired_inspection_id),
  KEY idx_hj_dvir_insp_created (server_recorded_at),
  CONSTRAINT fk_hj_dvir_insp_paired FOREIGN KEY (paired_inspection_id)
    REFERENCES hj_dvir_inspections (id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hj_dvir_photos (
  id                   CHAR(36)     NOT NULL,
  inspection_id        CHAR(36)     NOT NULL,
  organization_id      CHAR(36)     NOT NULL,
  slot_name            VARCHAR(32)  NOT NULL,
  stored_uuid_filename VARCHAR(64)  NOT NULL,
  relative_path        VARCHAR(255) NOT NULL,
  sha256_hash          CHAR(64)     NOT NULL,
  is_duplicate_hash    TINYINT(1)   NOT NULL DEFAULT 0,
  file_size_bytes      INT          NOT NULL DEFAULT 0,
  created_at           TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_hj_dvir_photos_insp (inspection_id),
  KEY idx_hj_dvir_photos_org (organization_id),
  KEY idx_hj_dvir_photos_hash (organization_id, sha256_hash),
  CONSTRAINT fk_hj_dvir_photos_insp FOREIGN KEY (inspection_id)
    REFERENCES hj_dvir_inspections (id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS hj_dvir_audit_logs (
  id              CHAR(36)     NOT NULL,
  organization_id CHAR(36)     NULL,
  inspection_id   CHAR(36)     NULL,
  user_id         CHAR(36)     NULL,
  action          VARCHAR(48)  NOT NULL,
  details_json    JSON         NULL,
  created_at      TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_hj_dvir_audit_insp (inspection_id),
  KEY idx_hj_dvir_audit_org (organization_id),
  KEY idx_hj_dvir_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Retenção de fotos por organização (padrão 12 meses)
CREATE TABLE IF NOT EXISTS hj_dvir_retention_config (
  organization_id   CHAR(36) NOT NULL,
  retention_months  INT      NOT NULL DEFAULT 12,
  updated_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ─── 4 templates padrão (um por categoria de veículo) ───────────────────────
INSERT IGNORE INTO hj_dvir_templates
  (id, vehicle_category, label, required_items_json, required_photos_json)
VALUES
  ('11111111-1111-4111-8111-111111110001', 'moto',
   'Moto / Mototáxi',
   '["pneu_pressao","pneu_danos","freios","luz_frente","luz_traseira","buzina","espelhos","oleo_motor","pneu_estepe","placa"]',
   '["frente","lateral_esquerda","lateral_direita","pneus","velocimetro"]'),
  ('11111111-1111-4111-8111-111111110002', 'utilitario',
   'Utilitário / Fiorino',
   '["pneu_pressao","pneu_danos","freios","luz_frente","luz_traseira","buzina","espelhos","oleo_motor","pneu_estepe","porta_carga","placa"]',
   '["frente","lateral_esquerda","lateral_direita","pneus","velocimetro"]'),
  ('11111111-1111-4111-8111-111111110003', 'bau',
   'Caminhão Baú',
   '["pneu_pressao","pneu_danos","freios","luz_frente","luz_traseira","buzina","espelhos","oleo_motor","pneu_estepe","porta_carga","mecanismo_elevador","escada_lateral","placa"]',
   '["frente","lateral_esquerda","lateral_direita","pneus","velocimetro","avaria"]'),
  ('11111111-1111-4111-8111-111111110004', 'carreta',
   'Carreta Pesada',
   '["pneu_pressao","pneu_danos","freios","luz_frente","luz_traseira","buzina","espelhos","oleo_motor","pneu_estepe","porta_carga","mecanismo_elevador","escada_lateral","lacrar_carga","placa"]',
   '["frente","lateral_esquerda","lateral_direita","pneus","velocimetro","avaria"]');

-- Retenção padrão 12 meses para a organização do piloto
INSERT IGNORE INTO hj_dvir_retention_config (organization_id, retention_months)
SELECT uuid, 12 FROM companies ORDER BY created_at ASC LIMIT 1;
