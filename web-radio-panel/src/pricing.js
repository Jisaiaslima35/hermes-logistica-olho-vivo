function toCents(val) {
  return Math.round(Number(val || 0) * 100);
}

function fromCents(cents) {
  return Number((Math.round(cents) / 100).toFixed(2));
}

function calculateOrderPricing(tariff, opts = {}) {
  const km = Math.max(0.5, Number(opts.distance_km || 0));
  const extraStops = Math.max(0, parseInt(opts.extra_stops_count || 0, 10));
  const requiresReturn = Boolean(opts.requires_return);

  const taxaBaseCents = toCents(tariff.base_fee);
  const kmFranquia = Math.max(0, Number(tariff.km_franquia ?? 3));
  const valorPorKmCents = toCents(tariff.per_km_fee);
  const adicionalRetornoCents = toCents(tariff.adicional_retorno || 0);
  const adicionalParadaCents = toCents(tariff.adicional_parada_extra || 0);
  const adicionalNoturnoCents = tariff.adicional_noturno_ativo ? toCents(tariff.adicional_noturno_ou_clima || 0) : 0;

  const kmExcedente = Math.max(0, Number((km - kmFranquia).toFixed(2)));
  const freteBaseKmCents = taxaBaseCents + Math.round(kmExcedente * valorPorKmCents);

  const retornoCents = requiresReturn ? adicionalRetornoCents : 0;
  const paradasCents = extraStops * adicionalParadaCents;
  const extrasCents = retornoCents + paradasCents + adicionalNoturnoCents;

  const totalCents = freteBaseKmCents + extrasCents;

  return {
    valor_total_cliente: fromCents(totalCents),
    valor_base_km: fromCents(freteBaseKmCents),
    valor_extras: fromCents(extrasCents),
    snapshot: {
      fleet_type: tariff.fleet_type,
      taxa_base: fromCents(taxaBaseCents),
      km_franquia: kmFranquia,
      valor_por_km: fromCents(valorPorKmCents),
      distance_km: km,
      km_excedente: kmExcedente,
      requires_return: requiresReturn,
      adicional_retorno_aplicado: fromCents(retornoCents),
      extra_stops_count: extraStops,
      adicional_parada_aplicado: fromCents(paradasCents),
      adicional_noturno_ativo: Boolean(tariff.adicional_noturno_ativo),
      adicional_noturno_aplicado: fromCents(adicionalNoturnoCents),
      valor_extras: fromCents(extrasCents),
      valor_total_cliente: fromCents(totalCents),
      calculated_at: new Date().toISOString()
    }
  };
}

function calculateOrderSplit(order, splitRule) {
  const totalCents = toCents(order.valor_total_cliente || order.final_price || 0);
  const snap = typeof order.pricing_snapshot_json === 'string'
    ? JSON.parse(order.pricing_snapshot_json || '{}')
    : (order.pricing_snapshot_json || order.pricing_snapshot || {});
  const extrasCents = toCents(snap.valor_extras || 0);

  const rule = splitRule || {
    split_type: 'percentual',
    coop_value: Number(order.coop_fee_pct || 15),
    extras_to_driver_100: 1
  };

  const extrasToDriver100 = Boolean(Number(rule.extras_to_driver_100 ?? 1));
  const rateioBaseCents = extrasToDriver100 ? Math.max(0, totalCents - extrasCents) : totalCents;

  let coopCents = 0;
  if (rule.split_type === 'taxa_fixa_por_corrida') {
    coopCents = Math.min(rateioBaseCents, toCents(rule.coop_value));
  } else {
    const pct = Math.min(100, Math.max(0, Number(rule.coop_value || 0)));
    coopCents = Math.round(rateioBaseCents * (pct / 100));
  }

  const driverCents = Math.max(0, totalCents - coopCents);

  return {
    valor_total_cliente: fromCents(totalCents),
    valor_taxa_cooperativa: fromCents(coopCents),
    valor_liquido_motoboy: fromCents(driverCents),
    split_type: rule.split_type,
    coop_value: Number(rule.coop_value),
    extras_to_driver_100: extrasToDriver100
  };
}

module.exports = {
  toCents,
  fromCents,
  calculateOrderPricing,
  calculateOrderSplit
};
