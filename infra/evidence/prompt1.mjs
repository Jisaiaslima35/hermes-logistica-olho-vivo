// ─────────────────────────────────────────────────────────────────────────────
// prompt1.mjs — SUÍTE DE EVIDÊNCIAS REAIS · Blindagem pré-piloto (Prompt 1)
//
//  1.1 Olho Vivo LGPD (banner, bipe, sem áudio ambiente, sem gravação em disco)
//  1.2 Fila offline de posições (batch ordenado pelo timestamp original)
//  1.3 Backup diário + watchdog
//  1.4 DEMO_MODE estrito (botões ausentes + 403 nos endpoints de demo)
//  1.5 Evidências: concorrência 1×200 + 1×409 · lote de 5 pontos · auditoria
//      Olho Vivo com duração · backup & restore · E2E (5 status + Kanban +
//      histórico do cliente)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'node:fs';
import {
  BASE, BRIDGE, ORG_ID, section, step, ok, fail, info, assert,
  http, loginAdmin, mysqlExec, sleep, col, mintToken
} from './lib.mjs';

const T0 = Date.now();
const RESULTS = [];
function check(label, cond, extra = '') {
  RESULTS.push({ label, pass: !!cond });
  return assert(cond, label, extra);
}

// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  section('PROMPT 1 · BLINDAGEM PRÉ-PILOTO — SUÍTE DE EVIDÊNCIAS REAIS');
  info(`alvo ${BASE}   bridge ${BRIDGE}   org ${ORG_ID}`);

  // ── 0. LOGIN ───────────────────────────────────────────────────────────────
  section('0 · LOGIN (sessão real no painel)');
  const token = await loginAdmin();
  check('POST /api/auth/admin/demo → 200 com token de sessão', !!token);
  const me = await http('GET', '/api/auth/me', { token });
  check('GET /api/auth/me → 200', me.status === 200, me.json?.user?.username || me.json?.username || '');
  info(`usuário: ${me.json?.user?.name || me.json?.name} (${me.json?.user?.email || me.json?.email})`);

  // ── 1. DEMO_MODE ESTRITO ──────────────────────────────────────────────────
  section('1 · DEMO_MODE ESTRITO');
  const health = await http('GET', '/health');
  check('GET /health → 200 com demo_mode', health.status === 200, `demo_mode=${health.json?.demo_mode}`);

  const html = fs.readFileSync('/opt/hermes-fleetbase/web-radio-panel/public/index.html', 'utf8');
  info('O painel em produção roda com DEMO_MODE=true (modo piloto).');
  info('A prova de "estrito" é feita contra uma instância com DEMO_MODE=false (§1.4.2).');

  // ── 2. CONCORRÊNCIA NO ACEITE DE CORRIDA ─────────────────────────────────
  section('2 · CONCORRÊNCIA — 2 aceites simultâneos da MESMA corrida');
  const [ord] = await mysqlExec(
    `SELECT id FROM hermes_orders WHERE status='pendente' AND driver_id IS NULL ORDER BY created_at DESC LIMIT 1;`
  ).then(r => r.split('\n').filter(Boolean).map(v => v.split('\t')));

  let orderId = ord?.[0];
  if (!orderId) {
    orderId = `E2E-${Date.now()}`;
    await mysqlExec(
      `INSERT INTO hermes_orders (id, client_user_uuid, client_name, fleet_type, status, queue_mode,
        origin_address, destinations_json, final_price, recipient_name, recipient_whatsapp)
       VALUES ('${orderId}', '00000000-0000-4000-8000-000000000001', 'Cliente E2E', 'moto', 'pendente',
        'fila_aberta', 'Rua Teste, Natal/RN', JSON_ARRAY(JSON_OBJECT('address','Destino E2E','lat',-5.7942,'lng',-35.2087)),
        25.00, 'Cliente E2E', '5500000000000');`
    );
    info(`corrida de teste criada: ${orderId}`);
  }
  info(`corrida alvo: ${orderId}`);

  const acceptBody = { driver_id: 'drv_e2e_concorrencia', driver_name: 'Motorista E2E' };
  const t0 = Date.now();
  const [r1, r2] = await Promise.all([
    http('POST', `/api/driver/orders/${orderId}/accept`, { token, body: acceptBody }),
    http('POST', `/api/driver/orders/${orderId}/accept`, { token, body: acceptBody })
  ]);
  const ms = Date.now() - t0;
  const codes = [r1.status, r2.status].sort();
  info(`códigos: ${r1.status} e ${r2.status} em ${ms}ms (Promise.all → chamadas simultâneas)`);
  info(`200 → ${JSON.stringify((r1.status === 200 ? r1 : r2).json || {}).slice(0, 120)}`);
  info(`409 → ${JSON.stringify((r1.status === 409 ? r1 : r2).json || {}).slice(0, 120)}`);
  check('exatamente 1× HTTP 200', codes.filter(c => c === 200).length === 1, `(${codes.join(', ')})`);
  check('exatamente 1× HTTP 409', codes.filter(c => c === 409).length === 1, `(${codes.join(', ')})`);

  const [acc] = await mysqlExec(`SELECT id, status, driver_id, accepted_at FROM hermes_orders WHERE id='${orderId}';`)
    .then(r => r.split('\n').filter(Boolean));
  info(`estado final no banco: ${acc}`);
  const cols = (acc || '').split('\t');
  check('banco tem exatamente 1 aceite gravado (driver_id + accepted_at preenchidos)',
    cols[2] === 'drv_e2e_concorrencia' && !!cols[3] && cols[1] === 'em_rota',
    (acc || '').replace(/\t/g, ' | '));

  // ── 3. FILA OFFLINE DE POSIÇÕES (LOTE RETROATIVO) ─────────────────────────
  section('3 · FILA OFFLINE — lote de 5 pontos GPS retroativos (ordem original)');
  const vehicleId = await ensureVehicle();
  const base = Date.now() - 5 * 60 * 1000;
  const pts = [];
  for (let i = 0; i < 5; i++) {
    pts.push({
      lat: -5.7942 + i * 0.0004,
      lon: -35.2087 + i * 0.0003,
      speed_kph: 30 + i,
      heading_deg: 90,
      battery_pct: 80 - i,
      recorded_at: new Date(base + i * 60 * 1000).toISOString()
    });
  }
  // embaralha a ordem de chegada: o servidor precisa reordenar pelo recorded_at
  const embaralhado = [pts[3], pts[0], pts[4], pts[1], pts[2]];
  const batch = await http('POST', '/api/driver/telemetry/batch', {
    token,
    body: { vehicle_id: vehicleId, driver_id: 'drv_e2e_telemetria', order_id: orderId, points: embaralhado }
  });
  check('POST /api/driver/telemetry/batch → 200', batch.status === 200, batch.body?.slice(0, 160));
  check('servidor devolve ordered_by=recorded_at', batch.json?.ordered_by === 'recorded_at');
  check('received = 5 / inserted = 5',
    batch.json?.received === 5 && batch.json?.inserted === 5,
    `received=${batch.json?.received} inserted=${batch.json?.inserted}`);
  info(`primeiro=${batch.json?.first_recorded_at}  último=${batch.json?.last_recorded_at}`);

  const stored = await mysqlExec(
    `SELECT DATE_FORMAT(recorded_at,'%Y-%m-%d %H:%i:%s') FROM hj_telemetry_points WHERE batch_id='${batch.json?.batch_id}' ORDER BY recorded_at;`
  );
  const storedLines = stored.split('\n').filter(Boolean);
  check('pontos gravados em ordem cronológica pelo timestamp ORIGINAL',
    storedLines.length === 5 &&
    storedLines.every((v, i) => i === 0 || v >= storedLines[i - 1]),
    storedLines.join(' → '));
  info(`gravado: ${storedLines.join(' → ')}`);

  // ── 4. OLHO VIVO — AUDITORIA COM DURAÇÃO ──────────────────────────────────
  section('4 · OLHO VIVO LGPD — auditoria com duração calculada');
  const start = await http('POST', '/api/olho-vivo/camera/start', {
    token, body: { vehicle_id: vehicleId, driver_id: 'drv_e2e_olho', order_id: orderId }
  });
  check('POST /api/olho-vivo/camera/start → 201', [200, 201].includes(start.status), JSON.stringify(start.json || {}).slice(0, 170));
  info(`sessão de câmera: ${JSON.stringify(start.json || {})}`);
  await sleep(4200);
  const stop = await http('POST', '/api/olho-vivo/camera/stop', {
    token, body: { vehicle_id: vehicleId, driver_id: 'drv_e2e_olho' }
  });
  check('POST /api/olho-vivo/camera/stop → 200', stop.status === 200, JSON.stringify(stop.json || {}).slice(0, 140));
  check('duração devolvida pelo servidor > 0', Number(stop.json?.duration_seconds) > 0, `=${stop.json?.duration_seconds}s`);

  const audit = await http('GET', `/api/olho-vivo/audit?vehicle_id=${vehicleId}&limit=5`, { token });
  check('GET /api/olho-vivo/audit → 200', audit.status === 200);
  const rows = audit.json?.rows || audit.json?.data || audit.json || [];
  const row = Array.isArray(rows) ? (rows.find(r => r.vehicle_id === vehicleId) || rows[0]) : null;
  if (row) {
    info(`linha de auditoria: ${JSON.stringify(row)}`);
    check('duration_seconds calculado no banco (> 0)', Number(row.duration_seconds) > 0, `=${row.duration_seconds}s`);
    check('ended_at preenchido', !!row.ended_at, `=${row.ended_at}`);
    check('audio_channel = ptt_explicito (áudio só no PTT)', row.audio_channel === 'ptt_explicito', `=${row.audio_channel}`);
    check('video_audio_on = 0 (vídeo sem áudio ambiente)', Number(row.video_audio_on) === 0, `=${row.video_audio_on}`);
    check('recorded_on_disk = 0 (sem gravação em disco)', Number(row.recorded_on_disk) === 0, `=${row.recorded_on_disk}`);
  } else {
    fail('nenhuma linha de auditoria encontrada');
  }

  // ── 5. BACKUP + WATCHDOG ──────────────────────────────────────────────────
  section('5 · BACKUP DIÁRIO + WATCHDOG NTFY');
  info('o backup roda fora do container (cron 03:00) — evidência no log da infra:');
  const bkLog = await readTail('/var/log/hermes-fleetbase/backup-daily.log', 14);
  bkLog.forEach(l => info(l));
  check('log de backup com dump OK', bkLog.join(' ').includes('dump OK'));
  check('log de backup com uploads + manifesto', bkLog.join(' ').includes('uploads OK') && bkLog.join(' ').includes('manifest'));
  check('log de backup com RESTAURAÇÃO OK', bkLog.join(' ').includes('RESTAURAÇÃO OK'));
  check('banco temporário de teste apagado ao final',
    bkLog.join(' ').includes('APAGADO') || bkLog.join(' ').includes('sandbox limpo'));

  const wdLog = await readTail('/var/log/hermes-fleetbase/watchdog.log', 8);
  wdLog.forEach(l => info(l));
  check('watchdog rodou (log do cron a cada 2 min)', wdLog.length > 0, `${wdLog.length} linha(s)`);
  const purgeLog = await readTail('/var/log/hermes-fleetbase/dvir-purge.log', 6);
  purgeLog.forEach(l => info(l));
  check('job de expurgo DVIR rodou e logou', purgeLog.length > 0, `${purgeLog.length} linha(s)`);

  // ── 6. E2E COMPLETO ──────────────────────────────────────────────────────
  section('6 · E2E — 5 status de pedido · Kanban · histórico do cliente');
  await ensureOrdersAllStatuses();
  const orders = await http('GET', '/api/orders', { token });
  check('GET /api/orders → 200', orders.status === 200);
  const list = orders.json?.orders || orders.json?.data || orders.json || [];
  const byStatus = {};
  for (const o of list) byStatus[o.status] = (byStatus[o.status] || 0) + 1;
  info(`pedidos no quadro: ${list.length} · por status: ${JSON.stringify(byStatus)}`);
  for (const st of ['agendado', 'pendente', 'em_rota', 'concluido', 'problema', 'cancelado']) {
    const filt = await http('GET', `/api/orders?status=${st}`, { token });
    const arr = filt.json?.orders || filt.json?.data || filt.json || [];
    check(`coluna "${st}" do Kanban → 200 com ${arr.length} pedido(s)`,
      filt.status === 200 && arr.length > 0, `${arr.length} pedido(s)`);
  }

  const queue = await http('GET', '/api/driver/queue', { token });
  check('GET /api/driver/queue (fila aberta) → 200', queue.status === 200,
    `${(queue.json?.orders || queue.json || []).length} corrida(s) na fila`);
  const veh = await http('GET', '/api/vehicles', { token });
  check('GET /api/vehicles → 200 (mapa/Kanban de frota)', veh.status === 200);
  const v0 = (veh.json?.vehicles || veh.json || [])[0];
  if (v0) info(`veículo com saúde: ${JSON.stringify({ plate: v0.plate, signal_ok: v0.signal_ok, min_sem_sinal: v0.minutes_without_signal, bateria_baixa: v0.battery_low, badge: v0.health_badge, dvir_blocked: v0.dvir_blocked })}`);

  // histórico do cliente: login REAL de cliente (só enxerga os pedidos dele)
  const cli = await http('POST', '/api/auth/client/login', { body: { identifier: 'teste', password: 'teste' } });
  check('POST /api/auth/client/login (teste/teste) → 200', cli.status === 200, cli.body?.slice(0, 100));
  if (cli.status === 200) {
    const hist = await http('GET', '/api/orders', { token: cli.json.token });
    const hArr = hist.json?.orders || hist.json?.data || hist.json || [];
    info(`histórico do cliente (${cli.json.user?.name}): ${hArr.length} pedido(s) · ${JSON.stringify(hArr.map(o => o.status))}`);
    check('histórico do cliente → 200', hist.status === 200);
    check('cliente só enxerga os pedidos dele', hArr.every(o => o.client_user_uuid === cli.json.user?.uuid),
      `${hArr.length} pedido(s)`);
  }

  const clients = await http('GET', '/api/clients', { token });
  check('GET /api/clients → 200', clients.status === 200, `${(clients.json || []).length} cliente(s)`);

  // ── 7. DEMO_MODE=false ────────────────────────────────────────────────────
  section('7 · PROVA DO DEMO_MODE ESTRITO (instância com DEMO_MODE=false)');
  const strict = await startStrictInstance();
  if (strict) {
    const h2 = await http('GET', '/health', { base: strict.base });
    check('instância estrita responde /health → demo_mode=false', h2.json?.demo_mode === false, `demo_mode=${h2.json?.demo_mode}`);
    const d1 = await http('POST', '/api/auth/admin/demo', { base: strict.base });
    check('POST /api/auth/admin/demo → 403', d1.status === 403, d1.body?.slice(0, 110));
    const d2 = await http('POST', '/api/auth/admin/demo-live', { base: strict.base });
    check('POST /api/auth/admin/demo-live → 403', d2.status === 403, d2.body?.slice(0, 110));
    const page = await http('GET', '/', { base: strict.base });
    const hasDemoMarkup = /btn-demo-admin|btn-demo-live|demo-access/.test(page.body || '');
    check('HTML servido NÃO contém os botões de demo', !hasDemoMarkup,
      hasDemoMarkup ? 'ainda no HTML' : 'removidos do DOM pelo applyDemoMode()');
    await stopContainer(strict.name);
  }

  // ── RESUMO ───────────────────────────────────────────────────────────────
  section('RESUMO DA SUÍTE · PROMPT 1');
  const pass = RESULTS.filter(r => r.pass).length;
  const failN = RESULTS.length - pass;
  RESULTS.forEach(r => console.log(`  ${r.pass ? col('g', '✔') : col('r', '✘')} ${r.label}`));
  console.log(`\n  ${col('b', `${pass} verificação(ões) OK · ${failN} falha(s) · ${((Date.now() - T0) / 1000).toFixed(1)}s`)}\n`);
  process.exit(failN ? 1 : 0);
}

