// ─────────────────────────────────────────────────────────────────────────────
// prompt2.mjs — SUÍTE DE EVIDÊNCIAS REAIS · Vistoria Fotográfica (DVIR)
//
//  FLUXO POSITIVO
//   • upload em streaming de vistoria de ENTRADA com JPEGs válidos
//   • vistoria de SAÍDA pareada (antes × depois)
//   • detecção de HASH REPETIDO na segunda tentativa (antifraude)
//   • reprovação → bloqueio do veículo → aceite de corrida → 403
//   • download da imagem por UUID → 200 image/jpeg
//
//  TESTES NEGATIVOS OBRIGATÓRIOS
//   • sem login            → 401
//   • outra organização    → 403
//   • .txt/.exe renomeado  → 400
//   • acima de 2 MB        → 400/413
//   • path traversal       → 400/404
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import path from 'node:path';
import {
  BASE, ORG_ID, section, step, ok, fail, info, assert,
  http, loginAdmin, mysqlExec, sleep, col, mintToken
} from './lib.mjs';

const T0 = Date.now();
const ASSETS = '/tmp/evidence';
const RESULTS = [];
function check(label, cond, extra = '') {
  RESULTS.push({ label, pass: !!cond });
  return assert(cond, label, extra);
}

const OTHER_ORG_UUID = '11111111-2222-4333-8444-555555555555';
// NUNCA o telefone real do Isaías em teste (regra: nenhum WhatsApp real de teste).
const FAKE_MANAGER = '5584999999999';

/** Gera um JPEG inédita (sha256 novo a cada execução) a partir de uma base.
 *  Serve para provar que foto NUNCA vista não é marcada como duplicada,
 *  enquanto a foto repetida É marcada (antifraude). */
async function makeUniqueJpeg(basePath, slot) {
  const out = path.join(ASSETS, `${slot}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.jpg`);
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ex = promisify(execFile);
  const code = [
    'from PIL import Image, ImageDraw',
    'import random',
    'random.seed()',
    `im = Image.open(${JSON.stringify(basePath)}).convert('RGB')`,
    'w, h = im.size',
    'px = im.load()',
    'for _ in range(4000):',
    '    x = random.randrange(w); y = random.randrange(h)',
    '    px[x, y] = (random.randrange(256), random.randrange(256), random.randrange(256))',
    'd = ImageDraw.Draw(im)',
    `d.text((8, 8), ${JSON.stringify('e2e ' + Date.now())}, fill=(255, 255, 255))`,
    `im.save(${JSON.stringify(out)}, 'JPEG', quality=88)`
  ].join('\n');
  await ex('python3', ['-c', code]);
  return out;
}


