const DEMO_COMPANY = {
  uuid: 'demo_coop_transportes',
  name: 'Demo Cooperativa & Transportes'
};

const state = {
  tariffs: [
    { id: 1, fleet_type: 'moto', label: 'Moto / Mototáxi', base_fee: 8.00, per_km_fee: 2.20, coop_fee_pct: 15.00, active: 1 },
    { id: 2, fleet_type: 'utilitario', label: 'Utilitário / Fiorino', base_fee: 25.00, per_km_fee: 3.80, coop_fee_pct: 15.00, active: 1 },
    { id: 3, fleet_type: 'bau', label: 'Caminhão Baú', base_fee: 85.00, per_km_fee: 6.50, coop_fee_pct: 12.00, active: 1 },
    { id: 4, fleet_type: 'carreta', label: 'Carreta Pesada', base_fee: 180.00, per_km_fee: 11.00, coop_fee_pct: 10.00, active: 1 }
  ],
  places: [
    { id: 'demo_plc_1', name: 'Ponto Centro Natal', place_type: 'base', address: 'Av. Rio Branco, Centro - Natal/RN', lat: -5.7842, lon: -35.2039, radius_m: 350 },
    { id: 'demo_plc_2', name: 'Pátio Distribuidora BR-101', place_type: 'cerca', address: 'BR-101 Km 96, Parnamirim/RN', lat: -5.8812, lon: -35.2345, radius_m: 500 },
    { id: 'demo_plc_3', name: 'Base Ponta Negra', place_type: 'base', address: 'Av. Eng. Roberto Freire, Ponta Negra - Natal/RN', lat: -5.8755, lon: -35.1778, radius_m: 300 }
  ],
  drivers: [
    { id: 'demo_drv_1', name: 'Marcos Silva', whatsapp: '5584999110001', plate: 'QGA1M10', fleet_type: 'moto', commission_pct: 85, online: 1, status: 'em_rota', lat: -5.7945, lon: -35.2084 },
    { id: 'demo_drv_2', name: 'Rafael Costa', whatsapp: '5584999110002', plate: 'QGB2M20', fleet_type: 'moto', commission_pct: 85, online: 1, status: 'em_rota', lat: -5.8210, lon: -35.2110 },
    { id: 'demo_drv_3', name: 'João Pereira', whatsapp: '5584999110003', plate: 'QGC3U30', fleet_type: 'utilitario', commission_pct: 85, online: 1, status: 'disponivel', lat: -5.8530, lon: -35.2015 },
    { id: 'demo_drv_4', name: 'Carlos Mendes', whatsapp: '5584999110004', plate: 'QGD4B40', fleet_type: 'bau', commission_pct: 88, online: 1, status: 'em_rota', lat: -5.8805, lon: -35.2350 },
    { id: 'demo_drv_5', name: 'André Oliveira', whatsapp: '5584999110005', plate: 'QGE5M50', fleet_type: 'moto', commission_pct: 85, online: 1, status: 'disponivel', lat: -5.7580, lon: -35.2450 },
    { id: 'demo_drv_6', name: 'Roberto Alves', whatsapp: '5584999110006', plate: 'QGF6C60', fleet_type: 'carreta', commission_pct: 90, online: 1, status: 'em_rota', lat: -5.9150, lon: -35.2610 }
  ],
  vehicles: [
    { id: 'demo_veh_1', plate: 'QGA1M10', model: 'Honda CG 160 Start', fleet_type: 'moto', driver_id: 'demo_drv_1', driver_name: 'Marcos Silva', status: 'em_rota', lat: -5.7945, lon: -35.2084, speed_kph: 48, heading_deg: 120, battery_pct: 88, dvir_status: 'aprovado', angle: 0.2 },
    { id: 'demo_veh_2', plate: 'QGB2M20', model: 'Yamaha Fazer 150', fleet_type: 'moto', driver_id: 'demo_drv_2', driver_name: 'Rafael Costa', status: 'em_rota', lat: -5.8210, lon: -35.2110, speed_kph: 54, heading_deg: 210, battery_pct: 76, dvir_status: 'aprovado', angle: 1.4 },
    { id: 'demo_veh_3', plate: 'QGC3U30', model: 'Fiat Fiorino Endurance', fleet_type: 'utilitario', driver_id: 'demo_drv_3', driver_name: 'João Pereira', status: 'disponivel', lat: -5.8530, lon: -35.2015, speed_kph: 32, heading_deg: 45, battery_pct: 92, dvir_status: 'aprovado', angle: 2.3 },
    { id: 'demo_veh_4', plate: 'QGD4B40', model: 'VW Delivery 9.170 Baú', fleet_type: 'bau', driver_id: 'demo_drv_4', driver_name: 'Carlos Mendes', status: 'em_rota', lat: -5.8805, lon: -35.2350, speed_kph: 61, heading_deg: 185, battery_pct: 81, dvir_status: 'aprovado_com_observacao', angle: 3.1 },
    { id: 'demo_veh_5', plate: 'QGE5M50', model: 'Honda Biz 125', fleet_type: 'moto', driver_id: 'demo_drv_5', driver_name: 'André Oliveira', status: 'disponivel', lat: -5.7580, lon: -35.2450, speed_kph: 40, heading_deg: 90, battery_pct: 95, dvir_status: 'aprovado', angle: 4.2 },
    { id: 'demo_veh_6', plate: 'QGF6C60', model: 'Scania R450 Carreta', fleet_type: 'carreta', driver_id: 'demo_drv_6', driver_name: 'Roberto Alves', status: 'em_rota', lat: -5.9150, lon: -35.2610, speed_kph: 68, heading_deg: 170, battery_pct: 84, dvir_status: 'aprovado', angle: 5.0 }
  ],
  orders: [
    { id: 'DEMO-101', client_name: 'Distribuidora Potiguar', fleet_type: 'bau', status: 'agendado', queue_mode: 'direto', origin_address: 'BR-101 Km 96, Parnamirim', destinations: [{ address: 'Midway Mall, Natal' }], distance_km: 14.2, final_price: 177.30, payment_method: 'faturado', cargo_weight_kg: 1850, cargo_type: 'Alimentos Secos', scheduled_at: new Date(Date.now() + 7200000).toISOString(), created_at: new Date().toISOString() },
    { id: 'DEMO-102', client_name: 'Farmácia Central', fleet_type: 'moto', status: 'agendado', queue_mode: 'direto', origin_address: 'Av. Prudente de Morais, 800', destinations: [{ address: 'Capim Macio, Natal' }], distance_km: 7.5, final_price: 24.50, payment_method: 'pix', scheduled_at: new Date(Date.now() + 3600000).toISOString(), created_at: new Date().toISOString() },
    { id: 'DEMO-103', client_name: 'Auto Peças Natal', fleet_type: 'moto', status: 'pendente', queue_mode: 'fila_aberta', origin_address: 'Av. Bernardo Vieira, 1200', destinations: [{ address: 'Alecrim, Natal' }], distance_km: 5.2, final_price: 19.44, payment_method: 'pix', created_at: new Date().toISOString() },
    { id: 'DEMO-104', client_name: 'Mercado Bom Preço', fleet_type: 'utilitario', status: 'pendente', queue_mode: 'fila_aberta', origin_address: 'Tirol, Natal', destinations: [{ address: 'Ponta Negra, Natal' }], distance_km: 11.4, final_price: 68.32, payment_method: 'dinheiro', created_at: new Date().toISOString() },
    { id: 'DEMO-105', client_name: 'Construtora Horizonte', fleet_type: 'bau', status: 'em_rota', queue_mode: 'direto', driver_id: 'demo_drv_4', driver_name: 'Carlos Mendes', origin_address: 'Pátio BR-101, Parnamirim', destinations: [{ address: 'Candelária, Natal' }], distance_km: 16.0, final_price: 189.00, payment_method: 'faturado', cargo_weight_kg: 3200, cargo_type: 'Material Elétrico', created_at: new Date().toISOString() },
    { id: 'DEMO-106', client_name: 'E-commerce Express', fleet_type: 'moto', status: 'em_rota', queue_mode: 'direto', driver_id: 'demo_drv_1', driver_name: 'Marcos Silva', origin_address: 'Centro, Natal', destinations: [{ address: 'Lagoa Nova, Natal' }], distance_km: 6.1, final_price: 21.42, payment_method: 'pix', created_at: new Date().toISOString() },
    { id: 'DEMO-107', client_name: 'Siderúrgica RN', fleet_type: 'carreta', status: 'em_rota', queue_mode: 'direto', driver_id: 'demo_drv_6', driver_name: 'Roberto Alves', origin_address: 'Porto de Natal', destinations: [{ address: 'Distrito Industrial, Macaíba' }], distance_km: 24.5, final_price: 449.50, payment_method: 'faturado', cargo_weight_kg: 18500, cargo_type: 'Aço e Perfis', created_at: new Date().toISOString() },
    { id: 'DEMO-108', client_name: 'Distribuidora Potiguar', fleet_type: 'moto', status: 'concluido', driver_id: 'demo_drv_1', driver_name: 'Marcos Silva', origin_address: 'Tirol, Natal', destinations: [{ address: 'Petrópolis, Natal' }], distance_km: 4.8, final_price: 18.56, coop_fee_pct: 15, payment_method: 'pix', completed_at: new Date().toISOString(), settlement_id: null, created_at: new Date().toISOString() },
    { id: 'DEMO-109', client_name: 'Atacadão Norte', fleet_type: 'bau', status: 'concluido', driver_id: 'demo_drv_4', driver_name: 'Carlos Mendes', origin_address: 'Zona Norte, Natal', destinations: [{ address: 'Parnamirim Centro' }], distance_km: 21.0, final_price: 221.50, coop_fee_pct: 12, payment_method: 'faturado', cargo_weight_kg: 4100, cargo_type: 'Bebidas', completed_at: new Date().toISOString(), settlement_id: null, created_at: new Date().toISOString() },
    { id: 'DEMO-110', client_name: 'Loja Centro', fleet_type: 'moto', status: 'problema', driver_id: 'demo_drv_2', driver_name: 'Rafael Costa', origin_address: 'Alecrim, Natal', destinations: [{ address: 'Ribeira, Natal' }], distance_km: 3.9, final_price: 16.58, problem_reason: 'Portaria fechada no horário do almoço', created_at: new Date().toISOString() }
  ],
  settlements: [
    { id: 'DEMO-SET-01', driver_id: 'demo_drv_1', driver_name: 'Marcos Silva', period_start: '2026-11-01', period_end: '2026-11-15', total_deliveries: 42, gross_amount: 1120.00, coop_fee_amount: 168.00, net_amount: 952.00, status: 'fechado', closed_at: '2026-11-16T18:00:00Z' },
    { id: 'DEMO-SET-02', driver_id: 'demo_drv_4', driver_name: 'Carlos Mendes', period_start: '2026-11-01', period_end: '2026-11-15', total_deliveries: 18, gross_amount: 3420.00, coop_fee_amount: 410.40, net_amount: 3009.60, status: 'fechado', closed_at: '2026-11-16T18:05:00Z' }
  ],
  dvir: [
    { id: 'demo_dvir_1', vehicle_id: 'QGD4B40', driver_name: 'Carlos Mendes', result: 'aprovado_com_observacao', blocks_departure: 0, created_at: new Date().toISOString() },
    { id: 'demo_dvir_2', vehicle_id: 'QGF6C60', driver_name: 'Roberto Alves', result: 'aprovado', blocks_departure: 0, created_at: new Date().toISOString() }
  ],
  alerts: [
    { id: 'demo_alt_1', order_id: 'DEMO-105', vehicle_id: 'QGD4B40', alert_type: 'desvio_rota', message: 'Desvio de 420m detectado próximo ao Viaduto de Ponta Negra', acknowledged: 0, created_at: new Date().toISOString() },
    { id: 'demo_alt_2', order_id: 'DEMO-107', vehicle_id: 'QGF6C60', alert_type: 'parada_prolongada', message: 'Parada prolongada (18 min) na BR-101 Sul', acknowledged: 0, created_at: new Date().toISOString() }
  ],
  clients: [
    { uuid: 'demo_cli_1', name: 'Distribuidora Potiguar Ltda', username: 'potiguar', phone: '5584999887766', meta: { cpf_cnpj: '12.345.678/0001-90' } },
    { uuid: 'demo_cli_2', name: 'Farmácia Central Natal', username: 'farmacia', phone: '5584999776655', meta: { cpf_cnpj: '98.765.432/0001-10' } }
  ]
};

let simulatorStarted = false;
function startDemoSimulator() {
  if (simulatorStarted) return;
  simulatorStarted = true;
  setInterval(() => {
    for (const v of state.vehicles) {
      v.angle = (v.angle + 0.18) % (Math.PI * 2);
      const dLat = Math.cos(v.angle) * 0.00045;
      const dLon = Math.sin(v.angle) * 0.00045;
      v.lat = Number((v.lat + dLat).toFixed(6));
      v.lon = Number((v.lon + dLon).toFixed(6));
      v.heading_deg = Math.round(((v.angle * 180) / Math.PI) % 360);
      v.speed_kph = v.status === 'em_rota' ? Math.round(38 + Math.abs(Math.sin(v.angle)) * 28) : 0;
      const drv = state.drivers.find(d => d.id === v.driver_id);
      if (drv) { drv.lat = v.lat; drv.lon = v.lon; }
    }
  }, 3000);
}

module.exports = {
  DEMO_COMPANY,
  demoState: state,
  startDemoSimulator
};
