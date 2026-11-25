# 04-SPEC-KIT.md — Kit de Especificação e Contratos Técnicos

**Projeto:** Hermes Logística & Olho Vivo (Fleetbase + Navigator + LiveKit PTT/Vision)
**Versão:** 1.0 — 18/11/2026
**Status:** DRAFT — não aprovado
**Host de referência:** `hermes-prod` (156.67.31.108)
**Documentos relacionados:** `01-BRD.md` · `02-PRD.md` · `03-ARCHITECTURE-ADR.md`

> **Trava vigente:** nada deste kit foi implantado. Este documento define **o que** construir e **como** os 3 agentes divide o trabalho, não **quando** subir. A ordem de subida é o §10 do ADR (F0→F5), com o gate **F1-VAL-001** como entrada obrigatória.

---

## 0. Como este kit funciona

Este kit é o **contrato de engenharia** do projeto. Ele existe para resolver 4 problemas concretos:

1. **Conflito entre agentes** — Claude Code, OpenCode e Gemini vão trabalhar no mesmo repositório. A divisão de diretórios (§1) garante que **nenhum par de arquivos é editado por dois agentes**.
2. **Contrato de dados** — telemetria, webhooks e comandos de rádio precisam ter **shape fixo**, senão cada agente inventa o seu e o quebra na integração.
3. **Reprodutibilidade** — o compose, o `livekit.yaml` e o nginx estão **escritos aqui**, não improvisados no deploy.
4. **Rastreabilidade** — cada AC (critério de aceite) tem task e teste anotado (`@spec:AC-xxx`), seguindo a gramática da casa (`spec.md` → `tasks.md` → `audit --ci`).

**Regra de leitura:** quem implementa, **lê este arquivo inteiro** antes de escrever a primeira linha de código. Quem revisa, confere contra o §10 (matriz de testes) e §11 (DoR/DoD).

---

## 1. Regra de ouro: quem mexe em quê

### 1.1 Tabela de ownership (1 arquivo = 1 dono, sem exceção)

| Diretório | Conteúdo | **Dono único** | Git branch | Nunca tocado por |
|---|---|---|---|---|
| `/infra/` | compose, livekit.yaml, coturn, nginx, scripts, `.env.shared*` | **Claude Code** | `feat/infra` | OpenCode, Gemini |
| `/mobile-navigator/` | app React Native (fork do Navigator) | **OpenCode** | `feat/navigator` | Claude Code, Gemini |
| `/web-radio-panel/` | painel web de rádio/câmera (fase 2) | **OpenCode** | `feat/radio-panel` | Claude Code, Gemini |
| `/integrations/` | `bridge-whatsapp/`, `contracts/`, regras de negócio | **Gemini** | `feat/integrations` | Claude Code, OpenCode |
| `/docs/` | este dossiê | **Claude Code** (Isaías decide) | `docs/` | OpenCode, Gemini |
| `/tests/` | testes de integração **entre** serviços | **Claude Code** (orquestra) | `test/contract` | OpenCode, Gemini |

### 1.2 Exceções e regras de desempate

1. **`/integrations/contracts/` é fonte única dos payloads.** O Gemini é o dono e **publica** os JSON Schema. Nenhum outro agente reescreve schema — se precisar de campo novo, **pede** ao Gemini (issue no kanban) e consome a versão nova. Isso elimina a classe inteira de "cada um inventou um campo".
2. **`.env.shared` só o Claude Code edita.** OpenCode e Gemini **leem**; se precisarem de uma var nova, **pedem**. Values **nunca** vão para o repo (ver §3).
3. **`/web-radio-panel` é do OpenCode**, junto com o app, porque os dois são TypeScript/React e compartilham o **mesmo** pacote de contratos (`@fleetbase/contracts` — workspace local). Isso evita duplicar o cliente DataChannel.
4. **Nenhum agente edita `/docs/`**. Correção de doc → PR de volta para o dono da doc.
5. **Nenhum agente mexe em `docker-compose.yml` na raiz** — só `/infra/docker/compose.base.yml` existe, e é do Claude Code.
6. **Conflito de contrato** (ex.: Gemini precisa de campo que o OpenCode já consumiu com outro nome) → **Claude Code decide** (é o orquestrador), e a decisão vira **versão nova do schema** (`schema_version`).

### 1.3 Execução paralela — como abrir

```bash
# Cada agente trabalha em worktree próprio, com branch próprio.
# Nenhum comando git é executado por outro agente no mesmo worktree.

git worktree add ../wt-navigator  -b feat/navigator
git worktree add ../wt-panel     -b feat/radio-panel
git worktree add ../wt-integrations -b feat/integrations
git worktree add ../wt-infra      -b feat/infra

# A branch principal (main) só recebe merge do orquestrador, na ordem do §9.
```

**Regra de merge:** `feat/integrations` → `feat/infra` → `feat/navigator` + `feat/radio-panel` → `main`. Motivo: o core e os contratos são consumidos pelos dois lados.

---

## 2. Estrutura de diretórios

```
/opt/hermes-fleetbase/
├── docs/                                # este dossiê (leitura)
│   ├── 01-BRD.md
│   ├── 02-PRD.md
│   ├── 03-ARCHITECTURE-ADR.md
│   └── 04-SPEC-KIT.md
│
├── infra/                               # DONO: Claude Code
│   ├── docker/
│   │   ├── compose.base.yml             # core + mídia, com limits e profiles
│   │   ├── compose.routers.yml          # VROOM (fase 2) — profile 'router'
│   │   ├── compose.f1.yml               # stack isolada do gate F1 (api + redis)
│   │   ├── compose.f1.planb.yml         # OVERRIDE do Plano B: MySQL 8, profile 'fallback-mysql'
│   │   ├── livekit/livekit.yaml         # config do livekit-server
│   │   ├── coturn/turnserver.conf       # config do coturn
│   │   └── nginx/fleetbase.conf         # server blocks
│   ├── env/
│   │   ├── .env.shared                  # SÓ NOMES das vars (git-ignored)
│   │   ├── .env.shared.example          # mesma lista, vazia (versionado)
│   │   ├── fleetbase.env.example        # vars do container api (versionado)
│   │   └── fleetbase.mysql.env          # vars do Plano B (git-ignored, chmod 600)
│   └── scripts/
│       ├── preflight.sh                 # checklist read-only (ADR §11)
│       ├── db-bootstrap.sh              # cria os 3 schemas+user no MySQL 8 (Plano B)
│       ├── gate-f1-val-001.sh           # executa o gate (migrate em processo único)
│       └── smoke.sh                     # health de todos os serviços
│
├── mobile-navigator/                    # DONO: OpenCode
│   ├── src/
│   │   ├── modules/
│   │   │   ├── geo/                     # wrapper react-native-geolocation-service
│   │   │   ├── radio/                   # LiveKit: PTT, beep, ducking
│   │   │   ├── vision/                  # Olho Vivo: câmera on-demand
│   │   │   ├── tts/                     # react-native-tts
│   │   │   └── tracking/                # buffer offline (SQLite/MMKV)
│   │   ├── screens/
│   │   └── fleetbase.config.json        # aponta p/ o core
│   ├── android/app/src/main/AndroidManifest.xml   # permissões foreground
│   └── package.json
│
├── web-radio-panel/                     # DONO: OpenCode (fase 2)
│   ├── src/
│   │   ├── components/PttPanel.tsx
│   │   ├── components/VisionPanel.tsx
│   │   ├── hooks/useLiveKitRoom.ts
│   │   └── pages/  (frota, sala, sessão)
│   └── package.json
│
├── integrations/                        # DONO: Gemini
│   ├── contracts/                       # FONTE ÚNICA dos schemas
│   │   ├── envelope.schema.json
│   │   ├── telemetria.schema.json
│   │   ├── webhook-operacional.schema.json
│   │   ├── dvir.schema.json
│   │   ├── datachannel.schema.json
│   │   ├── livekit-token.claims.json
│   │   └── index.ts                     # exporta os tipos
│   ├── bridge-whatsapp/
│   │   ├── src/adapters/evolution-go.ts
│   │   ├── src/routes/webhooks.ts
│   │   ├── src/routes/evolution-callback.ts
│   │   ├── src/rules/ (desvio.ts, parada.ts, dwell.ts, alerta.ts)
│   │   ├── src/tracking/token.ts        # link assinado + TTL
│   │   └── src/queue/ (retry + idempotência)
│   └── package.json
│
└── tests/                               # DONO: Claude Code (orquestra)
    ├── contract/                        # testes de contrato entre serviços
    │   ├── envelope.contract.test.ts
    │   ├── webhook-operacional.contract.test.ts
    │   └── datachannel.contract.test.ts
    └── e2e/
```

---

## 3. `.env.shared` — nomes de variáveis (nunca valores)

> 🔒 **Regra do cofre:** este arquivo **no repo** tem **apenas nomes**. Os **valores** vivem em `~/claudinho-secrets/fleetbase.env` (chmod 600) e são injetados no deploy por `docker compose --env-file`. **Nunca** escrever valor de chave em arquivo versionado, no log ou em mensagem.

### 3.1 `.env.shared.example` (versionado — só nomes)

```bash
# ─── CORE (Fleetbase) ───────────────────────────────────────────────
APP_ENV=production
APP_NAME=
APP_KEY=                      # do cofre
APP_URL=
DATABASE_URL=                 # mysql://... (Plano B — ATIVO desde 18/11/2026)
DB_CONNECTION=mysql           # o core do Fleetbase só define a conexão 'mysql'
DB_HOST=DB_PORT=DB_DATABASE=DB_USERNAME=DB_PASSWORD=
MEM_LIMIT_MYSQL=640m          # ADR-002 / ADR-024 (MySQL 8 fallback)
REDIS_URL=
CACHE_DRIVER=redis
QUEUE_CONNECTION=redis
BROADCAST_DRIVER=socketcluster
SESSION_DOMAIN=
CACHE_PATH=

# ─── SOCKETCLUSTER ───────────────────────────────────────────────────
SOCKETCLUSTER_AUTH_ENABLED=true
SOCKETCLUSTER_AUTH_KEY=
SOCKETCLUSTER_PUBLISH_URL=http://socket:8001
SOCKETCLUSTER_AUTHORIZE_URL=http://api:8000/int/v1/socket/authorize
SOCKETCLUSTER_ORIGIN=
SOCKETCLUSTER_OPTIONS=

# ─── LIVEKIT / MÍDIA ─────────────────────────────────────────────────
LIVEKIT_URL=wss://livekit.automacaojs.us
LIVEKIT_API_KEY=
LIVEKIT_API_SECRET=
LIVEKIT_TURN_SECRET=
LIVEKIT_TURN_DOMAIN=
TURN_EXTERNAL_IP=          # IP público do host que roda o Coturn (muda na virada pra VPS-2)
LIVEKIT_TURN_UDP_PORT=3478
LIVEKIT_TURN_TCP_PORT=5349
LIVEKIT_RELAY_MIN_PORT=49160
LIVEKIT_RELAY_MAX_PORT=49260
LIVEKIT_RTC_UDP_PORT=7882
LIVEKIT_RTC_TCP_PORT=7881
LIVEKIT_ROOM_PADRAO=radio-frota-geral

# ─── PLANO DE MÍDIA / VPS-2 (ADR-016 · §12.3 do ADR) ─────────────────
# Tudo que aponta para o host de mídia vive aqui. Na virada pra VPS-2:
# muda só o valor destas variáveis + DNS + firewall. Nenhum código muda.
LIVEKIT_HOST=livekit.automacaojs.us
RADIO_PUBLIC_URL=https://frota.automacaojs.us   # Painel Web/PTT Frota (radio.automacaojs.us preservado para Rádio Devocional 12)
RADIO_LOUVOR_URL=            # vazio = mesmo host do rádio principal

# ─── TENANT / FUSO (ADR-018) ─────────────────────────────────────────
TENANT_DEFAULT_TIMEZONE=America/Sao_Paulo   # IANA; Honduras = America/Tegucigalpa

# ─── WHATSAPP / EVOLUTION GO ─────────────────────────────────────────
EVOLUTION_URL=http://host.docker.internal:8096
EVOLUTION_INSTANCE=
EVOLUTION_API_KEY=
BRIDGE_URL=
BRIDGE_PORT=8600
WEBHOOK_HMAC_SECRET=
BRIDGE_QUEUE_DRIVER=redis
BRIDGE_RETRY_MAX=5

# ─── ROTEAMENTO (T-4, zero-custo) ───────────────────────────────────
ROUTER_URL=https://routing.openstreetmap.de/routed-car/route/v1/driving/
OSRM_HOST=https://router.project-osrm.org
VROOM_URL=http://vroom:5000
MAPS_TILE_URL=https://tile.openstreetmap.org/{z}/{x}/{y}.png
MAPS_USER_AGENT=

# ─── LINK DE RASTREIO ────────────────────────────────────────────────
TRACKING_BASE_URL=https://track.automacaojs.us
TRACKING_TTL_SECONDS=21600
TRACKING_SIGNING_KEY=

# ─── MONITORAMENTO ───────────────────────────────────────────────────
NTFY_URL=http://ntfy:8088
NTFY_TOPIC=
LOG_LEVEL=info
LOG_FORMAT=json
HEALTHCHECK_INTERVAL=30s

# ─── LIMITES (espelham o ADR §6.2) ──────────────────────────────────
MEM_LIMIT_API=1024m
MEM_LIMIT_QUEUE=512m
MEM_LIMIT_SCHEDULER=256m
MEM_LIMIT_SOCKET=256m
MEM_LIMIT_REDIS=160m
MEM_LIMIT_LIVEKIT=512m
MEM_LIMIT_COTURN=192m
MEM_LIMIT_PANEL=256m
MEM_LIMIT_BRIDGE=192m
```