async function main() {
  section('PROMPT 2 · VISTORIA FOTOGRÁFICA (DVIR) — SUÍTE DE EVIDÊNCIAS REAIS');

  // ── 0. LOGIN ──────────────────────────────────────────────────────────────
  section('0 · LOGIN');
  const token = await loginAdmin();
  check('POST /api/auth/admin/demo → 200 (sessão de gestor)', !!token);

  const UNIQUE_FRENTE = await makeUniqueJpeg(path.join(ASSETS, 'frente.jpg'), 'frente-inedita');
  info(`foto inédita gerada para o teste de antifraude: ${path.basename(UNIQUE_FRENTE)}`);

  const vehicleId = await ensureVehicle();
  const driverId = 'drv_e2e_dvir';
  info(`veículo: ${vehicleId}   motorista: ${driverId}`);

  // ── 1. TEMPLATES ──────────────────────────────────────────────────────────
  section('1 · TEMPLATES DE CHECKLIST POR CATEGORIA');
  const tpl = await http('GET', '/api/dvir/templates', { token });
  check('GET /api/dvir/templates → 200', tpl.status === 200);
  const templates = tpl.json?.templates || tpl.json || [];
  const cats = templates.map(t => t.vehicle_category);
  info(`templates: ${JSON.stringify(templates.map(t => ({ cat: t.vehicle_category, itens: (t.required_items || []).length, fotos: (t.required_photos || []).length })))}`);
  // O app (mobile-navigator) usa fleet_type='bau' como taxonomia de veículo;
  // 'bau' e 'caminhao_bau' são o mesmo template (Caminhão Baú).
  const ALIAS = { caminhao_bau: ['bau', 'caminhao_bau'] };
  for (const c of ['moto', 'utilitario', 'caminhao_bau', 'carreta']) {
    const variants = ALIAS[c] || [c];
    check(`template "${c}" existe`, variants.some(v => cats.includes(v)),
      variants.some(v => cats.includes(v)) ? `slug=${variants.find(v => cats.includes(v))}` : `=${cats.join(',')}`);
  }

  // ── 2. FLUXO POSITIVO ────────────────────────────────────────────────────
  section('2 · FLUXO POSITIVO — vistoria de ENTRADA (upload em streaming)');
  const entrada = await uploadInspection({
    token, vehicleId, driverId, shiftType: 'entrada',
    photos: [
      ['frente', UNIQUE_FRENTE],
      ['lateral_esquerda', path.join(ASSETS, 'lateral_esquerda.jpg')],
      ['lateral_direita', path.join(ASSETS, 'lateral_direita.jpg')],
      ['pneus', path.join(ASSETS, 'pneus.jpg')],
      ['velocimetro', path.join(ASSETS, 'velocimetro.jpg')]
    ],
    odometer: 12345,
    gps: { lat: -5.7942, lng: -35.2087 },
    checklist: [{ item: 'Freios', ok: true }, { item: 'Pneus', ok: true }, { item: 'Luzes', ok: true }],
    hasDamage: false
  });
  check('POST /api/driver/dvir (entrada) → 201', [200, 201].includes(entrada.status), `=${entrada.status} ${entrada.body?.slice(0, 120)}`);
  const insEntrada = entrada.json?.inspection || entrada.json;
  const insIdEntrada = insEntrada?.id;
  info(`inspeção de entrada: ${insIdEntrada}  status=${insEntrada?.status}  fotos=${(insEntrada?.photos || []).length}`);
  check('inspeção criada com id UUID', !!insIdEntrada && /^[0-9a-f-]{36}$/.test(insIdEntrada));
  check('status = aprovado (sem avaria)', insEntrada?.status === 'aprovado', `=${insEntrada?.status}`);
  check('locked_immutable = 1 (vistoria travada após envio)', Number(insEntrada?.locked_immutable) === 1);
  check('5 fotos anexadas', (insEntrada?.photos || []).length === 5);
  const fotoInedita = (insEntrada?.photos || []).find(p => p.slot_name === 'frente');
  check('foto inédita NÃO é marcada como duplicada',
    !!fotoInedita && !fotoInedita.is_duplicate_hash,
    `sha=${String(fotoInedita?.sha256_hash).slice(0, 12)} dup=${fotoInedita?.is_duplicate_hash}`);

  const detEntrada = await http('GET', `/api/dvir/inspections/${insIdEntrada}`, { token });
  check('GET /api/dvir/inspections/:id → 200', detEntrada.status === 200);
  const rowEntrada = detEntrada.json || {};
  info(`detalhe: odo=${rowEntrada.odometer_km} km  gps=${rowEntrada.gps_lat},${rowEntrada.gps_lng}  servidor=${rowEntrada.server_recorded_at}`);
  check('odômetro gravado (12345)', Number(rowEntrada.odometer_km) === 12345, `=${rowEntrada.odometer_km}`);
  check('gps gravado pelo servidor', rowEntrada.gps_lat != null && rowEntrada.gps_lng != null,
    `${rowEntrada.gps_lat},${rowEntrada.gps_lng}`);
  check('server_recorded_at gravado (horário do servidor)', !!rowEntrada.server_recorded_at, `=${rowEntrada.server_recorded_at}`);

  // ── 3. PAREAMENTO (ANTES × DEPOIS) ───────────────────────────────────────
  section('3 · PAREAMENTO ENTRADA × SAÍDA (galeria comparativa)');
  const saida = await uploadInspection({
    token, vehicleId, driverId, shiftType: 'saida',
    photos: [
      ['frente', path.join(ASSETS, 'frente.jpg')],
      ['lateral_esquerda', path.join(ASSETS, 'lateral_esquerda.jpg')]
    ],
    odometer: 12410,
    gps: { lat: -5.7938, lng: -35.2082 },
    checklist: [{ item: 'Freios', ok: true }, { item: 'Pneus', ok: true }],
    hasDamage: false,
    pairedInspectionId: insIdEntrada
  });
  check('POST /api/driver/dvir (saída) → 201', [200, 201].includes(saida.status), `=${saida.status} ${saida.body?.slice(0, 120)}`);
  const insSaida = saida.json?.inspection || saida.json;
  const insIdSaida = insSaida?.id;
  info(`inspeção de saída: ${insIdSaida}  pareada com: ${insSaida?.paired_inspection_id}`);
  check('saída pareada com a entrada', insSaida?.paired_inspection_id === insIdEntrada);

  const pair = await http('GET', `/api/dvir/inspections/${insIdSaida}/pair`, { token });
  check('GET /api/dvir/inspections/:id/pair → 200', pair.status === 200);
  const kmDiff = pair.json?.km_diff ?? pair.json?.odometer_diff;
  info(`par (antes × depois): ${pair.json?.inspection?.shift_type} ${pair.json?.inspection?.odometer_km} km  ↔  ${pair.json?.paired?.shift_type} ${pair.json?.paired?.odometer_km} km  →  km_diff=${kmDiff}`);
  check('diferença de odômetro calculada (65 km)', Number(kmDiff) === 65, `=${kmDiff}`);
  check('galeria comparativa traz as fotos dos dois lados',
    (pair.json?.photos || []).length > 0 && (pair.json?.paired?.photos || []).length > 0);

  // ── 4. ANTIFRAUDE — HASH REPETIDO ────────────────────────────────────────
  section('4 · ANTIFRAUDE — reenvio da MESMA foto (hash repetido)');
  const dup = await uploadInspection({
    token, vehicleId, driverId, shiftType: 'saida',
    photos: [['pneus', path.join(ASSETS, 'pneus.jpg')]],
    odometer: 12415,
    gps: { lat: -5.7938, lng: -35.2082 },
    checklist: [{ item: 'Freios', ok: true }],
    hasDamage: false
  });
  check('POST /api/driver/dvir (reenvio) → 201', [200, 201].includes(dup.status), `=${dup.status} ${dup.body?.slice(0, 120)}`);
  const insDup = dup.json?.inspection || dup.json;
  const dupPhotos = insDup?.photos || [];
  info(`fotos do reenvio: ${JSON.stringify(dupPhotos.map(p => ({ slot: p.slot_name, dup: p.is_duplicate_hash, sha: String(p.sha256_hash).slice(0, 12) })))}`);
  check('is_duplicate_hash = true na foto repetida',
    dupPhotos.some(p => p.is_duplicate_hash === true || p.is_duplicate_hash === 1));

  const dupAlert = await http('GET', '/api/dvir/inspections?duplicate=1', { token });
  const dupList = dupAlert.json?.inspections || dupAlert.json?.data || dupAlert.json || [];
  check('filtro "Foto Duplicada Suspeita" lista a vistoria',
    Array.isArray(dupList) && dupList.length >= 1, `${Array.isArray(dupList) ? dupList.length : 'n/d'} registro(s)`);

  // ── 5. IMUTABILIDADE ─────────────────────────────────────────────────────
  section('5 · IMUTABILIDADE — PUT/DELETE em vistoria enviada');
  const put = await http('PUT', `/api/dvir/inspections/${insIdEntrada}`, { token, body: { status: 'aprovado' } });
  check('PUT /api/dvir/inspections/:id → 403', put.status === 403, put.body?.slice(0, 120));
  const del = await http('DELETE', `/api/dvir/inspections/${insIdEntrada}`, { token });
  check('DELETE /api/dvir/inspections/:id → 403', del.status === 403, del.body?.slice(0, 120));

  // ── 6. DOWNLOAD DA IMAGEM POR UUID ────────────────────────────────────────
  section('6 · DOWNLOAD DA FOTO POR UUID (sem caminho de arquivo na URL)');
  const photoId = (insEntrada?.photos || [])[0]?.id;
  const dl = await http('GET', `/api/dvir/photos/${photoId}`, { token, raw: true });
  check('GET /api/dvir/photos/:id → 200', dl.status === 200);
  check('content-type = image/jpeg', (dl.headers.get('content-type') || '').includes('image/jpeg'),
    `=${dl.headers.get('content-type')}`);
  check('X-Content-Type-Options: nosniff', (dl.headers.get('x-content-type-options') || '') === 'nosniff');
  check('bytes do JPEG com magic FF D8 FF', (dl.buf?.[0] === 0xff && dl.buf?.[1] === 0xd8 && dl.buf?.[2] === 0xff),
    `=${(dl.buf || []).slice(0, 3).toString('hex')}`);

  // ── 7. REPROVAÇÃO → BLOQUEIO DO VEÍCULO → 403 NO ACEITE ──────────────────
  section('7 · REPROVAÇÃO → BLOQUEIO DO VEÍCULO → aceite de corrida 403');
  const reprovada = await uploadInspection({
    token, vehicleId, driverId, shiftType: 'entrada',
    photos: [['avaria', path.join(ASSETS, 'pneus.jpg')]],
    odometer: 12500, gps: { lat: -5.7942, lng: -35.2087 },
    checklist: [{ item: 'Pneu dianteiro', ok: false }],
    hasDamage: true, damageNotes: 'Pneu dianteiro Direito com boltagem — E2E'
  });
  check('POST /api/driver/dvir com avaria → 201', [200, 201].includes(reprovada.status), `=${reprovada.status} ${reprovada.body?.slice(0, 120)}`);
  const insRep = reprovada.json?.inspection || reprovada.json;
  check('status = reprovado (avaria detectada)', insRep?.status === 'reprovado', `=${insRep?.status}`);
  const dnRow = await mysqlExec(
    `SELECT has_damage, damage_notes, status FROM hj_dvir_inspections WHERE id='${insRep?.id}';`);
  const dnCols = dnRow.split('\t');
  check('damage_notes gravado', !!dnCols[1] && dnCols[1].includes('boltagem'), `="${dnCols[1]}"`);
  check('has_damage = 1 no banco', dnCols[0] === '1', `has_damage=${dnCols[0]}`);

  const blockedRow = await mysqlExec(
    `SELECT id, plate, status, dvir_blocked, dvir_blocked_reason FROM hermes_vehicles WHERE id='${vehicleId}';`);
  info(`veículo no banco: ${blockedRow}`);
  check('veículo marcado como bloqueado no banco', /dvir_blocked[^0-9]*1/.test(blockedRow) || blockedRow.includes('\t1\t'));

  const [ordRow] = await mysqlExec(
    `SELECT id FROM hermes_orders WHERE status='pendente' AND driver_id IS NULL ORDER BY created_at DESC LIMIT 1;`)
    .then(r => r.split('\n').filter(Boolean).map(v => v.split('\t')));
  const orderId = ordRow?.[0] || await createPendingOrder();
  const accept = await http('POST', `/api/driver/orders/${orderId}/accept`, {
    token, body: { driver_id: driverId, driver_name: 'Motorista E2E', vehicle_id: vehicleId }
  });
  check('POST /api/driver/orders/:id/accept com veículo bloqueado → 403', accept.status === 403, accept.body?.slice(0, 160));
  check('código de bloqueio DVIR exposto', accept.json?.code === 'VEICULO_BLOQUEADO_DVIR', `=${accept.json?.code}`);

  const queue = await http('GET', `/api/driver/queue?vehicle_id=${vehicleId}`, { token });
  check('GET /api/driver/queue com veículo bloqueado → 403', queue.status === 403, queue.body?.slice(0, 140));

  // ── 8. TESTES NEGATIVOS OBRIGATÓRIOS ─────────────────────────────────────
  section('8 · TESTES NEGATIVOS OBRIGATÓRIOS');

  // 8.1 sem login
  const noAuth = await http('GET', `/api/dvir/photos/${photoId}`);
  check('sem token → 401', noAuth.status === 401, noAuth.body?.slice(0, 110));

  // 8.2 outra organização
  const otherToken = mintToken({
    sub: '99999999-8888-4777-8666-555555555555',
    username: 'gestor_outra_org', email: 'outra@empresa.example', name: 'Gestor Outra Org',
    type: 'admin', company_uuid: OTHER_ORG_UUID
  });
  const crossOrg = await http('GET', `/api/dvir/photos/${photoId}`, { token: otherToken });
  check('token de outra organização → 403', crossOrg.status === 403, crossOrg.body?.slice(0, 130));

  // 8.3 arquivo que não é JPEG (.txt e .exe renomeados)
  const fake1 = await uploadInspection({ token, vehicleId, driverId, shiftType: 'entrada', photos: [['frente', path.join(ASSETS, 'malicioso.jpg')]], odometer: 1, gps: { lat: -5.79, lng: -35.2 }, checklist: [], hasDamage: false });
  check('.txt renomeado para .jpg → 400', fake1.status === 400, `=${fake1.status} ${fake1.body?.slice(0, 110)}`);
  const fake2 = await uploadInspection({ token, vehicleId, driverId, shiftType: 'entrada', photos: [['frente', path.join(ASSETS, 'malicioso.exe.jpg')]], odometer: 1, gps: { lat: -5.79, lng: -35.2 }, checklist: [], hasDamage: false });
  check('.exe renomeado para .jpg → 400', fake2.status === 400, `=${fake2.status} ${fake2.body?.slice(0, 110)}`);

  // 8.4 acima de 2 MB
  const big = await uploadInspection({ token, vehicleId, driverId, shiftType: 'entrada', photos: [['frente', path.join(ASSETS, 'grande.jpg')]], odometer: 1, gps: { lat: -5.79, lng: -35.2 }, checklist: [], hasDamage: false });
  check('arquivo acima de 2 MB → 400/413', [400, 413].includes(big.status), `=${big.status} ${big.body?.slice(0, 110)}`);

  // 8.5 path traversal
  for (const evil of ['../../etc/passwd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', '..%2F..%2Fetc%2Fpasswd']) {
    const trav = await http('GET', `/api/dvir/photos/${evil}`, { token });
    check(`path traversal "${evil}" → 400/404`, [400, 404].includes(trav.status), `=${trav.status}`);
  }
  const travId = await http('GET', '/api/dvir/photos/00000000-0000-4000-8000-000000000000', { token });
  check('UUID inexistente → 404', travId.status === 404, `=${travId.status}`);
  const travUuid = await http('GET', '/api/dvir/photos/not-a-uuid', { token });
  check('id fora do padrão UUID → 400', travUuid.status === 400, `=${travUuid.status}`);

  // ── 9. RETENÇÃO ──────────────────────────────────────────────────────────
  section('9 · RETENÇÃO CONFIGURÁVEL (12 meses)');
  const ret = await mysqlExec(`SELECT COUNT(*) FROM hj_dvir_retention_config;`);
  info(`linhas em hj_dvir_retention_config: ${ret}`);
  const retRows = await mysqlExec(`SELECT organization_id, retention_months FROM hj_dvir_retention_config;`);
  info(`config: ${retRows.replace(/\t/g, ' | ')}`);

  // ── 10. AUDITORIA IMUTÁVEL ────────────────────────────────────────────────
  section('10 · TRILHA DE AUDITORIA (hj_dvir_audit_logs)');
  const aud = await mysqlExec(
    `SELECT action, COUNT(*) FROM hj_dvir_audit_logs GROUP BY action ORDER BY action;`);
  info(`ações registradas:\n${aud.split('\n').map(l => '      ' + l.replace('\t', ' → ')).join('\n')}`);

  // ── 11. LIBERAR O VEÍCULO ─────────────────────────────────────────────────
  section('11 · LIBERAÇÃO DO VEÍCULO (revisão do gestor)');
  const rev = await http('POST', `/api/dvir/inspections/${insRep?.id}/review`, {
    token, body: { action: 'liberar', notes: 'E2E — liberação após manutenção', telefone_gestor: FAKE_MANAGER }
  });
  check('POST /api/dvir/inspections/:id/review (liberar) → 200', rev.status === 200, rev.body?.slice(0, 130));
  const after = await mysqlExec(`SELECT status, dvir_blocked FROM hermes_vehicles WHERE id='${vehicleId}';`);
  info(`veículo após liberação: ${after}`);
  check('veículo desbloqueado', after.includes('\t0') || /dvir_blocked[^\t]*\t0/.test(after));

  // ── RESUMO ───────────────────────────────────────────────────────────────
  section('RESUMO DA SUÍTE · PROMPT 2');
  const pass = RESULTS.filter(r => r.pass).length;
  const failN = RESULTS.length - pass;
  RESULTS.forEach(r => console.log(`  ${r.pass ? col('g', '✔') : col('r', '✘')} ${r.label}`));
  console.log(`\n  ${col('b', `${pass} verificação(ões) OK · ${failN} falha(s) · ${((Date.now() - T0) / 1000).toFixed(1)}s`)}\n`);
  process.exit(failN ? 1 : 0);
}

