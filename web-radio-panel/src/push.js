const crypto = require('crypto');
const webpush = require('web-push');
const { pool } = require('./db');

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || '';
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || '';
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@automacaojs.us';

let configured = false;
if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  try {
    webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
    configured = true;
  } catch (err) {
    console.warn('Falha ao configurar VAPID:', err.message);
  }
}

async function saveSubscription({ driverId, organizationId = 'default', subscription }) {
  if (!driverId || !subscription?.endpoint || !subscription?.keys?.p256dh || !subscription?.keys?.auth) {
    throw new Error('Subscription inválida');
  }
  const id = `push_${crypto.randomBytes(5).toString('hex')}`;
  await pool.query(
    `INSERT INTO hj_driver_push_subscriptions (id, driver_id, organization_id, endpoint, p256dh, auth)
     VALUES (?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE driver_id = VALUES(driver_id), organization_id = VALUES(organization_id), p256dh = VALUES(p256dh), auth = VALUES(auth)`,
    [id, driverId, organizationId, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth]
  );
  return { ok: true };
}

async function sendToSubscriptions(rows, payloadObj) {
  if (!configured || !rows.length) return 0;
  const payload = JSON.stringify(payloadObj);
  let sent = 0;
  for (const r of rows) {
    try {
      await webpush.sendNotification(
        { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } },
        payload
      );
      sent += 1;
    } catch (err) {
      if (err.statusCode === 404 || err.statusCode === 410) {
        await pool.query('DELETE FROM hj_driver_push_subscriptions WHERE id = ?', [r.id]).catch(() => {});
      }
    }
  }
  return sent;
}

async function notifyDriverPush(driverId, payloadObj) {
  if (!configured || !driverId) return 0;
  const [rows] = await pool.query('SELECT * FROM hj_driver_push_subscriptions WHERE driver_id = ?', [driverId]);
  return sendToSubscriptions(rows, payloadObj);
}

async function notifyQueuePush(organizationId, payloadObj) {
  if (!configured) return 0;
  const [rows] = await pool.query(
    'SELECT * FROM hj_driver_push_subscriptions WHERE organization_id IN (?, "default") LIMIT 100',
    [organizationId || 'default']
  );
  return sendToSubscriptions(rows, payloadObj);
}

module.exports = {
  VAPID_PUBLIC_KEY,
  saveSubscription,
  notifyDriverPush,
  notifyQueuePush
};
