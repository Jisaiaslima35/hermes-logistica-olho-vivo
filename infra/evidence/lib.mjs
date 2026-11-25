// ─────────────────────────────────────────────────────────────────────────────
// lib.mjs — helpers compartilhados das suítes de evidência do Hermes.
//
//  • http()        → fetch com log de método/URL/status
//  • json()        → wrapper que devolve {status, headers, body}
//  • loginAdmin()  → token de sessão via /api/auth/admin/demo
//  • mintToken()   → JWT HS256 sem dependência externa (para org de outra empresa)
//  • mysqlExec()   → executa SQL via container fleetbase-mysql (sem imprimir senha)
//
// NUNCA imprime senha. Só nomes de variável.
// ─────────────────────────────────────────────────────────────────────────────
import crypto from 'node:crypto';

export const BASE = process.env.PANEL_URL || 'http://127.0.0.1:8601';
export const BRIDGE = process.env.BRIDGE_URL || 'http://127.0.0.1:8600';
export const ORG_ID = '5b4e40e1-0348-4051-835d-4cbc33b9cf36';
export const JWT_SECRET = process.env.PANEL_JWT_SECRET || 'hermes_panel_secret_key_2026';
export const MYSQL_CONTAINER = 'fleetbase-mysql';

const C = { g: '\x1b[32m', r: '\x1b[31m', y: '\x1b[33m', b: '\x1b[1m', d: '\x1b[2m', x: '\x1b[0m' };
export const col = (c, s) => `${C[c]}${s}${C.x}`;

export function section(t) {
  console.log(`\n${col('b', '═'.repeat(78))}`);
  console.log(col('b', `  ${t}`));
  console.log(col('b', '═'.repeat(78)));
}

export function step(t) {
  console.log(`\n${col('y', '▸')} ${col('b', t)}`);
}

export function ok(t, extra = '') {
  console.log(`  ${col('g', '✔')} ${t}${extra ? col('d', '  ' + extra) : ''}`);
}

export function fail(t, extra = '') {
  console.log(`  ${col('r', '✘')} ${t}${extra ? col('d', '  ' + extra) : ''}`);
}

export function info(t) {
  console.log(`    ${col('d', t)}`);
}

export function assert(cond, label, extra = '') {
  if (cond) ok(label, extra);
  else fail(label, extra);
  return !!cond;
}

/** fetch com log. Devolve {status, headers, body, json}. */
export async function http(method, path, { token, body, headers = {}, base = BASE, raw = false } = {}) {
  const url = path.startsWith('http') ? path : base + path;
  const h = { ...headers };
  if (token) h.Authorization = `Bearer ${token}`;
  let payload = body;
  if (body && !raw && typeof body === 'object' && !(body instanceof FormData)) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  const t0 = Date.now();
  const res = await fetch(url, { method, headers: h, body: payload });
  const ms = Date.now() - t0;
  const ctype = res.headers.get('content-type') || '';
  let out = { status: res.status, headers: res.headers, ms, body: null, json: null, buf: null };
  if (ctype.includes('application/json')) {
    const txt = await res.text();
    out.body = txt;
    try { out.json = JSON.parse(txt); } catch { out.json = null; }
  } else if (raw) {
    out.buf = Buffer.from(await res.arrayBuffer());
    out.body = `<${out.buf.length} bytes binários>`;
  } else {
    out.body = (await res.text()).slice(0, 400);
  }
  console.log(`    ${col('d', `${method} ${path.replace(BASE, '').slice(0, 90)} → ${res.status} (${ms}ms)`)}`);
  return out;
}

/** Login do admin piloto (modo demo do painel). */
export async function loginAdmin() {
  const r = await http('POST', '/api/auth/admin/demo');
  if (r.status !== 200) throw new Error(`login admin falhou: ${r.status} ${r.body}`);
  return r.json.token;
}

/** Login de motorista (usuário real do users表). */
export async function loginDriver(identifier, password) {
  const r = await http('POST', '/api/auth/driver/login', { body: { identifier, password } });
  if (r.status !== 200) throw new Error(`login driver falhou: ${r.status} ${r.body}`);
  return r.json.token;
}

/** JWT HS256 no formato do painel (sub, username, type, company_uuid). */
export function mintToken(payload, expiresInSec = 3600) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const head = { alg: 'HS256', typ: 'JWT' };
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const data = `${b64(head)}.${b64(body)}`;
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

/** Executa SQL no container do MySQL usando o usuário da aplicação. */
export async function mysqlExec(sql, { db = 'fleetbase_db', silent = false } = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ex = promisify(execFile);
  const env = await readMysqlEnv();
  const args = ['exec', '-i', '-e', `MYSQL_PWD=${env.DB_PASSWORD}`, MYSQL_CONTAINER, 'mysql',
    '-h', env.DB_HOST, '-u', env.DB_USER,
    '-D', db, '--default-character-set=utf8mb4', '--batch', '--skip-column-names', '-e', sql];
  const { stdout } = await ex('docker', args, { maxBuffer: 8 * 1024 * 1024 });
  if (!silent) console.log(`    ${col('d', `SQL[${db}] ${sql.replace(/\s+/g, ' ').slice(0, 80)}`)}`);
  return stdout.trim();
}

let ENV_CACHE = null;
async function readMysqlEnv() {
  if (ENV_CACHE) return ENV_CACHE;
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ex = promisify(execFile);
  const { stdout } = await ex('bash', ['-lc',
    `grep -E '^(DB_HOST|DB_USER|DB_USERNAME|DB_PASSWORD|DB_NAME|DB_DATABASE)=' /opt/hermes-fleetbase/infra/env/fleetbase.mysql.env`]);
  const raw = {};
  for (const line of stdout.split('\n')) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) raw[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  ENV_CACHE = {
    DB_HOST: raw.DB_HOST || 'fleetbase-mysql',
    DB_USER: raw.DB_USER || raw.DB_USERNAME || 'fleetbase',
    DB_PASSWORD: raw.DB_PASSWORD || '',
    DB_NAME: raw.DB_NAME || raw.DB_DATABASE || 'fleetbase_db'
  };
  return ENV_CACHE;
}

/** Monta FormData com arquivos do disco. */
export async function filePart(form, field, filePath, filename, contentType) {
  const fs = await import('node:fs');
  const buf = fs.readFileSync(filePath);
  form.append(field, new Blob([buf], { type: contentType }), filename);
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
