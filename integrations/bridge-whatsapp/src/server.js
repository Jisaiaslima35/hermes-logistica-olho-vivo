const Fastify = require('fastify');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Redis = require('ioredis');

const PORT = parseInt(process.env.PORT || '8600', 10);
const HOST = process.env.HOST || '0.0.0.0';
const REDIS_URL = process.env.REDIS_URL || 'redis://fleetbase-redis:6379';
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://127.0.0.1:8096';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'fluxo-logistica';
// Chave da API Evolution.
//   engine=go  -> TOKEN DA INSTÂNCIA (não é a GLOBAL_API_KEY!)
//   engine=v2  -> GLOBAL_API_KEY da Evolution API v2
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || '';
// 'go' (Evolution GO / whatsmeow, porta 8096) | 'v2' (Baileys, /message/sendText/:inst)
const EVOLUTION_ENGINE = String(process.env.EVOLUTION_ENGINE || 'go').toLowerCase();
// Telefone do gerente para alertas que não trazem telefone no payload.
const MANAGER_WHATSAPP = process.env.MANAGER_WHATSAPP || '';
const WEBHOOK_HMAC_SECRET = process.env.WEBHOOK_HMAC_SECRET || 'fleetbase_secret_default';
const TRACKING_SIGNING_KEY = process.env.TRACKING_SIGNING_KEY || 'tracking_secret_default';
const TRACKING_BASE_URL = process.env.TRACKING_BASE_URL || 'https://track.automacaojs.us';
const TRACKING_DEFAULT_TTL = parseInt(process.env.TRACKING_TTL_SECONDS || '21600', 10); // 6h default, teto 24h (86400)

const fastify = Fastify({
  maxParamLength: 1024,
  logger: {
    level: process.env.LOG_LEVEL || 'info'
  }
});

// Redis client
let redis;
try {
  redis = new Redis(REDIS_URL, {
    maxRetriesPerRequest: 2,
    enableReadyCheck: true,
    lazyConnect: true
  });
  redis.connect().catch(err => {
    fastify.log.warn(`Redis connection error, fallback in-memory: ${err.message}`);
  });
} catch (e) {
  fastify.log.warn(`Failed to init Redis: ${e.message}`);
}

const memoryCache = new Map();

async function isDuplicate(key, ttlSeconds = 86400) {
  if (redis && redis.status === 'ready') {
    try {
      const res = await redis.set(`idemp:${key}`, '1', 'EX', ttlSeconds, 'NX');
      return res === null;
    } catch (e) {
      fastify.log.warn(`Redis isDuplicate error: ${e.message}`);
    }
  }
  if (memoryCache.has(key)) {
    return true;
  }
  memoryCache.set(key, Date.now());
  setTimeout(() => memoryCache.delete(key), ttlSeconds * 1000);
  return false;
}

// Assinatura de token de rastreio (JWT HS256)
function signTrackingToken(payload, ttlSeconds = TRACKING_DEFAULT_TTL) {
  const finalTtl = Math.min(ttlSeconds, 86400); // Teto absoluto de 24h
  return jwt.sign(payload, TRACKING_SIGNING_KEY, {
    algorithm: 'HS256',
    expiresIn: finalTtl
  });
}

// Verificação de token de rastreio
function verifyTrackingToken(token) {
  try {
    return jwt.verify(token, TRACKING_SIGNING_KEY, { algorithms: ['HS256'] });
  } catch (err) {
    return null;
  }
}

// Envio para Evolution GO
//
//  engine=go : POST /send/text          body {number, text}          apikey = TOKEN DA INSTÂNCIA
//  engine=v2 : POST /message/sendText/:inst body {number, textMessage:{text}} apikey = GLOBAL_API_KEY
//
//  Gotcha GO: mandar a GLOBAL_API_KEY na rota de envio devolve 401 — o
//  header `apikey` tem que ser o token da INSTÂNCIA.
async function sendWhatsAppNotification(to, text) {
  const cleanPhone = String(to).replace(/\D/g, '');
  if (!cleanPhone || !text) {
    fastify.log.warn('Tentativa de envio de WhatsApp sem telefone ou texto');
    return { success: false, reason: 'invalid_params' };
  }

  const isGo = EVOLUTION_ENGINE === 'go';
  const endpoint = isGo
    ? `${EVOLUTION_URL.replace(/\/$/, '')}/send/text`
    : `${EVOLUTION_URL.replace(/\/$/, '')}/message/sendText/${EVOLUTION_INSTANCE}`;
  const payload = isGo
    ? { number: cleanPhone, text }
    : {
        number: cleanPhone,
        options: { delay: 100, presence: 'composing', linkPreview: false },
        textMessage: { text }
      };

  fastify.log.info({ endpoint, engine: EVOLUTION_ENGINE, to: cleanPhone }, 'Disparando WhatsApp via Evolution');

  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY
      },
      body: JSON.stringify(payload)
    });

    const body = await response.text();
    return {
      success: response.ok,
      status: response.status,
      body: body
    };
  } catch (error) {
    fastify.log.error({ err: error.message }, 'Falha na requisicao para Evolution');
    return { success: false, error: error.message };
  }
}

