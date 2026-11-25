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

async function searchAddresses(query) {
  const q = String(query || '').trim();
  if (q.length < 3) return [];

  try {
    const params = new URLSearchParams({
      q,
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
          return {
            label: buildPhotonLabel(p) || q,
            lon: Number(coords[0]),
            lat: Number(coords[1])
          };
        })
        .filter(Boolean);
      if (list.length) return list;
    }
  } catch {}

  // Fallback Nominatim
  try {
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=5&addressdetails=1&q=${encodeURIComponent(q)}`;
    const res = await fetchWithTimeout(url, { headers: { 'User-Agent': USER_AGENT } }, 3000);
    if (res.ok) {
      const rows = await res.json();
      return (Array.isArray(rows) ? rows : []).map(r => ({
        label: r.display_name,
        lat: Number(r.lat),
        lon: Number(r.lon)
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
