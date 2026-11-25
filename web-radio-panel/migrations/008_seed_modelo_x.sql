-- 008_seed_modelo_x.sql — Enxame padrão, Template Modelo X e Super-Admin

INSERT IGNORE INTO fleets (uuid, public_id, company_uuid, name, slug, status, color, created_at, updated_at)
SELECT
  'net_geral_00000000000000000000000001',
  'fleet_geral_01',
  c.uuid,
  'Rede Geral — Todos os Motoboys',
  'rede-geral-todos-os-motoboys',
  'active',
  '#2563EB',
  NOW(),
  NOW()
FROM companies c
WHERE c.deleted_at IS NULL
ORDER BY c.created_at ASC
LIMIT 1;

INSERT IGNORE INTO hj_org_templates (id, name, version, description, config_json, created_by)
VALUES (
  'tpl_modelo_x_v1',
  'Modelo X — Cooperativa Padrão',
  '1.0.0',
  'Estrutura completa com Rede Geral, tabela de tarifas padrão (Moto/Utilitário/Baú/Carreta) e Split 15%.',
  JSON_OBJECT(
    'networks', JSON_ARRAY(
      JSON_OBJECT('name', 'Rede Geral — Todos os Motoboys', 'slug', 'rede-geral', 'color', '#2563EB'),
      JSON_OBJECT('name', 'Enxame Expresso Centro', 'slug', 'expresso-centro', 'color', '#10B981')
    ),
    'split', JSON_OBJECT('split_type', 'percentual', 'coop_value', 15, 'extras_to_driver_100', true),
    'tariffs', JSON_ARRAY(
      JSON_OBJECT('fleet_type', 'moto', 'base_fee', 8.00, 'km_franquia', 3.0, 'per_km_fee', 2.20),
      JSON_OBJECT('fleet_type', 'utilitario', 'base_fee', 25.00, 'km_franquia', 3.0, 'per_km_fee', 3.80),
      JSON_OBJECT('fleet_type', 'bau', 'base_fee', 85.00, 'km_franquia', 5.0, 'per_km_fee', 6.50),
      JSON_OBJECT('fleet_type', 'carreta', 'base_fee', 180.00, 'km_franquia', 10.0, 'per_km_fee', 11.00)
    )
  ),
  'system'
);

UPDATE users
   SET type = 'super_admin'
 WHERE email IN ('admin@automacaojs.us', 'isaiassilva356@gmail.com')
   AND deleted_at IS NULL;
