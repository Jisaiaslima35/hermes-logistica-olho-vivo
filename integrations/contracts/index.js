const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const envelopeSchema = JSON.parse(fs.readFileSync(path.join(__dirname, 'envelope.schema.json'), 'utf8'));
const telemetriaSchema = JSON.parse(fs.readFileSync(path.join(__dirname, 'telemetria.position.batch.schema.json'), 'utf8'));
const dvirSchema = JSON.parse(fs.readFileSync(path.join(__dirname, 'dvir.registrada.schema.json'), 'utf8'));
const dataChannelSchema = JSON.parse(fs.readFileSync(path.join(__dirname, 'datachannel.control.schema.json'), 'utf8'));
const desvioSchema = JSON.parse(fs.readFileSync(path.join(__dirname, 'desvio.detectado.schema.json'), 'utf8'));
const paradaSchema = JSON.parse(fs.readFileSync(path.join(__dirname, 'parada.prolongada.schema.json'), 'utf8'));
const linkRastreioSchema = JSON.parse(fs.readFileSync(path.join(__dirname, 'link_rastreio.solicitado.schema.json'), 'utf8'));

/**
 * Calcula idempotency_key determinística:
 * sha256(event_type + subject_id + occurred_at + payload_hash)
 */
function calculateIdempotencyKey(eventType, subjectId, occurredAt, payload) {
  const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload || {});
  const payloadHash = crypto.createHash('sha256').update(payloadStr).digest('hex');
  const rawKey = `${eventType}:${subjectId || ''}:${occurredAt}:${payloadHash}`;
  return crypto.createHash('sha256').update(rawKey).digest('hex');
}

/**
 * Valida assinatura HMAC em tempo constante
 */
function verifyHmacSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false;
  const expectedPrefix = 'sha256=';
  const receivedSig = signatureHeader.startsWith(expectedPrefix)
    ? signatureHeader.slice(expectedPrefix.length)
    : signatureHeader;
  const hmac = crypto.createHmac('sha256', secret);
  hmac.update(rawBody);
  const calculatedSig = hmac.digest('hex');
  if (receivedSig.length !== calculatedSig.length) return false;
  return crypto.timingSafeEqual(Buffer.from(receivedSig, 'utf8'), Buffer.from(calculatedSig, 'utf8'));
}

module.exports = {
  schemas: {
    envelope: envelopeSchema,
    telemetriaPositionBatch: telemetriaSchema,
    dvirRegistrada: dvirSchema,
    dataChannelControl: dataChannelSchema,
    desvioDetectado: desvioSchema,
    paradaProlongada: paradaSchema,
    linkRastreioSolicitado: linkRastreioSchema
  },
  calculateIdempotencyKey,
  verifyHmacSignature
};