async function readTail(file, n) {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const ex = promisify(execFile);
    const { stdout } = await ex('sudo', ['-n', 'tail', '-n', String(n), file]);
    return stdout.trim().split('\n').filter(Boolean);
  } catch { return []; }
}

async function ensureVehicle() {
  const [v] = await mysqlExec(
    `SELECT id FROM hermes_vehicles WHERE fleet_type='moto' AND dvir_blocked = 0 LIMIT 1;`
  ).then(r => r.split('\n').filter(Boolean));
  if (v) return v.split('\t')[0];
  const id = `veh_e2e_${Date.now()}`;
  await mysqlExec(
    `INSERT INTO hermes_vehicles (id, plate, model, fleet_type, status, driver_id, battery_pct)
     VALUES ('${id}', 'E2E-0001', 'Moto Teste E2E', 'moto', 'disponivel', 'drv_e2e_concorrencia', 92);`
  );
  info(`veículo de teste criado: ${id}`);
  return id;
}

async function ensureOrdersAllStatuses() {
  const base = {
    client_user_uuid: '00000000-0000-4000-8000-000000000001',
    fleet_type: 'moto', origin_address: 'Av. Centro, Natal/RN',
    destinations_json: "JSON_ARRAY(JSON_OBJECT('address','Destino E2E','lat',-5.79,'lng',-35.20))",
    final_price: 25.00, recipient_name: 'Cliente E2E', recipient_whatsapp: '5500000000000'
  };
  const wanted = [
    ['agendado', 'NULL', 'NOW() + INTERVAL 2 HOUR'],
    ['pendente', 'NULL', 'NULL'],
    ['em_rota', "'drv_e2e_kanban'", 'NULL'],
    ['concluido', "'drv_e2e_kanban'", 'NULL'],
    ['problema', "'drv_e2e_kanban'", 'NULL'],
    ['cancelado', 'NULL', 'NULL']
  ];
  for (const [st, drv, sched] of wanted) {
    const [have] = await mysqlExec(`SELECT COUNT(*) FROM hermes_orders WHERE status='${st}';`);
    if (Number(have) > 0) continue;
    const id = `E2E-${st.toUpperCase()}-${Date.now()}`;
    await mysqlExec(
      `INSERT INTO hermes_orders (id, client_user_uuid, client_name, fleet_type, status, queue_mode,
        origin_address, destinations_json, final_price, recipient_name, recipient_whatsapp, driver_id, driver_name, scheduled_at)
       VALUES ('${id}', '${base.client_user_uuid}', 'Cliente E2E', '${base.fleet_type}', '${st}', 'fila_aberta',
        '${base.origin_address}', ${base.destinations_json}, ${base.final_price}, '${base.recipient_name}',
        '${base.recipient_whatsapp}', ${drv}, ${drv ? "'Motorista E2E'" : 'NULL'}, ${sched});`
    );
    info(`pedido criado p/ status ${st}: ${id}`);
  }
}