### 3.2 `.env.shared` (git-ignored) — mesma lista, com valores do cofre

Gerado por:

```bash
install -m 600 ~/claudinho-secrets/fleetbase.env \
  /opt/hermes-fleetbase/infra/env/.env.shared
```

E o `.gitignore` da raiz **precisa** conter:

```
infra/env/.env.shared
infra/env/*.env
!**/env/*.env.example
```

### 3.3 `fleetbase.env.example` (o que o container `api` consome)

```bash
ENVIRONMENT=production
APP_NAME=Fleetbase
APP_KEY=
APP_URL=https://fleetbase.automacaojs.us
DATABASE_URL=
QUEUE_CONNECTION=redis
CACHE_DRIVER=redis
CACHE_PATH=/fleetbase/api/storage/framework/cache
CACHE_URL=tcp://cache
REDIS_URL=tcp://cache
BROADCAST_DRIVER=socketcluster
MAIL_FROM_NAME=Fleetbase
LOG_CHANNEL=daily
REGISTRY_HOST=https://registry.fleetbase.io
REGISTRY_PREINSTALLED_EXTENSIONS=true
OSRM_HOST=https://router.project-osrm.org
ROUTER_URL=
SESSION_DOMAIN=fleetbase.automacaojs.us
```

---

## 4. Contratos de dados

### 4.1 Envelope comum (obrigatório em **todo** payload)

```jsonc
{
  "event_id": "9f3c1e5a-6b2d-4c1e-9a77-2f0b8d5e4a11",   // uuid v4 — chave de deduplicação na origem
  "event_type": "telemetria.position.batch",              // snake_case, ver §4.2
  "schema_version": "1.0",                                // major.minor do payload
  "occurred_at": "2026-11-18T15:04:05Z",                  // SEMPRE UTC (RFC3339, sufixo Z)
  "received_at": "2026-11-18T15:04:07Z",                  // preenchido pelo receptor
  "correlation_id": "c71a...-...",                        // encadeia o ciclo (app → api → bridge → whatsapp)
  "idempotency_key": "b9a1f0c2...",                       // sha256 do conteúdo canônico
  "tenant": { "id": "ten_...", "slug": "..." },
  "actor":  { "type": "motorista|gestor|sistema|app", "id": "..." },
  "subject":{ "type": "veiculo|ordem_de_servico|turno|motorista", "id": "..." },
  "payload": { /* específico do event_type */ }
}
```

**Regras do envelope**

| Regra | Detalhe |
|---|---|
| `occurred_at` | **sempre UTC com `Z`**. OBRIGATÓRIO o `Z` — sem ele, o parse quebra (bug histórico cross-post BRT→UTC). |
| `idempotency_key` | `sha256(event_type + subject.id + occurred_at + payload_hash)`. **Mesmo evento reenviado = mesma chave.** |
| `correlation_id` | Gerado **uma vez** na origem (app) e propagado. |
| `schema_version` | Minor **sobe** quando só **adiciona** campo (retrocompatível). Major sobe quando **quebra**. |
| Campos desconhecidos | O receptor **deve ignorar**. Isso é o que permite os 3 agentes subirem em paralelo. |

### 4.2 Tabela de `event_type`

| `event_type` | Emissor | Consumidor | Versão |
|---|---|---|---|
| `telemetria.position.batch` | App → API | API (Fleetbase) | 1.0 |
| `telemetria.offline.flush` | App → API | API | 1.0 |
| `desvio.detectado` | API → Bridge | Bridge → WhatsApp | 1.0 |
| `parada.prolongada` | API → Bridge | Bridge → WhatsApp | 1.0 |
| `carga.descarga.concluida` | API → Bridge | Bridge → WhatsApp | 1.0 |
| `dvir.registrada` | API → Bridge | Bridge → WhatsApp | 1.0 |
| `alerta.operacional` | API → Bridge | Bridge → WhatsApp | 1.0 |
| `link_rastreio.solicitado` | API → Bridge | Bridge → Evolution GO | 1.0 |
| `link_rastreio.revogado` | API → Bridge | Bridge | 1.0 |
| `whatsapp.entrega.status` | Bridge → Evolution GO | Bridge → API | 1.0 |
| `whatsapp.leitura.status` | Bridge → Evolution GO | Bridge → API | 1.0 |
| `sessao_video.solicitada` | Painel → API → App | Todos | 1.0 |
| `sessao_video.expirada` | API → Painel | Todos | 1.0 |

---

## 5. Payloads (JSON canônicos)

> Este bloco é a **fonte de verdade** do formato. O Gemini vai transformar cada bloco em `JSON Schema` em `/integrations/contracts/` — o schema é **derivado** daqui, nunca o contrário.

### 5.1 `telemetria.position.batch`

```jsonc
{
  "event_id": "uuid",
  "event_type": "telemetria.position.batch",
  "schema_version": "1.0",
  "occurred_at": "2026-11-18T15:04:05Z",
  "correlation_id": "uuid",
  "idempotency_key": "sha256hex",
  "tenant": { "id": "ten_...", "slug": "logistica-nordeste" },
  "actor": { "type": "motorista", "id": "mot_..." },
  "subject": { "type": "veiculo", "id": "veh_cav_meu_001" },
  "payload": {
    "ordem_servico_id": "os_8821",
    "turno_id": "turno_4417",
    "motorista_id": "mot_...",
    "batch_size": 42,
    "pontos": [
      {
        "ts": "2026-11-18T15:03:41Z",
        "lat": -5.7945123,
        "lon": -35.2084567,
        "speed_kph": 62.4,
        "heading_deg": 187.2,
        "accuracy_m": 12.0,
        "altitude_m": 18.0,
        "battery_pct": 74,
        "battery_charging": false,
        "network_type": "4g",
        "source": "gps",
        "flags": {
          "harsh_brake": false,
          "harsh_accel": false,
          "towing": true,
          "offline_buffered": false
        }
      }
    ]
  }
}
```

**Regras de telemetria**

- Lote a cada **30 s** com buffer local; em plano de fundo a cada **60 s**; parado (**> 5 min** sem movimento) → **não enviar** (economiza bateria, NF-01).
- Offline: o app acumula em **SQLite local** e faz `flush` quando volta a rede (`telemetria.offline.flush`, com `payload.offline_buffered: true` nos pontos).
- `lat`/`lon` com **6 casas** (~11 cm) e `speed_kph` com 1 casa. `heading_deg` 0–359,9.
- `ts` de cada ponto é **UTC com `Z`**; o app guarda o fuso só para exibição.
- `battery_pct` inteiro 0–100; `battery_charging` booleano (o app sabe se está carregando).

### 5.2 `desvio.detectado`

```jsonc
{
  "event_type": "desvio.detectado",
  "occurred_at": "2026-11-18T15:22:10Z",
  "correlation_id": "uuid",
  "idempotency_key": "sha256hex",
  "tenant": { "id": "ten_...", "slug": "..." },
  "subject": { "type": "ordem_de_servico", "id": "os_8821" },
  "payload": {
    "ordem_servico_id": "os_8821",
    "veiculo_id": "veh_cav_meu_001",
    "motorista_id": "mot_...",
    "desvio_id": "des_551",
    "ponto_referencia": { "lat": -5.8001, "lon": -35.1999, "descricao": "Trevo da BR-101" },
    "deslocamento_m": 850,
    "tolerancia_m": 200,
    "duracao_s": 420,
    "velocidade_media_kph": 4.1,
    "situacao": "parado_em_movimento",
    "notificado": false
  }
}
```

### 5.3 `parada.prolongada`

```jsonc
{
  "event_type": "parada.prolongada",
  "occurred_at": "2026-11-18T16:40:00Z",
  "correlation_id": "uuid",
  "idempotency_key": "sha256hex",
  "subject": { "type": "ordem_de_servico", "id": "os_8821" },
  "payload": {
    "ordem_servico_id": "os_8821",
    "veiculo_id": "veh_cav_meu_001",
    "parada_id": "par_993",
    "inicio": "2026-11-18T16:10:00Z",
    "fim": "2026-11-18T16:40:00Z",
    "duracao_s": 1800,
    "limiar_s": 900,
    "local": {
      "lat": -5.7798, "lon": -35.2001,
      "endereco": "Av. João XXIII, Lagoa Seca, Natal/RN",
      "endereco_fonte": "nominatim"
    },
    "motivo_declarado": "espera da carga",
    "motorista_confirmou": true
  }
}
```

### 5.4 `carga.descarga.concluida`

```jsonc
{
  "event_type": "carga.descarga.concluida",
  "occurred_at": "2026-11-18T18:02:00Z",
  "correlation_id": "uuid",
  "idempotency_key": "sha256hex",
  "subject": { "type": "ordem_de_servico", "id": "os_8821" },
  "payload": {
    "ordem_servico_id": "os_8821",
    "veiculo_id": "veh_cav_meu_001",
    "etapa": "carga",                       // "carga" | "descarga"
    "ponto_id": "ptc_441",
    "ponto_nome": "Terminal Portuário do Pecém",
    "inicio": "2026-11-18T17:32:00Z",
    "fim": "2026-11-18T18:02:00Z",
    "duracao_s": 1800,
    "dwell_time_s": 1800,
    "chave_documento": "CTe-881233",
    "observacao": "",
    "foto_url": "https://fleetbase.automacaojs.us/api/files/..."
  }
}
```

### 5.5 `dvir.registrada`

```jsonc
{
  "event_type": "dvir.registrada",
  "occurred_at": "2026-11-18T05:55:00Z",
  "correlation_id": "uuid",
  "idempotency_key": "sha256hex",
  "subject": { "type": "ordem_de_servico", "id": "os_8821" },
  "payload": {
    "dvir_id": "dvir_7781",
    "ordem_servico_id": "os_8821",
    "veiculo_id": "veh_cav_meu_001",
    "motorista_id": "mot_...",
    "resultado": "aprovado_com_observacao",   // aprovado | aprovado_com_observacao | reprovado
    "itens": [
      {
        "codigo": "PNEU-01",
        "categoria": "pneu",
        "aprovado": false,
        "gravidade": "media",                  // baixa | media | alta
        "observacao": "desgaste irregular no eixo dianteiro direito",
        "foto_url": "https://fleetbase.automacaojs.us/api/files/..."
      }
    ],
    "assinatura_motorista": true,
    "assinatura_gestor": false,
    "bloqueia_saida": false
  }
}
```

### 5.6 `link_rastreio.solicitado`