/** Monta e envia o multipart da vistoria. */
async function uploadInspection({ token, vehicleId, driverId, shiftType, photos, odometer, gps, checklist, hasDamage, damageNotes = '', pairedInspectionId }) {
  const form = new FormData();
  form.append('vehicle_id', vehicleId);
  form.append('driver_id', driverId);
  form.append('organization_id', ORG_ID);
  form.append('shift_type', shiftType);
  form.append('checklist', JSON.stringify(checklist || []));
  form.append('has_damage', hasDamage ? '1' : '0');
  form.append('damage_notes', damageNotes || '');
  form.append('odometer_km', String(odometer));
  form.append('gps_lat', String(gps.lat));
  form.append('gps_lng', String(gps.lng));
  // Telefone FICTÍCIO do gestor: a suíte dispara o alerta de WhatsApp de verdade
  // (bridge -> Evolution GO), mas nunca no número real do Isaías.
  form.append('telefone_gestor', FAKE_MANAGER);
  if (pairedInspectionId) form.append('paired_inspection_id', pairedInspectionId);
  for (const [slot, file] of photos) {
    const buf = fs.readFileSync(file);
    form.append(slot, new Blob([buf], { type: 'image/jpeg' }), path.basename(file));
  }
  return http('POST', '/api/driver/dvir', { token, body: form });
}

