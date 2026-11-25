const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const { pool } = require('./db');

const JWT_SECRET = process.env.JWT_SECRET || process.env.TRACKING_SIGNING_KEY || 'hermes_panel_secret_key_2026';
const COMPANY_UUID = process.env.FLEETBASE_COMPANY_UUID || '';

function verifyLaravelHash(password, hash) {
  if (!hash) return false;
  const normalized = hash.startsWith('$2y$') ? '$2a$' + hash.slice(4) : hash;
  return bcrypt.compareSync(password, normalized);
}

function hashPassword(password) {
  return bcrypt.hashSync(password, 10);
}

function signSessionToken(user) {
  return jwt.sign(
    {
      sub: user.uuid,
      username: user.username,
      email: user.email,
      name: user.name,
      type: user.type,
      company_uuid: user.company_uuid
    },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: '12h' }
  );
}

function verifySessionToken(token) {
  if (!token) return null;
  try {
    return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'] });
  } catch {
    return null;
  }
}

function extractBearer(request) {
  const auth = request.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7).trim();
  return null;
}

async function requireAuth(request, reply, allowedTypes = null) {
  const token = extractBearer(request);
  const decoded = verifySessionToken(token);
  if (!decoded) {
    reply.code(401).send({ error: 'Não autorizado. Faça login.' });
    return null;
  }
  if (allowedTypes) {
    const isSuper = decoded.type === 'super_admin' && !allowedTypes.every(t => t === 'customer');
    if (!isSuper && !allowedTypes.includes(decoded.type)) {
      reply.code(403).send({ error: 'Acesso negado para este perfil.' });
      return null;
    }
  }
  return decoded;
}

async function authenticateUser(identifier, password, expectedTypes = null) {
  const cleanId = String(identifier || '').trim();
  if (!cleanId || !password) return null;

  const [rows] = await pool.query(
    `SELECT uuid, company_uuid, username, email, phone, password, name, type, status, meta
     FROM users
     WHERE (username = ? OR email = ?) AND deleted_at IS NULL
     LIMIT 1`,
    [cleanId, cleanId]
  );

  if (!rows.length) return null;
  const user = rows[0];
  if (user.status && user.status !== 'active') return null;
  if (expectedTypes && !expectedTypes.includes(user.type)) return null;

  if (!verifyLaravelHash(password, user.password)) return null;
  return user;
}

async function registerCustomer({ name, whatsapp, cpf_cnpj, email, username, password }) {
  const cleanUsername = String(username || email || '').trim().toLowerCase();
  const cleanEmail = String(email || `${cleanUsername}@cliente.automacaojs.us`).trim().toLowerCase();
  const cleanPhone = String(whatsapp || '').trim();
  const cleanName = String(name || '').trim();

  if (!cleanName || !cleanUsername || !password) {
    throw new Error('Nome, usuário/e-mail e senha são obrigatórios.');
  }

  const [existing] = await pool.query(
    `SELECT uuid FROM users WHERE (username = ? OR email = ?) AND deleted_at IS NULL LIMIT 1`,
    [cleanUsername, cleanEmail]
  );
  if (existing.length > 0) {
    throw new Error('Usuário ou e-mail já cadastrado.');
  }

  let companyUuid = COMPANY_UUID;
  if (!companyUuid) {
    const [comps] = await pool.query(`SELECT uuid FROM companies ORDER BY created_at ASC LIMIT 1`);
    companyUuid = comps[0]?.uuid || null;
  }

  const userUuid = crypto.randomUUID();
  const contactUuid = crypto.randomUUID();
  const hashed = hashPassword(password);
  const metaJson = JSON.stringify({ cpf_cnpj: cpf_cnpj || '', source: 'portal_solicitar' });

  await pool.query(
    `INSERT INTO users (uuid, company_uuid, username, email, phone, password, name, type, status, meta, email_verified_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'customer', 'active', ?, NOW(), NOW(), NOW())`,
    [userUuid, companyUuid, cleanUsername, cleanEmail, cleanPhone, hashed, cleanName, metaJson]
  );

  await pool.query(
    `INSERT INTO contacts (uuid, company_uuid, user_uuid, name, email, phone, type, meta, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'customer', ?, NOW(), NOW())`,
    [contactUuid, companyUuid, userUuid, cleanName, cleanEmail, cleanPhone, metaJson]
  );

  return {
    uuid: userUuid,
    contact_uuid: contactUuid,
    company_uuid: companyUuid,
    username: cleanUsername,
    email: cleanEmail,
    phone: cleanPhone,
    name: cleanName,
    type: 'customer'
  };
}

module.exports = {
  authenticateUser,
  registerCustomer,
  signSessionToken,
  verifySessionToken,
  requireAuth
};