/** Telefone do gerente: payload > env MANAGER_WHATSAPP. */
function managerPhone(payload) {
  return payload.telefone_gestor || payload.telefone_notificacao || MANAGER_WHATSAPP || '';
}

// Health check
fastify.get('/health', async (request, reply) => {
  const redisHealthy = redis ? redis.status === 'ready' : false;
  return reply.code(200).send({
    status: 'ok',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
    redis: redisHealthy
  });
});

// Verificação e decodificação do link de rastreio
fastify.get('/v1/tracking/verify/:token', async (request, reply) => {
  const { token } = request.params;
  const decoded = verifyTrackingToken(token);
  if (!decoded) {
    return reply.code(401).send({ error: 'Token inválido ou expirado' });
  }
  return reply.code(200).send({
    valid: true,
    data: decoded
  });
});

// Emissão de link de rastreio
fastify.post('/v1/tracking/sign', async (request, reply) => {
  const { ordem_servico_id, veiculo_id, tenant_id, ttl_s, destinatario } = request.body || {};
  if (!ordem_servico_id) {
    return reply.code(400).send({ error: 'ordem_servico_id obrigatório' });
  }

  const ttl = Math.min(parseInt(ttl_s || TRACKING_DEFAULT_TTL, 10), 86400);
  const token = signTrackingToken({
    sub: tenant_id || 'default',
    aud: 'ordem_de_servico',
    os_id: ordem_servico_id,
    veiculo_id: veiculo_id || null,
    scope: ['posicao', 'status']
  }, ttl);

  const url = `${TRACKING_BASE_URL.replace(/\/$/, '')}/r/${token}`;
  const expira_em = new Date(Date.now() + ttl * 1000).toISOString();

  return reply.code(200).send({
    token,
    url,
    expira_em,
    ttl_s: ttl
  });
});

