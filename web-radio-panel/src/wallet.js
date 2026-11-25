const crypto = require('crypto');
const { pool } = require('./db');
const { calculateOrderSplit, toCents, fromCents } = require('./pricing');

function genId(prefix) {
  return `${prefix}_${crypto.randomBytes(5).toString('hex')}`;
}

async function getEffectiveSplitRule(conn, organizationId, driverId) {
  const orgId = organizationId || 'default';
  if (driverId) {
    const [drvRules] = await conn.query(
      `SELECT * FROM hermes_split_rules WHERE organization_id IN (?, 'default') AND driver_id = ? ORDER BY FIELD(organization_id, ?, 'default') LIMIT 1`,
      [orgId, driverId, orgId]
    );
    if (drvRules.length) return drvRules[0];
  }
  const [orgRules] = await conn.query(
    `SELECT * FROM hermes_split_rules WHERE organization_id IN (?, 'default') AND driver_id IS NULL ORDER BY FIELD(organization_id, ?, 'default') LIMIT 1`,
    [orgId, orgId]
  );
  if (orgRules.length) return orgRules[0];
  return { split_type: 'percentual', coop_value: 15.00, extras_to_driver_100: 1 };
}

async function lockOrderCreditOnStart(orderId) {
  const conn = await pool.getConnection();
  try {
    const [orders] = await conn.query('SELECT * FROM hermes_orders WHERE id = ? LIMIT 1', [orderId]);
    if (!orders.length || !orders[0].driver_id) return null;
    const order = orders[0];
    const rule = await getEffectiveSplitRule(conn, order.organization_id, order.driver_id);
    const split = calculateOrderSplit(order, rule);

    await conn.query(
      `INSERT IGNORE INTO driver_wallet_transactions
       (id, organization_id, driver_id, order_id, tipo, status, valor, valor_bruto_os, taxa_cooperativa_os, descricao)
       VALUES (?, ?, ?, ?, 'credito_corrida', 'bloqueado', ?, ?, ?, ?)`,
      [
        genId('wlt'),
        order.organization_id || 'default',
        order.driver_id,
        order.id,
        split.valor_liquido_motoboy,
        split.valor_total_cliente,
        split.valor_taxa_cooperativa,
        `Corrida ${order.id} (em andamento)`
      ]
    );
    return split;
  } finally {
    conn.release();
  }
}

