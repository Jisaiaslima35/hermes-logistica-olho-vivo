/**
 * src/migrations.js — runner de migrações idempotentes.
 *
 * Lê `migrations/` (mesma pasta do src) em ordem alfabética e aplica cada
 * arquivo uma única vez, registrando em `hj_schema_migrations`.
 *   - *.sql → executa os statements separados por `;` (com guarda contra
 *              comentários e strings simples).
 *   - *.js  → módulo que exporta `async function up(conn)`.
 *
 * Nunca mexe no core Fleetbase (AGPL): tudo aqui é schema do serviço próprio.
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { pool } = require('./db');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');
const LEDGER_TABLE = 'hj_schema_migrations';

/** Divide um arquivo .sql em statements, ignorando comentários e `;` dentro de literais. */
function splitSql(sql) {
  const out = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (c === '\n') { inLineComment = false; buf += c; }
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && next === '/') { inBlockComment = false; i++; }
      continue;
    }
    if (!inSingle && !inDouble && !inBacktick) {
      if (c === '-' && next === '-') { inLineComment = true; i++; continue; }
      if (c === '#') { inLineComment = true; continue; }
      if (c === '/' && next === '*') { inBlockComment = true; i++; continue; }
    }

    if (c === "'" && !inDouble && !inBacktick) inSingle = !inSingle;
    else if (c === '"' && !inSingle && !inBacktick) inDouble = !inDouble;
    else if (c === '`' && !inSingle && !inDouble) inBacktick = !inBacktick;

    if (c === ';' && !inSingle && !inDouble && !inBacktick) {
      const stmt = buf.trim();
      if (stmt) out.push(stmt);
      buf = '';
      continue;
    }
    buf += c;
  }
  const last = buf.trim();
  if (last) out.push(last);
  return out;
}

async function ensureLedger(conn) {
  await conn.query(`
    CREATE TABLE IF NOT EXISTS ${LEDGER_TABLE} (
      filename    VARCHAR(191) NOT NULL,
      checksum    CHAR(64)     NOT NULL,
      applied_at  TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (filename)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function checksumOf(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

async function runMigrations(log = console) {
  const conn = await pool.getConnection();
  const applied = [];
  try {
    await ensureLedger(conn);
    const [rows] = await conn.query(`SELECT filename FROM ${LEDGER_TABLE}`);
    const done = new Set(rows.map(r => r.filename));

    const files = fs.readdirSync(MIGRATIONS_DIR)
      .filter(f => /\.(sql|js)$/i.test(f))
      .sort();

    for (const file of files) {
      const full = path.join(MIGRATIONS_DIR, file);
      const content = fs.readFileSync(full, 'utf8');
      const sum = checksumOf(content);

      if (done.has(file)) {
        const [prev] = await conn.query(`SELECT checksum FROM ${LEDGER_TABLE} WHERE filename = ?`, [file]);
        if (prev[0] && prev[0].checksum === sum) continue;
        log.warn?.(`[migrations] ${file} mudou (checksum) — será reaplicada (idempotente por design)`);
      }

      if (/\.sql$/i.test(file)) {
        for (const stmt of splitSql(content)) {
          await conn.query(stmt);
        }
      } else {
        const mod = require(full);
        await mod(conn);
      }

      await conn.query(
        `INSERT INTO ${LEDGER_TABLE} (filename, checksum) VALUES (?, ?)
         ON DUPLICATE KEY UPDATE checksum = VALUES(checksum), applied_at = NOW()`,
        [file, sum]
      );
      applied.push(file);
      log.info?.(`[migrations] aplicado: ${file}`);
    }
  } finally {
    conn.release();
  }
  return applied;
}

module.exports = { runMigrations, splitSql, MIGRATIONS_DIR };
