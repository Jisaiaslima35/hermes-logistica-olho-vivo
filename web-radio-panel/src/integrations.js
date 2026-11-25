const crypto = require('crypto');

const BRIDGE_URL = (process.env.BRIDGE_URL || 'http://fleetbase-bridge-whatsapp:8600').replace(/\/$/, '');
const FLEETBASE_API_URL = (process.env.FLEETBASE_API_URL || 'http://fleetbase-api:8000').replace(/\/$/, '');
const FLEETBASE_API_KEY = process.env.FLEETBASE_API_KEY || '';

async function signTrackingLink({ orderId, vehicleId, companyUuid }) {
  try {
    const res = await fetch(`${BRIDGE_URL}/v1/tracking/sign`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ordem_servico_id: orderId,
        veiculo_id: vehicleId || null,
        tenant_id: companyUuid || 'automacaojs',
        ttl_s: 21600
      })
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

async function emitBridgeEvent(eventType, subjectId, payload) {
  try {
    const eventId = crypto.randomUUID();
    const occurredAt = new Date().toISOString();
    const res = await fetch(`${BRIDGE_URL}/v1/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Fleetbase-Event': eventType,
        'X-Fleetbase-Delivery': eventId,
        'X-Fleetbase-Timestamp': occurredAt
      },
      body: JSON.stringify({
        event_id: eventId,
        event_type: eventType,
        schema_version: '1.0',
        occurred_at: occurredAt,
        correlation_id: eventId,
        idempotency_key: crypto.createHash('sha256').update(`${eventType}:${subjectId}:${occurredAt}`).digest('hex'),
        tenant: { id: process.env.FLEETBASE_COMPANY_UUID || 'default', slug: 'automacaojs' },
        subject: { type: 'ordem_de_servico', id: subjectId },
        payload
      })
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function mirrorPlaceToFleetbase({ name, address, lat, lon }) {
  if (!FLEETBASE_API_KEY) return null;
  try {
    const res = await fetch(`${FLEETBASE_API_URL}/v1/places`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${FLEETBASE_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        name,
        street1: address || name,
        city: 'Natal',
        country: 'BR',
        latitude: lat,
        longitude: lon
      })
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.id || null;
  } catch {
    return null;
  }
}

module.exports = {
  signTrackingLink,
  emitBridgeEvent,
  mirrorPlaceToFleetbase
};
