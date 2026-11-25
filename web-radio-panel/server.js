const Fastify = require('fastify');
const fastifyStatic = require('@fastify/static');
const path = require('path');
const { AccessToken } = require('livekit-server-sdk');

const PORT = parseInt(process.env.PORT || '8601', 10);
const HOST = process.env.HOST || '0.0.0.0';
const LIVEKIT_API_KEY = process.env.LIVEKIT_API_KEY || 'devkey';
const LIVEKIT_API_SECRET = process.env.LIVEKIT_API_SECRET || 'secret';
const LIVEKIT_URL = process.env.LIVEKIT_URL || 'wss://livekit.automacaojs.us';
const BRIDGE_URL = process.env.BRIDGE_URL || 'http://127.0.0.1:8600';

const fastify = Fastify({
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
});

fastify.register(fastifyStatic, {
  root: path.join(__dirname, '..', 'public'),
  prefix: '/',
  index: false // Desativa index automático para customizar a rota GET /
});

// Health Check
fastify.get('/health', async (request, reply) => {
  return reply.code(200).send({
    status: 'ok',
    service: 'web-radio-panel',
    uptime: process.uptime(),
    timestamp: new Date().toISOString()
  });
});

// Rota raiz customizada por Host (track.automacaojs.us vs frota.automacaojs.us)
fastify.get('/', async (request, reply) => {
  const host = (request.headers.host || '').toLowerCase();
  if (host.startsWith('track.') || host.includes('track.automacaojs.us')) {
    return reply.sendFile('track-landing.html');
  }
  return reply.sendFile('index.html');
});

// Emissão de Token LiveKit para Gestor
fastify.get('/api/livekit/token', async (request, reply) => {
  const identity = request.query.identity || `gestor_${Math.floor(Math.random() * 1000)}`;
  const roomName = request.query.room || 'radio-frota-geral';

  try {
    const at = new AccessToken(LIVEKIT_API_KEY, LIVEKIT_API_SECRET, {
      identity: identity,
      ttl: '1h'
    });

    at.addGrant({
      roomJoin: true,
      room: roomName,
      canPublish: true,
      canSubscribe: true,
      canPublishData: true
    });

    const token = await at.toJwt();
    return reply.send({
      token,
      url: LIVEKIT_URL,
      room: roomName,
      identity
    });
  } catch (err) {
    fastify.log.error(err);
    return reply.code(500).send({ error: 'Erro ao gerar token LiveKit' });
  }
});

// Lista de Veículos e Telemetria
fastify.get('/api/vehicles', async (request, reply) => {
  return reply.send([
    {
      id: 'veh_cav_meu_001',
      placa: 'BRA2E19',
      modelo: 'Volvo FH 540',
      motorista: 'Carlos Eduardo',
      status: 'em_rota',
      lat: -5.794512,
      lon: -35.208456,
      speed_kph: 62.4,
      heading_deg: 187.2,
      dvir_status: 'aprovado_com_observacao',
      camera_active: false,
      facing: 'back',
      battery_pct: 78,
      updated_at: new Date().toISOString()
    },
    {
      id: 'veh_mot_centauro_002',
      placa: 'RNX8A42',
      modelo: 'Honda CG 160 Fan',
      motorista: 'Lucas Andrade',
      status: 'parado',
      lat: -5.836100,
      lon: -35.215400,
      speed_kph: 0.0,
      heading_deg: 45.0,
      dvir_status: 'aprovado',
      camera_active: false,
      facing: 'back',
      battery_pct: 95,
      updated_at: new Date().toISOString()
    }
  ]);
});

// Registros de DVIR
fastify.get('/api/dvir', async (request, reply) => {
  return reply.send([
    {
      dvir_id: 'dvir_7781',
      ordem_servico_id: 'os_8821',
      veiculo_id: 'veh_cav_meu_001',
      motorista: 'Carlos Eduardo',
      resultado: 'aprovado_com_observacao',
      bloqueia_saida: false,
      data_vistoria: '2026-11-21T08:30:00Z',
      itens: [
        { codigo: 'PNEU-01', categoria: 'Pneus e Rodas', aprovado: false, gravidade: 'media', observacao: 'Desgaste irregular dianteiro direito' },
        { codigo: 'FREIO-01', categoria: 'Sistema de Freios', aprovado: true, gravidade: 'baixa', observacao: 'Pastilhas em bom estado' },
        { codigo: 'ILUM-01', categoria: 'Faróis e Lanternas', aprovado: true, gravidade: 'baixa', observacao: 'Todos funcionando' }
      ]
    },
    {
      dvir_id: 'dvir_7782',
      ordem_servico_id: 'os_8822',
      veiculo_id: 'veh_mot_centauro_002',
      motorista: 'Lucas Andrade',
      resultado: 'aprovado',
      bloqueia_saida: false,
      data_vistoria: '2026-11-21T09:15:00Z',
      itens: [
        { codigo: 'MOT-01', categoria: 'Pneus', aprovado: true, gravidade: 'baixa', observacao: 'Calibragem ok' },
        { codigo: 'MOT-02', categoria: 'Óleo e Filtro', aprovado: true, gravidade: 'baixa', observacao: 'Nível dentro da marca' }
      ]
    }
  ]);
});

// Rastreio público com token (/r/:token)
fastify.get('/r/:token', async (request, reply) => {
  const { token } = request.params;
  return reply.sendFile('track.html');
});

async function start() {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Painel Web Rádio PTT & Olho Vivo ativo em http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