```jsonc
{
  "event_type": "link_rastreio.solicitado",
  "occurred_at": "2026-11-18T17:00:00Z",
  "correlation_id": "uuid",
  "idempotency_key": "sha256hex",
  "subject": { "type": "ordem_de_servico", "id": "os_8821" },
  "payload": {
    "link_id": "lnk_441",
    "ordem_servico_id": "os_8821",
    "veiculo_id": "veh_cav_meu_001",
    "destinatario": {
      "nome": "Transportadora XYZ",
      "telefone": "+55849996327329",
      "canal": "whatsapp"
    },
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "url": "https://track.automacaojs.us/r/eyJhbGciOiJIUzI1NiIs...",
    "expira_em": "2026-11-18T23:00:00Z",
    "ttl_s": 21600,
    "escopo": ["posicao", "paradas", "eta"],
    "revogavel": true
  }
}
```

> 🔒 O `token` é **JWT HS256** assinado com `TRACKING_SIGNING_KEY`, com `exp`, `sub=tenant`, `aud=ordem_de_servico` e `scope`. **Não** embute telefone nem nome do motorista no payload do link.

### 5.7 `sessao_video.solicitada` / `sessao_video.expirada`

```jsonc
{
  "event_type": "sessao_video.solicitada",
  "occurred_at": "2026-11-18T19:12:00Z",
  "correlation_id": "uuid",
  "idempotency_key": "sha256hex",
  "subject": { "type": "veiculo", "id": "veh_cav_meu_001" },
  "payload": {
    "sessao_id": "sess_9901",
    "sala": "radio-frota-geral",
    "solicitante": { "type": "gestor", "id": "usr_..." },
    "motivo": "chegada no ponto de carga",
    "inicio": "2026-11-18T19:12:00Z",
    "expira_em": "2026-11-18T19:22:00Z",
    "duracao_s": 600,
    "video": { "enabled": true, "resolucao": "480p", "fps": 15, "facing": "back" },
    "audio": { "enabled": false }
  }
}
```

### 5.8 Contrato de envio ao Bridge (Fleetbase → Bridge)

```http
POST /v1/events HTTP/1.1
Host: bridge-whatsapp:8600
Content-Type: application/json
X-Fleetbase-Signature: sha256=<hmac_sha256_do_corpo>
X-Fleetbase-Event: desvio.detectado
X-Fleetbase-Delivery: 9f3c1e5a-6b2d-4c1e-9a77-2f0b8d5e4a11
X-Fleetbase-Timestamp: 2026-11-18T15:22:10Z
Idempotency-Key: b9a1f0c2...
```

- **HMAC**: `sha256(corpo bruto)` com `WEBHOOK_HMAC_SECRET`, comparado em **tempo constante**. Rejeitar se abs(ts) > **300 s** (anti-replay).
- **Retry**: o core reenvia em `5s, 30s, 2min, 10min, 1h` (5 tentativas), com **backoff exponencial + jitter**. O bridge responde `200` mesmo se a mensagem do WhatsApp falhar (o erro fica na fila interna) — senão o core fica reenviando.
- **Idempotência no bridge**: `idempotency_key` já visto → responde `200` com `{"status":"duplicate"}` e **não reenvia** no WhatsApp.

### 5.9 Bridge → Evolution GO (envio de WhatsApp)

```http
POST /message/sendText/{instance}
Content-Type: application/json
apikey: $EVOLUTION_API_KEY

{
  "to": "55849996327329",
  "type": "text",
  "text": "🚚 Rota OS-8821 atualizada.\nLink de rastreio (válido por 6h): https://track.automacaojs.us/r/...",
  "options": { "delay": 120, "linkPreview": false }
}
```

> A Evolution GO **não** é exposta publicamente. Só o bridge fala com ela (`host.docker.internal:8096`).

### 5.10 Resposta da Evolution (callback → Bridge → API)

```jsonc
{
  "event_type": "whatsapp.entrega.status",
  "occurred_at": "2026-11-18T19:13:02Z",
  "correlation_id": "uuid",
  "idempotency_key": "sha256hex",
  "subject": { "type": "ordem_de_servico", "id": "os_8821" },
  "payload": {
    "message_id": "BAE5F0A9",
    "instance": "fluxo-logistica",
    "telefone": "55849996327329",
    "status": "delivered",              // queued | sent | delivered | read | failed
    "erro": null,
    "link_id": "lnk_441"
  }
}
```

---

## 6. Contrato LiveKit (DataChannel + token)

### 6.1 DataChannel — **formato exato exigido pela T-5**

Mensagens **texto** (não binárias), UTF-8, no DataChannel `fleetbase-control` (criado pelo cliente com `ordered: true, reliable: true`).

**Comando de câmera (shape FIXO — não mudar):**

```json
{"action":"stream_video","state":true,"facing":"back"}
```

| Chave | Tipo | Valores | Regra |
|---|---|---|---|
| `action` | string | `stream_video` | **obrigatória** |
| `state` | boolean | `true` \| `false` | **obrigatória** — liga/desliga a câmera |
| `facing` | string | `front` \| `back` | **obrigatória** — cabine (front) ou estrada (back) |

`state:false` → **ignora** `facing` (câmera desliga de qualquer jeito).

**Demais comandos (mesmo estilo flat):**

```jsonc
{"action":"ptt","state":true}                 // abre o microfone (PTT)
{"action":"ptt","state":false}                // fecha o microfone
{"action":"tts","text":"Carga concluída em Pecém","lang":"pt-BR"}
{"action":"geo_share","state":true}            // liga/desliga envio de posição
{"action":"hello","app_version":"1.0.0","device":"moto-g84"}
{"action":"ack","ref":"<id-da-comando>","ok":true,"error":null}
```

**Regras do canal**

1. O **`stream_video` só é aceito se** o servidor LiveKit ** concedeu permissão de publicar vídeo** ao participante naquele momento (token ou `UpdateParticipant` do servidor). Cliente que receber `stream_video` sem permissão **responde `ack{ok:false,error:"sem_permissao"}`** e **não** liga a câmera.
2. Toda resposta do app a um comando é um `ack` com `ref` = `id` do comando recebido (quando houver) ou `event_id` do comando.
3. Campos **desconhecidos** no comando são **ignorados** (permite evoluir sem quebrar app antigo).
4. O comando **nunca** vem por WhatsApp — só pelo painel ou pelo core.

### 6.2 Token LiveKit (claims)

```jsonc
{
  "iss": "livekit",
  "sub": "veh_cav_meu_001",                   // o VEÍCULO é o participante (1 veículo = 1 participante)
  "nbf": 1763474000,
  "exp": 1763474900,                          // TTL 15 min, renovável
  "video": {
    "room": "radio-frota-geral",
    "roomJoin": true,
    "canPublish": true,                       // concede a capacidade; o CLIENTE decide o que liga
    "canSubscribe": true,
    "canPublishData": true,
    "canPublishAudio": true
  },
  "metadata": "{\"tenant_id\":\"ten_...\",\"vehicle_id\":\"veh_cav_meu_001\",\"role\":\"motorista\",\"os_id\":\"os_8821\"}"
}
```

**Modelo de permissão (2 níveis):**

| Cenário | Token | O que o app faz |
|---|---|---|
| **Padrão (98 % do tempo)** | `canPublish: true`, sem sessão de vídeo aberta | conecta com `mic:false` e `câmera:false`; só o **DataChannel** comanda; PTT liga o mic por ≤ 30 s |
| **Olho Vivo ativo** | idem + `metadata.sessao_id` + expiração | ao receber `stream_video{state:true}` → `setCameraEnabled(true)` a 480p/15fps |

> ⚠️ `canPublish:true` **não** significa "câmera ligada". O cliente **sempre** inicia com `setCameraEnabled(false)` e `setMicrophoneEnabled(false)`. Isso é o que garante a T-5 ("câmera **desligada** por padrão").

### 6.3 Sala `radio-frota-geral`

| Propriedade | Valor | Porquê |
|---|---|---|
| `empty_timeout` | 300 s | sala morre 5 min depois de vazia (economiza RAM) |
| `departure_timeout` | 60 s | desconexão não mata a sala na hora |
| `max_participants` | 50 | teto por frota |
| `enable_auto_create` | true | o app cria ao conectar (o app não é dono da sala) |
| Fixa | **não** é criada pelo painel | evita sala duplicada |

### 6.4 Encerramento da sessão de vídeo (TTL)

1. Ao abrir, o core grava `sessao_video.solicitada` com `expira_em` (padrão **10 min**, ADR-013).
2. Um job (core) a cada 60 s verifica sessões vencidas → emite `sessao_video.expirada`.
3. O core chama a API do LiveKit: `POST /twirp/livekit.RoomService/UpdateParticipant` com `permission.canPublish = false` e `permission.canPublishData` mantido.
4. O app **também** apaga a câmera sozinho quando `expira_em` passa (defesa em profundidade, mesmo com o app em background).

---

## 7. Docker Compose base (contrato de deploy)

> 📄 **Dono:** Claude Code. Fica em `/infra/docker/compose.base.yml`.
> 🔒 As senhas **nunca** ficam aqui — todas vêm de `${VAR}` do `.env.shared` (cofre).

### 7.1 `compose.base.yml`

