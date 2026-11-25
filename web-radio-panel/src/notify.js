/**
 * src/notify.js — canal de alerta da Central (NTFY local + WhatsApp via bridge).
 *
 * NTFY: servidor local em 127.0.0.1:8088 (container ntfy-server), sem auth.
 * WhatsApp: NÃO fala direto com a Evolution — delega ao bridge-whatsapp via
 * `emitBridgeEvent` (regra do projeto: o painel não conhece credenciais de
 * mensageria).
 */
const NTFY_URL = (process.env.NTFY_URL || 'http://127.0.0.1:8088').replace(/\/$/, '');
const NTFY_TOPIC = process.env.NTFY_TOPIC || 'hermes-frota';
const NTFY_TIMEOUT_MS = parseInt(process.env.NTFY_TIMEOUT_MS || '4000', 10);

async function publishNtfy(title, message, opts = {}) {
  const topic = opts.topic || NTFY_TOPIC;
  const url = `${NTFY_URL}/${encodeURIComponent(topic)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), NTFY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Title': String(title || 'Alerta Hermes').slice(0, 200),
        'Priority': String(opts.priority || 'default'),
        'Tags': opts.tags || 'rotating_light',
        ...(opts.click ? { 'Click': opts.click } : {}),
        ...(opts.actions ? { 'Actions': opts.actions } : {})
      },
      body: String(message || ''),
      signal: controller.signal
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { publishNtfy, NTFY_URL, NTFY_TOPIC };