// Webhook central de eventos
fastify.post('/v1/events', async (request, reply) => {
  const event = request.body || {};
  const eventType = event.event_type || request.headers['x-fleetbase-event'];
  const occurredAt = event.occurred_at || new Date().toISOString();
  const subjectId = (event.subject && event.subject.id) || (event.payload && event.payload.ordem_servico_id) || 'unknown';

  // Anti-replay (janela de 300 segundos se fornecido timestamp no header)
  const headerTs = request.headers['x-fleetbase-timestamp'];
  if (headerTs) {
    const eventTime = new Date(headerTs).getTime();
    if (!isNaN(eventTime) && Math.abs(Date.now() - eventTime) > 300000) {
      return reply.code(400).send({ error: 'Timestamp fora da janela anti-replay de 300s' });
    }
  }

  // Idempotência
  const idempotencyKey = event.idempotency_key ||
    crypto.createHash('sha256').update(`${eventType}:${subjectId}:${occurredAt}:${JSON.stringify(event.payload || {})}`).digest('hex');

  const duplicate = await isDuplicate(idempotencyKey, 86400);
  if (duplicate) {
    fastify.log.info({ idempotencyKey, eventType }, 'Evento duplicado ignorado');
    return reply.code(200).send({ status: 'duplicate', idempotency_key: idempotencyKey });
  }

  fastify.log.info({ eventType, subjectId }, 'Processando evento Fleetbase');
  const payload = event.payload || {};

  // Roteamento de regras de negócio
  switch (eventType) {
    case 'desvio.detectado': {
      // Regra: desvio > 300m e duração >= 10 min (600s)
      const deslocamento = Number(payload.deslocamento_m || 0);
      const duracao = Number(payload.duracao_s || 0);
      if (deslocamento >= 300 && duracao >= 600) {
        const msg = `🚨 *ALERTA DE DESVIO DE ROTA*\n` +
          `OS: ${payload.ordem_servico_id || 'N/A'}\n` +
          `Veículo: ${payload.veiculo_id || 'N/A'}\n` +
          `Deslocamento: ${deslocamento} metros\n` +
          `Duração: ${Math.round(duracao / 60)} minutos fora do trajeto previsto.`;
        if (payload.telefone_notificacao) {
          await sendWhatsAppNotification(payload.telefone_notificacao, msg);
        }
      }
      break;
    }

    case 'parada.prolongada': {
      // Regra: parada prolongada >= 15 min (900s)
      const duracao = Number(payload.duracao_s || 0);
      if (duracao >= 900) {
        const endereco = (payload.local && payload.local.endereco) || 'Localização não identificada';
        const msg = `⚠️ *ALERTA DE PARADA PROLONGADA*\n` +
          `OS: ${payload.ordem_servico_id || 'N/A'}\n` +
          `Veículo: ${payload.veiculo_id || 'N/A'}\n` +
          `Duração: ${Math.round(duracao / 60)} min parado\n` +
          `Local: ${endereco}`;
        if (payload.telefone_notificacao) {
          await sendWhatsAppNotification(payload.telefone_notificacao, msg);
        }
      }
      break;
    }

    case 'link_rastreio.solicitado': {
      // Geração e envio do link temporário
      const dest = payload.destinatario || {};
      const osId = payload.ordem_servico_id;
      const ttl = Math.min(Number(payload.ttl_s || TRACKING_DEFAULT_TTL), 86400);

      const token = signTrackingToken({
        sub: event.tenant ? event.tenant.id : 'default',
        aud: 'ordem_de_servico',
        os_id: osId,
        veiculo_id: payload.veiculo_id,
        scope: payload.escopo || ['posicao', 'status']
      }, ttl);

      const trackingUrl = `${TRACKING_BASE_URL.replace(/\/$/, '')}/r/${token}`;
      const horas = Math.round(ttl / 3600);
      const msg = `🚚 *Acompanhe sua entrega*\n` +
        `Sua ordem de serviço ${osId} está em andamento.\n` +
        `Link de rastreio ao vivo (válido por ${horas}h):\n` +
        `${trackingUrl}`;

      if (dest.telefone) {
        await sendWhatsAppNotification(dest.telefone, msg);
      }
      break;
    }

    case 'dvir.registrada': {
      if (payload.resultado === 'reprovado' || payload.bloqueia_saida) {
        const msg = `🛑 *VEÍCULO BLOQUEADO POR DVIR*\n` +
          `Veículo: ${payload.veiculo_id}\n` +
          `Motorista: ${payload.motorista_id}\n` +
          `Vistoria reprovada. Saída bloqueada até resolução técnica.`;
        if (payload.telefone_gestor) {
          await sendWhatsAppNotification(payload.telefone_gestor, msg);
        }
      }
      break;
    }

    // ── BLINDAGEM DVIR (prompt 2) ────────────────────────────────────────────
    case 'dvir.bloqueio': {
      const msg = `🛑 *DVIR — VEÍCULO BLOQUEADO*\n` +
        `Vistoria: ${payload.vistoria_id || '-'}\n` +
        `Veículo: ${payload.veiculo_id || '-'}\n` +
        `Resultado: REPROVADO\n` +
        `${payload.motivo || 'Vistoria reprovada'}\n\n` +
        `O veículo NÃO aceita novas corridas até a liberação do gestor.`;
      const to = managerPhone(payload);
      if (to) await sendWhatsAppNotification(to, msg);
      break;
    }

    case 'dvir.fraude': {
      const msg = `🚨 *ALERTA DE FRAUDE — FOTO DUPLICADA (DVIR)*\n` +
        `Vistoria: ${payload.vistoria_id || '-'}\n` +
        `Veículo: ${payload.veiculo_id || '-'}\n` +
        `Slots com hash repetido: ${Array.isArray(payload.slots) ? payload.slots.join(', ') : '-'}\n\n` +
        `A mesma foto foi reaproveitada na organização. Confira no painel.`;
      const to = managerPhone(payload);
      if (to) await sendWhatsAppNotification(to, msg);
      break;
    }

    case 'dvir.aprovada': {
      const msg = `✅ *DVIR APROVADA*\n` +
        `Vistoria: ${payload.vistoria_id || '-'}\n` +
        `Veículo: ${payload.veiculo_id || '-'}`;
      const to = managerPhone(payload);
      if (to) await sendWhatsAppNotification(to, msg);
      break;
    }

    // ── ALERTAS DE FROTA (prompt 1) ──────────────────────────────────────────
    case 'alerta.sem_sinal': {
      const min = payload.minutos_sem_sinal;
      const msg = `📡 *VEÍCULO SEM SINAL*\n` +
        `Veículo: ${payload.placa || payload.veiculo_id || '-'}\n` +
        `Sem sinal há: ${min === null || min === undefined ? '?' : `${min} min`}\n` +
        `O veículo está em rota e parou de reportar posição.`;
      const to = managerPhone(payload);
      if (to) await sendWhatsAppNotification(to, msg);
      break;
    }

    case 'alerta.bateria_baixa': {
      const msg = `🔋 *BATERIA BAIXA — VEÍCULO*\n` +
        `Veículo: ${payload.placa || payload.veiculo_id || '-'}\n` +
        `Bateria: ${payload.battery_pct ?? '-'}%\n` +
        `Risco de a telemetria cair e a corrida ficar sem rastreio.`;
      const to = managerPhone(payload);
      if (to) await sendWhatsAppNotification(to, msg);
      break;
    }

    case 'carga.descarga.concluida': {
      const etapa = (payload.etapa || 'concluida').toUpperCase();
      const msg = `✅ *${etapa} CONCLUÍDA*\n` +
        `OS: ${payload.ordem_servico_id}\n` +
        `Ponto: ${payload.ponto_nome || payload.ponto_id}\n` +
        `Documento: ${payload.chave_documento || 'Registrado'}`;
      if (payload.telefone_notificacao) {
        await sendWhatsAppNotification(payload.telefone_notificacao, msg);
      }
      break;
    }

    case 'corrida.atribuida': {
      const msg = `🚚 *CORRIDA ATRIBUÍDA*\n` +
        `OS: ${payload.ordem_servico_id}\n` +
        `Motorista: ${payload.motorista_nome || 'Designado'}\n` +
        `Origem: ${payload.origem || '-'}\n` +
        `Valor: R$ ${Number(payload.valor || 0).toFixed(2)}`;
      if (payload.telefone_motorista) {
        await sendWhatsAppNotification(payload.telefone_motorista, msg);
      }
      if (payload.telefone_cliente) {
        await sendWhatsAppNotification(payload.telefone_cliente, `🚚 *Sua entrega (${payload.ordem_servico_id}) saiu para rota!* Motorista: ${payload.motorista_nome || 'em deslocamento'}.`);
      }
      break;
    }

    case 'corrida.fila_aberta': {
      const msg = `📢 *NOVA CORRIDA NA FILA DA COOPERATIVA*\n` +
        `OS: ${payload.ordem_servico_id}\n` +
        `Frota: ${payload.fleet_type || 'Geral'}\n` +
        `Origem: ${payload.origem || '-'}\n` +
        `Valor estimado: R$ ${Number(payload.valor || 0).toFixed(2)}\n` +
        `Abra o app Navigator para aceitar.`;
      if (payload.telefone_notificacao) {
        await sendWhatsAppNotification(payload.telefone_notificacao, msg);
      }
      break;
    }

    case 'corrida.concluida': {
      const msg = `✅ *ENTREGA CONCLUÍDA COM SUCESSO*\n` +
        `OS: ${payload.ordem_servico_id}\n` +
        `Comprovante registrado às ${new Date().toLocaleTimeString('pt-BR')}.`;
      if (payload.telefone_cliente) {
        await sendWhatsAppNotification(payload.telefone_cliente, msg);
      }
      break;
    }

    case 'corrida.problema': {
      const msg = `⚠️ *OCORRÊNCIA NA ENTREGA*\n` +
        `OS: ${payload.ordem_servico_id}\n` +
        `Motivo: ${payload.motivo || 'Não especificado'}`;
      if (payload.telefone_cliente) {
        await sendWhatsAppNotification(payload.telefone_cliente, msg);
      }
      if (payload.telefone_gestor) {
        await sendWhatsAppNotification(payload.telefone_gestor, msg);
      }
      break;
    }

    case 'corrida.cancelada': {
      const msg = `❌ *PEDIDO CANCELADO*\nOS: ${payload.ordem_servico_id}\nMotivo: ${payload.motivo || 'Cancelado'}`;
      if (payload.telefone_notificacao) {
        await sendWhatsAppNotification(payload.telefone_notificacao, msg);
      }
      break;
    }

    default:
      fastify.log.info({ eventType }, 'Evento recebido sem ação específica de WhatsApp');
  }

  return reply.code(200).send({
    status: 'processed',
    event_id: event.event_id || idempotencyKey,
    idempotency_key: idempotencyKey
  });
});

async function start() {
  try {
    await fastify.listen({ port: PORT, host: HOST });
    fastify.log.info(`Bridge WhatsApp escutando em http://${HOST}:${PORT}`);
  } catch (err) {
    fastify.log.error(err);
    process.exit(1);
  }
}

start();