```yaml
# /opt/hermes-fleetbase/infra/docker/compose.base.yml
# Uso:  docker compose -p fleetbase --env-file ../env/.env.shared -f compose.base.yml up -d
name: fleetbase

x-common: &common
  restart: unless-stopped
  logging:
    driver: json-file
    options: { max-size: "10m", max-file: "3" }
  security_opt: [ "no-new-privileges:true" ]
  networks: [ fleetbase_net ]

networks:
  fleetbase_net:
    name: fleetbase_net
    driver: bridge
# ─── PLANO A (Postgres do Supabase) DESCARTADO pelo gate F1-VAL-001 (18/11/2026):
# a imagem fleetbase/fleetbase-api:latest só tem pdo_mysql e o core só define a
# conexão 'mysql' ⇒ sem pgsql. Ver ADR §12.5.1. A rede supabase_default saiu
# do compose.

volumes:
  fleetbase_storage:
    name: fleetbase_storage
  fleetbase_socket_storage:
    name: fleetbase_socket_storage

services:

  # ─────────────────────────── CORE (AGPL) ───────────────────────────
  fleetbase-redis:
    <<: *common
    image: redis:7-alpine
    profiles: [ "core" ]
    command:
      - redis-server
      - --maxmemory
      - "96mb"
      - --maxmemory-policy
      - noeviction
      - --appendonly
      - "no"
    volumes: [ "fleetbase_redis:/data" ]
    healthcheck:
      test: [ "CMD", "redis-cli", "ping" ]
      interval: 10s
      timeout: 3s
      retries: 5
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_REDIS:-160m}, cpus: "0.30" }
        reservations: { memory: ${MEM_LIMIT_REDIS:-160m} }

  # ─────────────────────── BANCO (PLANO B · ADR-002/ADR-024) ─────────────
  fleetbase-mysql:
    <<: *common
    image: mysql:8.0
    profiles: [ "fallback-mysql" ]   # ← MUTUAMENTE EXCLUSIVO com "router" (VROOM)
    command:
      - --innodb-buffer-pool-size=128M
      - --performance-schema=OFF
      - --skip-log-bin
      - --max-connections=60
      - --character-set-server=utf8mb4
      - --collation-server=utf8mb4_unicode_ci
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD}
      MYSQL_DATABASE: ${MYSQL_DATABASE:-fleetbase_db}
      MYSQL_USER: ${MYSQL_USER:-fleetbase}
      MYSQL_PASSWORD: ${MYSQL_PASSWORD}
    healthcheck:
      test: [ "CMD-SHELL", "mysqladmin ping -h 127.0.0.1 -uroot -p\"$$MYSQL_ROOT_PASSWORD\" --silent" ]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 40s
    deploy:
      resources:
        limits:       { memory: ${MEM_LIMIT_MYSQL:-640m}, cpus: "0.50" }
        reservations: { memory: "320m" }

  fleetbase-api:
    <<: *common
    image: fleetbase/fleetbase-api:latest
    profiles: [ "core" ]
    env_file: [ "../env/fleetbase.env" ]
    environment:
      ENVIRONMENT: production
      DATABASE_URL: ${DATABASE_URL}
      DB_CONNECTION: mysql
      QUEUE_CONNECTION: redis
      CACHE_DRIVER: redis
      CACHE_URL: tcp://fleetbase-redis:6379
      REDIS_URL: tcp://fleetbase-redis:6379
      CACHE_PATH: /fleetbase/api/storage/framework/cache
      BROADCAST_DRIVER: socketcluster
      SOCKETCLUSTER_PUBLISH_URL: http://fleetbase-socket:8001
      SOCKETCLUSTER_AUTHORIZE_URL: http://fleetbase-api:8000/int/v1/socket/authorize
      SOCKETCLUSTER_AUTH_ENABLED: ${SOCKETCLUSTER_AUTH_ENABLED:-true}
      SOCKETCLUSTER_AUTH_KEY: ${SOCKETCLUSTER_AUTH_KEY}
      SOCKETCLUSTER_ORIGIN: ${SOCKETCLUSTER_ORIGIN}
      ROUTER_URL: ${ROUTER_URL}
      OSRM_HOST: ${OSRM_HOST}
      LOG_CHANNEL: daily
      APP_URL: ${APP_URL}
    volumes:
      - "fleetbase_storage:/fleetbase/api/storage/app"
    ports:
      - "127.0.0.1:8000:8000"      # ← só local; nginx publica
    networks: [ fleetbase_net ]
    depends_on:
      fleetbase-redis:  { condition: service_healthy }
      fleetbase-queue: { condition: service_started }
    healthcheck:
      test: [ "CMD-SHELL", "curl -fsS http://localhost:8000/health || exit 1" ]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 40s
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_API:-1024m}, cpus: "1.50" }
        reservations: { memory: ${MEM_LIMIT_API:-1024m} }

  fleetbase-queue:
    <<: *common
    image: fleetbase/fleetbase-api:latest
    profiles: [ "core" ]
    command: [ "php", "artisan", "queue:work", "--sleep=3", "--max-jobs=500", "--tries=3" ]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      QUEUE_CONNECTION: redis
      CACHE_DRIVER: redis
      CACHE_URL: tcp://fleetbase-redis:6379
      REDIS_URL: tcp://fleetbase-redis:6379
      CACHE_PATH: /fleetbase/api/storage/framework/cache
      BROADCAST_DRIVER: socketcluster
      SOCKETCLUSTER_PUBLISH_URL: http://fleetbase-socket:8001
      SOCKETCLUSTER_AUTH_ENABLED: ${SOCKETCLUSTER_AUTH_ENABLED:-true}
      SOCKETCLUSTER_AUTH_KEY: ${SOCKETCLUSTER_AUTH_KEY}
    volumes:
      - "fleetbase_storage:/fleetbase/api/storage/app"
    networks: [ fleetbase_net ]
    healthcheck:
      test: [ "CMD", "php", "artisan", "queue:status" ]
      interval: 30s
      timeout: 10s
      retries: 3
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_QUEUE:-512m}, cpus: "1.00" }
        reservations: { memory: ${MEM_LIMIT_QUEUE:-512m} }

  fleetbase-scheduler:
    <<: *common
    image: fleetbase/fleetbase-api:latest
    profiles: [ "core" ]
    command: [ "go-crond", "--verbose", "root:./crontab" ]
    environment:
      DATABASE_URL: ${DATABASE_URL}
      QUEUE_CONNECTION: redis
      CACHE_DRIVER: redis
      CACHE_URL: tcp://fleetbase-redis:6379
      REDIS_URL: tcp://fleetbase-redis:6379
      CACHE_PATH: /fleetbase/api/storage/framework/cache
      BROADCAST_DRIVER: socketcluster
      SOCKETCLUSTER_PUBLISH_URL: http://fleetbase-socket:8001
      SOCKETCLUSTER_AUTH_ENABLED: ${SOCKETCLUSTER_AUTH_ENABLED:-true}
      SOCKETCLUSTER_AUTH_KEY: ${SOCKETCLUSTER_AUTH_KEY}
    volumes:
      - "fleetbase_storage:/fleetbase/api/storage/app"
    networks: [ fleetbase_net ]
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_SCHEDULER:-256m}, cpus: "0.50" }
        reservations: { memory: ${MEM_LIMIT_SCHEDULER:-256m} }

  fleetbase-socket:
    <<: *common
    image: fleetbase/fleetbase-socket:latest
    profiles: [ "core" ]
    environment:
      SOCKETCLUSTER_AUTH_ENABLED: ${SOCKETCLUSTER_AUTH_ENABLED:-true}
      SOCKETCLUSTER_AUTH_KEY: ${SOCKETCLUSTER_AUTH_KEY}
      SOCKETCLUSTER_OPTIONS: ${SOCKETCLUSTER_OPTIONS}
      SOCKETCLUSTER_AUTHORIZE_URL: http://fleetbase-api:8000/int/v1/socket/authorize
    volumes:
      - "fleetbase_socket_storage:/socket/storage"
    ports:
      - "127.0.0.1:38000:8000"    # ← só local
    depends_on:
      fleetbase-api: { condition: service_started }
    healthcheck:
      test: [ "CMD-SHELL", "wget -qO- http://localhost:8000 >/dev/null || exit 1" ]
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_SOCKET:-256m}, cpus: "0.50" }
        reservations: { memory: ${MEM_LIMIT_SOCKET:-256m} }

  # ─────────────────────────── MÍDIA (PTT + Olho Vivo) ─────────────
  livekit:
    <<: *common
    image: livekit/livekit-server:v1.9.1
    profiles: [ "media" ]
    command: [ "--config", "/etc/livekit.yaml" ]
    environment:
      LIVEKIT_KEYS: "${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}"
      LIVEKIT_TURN_KEY: ${LIVEKIT_TURN_SECRET}
      LIVEKIT_TURN_DOMAIN: ${LIVEKIT_TURN_DOMAIN}
      LIVEKIT_TURN_UDP_PORT: ${LIVEKIT_TURN_UDP_PORT}
      LIVEKIT_TURN_TCP_PORT: ${LIVEKIT_TURN_TCP_PORT}
      LIVEKIT_RELAY_MIN_PORT: ${LIVEKIT_RELAY_MIN_PORT}
      LIVEKIT_RELAY_MAX_PORT: ${LIVEKIT_RELAY_MAX_PORT}
      LIVEKIT_RTC_UDP_PORT: ${LIVEKIT_RTC_UDP_PORT}
      LIVEKIT_RTC_TCP_PORT: ${LIVEKIT_RTC_TCP_PORT}
    volumes:
      - "./livekit/livekit.yaml:/etc/livekit.yaml:ro"
    ports:
      - "127.0.0.1:7880:7880"        # sinalização (WS) — via tunnel
      - "0.0.0.0:7881:7881/tcp"      # RTC/TCP — precisa ser público
      - "0.0.0.0:7882:7882/udp"      # mídia UDP
      - "0.0.0.0:7883:7883/udp"      # mídia UDP reserva
    healthcheck:
      test: [ "CMD-SHELL", "wget -qO- http://localhost:7880 >/dev/null || exit 1" ]
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_LIVEKIT:-512m}, cpus: "1.00" }
        reservations: { memory: ${MEM_LIMIT_LIVEKIT:-512m} }

  coturn:
    <<: *common
    image: coturn/coturn:4.6.3
    profiles: [ "media" ]
    command: [ "-c", "/etc/coturn/turnserver.conf" ]
    volumes:
      - "./coturn/turnserver.conf:/etc/coturn/turnserver.conf:ro"
    ports:
      - "0.0.0.0:3478:3478/tcp"
      - "0.0.0.0:3478:3478/udp"
      - "0.0.0.0:5349:5349/tcp"
      - "0.0.0.0:49160-49260:49160-49260/udp"     # relay — NÃO colide com 50000/udp
    healthcheck:
      test: [ "CMD-SHELL", "pidof coturn || exit 1" ]
      interval: 30s
      timeout: 5s
      retries: 3
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_COTURN:-192m}, cpus: "0.50" }
        reservations: { memory: ${MEM_LIMIT_COTURN:-192m} }

  # ─────────────────────── EXTENSÕES PROPRIETÁRIAS ───────────────────
  bridge-whatsapp:
    <<: *common
    build:
      context: ../../integrations/bridge-whatsapp
      dockerfile: Dockerfile
    profiles: [ "bridge" ]
    environment:
      EVOLUTION_URL: ${EVOLUTION_URL}
      EVOLUTION_INSTANCE: ${EVOLUTION_INSTANCE}
      EVOLUTION_API_KEY: ${EVOLUTION_API_KEY}
      WEBHOOK_HMAC_SECRET: ${WEBHOOK_HMAC_SECRET}
      BRIDGE_QUEUE_DRIVER: ${BRIDGE_QUEUE_DRIVER:-redis}
      REDIS_URL: tcp://fleetbase-redis:6379
      TRACKING_BASE_URL: ${TRACKING_BASE_URL}
      TRACKING_TTL_SECONDS: ${TRACKING_TTL_SECONDS:-21600}
      TRACKING_SIGNING_KEY: ${TRACKING_SIGNING_KEY}
      NTFY_URL: ${NTFY_URL}
      NTFY_TOPIC: ${NTFY_TOPIC}
    extra_hosts:
      - "host.docker.internal:host-gateway"
    ports:
      - "127.0.0.1:8600:8600"
    depends_on:
      fleetbase-redis: { condition: service_healthy }
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_BRIDGE:-192m}, cpus: "0.30" }
        reservations: { memory: ${MEM_LIMIT_BRIDGE:-192m} }

  web-radio-panel:
    <<: *common
    build:
      context: ../../web-radio-panel
      dockerfile: Dockerfile
    profiles: [ "panel" ]
    environment:
      LIVEKIT_URL: ${LIVEKIT_URL}
      LIVEKIT_API_KEY: ${LIVEKIT_API_KEY}
      LIVEKIT_API_SECRET: ${LIVEKIT_API_SECRET}
      APP_URL: ${APP_URL}
    ports:
      - "127.0.0.1:8601:8601"
    deploy:
      resources:
        limits:   { memory: ${MEM_LIMIT_PANEL:-256m}, cpus: "0.50" }
        reservations: { memory: ${MEM_LIMIT_PANEL:-256m} }
```

### 7.2 `compose.routers.yml` (fase 2 / fallback)

```yaml
# /opt/hermes-fleetbase/infra/docker/compose.routers.yml
name: fleetbase

services:
  # VROOM — fase 2 (ADR-004). Sem plano local de Valhalla (T-4).
  vroom:
    image: ghcr.io/gis-ops/docker-vroom:latest     # [A VERIFICAR] tag exata
    restart: unless-stopped
    profiles: [ "router" ]
    command: [ "-p", "5000" ]
    environment:
      - ROUTER_URL=${ROUTER_URL}
      - VROOM_LOG_LEVEL=warn
    ports:
      - "127.0.0.1:5000:5000"
    deploy:
      resources:
        limits:   { memory: "256m", cpus: "0.50" }
        reservations: { memory: "256m" }

  # MySQL — PLANO B do ADR-002 (só se F1-VAL-001 falhar)
  fleetbase-mysql:
    image: mysql:8.0-oracle
    restart: unless-stopped
    profiles: [ "fallback-mysql" ]
    command: [ "mysqld", "--skip-log-bin", "--innodb-buffer-pool-size=128M",
               "--performance-schema=OFF", "--max-connections=50" ]
    environment:
      MYSQL_ALLOW_EMPTY_PASSWORD: "no"
      MYSQL_DATABASE: fleetbase
      MYSQL_USER: fleetbase
      MYSQL_PASSWORD: ${DB_PASSWORD}
      MYSQL_ROOT_PASSWORD: ${DB_ROOT_PASSWORD}
    volumes:
      - "fleetbase_mysql:/var/lib/mysql"
    ports:
      - "127.0.0.1:3307:3306"     # ← portaAlternativa, 3306 pode estar usada
    healthcheck:
      test: [ "CMD", "mysqladmin", "ping", "-h", "localhost" ]
      interval: 10s
      timeout: 5s
      retries: 5
    deploy:
      resources:
        limits:   { memory: "640m", cpus: "0.50" }
        reservations: { memory: "640m" }

networks:
  fleetbase_net:
    name: fleetbase_net
    external: true

volumes:
  fleetbase_mysql:
    name: fleetbase_mysql
```

### 7.3 Comandos oficiais (os **únicos** permitidos)

```bash
cd /opt/hermes-fleetbase/infra/docker

# subir só o core
docker compose -p fleetbase --env-file ../env/.env.shared \
  -f compose.base.yml --profile core up -d

# subir core + mídia
docker compose -p fleetbase --env-file ../env/.env.shared \
  -f compose.base.yml --profile core --profile media up -d

# checar RAM real (deve caber no teto do ADR §6)
docker stats --no-stream --format 'table {{.Name}}\t{{.MemUsage}}\t{{.MemPerc}}' \
  | grep fleetbase

# parar (nunca 'rm' sem o gate)
docker compose -p fleetbase -f compose.base.yml down
```

