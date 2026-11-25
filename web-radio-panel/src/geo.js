const USER_AGENT = 'HermesLogistica/1.0 (contato: automacaojs.us)';
const BIAS = { lat: -5.7945, lon: -35.211 };

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * (2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a)));
}

async function fetchWithTimeout(url, opts = {}, timeoutMs = 3000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildPhotonLabel(p = {}) {
  const streetLine = [p.street || p.name, p.housenumber].filter(Boolean).join(', ');
  const parts = [streetLine, p.district || p.locality, p.city || p.town || p.village, p.state];
  const seen = new Set();
  return parts
    .map(v => String(v || '').trim())
    .filter(v => {
      if (!v) return false;
      const k = v.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .join(' - ');
}

function parseStreetAndNumber(rawQuery, explicitNumber = '') {
  const q = String(rawQuery || '').trim();
  const numClean = String(explicitNumber || '').trim();
  if (numClean) {
    const cleanStreet = q.replace(new RegExp(`,?\\s*\\b${numClean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`), '').trim();
    const parts = cleanStreet.split(',').map(s => s.trim()).filter(Boolean);
    return {
      street: parts[0] || cleanStreet,
      number: numClean,
      city: parts.length > 1 ? parts[parts.length - 1] : ''
    };
  }
  const m = q.match(/^([^,]+?),\s*(\d+[a-zA-Z]?)(?:\s*[-,]\s*(.+))?$/);
  if (m) {
    return { street: m[1].trim(), number: m[2].trim(), city: (m[3] || '').trim() };
  }
  const mSpace = q.match(/^(.+?)\s+(\d{1,5}[a-zA-Z]?)$/);
  if (mSpace && mSpace[1].length >= 4) {
    return { street: mSpace[1].trim(), number: mSpace[2].trim(), city: '' };
  }
  return { street: q, number: '', city: '' };
}

async function searchNominatimStructured({ street, number, city, state = 'RN' }) {
  try {
    const streetParam = number ? `${number} ${street}` : street;
    const params = new URLSearchParams({
      format: 'json',
      addressdetails: '1',
      limit: '5',
      street: streetParam,
      city: city || 'Natal',
      state: state || 'RN',
      country: 'Brazil'
    });
    const url = `https://nominatim.openstreetmap.org/search?${params.toString()}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 3500);
    if (!res.ok) return [];
    const rows = await res.json();
    return (Array.isArray(rows) ? rows : []).map(r => {
      const a = r.address || {};
      const hasExactNum = Boolean(number && (a.house_number || r.type === 'house' || r.osm_type === 'node'));
      const line = [a.road || street, a.house_number || number].filter(Boolean).join(', ');
      const label = [line, a.suburb || a.neighbourhood, a.city || a.town || city || 'Natal', a.state || state].filter(Boolean).join(' - ');
      return {
        label: label || r.display_name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        housenumber: a.house_number || number || null,
        precision: hasExactNum ? 'exact' : 'block',
        source: 'nominatim_structured'
      };
    });
  } catch {
    return [];
  }
}

async function lookupViaCep(cepRaw) {
  const cep = String(cepRaw || '').replace(/\D/g, '');
  if (cep.length !== 8) return null;
  try {
    const res = await fetchWithTimeout(`https://viacep.com.br/ws/${cep}/json/`, {}, 2500);
    if (!res.ok) return null;
    const d = await res.json();
    if (d.erro || !d.logradouro) return null;
    return { street: d.logradouro, district: d.bairro || '', city: d.localidade || 'Natal', state: d.uf || 'RN' };
  } catch {
    return null;
  }
}

async function searchAddresses(query, opts = {}) {
  let q = String(query || '').trim();
  if (q.length < 3) return [];

  const explicitNumber = String(opts.number || '').trim();
  const cepDigits = q.replace(/\D/g, '');
  if (/^\d{5}-?\d{3}$/.test(q) || (cepDigits.length === 8 && !/[a-zA-Z]/.test(q))) {
    const via = await lookupViaCep(cepDigits);
    if (via) {
      const struct = await searchNominatimStructured({
        street: via.street,
        number: explicitNumber,
        city: via.city,
        state: via.state
      });
      if (struct.length) return struct;
      q = [via.street, explicitNumber, via.district, via.city, via.state].filter(Boolean).join(', ');
    }
  }

  const parsed = parseStreetAndNumber(q, explicitNumber);
  if (parsed.number) {
    const struct = await searchNominatimStructured({
      street: parsed.street,
      number: parsed.number,
      city: opts.city || parsed.city || 'Natal',
      state: opts.state || 'RN'
    });
    if (struct.length && struct[0].precision === 'exact') {
      return struct;
    }
    // Guarda fallback estruturado de quadra caso Photon não tenha número
    var structuredFallback = struct;
  }

  try {
    const photonQ = parsed.number ? `${parsed.street} ${parsed.number}${parsed.city ? ' ' + parsed.city : ''}` : q;
    const params = new URLSearchParams({
      q: photonQ,
      limit: '6',
      lat: String(BIAS.lat),
      lon: String(BIAS.lon)
    });
    const res = await fetchWithTimeout(`https://photon.komoot.io/api/?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT }
    }, 3000);

    if (res.ok) {
      const data = await res.json();
      const features = Array.isArray(data.features) ? data.features : [];
      const list = features
        .map(f => {
          const coords = f?.geometry?.coordinates || [];
          const p = f?.properties || {};
          if (coords.length < 2) return null;
          const exact = Boolean(parsed.number && p.housenumber && String(p.housenumber).toLowerCase() === parsed.number.toLowerCase());
          return {
            label: buildPhotonLabel(p) || q,
            lon: Number(coords[0]),
            lat: Number(coords[1]),
            housenumber: p.housenumber || parsed.number || null,
            precision: exact ? 'exact' : 'block',
            source: 'photon'
          };
        })
        .filter(Boolean);
      if (structuredFallback && structuredFallback.length && !list.some(i => i.precision === 'exact')) {
        return [...structuredFallback, ...list].slice(0, 6);
      }
      if (list.length) return list;
    }
  } catch {}

  if (structuredFallback && structuredFallback.length) return structuredFallback;

  // Fallback Nominatim livre
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&q=${encodeURIComponent(q)}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 3000);
    if (res.ok) {
      const rows = await res.json();
      return (Array.isArray(rows) ? rows : []).map(r => ({
        label: r.display_name,
        lat: Number(r.lat),
        lon: Number(r.lon),
        housenumber: r.address?.house_number || null,
        precision: r.address?.house_number ? 'exact' : 'block',
        source: 'nominatim'
      }));
    }
  } catch {}

  return [];
}

async function geocodeAddress(address) {
  const results = await searchAddresses(address);
  return results[0] || null;
}

async function reverseGeocode(lat, lon) {
  try {
    const url = `https://nominatim.openstreetmap.org/reverse?format=json&lat=${lat}&lon=${lon}&addressdetails=1`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 3000);
    if (!res.ok) return null;
    const data = await res.json();
    const a = data.address || {};
    const street = [a.road || a.pedestrian, a.house_number].filter(Boolean).join(', ');
    const city = a.city || a.town || a.village || a.municipality;
    const label = [street, a.suburb || a.neighbourhood, city, a.state].filter(Boolean).join(' - ');
    return label || data.display_name || null;
  } catch {
    return null;
  }
}

async function calculateRoute(points) {
  const valid = (points || []).filter(p => Number.isFinite(Number(p.lat)) && Number.isFinite(Number(p.lon)));
  if (valid.length < 2) {
    return { distance_km: 5.0, duration_min: 12, geometry: valid.map(p => [Number(p.lat), Number(p.lon)]), source: 'default' };
  }

  const coordsStr = valid.map(p => `${Number(p.lon)},${Number(p.lat)}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coordsStr}?overview=full&geometries=geojson`;

  try {
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 3000);
    if (res.ok) {
      const data = await res.json();
      const route = data?.routes?.[0];
      if (route && Number.isFinite(route.distance)) {
        const distance_km = Math.max(0.5, Number((route.distance / 1000).toFixed(2)));
        const duration_min = Math.max(2, Math.round((route.duration || 0) / 60));
        const coords = route.geometry?.coordinates || [];
        const geometry = coords.length ? coords.map(([lon, lat]) => [lat, lon]) : valid.map(p => [Number(p.lat), Number(p.lon)]);
        return { distance_km, duration_min, geometry, source: 'osrm' };
      }
    }
  } catch {}

  // Fallback matemático: Haversine × 1.35
  let totalKm = 0;
  for (let i = 0; i < valid.length - 1; i++) {
    totalKm += haversineKm(Number(valid[i].lat), Number(valid[i].lon), Number(valid[i + 1].lat), Number(valid[i + 1].lon));
  }
  const distance_km = Math.max(0.5, Number((totalKm * 1.35).toFixed(2)));
  const duration_min = Math.max(3, Math.round((distance_km / 32) * 60));
  return {
    distance_km,
    duration_min,
    geometry: valid.map(p => [Number(p.lat), Number(p.lon)]),
    source: 'haversine_135'
  };
}

module.exports = {
  haversineKm,
  searchAddresses,
  geocodeAddress,
  reverseGeocode,
  calculateRoute
};
