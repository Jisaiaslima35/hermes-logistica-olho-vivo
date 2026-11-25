-- ============================================================================
-- 002_olho_vivo_audit.sql — Auditoria do Olho Vivo (LGPD)
-- Hermes Logística & Olho Vivo — web-radio-panel (serviço próprio)
--
-- Princípios:
--   * todo acionamento de câmera fica registrado (quem, qual veículo, quando);
--   * o áudio NUNCA trafega no stream de vídeo — o canal de áudio é o PTT
--     explícito, registrado aqui como audio_channel='ptt_explicito';
--   * por padrão NÃO há gravação em disco (recording_path NULL, rec_on_disk=0).
-- Idempotente.
-- ============================================================================

CREATE TABLE IF NOT EXISTS olho_vivo_audit_logs (
  id                CHAR(36)     NOT NULL,
  organization_id   CHAR(36)     NOT NULL,
  user_id           CHAR(36)     NULL,
  vehicle_id        VARCHAR(64)  NULL,
  driver_id         VARCHAR(64)  NULL,
  started_at        DATETIME     NOT NULL,
  ended_at          DATETIME     NULL,
  duration_seconds  INT          NULL,
  audio_channel     VARCHAR(32)  NOT NULL DEFAULT 'ptt_explicito',
  video_audio_on    TINYINT(1)   NOT NULL DEFAULT 0,
  recorded_on_disk  TINYINT(1)   NOT NULL DEFAULT 0,
  recording_path    VARCHAR(255) NULL,
  command_source    VARCHAR(32)  NOT NULL DEFAULT 'central',
  notes             VARCHAR(255) NULL,
  created_at        TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_ovo_org (organization_id),
  KEY idx_ovo_vehicle (vehicle_id),
  KEY idx_ovo_user (user_id),
  KEY idx_ovo_started (started_at),
  KEY idx_ovo_ended (ended_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