> ⛔ **Proibido:** `docker compose down -v` (apaga o volume), `docker system prune -a` (apaga imagens de outros projetos), `docker rm -f` no stack.

---

## 8. Configuração da mídia

### 8.1 `/infra/docker/livekit/livekit.yaml`

> O LiveKit expande `${VAR}` do ambiente no YAML.

```yaml
port: 7880
bind_addresses:
  - 0.0.0.0

rtc:
  tcp_port: ${LIVEKIT_RTC_TCP_PORT:-7881}
  udp_port: ${LIVEKIT_RTC_UDP_PORT:-7882}
  use_external_ip: true
  use_external_tcp: true

keys:
  ${LIVEKIT_API_KEY}: ${LIVEKIT_API_SECRET}

turn:
  enabled: true
  domain: ${LIVEKIT_TURN_DOMAIN}
  external_tls: false
  udp_port: ${LIVEKIT_TURN_UDP_PORT:-3478}
  tcp_port: ${LIVEKIT_TURN_TCP_PORT:-5349}
  relay_range: "${LIVEKIT_RELAY_MIN_PORT:-49160}-${LIVEKIT_RELAY_MAX_PORT:-49260}"

room:
  auto_create: true
  empty_timeout: 300
  departure_timeout: 60
  max_participants: 50

webhook:
  # (desativado na v1 — a API do core consome os eventos via polling)
  enabled: false

logging:
  level: info
  format: json

redis:
  address: "fleetbase-redis:6379"
```

### 8.2 `/infra/docker/coturn/turnserver.conf`

```ini
listening-port=3478
tls-listening-port=5349
listening-ip=0.0.0.0
relay-ip=0.0.0.0
external-ip=156.67.31.108
min-port=49160
max-port=49260

# auth via segredo compartilhado com o LiveKit
use-auth-secret
static-auth-secret=${LIVEKIT_TURN_SECRET}
realm=fleetbase.automacaojs.us

# deco
no-cli
no-multicast-peers
no-loopback-peers
no-tlsv1
no-tlsv1_1
fingerprint

# IPv6 desligado (o host é IPv4)
no-ipv6
no-udp-relay

# log
log-file=/var/log/coturn/turn.log
simple-log
```

> ⚠️ `external-ip` **tem** que ser o IP público real do host — se mudar, o TURN entrega relay quebrado e o vídeo cai **só** em 4G (funciona no Wi-Fi, que é o pior tipo de bug: "na garagem funciona").

---

## 9. Nginx (host)

`/infra/docker/nginx/fleetbase.conf` → `/etc/nginx/sites-available/fleetbase` (symlink em `sites-enabled`):

```nginx
server {
    listen 443 ssl http2;
    server_name fleetbase.automacaojs.us;

    # TLS gerenciado pelo Cloudflare (origin Full/Strict)

    client_max_body_size 25m;      # fotos de vistoria / documentos

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 120s;
    }

    # WebSocket do SocketCluster (telemetria ao vivo)
    location ~ ^/socket/ {
        proxy_pass http://127.0.0.1:38000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_read_timeout 3600s;
    }

    # Link de rastreio do cliente (público, com TTL)
    location /r/ {
        proxy_pass http://127.0.0.1:8601;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}

# Painel de rádio (interno no início; público depois do F4)
server {
    listen 443 ssl http2;
    server_name radio.automacaojs.us;

    location / {
        proxy_pass http://127.0.0.1:8601;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

> 🔒 **O nginx do host serve 14 sites.** Antes de aplicar: `nginx -t` e um `reload` (nunca `restart`). O `preview-only.conf` (drop-in) apontando `/etc/nginx/preview-only.conf` continua valendo — **não mexer**.

---

## 10. Especificações funcionais (AC) por fase

> **Gramática da casa:** `Dado` / `Quando` / `Então`. Cada AC é **verificável** por um teste anotado `@spec:AC-xxx` (§12).
> **IDs das histórias** vêm do PRD (`02-PRD.md`) — aqui só nasce o **AC** (critério de aceite técnico).

### 10.1 P1 — Núcleo, telemetria e operação (Fases F1/F2)

#### AC-001 — Isolamento de tenant
- **Dado** um tenant `ten_a` com 3 veículos
- **Quando** o gestor do `ten_b` lista `GET /api/v1/ordens-de-servico`
- **Então** a resposta **não** contém nenhuma OS do `ten_a`, e o `tenant_id` do token é injetado **pelo servidor** (nunca aceito do corpo da requisição)

#### AC-002 — Health do stack e guarda de RAM
- **Dado** o stack rodando
- **Quando** `GET /api/v1/metrics/snapshot` é chamado
- **Então** retorna, por serviço: `estado` (up/down), `mem_used_bytes`, `mem_limit_bytes`, `uptime_s` — e `estado="degraded"` quando qualquer container estiver acima de **85 %** do `mem_limit`

#### AC-003 — Posição no mapa com latência
- **Dado** um veículo em movimento
- **Quando** o app envia `telemetria.position.batch`
- **Então** o ponto aparece no mapa do gestor em **≤ 5 s** (via SocketCluster) e o histórico é gravado com `occurred_at` **UTC**

#### AC-004 — Parado, o mapa não se move
- **Dado** um veículo parado há **> 5 min**
- **Quando** o app decide o envio do próximo lote
- **Então** **não** envia lote de posição (economiza bateria/dados — NF-01) e o gestor vê o ícone como "parado"

#### AC-005 — Linha do tempo do turno
- **Dado** um turno com 30 pontos e 2 paradas
- **Quando** o gestor abre a linha do tempo
- **Então** os eventos aparecem em ordem cronológica **por `occurred_at`**, com a **duração de cada parada** calculada e exibida em **BRT** (exibição) enquanto o dado é **UTC** (armazenamento)

#### AC-006 — Motorista vê o turno do dia
- **Dado** um motorista autenticado com turno **em andamento**
- **Quando** ele abre o app
- **Então** vê OS, veículo, pontos de carga/descarga e o **estado do DVIR** (pendente/aprovado/reprovado) sem precisar de internet se o turno foi sincronizado antes

#### AC-007 — Buffer offline de telemetria
- **Dado** o app sem rede por **20 min** em movimento
- **Quando** a rede volta
- **Então** o app faz `flush` de todos os pontos em ordem cronológica, com `flags.offline_buffered = true`, e a **nenhum ponto** é perdido nem duplicado

#### AC-008 — Bateria do buffer
- **Dado** o app sem rede há **> 2 h**
- **Quando** o buffer local enche
- **Então** o app descarta os pontos **mais antigos** primeiro e **registra** `buffer_overflow` no log local (nunca cresce sem limite)

#### AC-009 — Offline-first da leitura
- **Dado** o app sem rede
- **Quando** o motorista tenta abrir uma OS
- **Então** o app abre a **cópia local** cacheada, marcada como `offline: true`, e **não** mostra erro de rede

#### AC-010 — Criar e despachar uma OS
- **Dado** um embarcador autenticado
- **Quando** ele cria uma OS com veículo, motorista, origem e destino
- **Então** a OS é criada, o status vira `despachada` e o app do motorista mostra a OS no turno **sem** precisar reiniciar

#### AC-011 — Pontos de carga e descarga
- **Dado** o gestor cadastrando um ponto
- **Quando** ele salva nome, endereço e coordenadas
- **Então** o ponto fica disponível no seletor de OS **e** o app passa a exibir o **nome** do ponto (não coordenadas cruas) no alerta de chegada

#### AC-012 — DVIR bloqueia a saída
- **Dado** uma OS com DVIR **reprovado** e `bloqueia_saida = true`
- **Quando** o motorista tenta marcar "início da viagem"
- **Então** o app **impede** a ação e mostra os itens reprovados

#### AC-013 — DVIR com foto
- **Dado** um item reprovado no checklist
- **Quando** o motorista fotografa o item
- **Então** a foto é anexada, uploadada quando há rede (ou fica pendente no buffer) e **aparece** no relatório do gestor

#### AC-014 — Foto na carga e na descarga
- **Dado** o motorista marcando carga/descarga
- **Quando** ele confirma
- **Então** o app **exige** uma foto (ou justificativa) e emite `carga.descarga.concluida` com `foto_url` preenchida

#### AC-015 — Confirmação de descarga
- **Dado** uma OS com descarga pendente
- **Quando** o embarcador confirma a descarga
- **Então** a OS muda para `concluida`, o `dwell_time_s` é registrado e a **linha do tempo** do turno é atualizada

#### AC-016 — Desvio de rota
- **Dado** uma OS com rota planejada
- **Quando** o veículo se afasta **> 300 m** da rota por **> 10 min**
- **Então** o sistema emite `desvio.detectado` **uma única vez** por episode (não a cada ponto) e o gestor vê o alerta

#### AC-017 — Parada prolongada
- **Dado** um veículo parado por **> 15 min** fora de ponto de carga/descarga cadastrado
- **Quando** o limite é atingido
- **Então** o sistema emite `parada.prolongada` com `inicio`, `fim`, `duracao_s` e `local`
- **E** um veículo parado **dentro** de ponto de carga/descarga cadastrado **nunca** gera `parada.prolongada`

#### AC-018 — Link de rastreio para o cliente
- **Dado** o gestor gerando um link para a OS
- **Quando** o link é criado
- **Então** ele é **assinado** (JWT), expira **na conclusão da OS** com **teto máximo de 24 h**, é **revogável** e **não** expõe telefone nem nome do motorista

#### AC-019 — Cliente acompanha pelo link
- **Dado** um cliente com o link válido
- **Quando** ele abre
- **Então** vê **apenas** a posição da OS, sem login, e **sem** ver outras OS do mesmo cliente

#### AC-020 — Evolution GO é o bridge de WhatsApp
- **Dado** o `bridge-whatsapp` no ar
- **Quando** ele envia uma mensagem
- **Então** a requisição vai para `http://host.docker.internal:8096/message/sendText/{instance}` (Evolution GO) e **nunca** para a Evolution API v2 (`:8080`) nem para a API do WhatsApp diretamente

### 10.2 P2 — Mídia: PTT e Olho Vivo (Fase F3)

#### AC-101 — Câmera desligada por padrão
- **Dado** o app recém-conectado à sala
- **Quando** a conexão LiveKit termina
- **Então** o app está com `câmera = false` e `microfone = false` — **nenhuma** faixa de vídeo publicada

#### AC-102 — Comando exato de stream de vídeo
- **Dado** um veículo na sala `radio-frota-geral`
- **Quando** o painel envia `{"action":"stream_video","state":true,"facing":"back"}`
- **Então** o app liga a câmera **traseira** e o painel recebe `ack` com `ok: true` e `ref` do comando

#### AC-103 — Desligar a câmera
- **Dado** a câmera ligada
- **Quando** chega `{"action":"stream_video","state":false}`
- **Então** o app desliga a câmera em **≤ 2 s** e **para de publicar** a faixa de vídeo

#### AC-104 — resolutions fixas
- **Dado** a câmera ligada
- **Quando** o app publica
- **Então** a faixa de vídeo é **480p a 15 fps** (verificável pelo `stats` do LiveKit), independente da qualidade da rede

#### AC-105 — Sessão de vídeo com TTL
- **Dado** uma sessão de vídeo aberta às **19:12** (TTL default de 10 min)
- **Quando** chegam **19:22** (10 min)
- **Então** o core revoga a permissão de publicar, o app desliga a câmera e o sistema emite `sessao_video.expirada`
- **E** o TTL pode ser **configurado por tenant**, com **teto rígido de 30 min**

#### AC-106 — Só quem pode pede vídeo
- **Dado** um solicitante **sem** permissão — na v1, **qualquer perfil diferente de Gestor** (motorista, embarcador, cliente)
- **Quando** ele tenta abrir uma sessão de vídeo
- **Então** a API responde **403**, **não** emite o comando no DataChannel e **registra a tentativa na auditoria**
- **E** o receptor da sessão é **solicitante + gestor** — nunca a sala inteira
- **E** a permissão pode ser **ampliada por tenant** (`tenant.can_request_video`) sem mudança de código