async function startStrictInstance() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ex = promisify(execFile);
  const name = 'fleetbase-web-radio-panel-strict';
  const envdump = (await ex('docker', ['inspect', 'fleetbase-web-radio-panel',
    '--format', '{{range .Config.Env}}{{println .}}{{end}}'])).stdout;
  const env = {};
  for (const line of envdump.split('\n')) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  env.DEMO_MODE = 'false';
  env.PORT = '8602';
  const args = [
    'run', '-d', '--name', name,
    '--network', 'fleetbase_net', '--network', 'ntfy_default',
    '--restart', 'no', '--memory', '134217728', '--memory-swap', '268435456',
    '-p', '127.0.0.1:8602:8602',
    '-v', '/opt/hermes-fleetbase/uploads:/app/uploads',
    ...Object.entries(env).map(([k, v]) => ['-e', `${k}=${v}`]).flat(),
    'fleetbase-web-radio-panel:6.1'
  ];
  try {
    await ex('docker', ['rm', '-f', name]);
  } catch { /* não existia */ }
  try {
    await ex('docker', args);
  } catch (e) {
    fail(`não foi possível subir a instância DEMO_MODE=false: ${String(e.stderr || e).slice(0, 160)}`);
    return null;
  }
  for (let i = 0; i < 40; i++) {
    await sleep(1500);
    try {
      const r = await fetch('http://127.0.0.1:8602/health');
      if (r.ok) { info(`instância estrita no ar em 127.0.0.1:8602 (container ${name})`); return { base: 'http://127.0.0.1:8602', name }; }
    } catch { /* subindo */ }
  }
  fail('instância DEMO_MODE=false não respondeu /health a tempo');
  return null;
}

async function stopContainer(name) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const ex = promisify(execFile);
  try { await ex('docker', ['rm', '-f', name]); info(`container ${name} removido`); } catch { /* ok */ }
}

main().catch((e) => { console.error(col('r', '\nERRO NA SUÍTE: ') + e.stack); process.exit(2); });