async function releaseOrderCreditOnComplete(orderId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [orders] = await conn.query('SELECT * FROM hermes_orders WHERE id = ? FOR UPDATE', [orderId]);
    if (!orders.length) {
      await conn.rollback();
      return null;
    }
    const order = orders[0];
    if (!order.driver_id) {
      await conn.commit();
      return null;
    }

    const rule = await getEffectiveSplitRule(conn, order.organization_id, order.driver_id);
    const split = calculateOrderSplit(order, rule);

    await conn.query(
      `UPDATE hermes_orders
       SET valor_total_cliente = ?, valor_taxa_cooperativa = ?, valor_liquido_motoboy = ?
       WHERE id = ?`,
      [split.valor_total_cliente, split.valor_taxa_cooperativa, split.valor_liquido_motoboy, order.id]
    );

    const [existing] = await conn.query(
      `SELECT id, status FROM driver_wallet_transactions WHERE order_id = ? AND tipo = 'credito_corrida' FOR UPDATE`,
      [order.id]
    );

    if (existing.length) {
      if (existing[0].status === 'bloqueado') {
        await conn.query(
          `UPDATE driver_wallet_transactions
           SET status = 'disponivel', driver_id = ?, valor = ?, valor_bruto_os = ?, taxa_cooperativa_os = ?, descricao = ?
           WHERE id = ?`,
          [
            order.driver_id,
            split.valor_liquido_motoboy,
            split.valor_total_cliente,
            split.valor_taxa_cooperativa,
            `Crédito corrida ${order.id} concluída`,
            existing[0].id
          ]
        );
      }
      // Se já está 'disponivel' ou 'pago', idempotência garante que nada é duplicado
    } else {
      await conn.query(
        `INSERT INTO driver_wallet_transactions
         (id, organization_id, driver_id, order_id, tipo, status, valor, valor_bruto_os, taxa_cooperativa_os, descricao)
         VALUES (?, ?, ?, ?, 'credito_corrida', 'disponivel', ?, ?, ?, ?)`,
        [
          genId('wlt'),
          order.organization_id || 'default',
          order.driver_id,
          order.id,
          split.valor_liquido_motoboy,
          split.valor_total_cliente,
          split.valor_taxa_cooperativa,
          `Crédito corrida ${order.id} concluída`
        ]
      );
    }

    await conn.commit();
    return split;
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function getDriversWalletSummary(organizationId = 'default') {
  const [drivers] = await pool.query(
    `SELECT d.id, d.name, d.whatsapp, d.plate, d.fleet_type, d.pix_key, d.commission_pct,
            COALESCE(SUM(CASE WHEN t.status = 'disponivel' THEN t.valor ELSE 0 END), 0) AS saldo_disponivel,
            COALESCE(SUM(CASE WHEN t.status = 'bloqueado' THEN t.valor ELSE 0 END), 0) AS saldo_bloqueado,
            COALESCE(SUM(CASE WHEN t.status = 'pago' THEN t.valor ELSE 0 END), 0) AS saldo_pago,
            COUNT(CASE WHEN t.status = 'disponivel' THEN 1 END) AS lancamentos_disponiveis
     FROM hermes_drivers d
     LEFT JOIN driver_wallet_transactions t ON d.id = t.driver_id
     GROUP BY d.id, d.name, d.whatsapp, d.plate, d.fleet_type, d.pix_key, d.commission_pct
     ORDER BY saldo_disponivel DESC, d.name ASC`
  );
  return drivers.map(d => ({
    ...d,
    saldo_disponivel: Number(Number(d.saldo_disponivel).toFixed(2)),
    saldo_bloqueado: Number(Number(d.saldo_bloqueado).toFixed(2)),
    saldo_pago: Number(Number(d.saldo_pago).toFixed(2))
  }));
}

async function getDriverWalletStatement(driverId) {
  const [drivers] = await pool.query('SELECT id, name, plate, pix_key, whatsapp FROM hermes_drivers WHERE id = ? LIMIT 1', [driverId]);
  const [txs] = await pool.query(
    `SELECT * FROM driver_wallet_transactions WHERE driver_id = ? ORDER BY created_at DESC LIMIT 150`,
    [driverId]
  );

  let dispCents = 0;
  let bloqCents = 0;
  let pagoCents = 0;
  for (const tx of txs) {
    const c = toCents(tx.valor);
    if (tx.status === 'disponivel') dispCents += c;
    else if (tx.status === 'bloqueado') bloqCents += c;
    else if (tx.status === 'pago') pagoCents += c;
  }

  return {
    driver: drivers[0] || { id: driverId, name: driverId },
    saldo_disponivel: fromCents(dispCents),
    saldo_bloqueado: fromCents(bloqCents),
    saldo_pago: fromCents(pagoCents),
    transactions: txs
  };
}

async function createManualAdjustment({ organizationId = 'default', driverId, tipo, valor, descricao }) {
  const allowed = ['bonus', 'ajuste_manual', 'desconto_mensalidade'];
  if (!allowed.includes(tipo)) {
    throw new Error('Tipo de ajuste inválido.');
  }
  const numVal = Number(valor);
  if (!Number.isFinite(numVal) || numVal === 0) {
    throw new Error('Valor inválido para ajuste.');
  }
  const finalVal = tipo === 'desconto_mensalidade' ? -Math.abs(numVal) : numVal;
  const id = genId('wlt');
  await pool.query(
    `INSERT INTO driver_wallet_transactions
     (id, organization_id, driver_id, order_id, tipo, status, valor, descricao)
     VALUES (?, ?, ?, NULL, ?, 'disponivel', ?, ?)`,
    [id, organizationId, driverId, tipo, fromCents(toCents(finalVal)), descricao || `Lançamento: ${tipo}`]
  );
  const [rows] = await pool.query('SELECT * FROM driver_wallet_transactions WHERE id = ?', [id]);
  return rows[0];
}

async function createPayoutBatch({ organizationId = 'default', driverIds = [], notes = '' }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let sql = `SELECT * FROM driver_wallet_transactions WHERE status = 'disponivel' AND payout_batch_id IS NULL`;
    const params = [];
    if (Array.isArray(driverIds) && driverIds.length > 0) {
      sql += ` AND driver_id IN (?)`;
      params.push(driverIds);
    }
    sql += ' FOR UPDATE';

    const [txs] = await conn.query(sql, params);
    if (!txs.length) {
      await conn.rollback();
      throw new Error('Não há lançamentos disponíveis para gerar lote de fechamento.');
    }

    let totalCents = 0;
    const drvSet = new Set();
    const txIds = [];
    for (const tx of txs) {
      totalCents += toCents(tx.valor);
      drvSet.add(tx.driver_id);
      txIds.push(tx.id);
    }

    const batchId = genId('lote');
    await conn.query(
      `INSERT INTO payout_batches (id, organization_id, total_amount, drivers_count, status, notes)
       VALUES (?, ?, ?, ?, 'aberto', ?)`,
      [batchId, organizationId, fromCents(totalCents), drvSet.size, notes || 'Lote de fechamento semanal']
    );

    await conn.query(
      `UPDATE driver_wallet_transactions SET payout_batch_id = ? WHERE id IN (?)`,
      [batchId, txIds]
    );

    await conn.commit();
    const [batches] = await pool.query('SELECT * FROM payout_batches WHERE id = ?', [batchId]);
    return batches[0];
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function payPayoutBatch(batchId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [batches] = await conn.query('SELECT * FROM payout_batches WHERE id = ? FOR UPDATE', [batchId]);
    if (!batches.length) {
      await conn.rollback();
      throw new Error('Lote não encontrado.');
    }
    if (batches[0].status === 'pago') {
      await conn.commit();
      return batches[0];
    }

    await conn.query(`UPDATE payout_batches SET status = 'pago', paid_at = NOW() WHERE id = ?`, [batchId]);
    await conn.query(
      `UPDATE driver_wallet_transactions SET status = 'pago' WHERE payout_batch_id = ? AND status = 'disponivel'`,
      [batchId]
    );

    await conn.commit();
    const [updated] = await pool.query('SELECT * FROM payout_batches WHERE id = ?', [batchId]);
    return updated[0];
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

module.exports = {
  getEffectiveSplitRule,
  lockOrderCreditOnStart,
  releaseOrderCreditOnComplete,
  getDriversWalletSummary,
  getDriverWalletStatement,
  createManualAdjustment,
  createPayoutBatch,
  payPayoutBatch
};