async function ensureVehicle() {
  const rows = await mysqlExec(
    `SELECT id, dvir_blocked FROM hermes_vehicles WHERE fleet_type='moto' AND dvir_blocked = 0 LIMIT 1;`);
  const first = rows.split('\n').filter(Boolean)[0];
  if (first) {
    const id = first.split('\t')[0];
    await mysqlExec(`UPDATE hermes_vehicles SET dvir_blocked=0, dvir_blocked_reason=NULL, dvir_blocked_at=NULL, status='disponivel' WHERE id='${id}';`);
    return id;
  }
  const id = `veh_e2e_dvir_${Date.now()}`;
  await mysqlExec(
    `INSERT INTO hermes_vehicles (id, plate, model, fleet_type, status, driver_id, battery_pct)
     VALUES ('${id}', 'E2E-DV1', 'Moto DVIR E2E', 'moto', 'disponivel', 'drv_e2e_dvir', 95);`);
  return id;
}

async function createPendingOrder() {
  const id = `E2E-PEND-${Date.now()}`;
  await mysqlExec(
    `INSERT INTO hermes_orders (id, client_user_uuid, client_name, fleet_type, status, queue_mode,
      origin_address, destinations_json, final_price, recipient_name, recipient_whatsapp)
     VALUES ('${id}', '00000000-0000-4000-8000-000000000001', 'Cliente E2E', 'moto', 'pendente',
      'fila_aberta', 'Rua Teste, Natal/RN', JSON_ARRAY(JSON_OBJECT('address','Destino E2E','lat',-5.79,'lng',-35.20)),
      25.00, 'Cliente E2E', '5500000000000');`);
  return id;
}

main().catch((e) => { console.error(col('r', '\nERRO NA SUÍTE: ') + e.stack); process.exit(2); });