#### AC-107 — PTT pelo botão
- **Dado** o app na sala
- **Quando** o motorista **segura** o botão PTT
- **Então** o microfone é **habilitado**, o **beep** toca e o volume do app cai (audio ducking)

#### AC-108 — PTT é talk-and-hold
- **Dado** o PTT ativo
- **Quando** o motorista **solta** o botão
- **Então** o microfone é **desabilitado** em **≤ 1 s** e o beep de fim toca

#### AC-109 — PTT pela barra de espaço (web)
- **Dado** o painel web aberto
- **Quando** o gestor **segura** a barra de espaço
- **Então** o áudio é publicado na sala **enquanto** a tecla estiver pressionada

#### AC-110 — Escutar é grátis
- **Dado** o app em repouso
- **Quando** não há comando ativo
- **Então** o app **não publica** áudio (só escuta) — consumo de banda ≈ 0

#### AC-111 — Beep e ducking não vazam para o PTT
- **Dado** o PTT ativo
- **Quando** o beep toca
- **Então** o beep é reproduzido **localmente no alto-falante**, **não** publicado na sala

#### AC-112 — TTS lê o chat
- **Dado** uma mensagem de texto no chat do veículo
- **Quando** o recurso TTS está **ligado** para o veículo
- **Então** `react-native-tts` lê a mensagem em voz alta **apenas no dispositivo**

#### AC-113 — TTS default desligado
- **Dado** um veículo novo
- **Quando** nenhum perfil foi configurado
- **Então** o TTS está **desligado** (P-B2/Q-007) e nenhuma voz é lida
- **E** o TTS **liga automaticamente** quando o veículo entra em movimento (velocidade > 5 km/h pela telemetria GPS) e **desliga** ao parar (< 2 km/h) — com histerese para não oscilar
- **E** cada mensagem do chat é lida **uma vez** (sem loop de leitura)

#### AC-114 — Kiosk Mode
- **Dado** o app no veículo, em carregamento
- **Quando** o app entra em foreground service
- **Então** a tela fica **escura** (brilho mínimo), a **notificação persistente** aparece com o botão PTT e a tela não apaga

#### AC-115 — Permissões de foreground service
- **Dado** o `AndroidManifest.xml` do app
- **Quando** o app é instalado
- **Então** declara `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_CAMERA`, `FOREGROUND_SERVICE_MICROPHONE`, `FOREGROUND_SERVICE_LOCATION`, `CAMERA`, `RECORD_AUDIO` e `ACCESS_FINE_LOCATION`

#### AC-116 — Higiene de bateria e dados
- **Dado** o app em uso normal (8 h de turno)
- **Quando** se mede o consumo
- **Então** o upload em repouso é **≈ 0** e o consumo de bateria fica dentro do orçamento definido em AC-116-ORÇAMENTO (NF-01/NF-02)

#### AC-117 — Vídeo em 4G com CGNAT
- **Dado** dois celulares em **4G com CGNAT** (operadora móveis, não Wi-Fi)
- **Quando** o painel pede vídeo
- **Então** a sessão **abre** (via relay TURN) e o vídeo aparece em **≤ 8 s** (NF-07)

### 10.3 P3 — WhatsApp, painel e relatórios (Fases F4/F5)

#### AC-201 — Link de rastreio no WhatsApp
- **Dado** a OS despachada e o WhatsApp configurado
- **Quando** a OS é despachada
- **Então** o cliente recebe **1** mensagem com o link assinado e a validade, via Evolution GO

#### AC-202 — Um envio por OS
- **Dado** uma OS já notificada
- **Quando** o webhook é **reentregue** (retry do core)
- **Então** o bridge reconhece o `idempotency_key` e **não** reenvia a mensagem

#### AC-203 — Assinatura inválida é rejeitada
- **Dado** um webhook com HMAC inválido
- **Quando** o bridge recebe
- **Então** responde **401**, **não** processa e **não** enfileira

#### AC-204 — Alerta de desvio no WhatsApp
- **Dado** um `desvio.detectado`
- **Quando** o bridge processa
- **Então** o gestor recebe a mensagem com distância, duração e ponto de referência

#### AC-205 — Alerta de parada e de carga/descarga
- **Dado** `parada.prolongada` e `carga.descarga.concluida`
- **Quando** o bridge processa
- **Então** cada um gera **1** mensagem no formato definido, com o **horário em BRT**

#### AC-206 — Falha da Evolution não perde o alerta
- **Dado** a Evolution GO fora do ar
- **Quando** o bridge tenta enviar
- **Then** a mensagem fica **na fila** com retry (5 tentativas, backoff) e o alerta é **reemitido** quando a Evolution volta

#### AC-207 — Webhook para o ERP do cliente
- **Dado** um cliente com webhook configurado
- **Quando** um evento relevante acontece
- **Então** o core faz `POST` no endpoint do cliente com o **envelope** (§4.1) + HMAC

#### AC-208 — Painel de carga da frota
- **Dado** o gestor filtrando por turno
- **Quando** a lista carrega
- **Então** mostra **todas** as OS do turno com status, última posição e **sem** OS de outro tenant

#### AC-209 — Relatório de turno
- **Dado** um turno encerrado
- **Quando** o gestor exporta o relatório
- **Então** ele contém: distância percorrida, tempo de direção, tempo de parada, custo estimado, eventos de desvio e **DVIR** — em **CSV** e **PDF**

#### AC-210 — Consultar o que está em rota
- **Dado** o embarcador
- **Quando** ele consulta a rota
- **Então** vê a posição da carga com **última atualização** e **sem** previsão que não exista

#### AC-211 — Fim do rastreio
- **Dado** uma OS concluída
- **Quando** o link é acessado
- **Então** mostra "rastreio encerrado" e **não** mostra a posição final indefinidamente

#### AC-212 — Canal alternativo
- **Dado** um cliente que não usa WhatsApp
- **Quando** ele acessa o link por e-mail/SMS
- **Então** o mesmo link funciona (o canal é só o **transporte** do link)

#### AC-213 — Cadastro e cobrança
- **Dado** um novo tenant
- **Quando** ele é cadastrado
- **Então** recebe **limites** (veículos, usuários, eventos/mês) e o consumo é **mensurado** por tenant

#### AC-214 — Auditoria
- **Dado** uma ação sensível (sessão de vídeo aberta, link gerado, permissão alterada)
- **Quando** ela acontece
- **Então** fica registrada com **quem**, **quando**, **o quê** e o **IP**, e é **imutável**

---

### 10.4 Suposições (ASM)

| ID | Suposição | Status | Resolução |
|---|---|---|---|
| ASM-001 | O `mysqldump` do MySQL 8 (Plano B) faz backup íntegro do `fleetbase_db` | **aberta** | backup testado no gate F1 |
| ASM-002 | `react-native-geolocation-service` funciona em Android 14/15 com foreground service de localização | **aberta** | ADR-013 plano C (módulo nativo) |
| ASM-003 | ~~O `fleetbase/fleetbase-api:latest` suporta `DATABASE_URL=pgsql://`~~ | **FALSA — 18/11/2026** | **Gate F1-VAL-001 rodou: FAIL no Plano A** (a imagem só tem `pdo_mysql`/`pdo_sqlite`, sem `pdo_pgsql`; o core só define a conexão `'mysql'`). ⇒ **Plano B (MySQL 8, 640 MB)** — ADR §12.5.1. **No Plano B o gate deu PASS: 395 migrations, 0 falhas, 0 pendentes** — ADR §12.5.4 |
| ASM-004 | A Evolution GO tem sessão WhatsApp ativa e com número próprio | **aberta** | checagem antes do F5 (R-06) |
| ASM-005 | O host aguenta 9 containers com 3,4 GB reserved sem OOM | **aberta** | gate G-RAM (ADR §6.1) |
| ASM-006 | O `@livekit/react-native` 3.2.0 suporta `setCameraEnabled(false)` no join | **aberta** | spike no F3 |
| ASM-007 | O app pode rodar em foreground service com tela apagada em Android 14+ | **aberta** | AC-114 |
| ASM-008 | `react-native-sound` toca beep local sem permissão de rede | **aberta** | spike F3 |
| ASM-009 | O OSM tile server aceita o volume de tiles do piloto (60 dias, 3–5 frotas) | **aberta** | política de tile cache + User-Agent |
| ASM-010 | O `fleetops-engine` (Fleet-Ops) roda sem alteração no core | **aberta** | ADR §12 Q-011 |

### 10.5 Perguntas — decididas em 18/11/2026

> As 22 perguntas foram fechadas pelo Isaac em 18/11/2026 (registro completo no **ADR §12.1**;
> as ADRs derivadas em ADR §12.2). Aqui fica **o que muda no SPEC** por causa de cada decisão.

| ID | Pergunta | Decisão | Onde entra no SPEC |
|---|---|---|---|
| Q-101 | `idempotency_key` único por **evento** ou por **(evento, OS, minuto)**? | **`event_id` (UUID da origem) + `idempotency_key` determinística calculada no servidor** — `sha256(event_type + subject.id + occurred_at + sha256(payload))` (ADR-020) | §4.1 (envelope) · §5.1 · `contracts/envelope.schema.json` (T-040) |
| Q-102 | `telemetria.position.batch` por **push** ou **polling**? | **Polling 30 s** (60 s em background) — ADR-025 | §5.1 · AC-021 · app T-023 |
| Q-103 | Buffer offline: **SQLite** ou MMKV? | **SQLite** — ADR-025 | app T-024 · §5.2 (`telemetria.offline.flush`) |
| Q-104 | Alerta de desvio: limiar? | **300 m em 10 min** (era 200 m / 5 min) — ADR-023 | **AC-016 (reescrever)** · §5.3 · regra T-049 |
| Q-105 | Parada prolongada: **15 min** ou 20 min? | **15 min** — ADR-023 | **AC-017 (reescrever)** · §5.4 · regra T-050 |
| Q-106 | Cliente final vê **ETA** ou só posição? | **Só posição** na v1 (confirmado) | AC-019 · §5.6 |
| Q-107 | Quem recebe o alerta de WhatsApp? | **Gestor** na v1; embarcador entra quando o tenant habilitar (ADR-019) | AC-205 · §5.9 · §5.10 · regra T-051 |
| Q-108 | Motorista pode solicitar `stream_video`? | **Não na v1** — **só o Gestor** solicita; permissão evolui para **por tenant** (ADR-019) | **AC-106 (reescrever)** · §6.1 · permissão do painel T-062 · auditoria T-014 |
| Q-109 | `facing` default: `back` ou `front`? | **`back`** (confirmado) | AC-102 · §6.1 |
| Q-110 | PTT por Bluetooth do volante na v1? | **Não na v1** — PTT de tela + barra de espaço; **BLE HID genérico na v1.1** | §6.1 · §6.3 · app (tarefa de fase 2) |

#### 10.5.1 Regras novas que decorrem das decisões (contra-normativas)

| Regra | Valor | Onde |
|---|---|---|
| **TTL da sessão de vídeo** | 10 min default, **configurável por tenant**, **teto rígido de 30 min** | §6.4 (job de expiração) · AC-105 |
| **Validade do link de rastreio** | expira na **conclusão da OS**, com **teto de 24 h**; revogação manual pelo gestor | §5.6 · AC-018 · AC-211 |
| **TTS do chat** | **desligado por default**; liga **só com o veículo em movimento** (GPS > 5 km/h, desliga < 2 km/h — histerese); configurável por veículo | AC-112 · AC-113 · app T-027 |
| **Fuso do tenant** | campo `tenant.timezone` (IANA, ex.: `America/Sao_Paulo`, `America/Tegucigalpa`); **gravação sempre UTC**, exibição no fuso do tenant | §3.1 (`TENANT_DEFAULT_TIMEZONE`) · §5 · AC-201 (relatórios por dia usam o fuso do tenant) |
| **Idempotência** | índice único em `event_id` **e** em `idempotency_key`; duplicado é descartado **sem recomputar efeito** | §4.1 · §5.x · AC-210 |
| **Permissão de vídeo** | v1: **só o perfil Gestor** solicita; receptor = **solicitante + gestor**; **todo pedido gera auditoria** | §6.1 · §6.4 · AC-106 · AC-214 |
| **Limiares** | desvio **300 m / 10 min**; parada **15 min** fora de ponto cadastrado; **parada em ponto cadastrado nunca alerta** | §5.3 · §5.4 · AC-016 · AC-017 |
| **Telemetria** | polling 30 s / 60 s em background; buffer SQLite; flush deduplicado pelo contrato de idempotência | §5.1 · §5.2 |
| **Teto de RAM** | 4,5 GB formal; **VROOM e MySQL mutuamente exclusivos** (perfis `router` e `fallback-mysql` nunca juntos) | §7.1 · §7.2 |
| **Plano de mídia** | tudo desacoplado por variável de host (`LIVEKIT_HOST`, `TURN_EXTERNAL_IP`, `LIVEKIT_TURN_DOMAIN`, `RADIO_PUBLIC_URL`) — virada para a VPS-2 sem mudança de código | §3.1 · §8.1 · §8.2 · ADR §12.3 |

#### 10.5.2 Variáveis novas em `.env.shared` (ADR-016 / ADR-017)

> **Nomenclatura canônica = a lista de §3.1.** As variáveis de mídia abaixo já estão
> consolidadas em §3.1 — aqui está o **recorte do plano de migração**, com o que muda em cada
> virada. Não criar duas nomes para a mesma coisa: a lista de §3.1 é a que vai para o cofre.

```
# ─── PLANO DE MÍDIA — desacoplado por host (virada para VPS-2 sem refator) ──
LIVEKIT_HOST=livekit.automacaojs.us       # §3.1 · hostname do plano de mídia
LIVEKIT_URL=wss://livekit.automacaojs.us # §3.1 · URL pública (não muda na virada: o DNS reponta)
LIVEKIT_TURN_DOMAIN=turn.automacaojs.us  # §3.1 · nome do TURN (DNS-only / nuvem cinza)
TURN_EXTERNAL_IP=                         # §3.1 · **ESTE É O QUE MUDA** na virada pra VPS-2
LIVEKIT_RELAY_MIN_PORT=49160              # §3.1 · faixa de relay do Coturn
LIVEKIT_RELAY_MAX_PORT=49260              # §3.1 · (nunca 50000/udp = astracalls)
RADIO_PUBLIC_URL=https://frota.automacaojs.us   # Painel Frota (radio.automacaojs.us exclusivo da Rádio Devocional 12)
RADIO_LOUVOR_URL=                               # §3.1 · idem para o stack de louvor
TENANT_DEFAULT_TIMEZONE=America/Sao_Paulo      # §3.1 · IANA (Honduras = America/Tegucigalpa)
```

> `TURN_EXTERNAL_IP` e `LIVEKIT_TURN_DOMAIN` **têm que bater** com o `external-ip` do
> `turnserver.conf` e com o `turn.domain` do `livekit.yaml` — é o item que faz o vídeo
> abrir (ou não) em 4G. conferir no checklist de cutover (ADR §12.3).

#### 10.5.3 VPS-2: papel e janela (ADR §12.6 — rascunho para revisão do Isaac)

> O Isaac fechou a compra de uma **VPS de 6 núcleos, 12 GB RAM, 100 GB disco,
> US$ 5,28/mês** (Telegram 6355, 18/11/2026). O papel dela **não** é host
> avulso: é a **VPS-2 (Mídia & Streaming)** que o ADR §12.3 já previa,
> ampliada para absorver o **tier de build** e os **apps sem dado crítico**.
> Plano completo,medições e rollback: **ADR §12.6**.

| Onda | O que move | Quando | Trava |
|---|---|---|---|
| **1** | LiveKit + Coturn + AzuraCast/rádios + relay Liquidsoap + tier de build + caches (npm 15 GB, gradle 2 GB) + `radio-libertacao-music` (8,4 GB) | **depois das 22 h** (janela combinada pelo Isaac, Telegram 6354) | exige **IPv4 público fixo** na VPS-2 (`TURN_EXTERNAL_IP`) |
| **2** | `ava-mentingo` · `opencode serve` + OpenBot · servidores de IA do Leitor · tooling do Hermes | mês seguinte | copiar → apontar → testar → desligar o antigo |
| **3** | Supabase self-hosted + `crm-hermes` (:3010) | **NÃO agora** | janela com o Isaac + **backup testado** + Regra de Ouro de isolamento do tenant |

> **O que não se move, em nenhuma onda:** Evolution API (sessão WhatsApp
> stateful), tunnel CF principal, Postgres do CRM, `hermes/state.db` e perfis.
> **Rede:** Tailscale + upstream no nginx — **sem rota nova na Cloudflare** no
> dia 1. **Backup:** os 12,6 GB de backup **não** ficam na VPS-2.

**O que muda no SPEC por causa da VPS-2:**
- `TURN_EXTERNAL_IP` (§3.1) passa a ser o **IP público da VPS-2** — é o item
  que habilita a onda 1; o checklist de cutover é o do ADR §12.3.
- `RADIO_PUBLIC_URL` / `RADIO_LOUVOR_URL` (§3.1) repontam para a VPS-2.
- O perfil `media` sai do `docker compose up` da `hermes-prod` (perfil, não
  delete de imagem) **só depois** do teste em 4G real.

---

## 11. Tasks (formato da casa) — faixas paralelas

> **Gramática:** `## T-xxx — Nome [pendente|concluida]` + `- Refs:` (códigos existentes) + `- Arquivos:` (caminho). **Arquivos disjuntos dentro da mesma faixa = paralelizável sem conflito.**
> Cada task tem **um** AC (ou mais) em `Refs:` e **exatamente um** arquivo em `Arquivos:` (ou um conjunto disjunto).

### 11.1 Faixa A — Infra (Claude Code) — `feat/infra`

| Task | Nome | Refs | Arquivos |
|---|---|---|---|
| T-001 | Compose base com limits e profiles | US-SA-03, AC-002, ASM-005 | `infra/docker/compose.base.yml` |
| T-002 | Config do LiveKit (sala, relay, chaves) | AC-101, AC-117, ASM-006 | `infra/docker/livekit/livekit.yaml` |
| T-003 | Config do Coturn (portas, secret, external-ip) | AC-117 | `infra/docker/coturn/turnserver.conf` |
| T-004 | Server blocks nginx (API + socket + link) | AC-003, AC-019 | `infra/docker/nginx/fleetbase.conf` |
| T-005 | `.env.shared` (nomes) + `.gitignore` + exemplos | US-SA-03, AC-002 | `infra/env/.env.shared.example` |
| T-006 | `preflight.sh` (checklist read-only do ADR §11) | AC-002 | `infra/scripts/preflight.sh` |
| T-007 | `db-bootstrap.sh` (cria os **3** schemas do MySQL 8 + user + grants, Plano B) | ASM-001, ASM-003 | `infra/scripts/db-bootstrap.sh` |
| T-008 | `smoke.sh` (health de todos os serviços) | AC-002 | `infra/scripts/smoke.sh` |
| T-009 | Executor do gate **F1-VAL-001** (migrations) | ASM-003, ADR-002 | `infra/scripts/gate-f1-val-001.sh` |
| T-010 | Hardening do compose (memswap, no-new-privileges, healthcheck) | AC-002, AC-002 | `infra/docker/compose.hardening.yml` |
| T-011 | Compose do fallback (VROOM + MySQL) | ADR-002, ADR-004 | `infra/docker/compose.routers.yml` |
| T-012 | Override do **Plano B** (MySQL 8, profile `fallback-mysql`, tuning 640 MB) | ADR-002, ADR-024, ASM-003 | `infra/docker/compose.f1.planb.yml` |
| T-013 | Vars do Plano B (git-ignored, chmod 600) | ADR-002, ASM-003 | `infra/env/fleetbase.mysql.env` |

### 11.2 Faixa B — App Navigator (OpenCode) — `feat/navigator`

| Task | Nome | Refs | Arquivos |
|---|---|---|---|
| T-020 | Wrapper de geolocalização + foreground service | US-MT-03, AC-003, AC-004, ASM-002 | `mobile-navigator/src/modules/geo/GeoTracker.ts` |
| T-021 | Buffer offline SQLite + overflow controlado | US-MT-09, AC-007, AC-008 | `mobile-navigator/src/modules/tracking/OfflineBuffer.ts` |
| T-022 | Remetente de telemetria em lote (30 s / 60 s / parado) | US-MT-03, AC-003, AC-004 | `mobile-navigator/src/modules/tracking/TelemetrySender.ts` |
| T-023 | Cliente LiveKit passivo (câmera e mic desligados no join) | US-MT-04, AC-101, AC-110 | `mobile-navigator/src/modules/radio/RadioClient.ts` |
| T-024 | PTT talk-and-hold + beep + ducking | US-MT-05, AC-107, AC-108, AC-111 | `mobile-navigator/src/modules/radio/PttController.ts` |
| T-025 | Handler de `stream_video` (480p/15fps, front/back) | US-MT-04, AC-102, AC-103, AC-104 | `mobile-navigator/src/modules/vision/VisionController.ts` |
| T-026 | TTL da sessão de vídeo (desliga sozinho) | AC-105, AC-117 | `mobile-navigator/src/modules/vision/SessionExpiry.ts` |
| T-027 | TTS das mensagens do chat (default desligado) | US-MT-06, AC-112, AC-113 | `mobile-navigator/src/modules/tts/TtsReader.ts` |
| T-028 | Kiosk Mode + notificação persistente | US-MT-08, AC-114 | `mobile-navigator/src/modules/kiosk/KioskMode.ts` |
| T-029 | Permissões do AndroidManifest | AC-115 | `mobile-navigator/android/app/src/main/AndroidManifest.xml` |
| T-030 | Tela do turno do dia | US-MT-01, AC-006 | `mobile-navigator/src/screens/TurnoScreen.tsx` |
| T-031 | Checklist DVIR no celular (com foto) | US-MT-02, AC-012, AC-013 | `mobile-navigator/src/screens/DvirScreen.tsx` |
| T-032 | Marcar carga/descarga com foto | US-MT-07, AC-014 | `mobile-navigator/src/screens/CargaDescargaScreen.tsx` |
| T-033 | Leitura offline da OS (cache local) | US-MT-09, AC-006, AC-009 | `mobile-navigator/src/offline/OsCache.ts` |
| T-034 | Higiene de bateria e dados | US-MT-10, AC-116 | `mobile-navigator/src/modules/geo/PowerPolicy.ts` |

### 11.3 Faixa C — Integrações (Gemini) — `feat/integrations`

| Task | Nome | Refs | Arquivos |
|---|---|---|---|
| T-040 | Schema do envelope comum | AC-202, AC-203 | `integrations/contracts/envelope.schema.json` |
| T-041 | Schema de telemetria | AC-003 | `integrations/contracts/telemetria.schema.json` |
| T-042 | Schema dos webhooks operacionais | AC-204, AC-205 | `integrations/contracts/webhook-operacional.schema.json` |
| T-043 | Schema de DVIR | AC-012 | `integrations/contracts/dvir.schema.json` |
| T-044 | Schema do DataChannel (shape fixo do `stream_video`) | AC-102, AC-103 | `integrations/contracts/datachannel.schema.json` |
| T-045 | Claims do token LiveKit | AC-101 | `integrations/contracts/livekit-token.claims.json` |
| T-046 | Verificação de HMAC + anti-replay + idempotência | AC-202, AC-203 | `integrations/bridge-whatsapp/src/middleware/verifySignature.ts` |
| T-047 | Fila com retry e backoff | AC-206 | `integrations/bridge-whatsapp/src/queue/RetryQueue.ts` |
| T-048 | Adapter da Evolution GO (`:8096`) | US-INT-04, AC-020, AC-201 | `integrations/bridge-whatsapp/src/adapters/evolution-go.ts` |
| T-049 | Regra: desvio → mensagem | US-INT-02, AC-204 | `integrations/bridge-whatsapp/src/rules/desvio.ts` |
| T-050 | Regra: parada prolongada → mensagem | US-INT-02, AC-205 | `integrations/bridge-whatsapp/src/rules/parada.ts` |
| T-051 | Regra: carga/descarga concluída → mensagem | US-INT-02, AC-205 | `integrations/bridge-whatsapp/src/rules/dwell.ts` |
| T-052 | Token do link de rastreio (JWT + TTL + revogação) | US-GF-08, AC-018, AC-211 | `integrations/bridge-whatsapp/src/tracking/token.ts` |
| T-053 | Callback de status da Evolution | AC-206 | `integrations/bridge-whatsapp/src/routes/evolution-callback.ts` |
| T-054 | Formatação de horários em BRT nas mensagens | AC-205, NF-14 | `integrations/bridge-whatsapp/src/format/brt.ts` |

### 11.4 Faixa D — Painel de rádio (OpenCode) — `feat/radio-panel`

| Task | Nome | Refs | Arquivos |
|---|---|---|---|
| T-060 | Mapa da frota ao vivo (SocketCluster) | US-GF-01, AC-003, AC-208 | `web-radio-panel/src/components/FleetMap.tsx` |
| T-061 | PTT do gestor (barra de espaço) | US-GF-05, AC-109 | `web-radio-panel/src/components/PttPanel.tsx` |
| T-062 | Botão de Olho Vivo (`stream_video`) | US-GF-04, AC-102, AC-106 | `web-radio-panel/src/components/VisionPanel.tsx` |
| T-063 | Hook da sala LiveKit (token + DataChannel) | AC-101, AC-109 | `web-radio-panel/src/hooks/useLiveKitRoom.ts` |
| T-064 | Linha do tempo do turno | US-GF-02, AC-005 | `web-radio-panel/src/components/Timeline.tsx` |
| T-065 | Lista de alertas operacionais | US-GF-03, AC-016, AC-017 | `web-radio-panel/src/components/Alerts.tsx` |
| T-066 | Página pública do link de rastreio | US-CL-01, AC-019 | `web-radio-panel/src/pages/Track.tsx` |
| T-067 | Relatório de turno (CSV + PDF) | US-GF-10, AC-209 | `web-radio-panel/src/pages/Report.tsx` |

### 11.5 Faixa E — Contrato e auditoria (Claude Code) — `test/contract`

| Task | Nome | Refs | Arquivos |
|---|---|---|---|
| T-070 | Teste de contrato: envelope (válido/inválido) | AC-202, AC-203 | `tests/contract/envelope.contract.test.ts` |
| T-071 | Teste de contrato: webhook operacional vs schema | AC-204, AC-205 | `tests/contract/webhook-operacional.contract.test.ts` |
| T-072 | Teste de contrato: DataChannel vs schema (shape do `stream_video`) | AC-102, AC-103 | `tests/contract/datachannel.contract.test.ts` |
| T-073 | Teste de idempotência do bridge (replay) | AC-202 | `tests/contract/idempotencia.contract.test.ts` |
| T-074 | E2E: telemetria → desvio → alerta | AC-016, AC-204 | `tests/e2e/alerta-desvio.e2e.ts` |
| T-075 | Auditoria `onp-spec audit --ci` verde | todos | `tests/audit/README.md` |

> **Nota de paralelismo:** T-070..T-075 dependem dos schemas (Faixa C) — rodam **depois** que a Faixa C publica a v1.0. Até lá, rodam contra os **fixtures** versionados em `tests/fixtures/`.

---

## 12. Matriz de testes (com anotação `@spec:AC-xxx`)

| AC | Tipo de teste | Onde | Anotação |
|---|---|---|---|
| AC-001 | integração (API + DB) | `tests/e2e/tenant-isolation.e2e.ts` | `@spec:AC-001` |
| AC-002 | integração | `tests/contract/health.contract.test.ts` | `@spec:AC-002` |
| AC-003 | integração | `tests/e2e/telemetria-mapa.e2e.ts` | `@spec:AC-003` |
| AC-004 | unit (app) | `mobile-navigator/src/modules/geo/__tests__/GeoTracker.test.ts` | `@spec:AC-004` |
| AC-007 | unit | `mobile-navigator/src/modules/tracking/__tests__/OfflineBuffer.test.ts` | `@spec:AC-007` |
| AC-012 | unit | `mobile-navigator/src/screens/__tests__/DvirScreen.test.tsx` | `@spec:AC-012` |
| AC-016 | integração | `tests/e2e/alerta-desvio.e2e.ts` | `@spec:AC-016` |
| AC-018 | unit | `integrations/bridge-whatsapp/src/tracking/__tests__/token.test.ts` | `@spec:AC-018` |
| AC-019 | integração | `tests/e2e/link-cliente.e2e.ts` | `@spec:AC-019` |
| AC-020 | integração | `tests/contract/evolution-adapter.contract.test.ts` | `@spec:AC-020` |
| AC-101 | unit | `mobile-navigator/src/modules/radio/__tests__/RadioClient.test.ts` | `@spec:AC-101` |
| AC-102 | unit | `mobile-navigator/src/modules/vision/__tests__/VisionController.test.ts` | `@spec:AC-102` |
| AC-103 | unit | idem | `@spec:AC-103` |
| AC-104 | integração (stats do LiveKit) | `tests/e2e/livekit-stats.e2e.ts` | `@spec:AC-104` |
| AC-105 | integração | `tests/e2e/sessao-ttl.e2e.ts` | `@spec:AC-105` |
| AC-107 | unit | `mobile-navigator/src/modules/radio/__tests__/PttController.test.ts` | `@spec:AC-107` |
| AC-108 | unit | idem | `@spec:AC-108` |
| AC-115 | estático (manifest) | `tests/contract/manifest.contract.test.ts` | `@spec:AC-115` |
| AC-117 | **manual em campo** (2 chips 4G) | `tests/e2e/manual-cgnat.md` | `@spec:AC-117` |
| AC-201 | integração | `tests/e2e/whatsapp-link.e2e.ts` | `@spec:AC-201` |
| AC-202 | integração | `tests/contract/idempotencia.contract.test.ts` | `@spec:AC-202` |
| AC-203 | integração | `tests/contract/hmac.contract.test.ts` | `@spec:AC-203` |
| AC-206 | integração (Evolution fora do ar → fila → volta) | `tests/e2e/whatsapp-retry.e2e.ts` | `@spec:AC-206` |

**Regra da casa:** *"Só PASS conta; skip não é prova."* — teste marcado `skip` **não** satisfaz o AC. Auditoria: `onp-spec audit --ci` precisa sair **0**.

---

## 13. Definition of Ready / Definition of Done

### 13.1 DoR (task pode começar)

- [ ] O `Refs:` aponta para AC **existente** neste kit (ou no PRD).
- [ ] O `Arquivos:` **não** está sendo editado por outro agente (checa §1.1).
- [ ] Se a task consome um contrato, o schema já está publicado em `/integrations/contracts/` **na versão citada**.
- [ ] O AC tem **Dado/Quando/Então** e é **testável** (senão: abrir Q-xxx no §10.5).

### 13.2 DoD (task concluída)

- [ ] Código + **teste anotado** `@spec:AC-xxx` passando.
- [ ] Nenhum **valor de segredo** no código, no teste, no log ou no `.env` versionado.
- [ ] Nenhum campo novo **sem** atualizar o schema correspondente (§4).
- [ ] `npm run lint` e `npm run typecheck` limpos (quando houver).
- [ ] PR com **1 task** (1 AC) — PR com 2 tarefas quebra o merge paralelo.
- [ ] Tarefa marcada `[concluida]` **só** depois do teste verde.

---

## 14. Rastreabilidade (BRD/PRD → SPEC → Task)

| Origem | AC | Tasks |
|---|---|---|
| US-SA-01 (tenants) | AC-001 | T-070 |
| US-SA-03 (health/guardas) | AC-002 | T-001, T-005, T-006, T-008 |
| US-GF-01 (mapa ao vivo) | AC-003 | T-020, T-022, T-060 |
| US-GF-02 (linha do tempo) | AC-005 | T-064 |
| US-GF-03 (alertas) | AC-016, AC-017 | T-049, T-050, T-065, T-074 |
| US-GF-04 (Olho Vivo) | AC-101..AC-106 | T-023, T-025, T-026, T-062, T-063 |
| US-GF-05 (rádio PTT) | AC-107..AC-111 | T-024, T-061 |
| US-GF-06 / US-MT-02 (DVIR) | AC-012, AC-013 | T-031 |
| US-GF-07 / US-MT-07 (foto) | AC-014 | T-032 |
| US-GF-08 (link) | AC-018 | T-052 |
| US-GF-09 (painel de carga) | AC-208 | T-060 |
| US-GF-10 (relatórios) | AC-209 | T-067 |
| US-EM-01 (OS) | AC-010 | (core Fleetbase — sem task local) |
| US-EM-02 (foto carga) | AC-014 | T-032 |
| US-EM-03 (descarga) | AC-015 | T-032 |
| US-EM-04 (em rota) | AC-210 | T-060 |
| US-EM-05 (pontos) | AC-011 | (core) |
| US-MT-01 (turno) | AC-006 | T-030 |
| US-MT-03 (buffer) | AC-007, AC-008 | T-020, T-021, T-022 |
| US-MT-04 (câmera) | AC-102..AC-105 | T-025, T-026 |
| US-MT-05 (PTT) | AC-107, AC-108 | T-024 |
| US-MT-06 (TTS) | AC-112, AC-113 | T-027 |
| US-MT-08 (Kiosk) | AC-114, AC-115 | T-028, T-029 |
| US-MT-09 (offline) | AC-009 | T-033 |
| US-MT-10 (bateria) | AC-116 | T-034 |
| US-CL-01 (link) | AC-019 | T-066 |
| US-CL-02 (fim) | AC-211 | T-052, T-066 |
| US-INT-01 (link WhatsApp) | AC-201 | T-048 |
| US-INT-02 (alertas) | AC-204, AC-205 | T-049..T-051 |
| US-INT-03 (ERP) | AC-207 | (core) |
| US-INT-04 (Evolution GO) | AC-020 | T-048 |

---

## 15. Ordem de execução e gates

```
                ┌──────────────── FAIXA C (Gemini) ────────────────┐
                │ T-040..T-045  (contracts/ = FONTE ÚNICA)        │
                └───────┬────────────────────────────────────────┘
                        │ publica v1.0 dos schemas
        ┌───────────────┼───────────────────┬────────────────────┐
        ▼               ▼                   ▼                    ▼
┌─── FAIXA A ───┐ ┌── FAIXA B ──┐ ┌── FAIXA D ──┐      ┌── FAIXA E ──┐
│ (Claude Code) │ │ (OpenCode)  │ │ (OpenCode)  │      │ (Claude Code)
│ infra/*       │ │ mobile/*    │ │ panel/*     │      │ tests/*
└───────┬───────┘ └──────┬──────┘ └──────┬──────┘      └──────┬──────┘
        │                │               │                    │
        └──────────┬─────┴───────────────┘                    │
                   ▼                                          │
            ┌──────────────┐                                 │
            │  MERGE       │◀────────────────────────────────┘
            │  feat/infra  │
            │  → main      │
            └──────┬───────┘
                   ▼
     ┌──────────────────────────┐
     │  GATES (ADR §10)         │
     │  F1-VAL-001 → G-RAM →    │
     │  F2 → F3 (4G real) →     │
     │  F4 (Edge/DNS) → F5      │
     └──────────────────────────┘
```

**Ordem de merge:** `feat/integrations` → `feat/infra` → `feat/navigator` + `feat/radio-panel` → `main`.
**Regra de branch protection:** `main` só aceita PR com **1 task** e **1 AC**.

---

## 16. Checklist de auditoria do dossiê (o que o Isaías revisa)

- [ ] **BRD** — problema, 5 verticais, preço, fase 0 do piloto (3–5 frotas / 60 dias)
- [ ] **PRD** — US por perfil, NF-01..NF-14, bloqueadores P-B1..P-B7
- [ ] **ADR** — 15 decisões, orçamento de RAM ≤ 4,5 GB, portas, TURN, AGPL (ADR-011), fases/gates
- [ ] **SPEC-KIT** — contratos JSON, compose com limits, `.env.shared` **sem valores**, divisão de pastas, AC com Dado/Quando/Então, tasks com Refs/Arquivos disjuntos
- [ ] **Decisões pendentes do Isaac** — ADR §12 (Q-001..Q-012) + SPEC §10.5 (Q-101..Q-110)

> **Nenhuma palavra deste dossiê autoriza subir container em produção.** A autorização de deploy é o **F1**, e ele depende do gate **F1-VAL-001** (ADR-002, §10).

---

**Fim do documento 04-SPEC-KIT.md.**

