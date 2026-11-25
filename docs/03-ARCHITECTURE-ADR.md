# 03-ARCHITECTURE-ADR.md — Architecture Decision Record

## Hermes Logística & Olho Vivo — stack enxuta sobre a VPS `hermes-prod`

| Campo | Valor |
|---|---|
| Versão do doc | 1.0 (fundacional) |
| Data | 18/11/2026 |
| Autor | Arquitetura Principal (Claude Code) |
| Derivado de | `01-BRD.md` (negócio) · `02-PRD.md` (requisitos funcionais) |
| Consome | `04-SPEC-KIT.md` (contratos + tasks) |
| Status | **DRAFT para revisão do Isaías** — nada foi instalado |
| Ambiente alvo | VPS `hermes-prod` — Contabo Frankfurt, IP público `156.67.31.108` |

> **Nota de honestidade:** este documento é **planejamento**. Nenhum container foi
> criado, nenhuma porta foi aberta, nenhum serviço de produção foi tocado. Todos os
> números de RAM, portas, rede e Postgres abaixo foram **medidos no host em
> 18/11/2026, 12:15–13:05 BRT** (`free -m`, `docker ps`, `ss -ltn`, `iptables -S`,
> `docker inspect`, `psql`). O que não foi verificado está marcado como
> **[A VERIFICAR]**.

---

## 1. Contexto

**O que é.** Plataforma B2B white-label de gestão de frotas com três módulos
juntos no mesmo app Android de médio porte: telemetria (GPS), Olho Vivo (câmera
sob demanda) e rádio PTT. O diferencial comercial (BRD §5) é entregar os três
**sem hardware dedicado de rastreio**.

**O que este documento decide.** *Onde* cada coisa roda, *com quais limites de
memória*, *em quais portas*, *como atravessa CGNAT*, e *o que fazer quando a
premissa original não se sustenta*. Ele é o único lugar do dossiê onde a
tecnologia aparece (BRD = negócio, PRD = requisitos, ADR = decisões técnicas,
SPEC-KIT = contratos + execução).

### 1.1 Travas herdadas do pedido (msg 6338/6339) — todas respeitadas

| # | Trava | Como este ADR cumpre |
|---|---|---|
| T-1 | Usar `fleetbase/fleetbase` (Fleet-Ops) + clone completo do `fleetbase/navigator-app` | ADR-001, ADR-002, ADR-005 |
| T-2 | **Não subir container de banco novo** — reusar o Postgres já ativo criando DB isolado `fleetbase_db` | ADR-002 (com risco alto e gate — ver §9 R-02) |
| T-3 | `deploy.resources.limits.memory` em **todos** os containers | ADR-006 (orçamento por container) |
| T-4 | Mapas/routing sem custo: `react-native-geolocation-service` no lugar do `react-native-background-geolocation` pago; tiles OSM; **sem Valhalla local**; só VROOM leve (256 MB) apontado por `ROUTER_URL` para API OSM externa | ADR-004 (VROOM adiado para a fase 2 — decisão minha, justificada) |
| T-5 | Olho Vivo + PTT unificados em LiveKit: LiveKit Server + Coturn via Docker para CGNAT; `@livekit/react-native` em Kiosk Mode; câmera **OFF** por padrão; 480p/15fps; DataChannel `{"action":"stream_video","state":true|false,"facing":"front"|"back"}`; sala fixa `radio-frota-geral`; PTT com beep + ducking; `react-native-tts` | ADR-007, ADR-013 + SPEC-KIT §5 |
| T-6 | WhatsApp: webhooks Fleetbase → Evolution GO (`:8096`) para link de rastreio temporário e alertas (desvio, parada prolongada, carga/descarga) | ADR-008, ADR-012 + SPEC-KIT §5 |
| T-7 | AGPL-3.0: extensões proprietárias em serviços desacoplados via API/Webhooks | ADR-011 (mantém o número citado no BRD §10) |
| T-8 | **Não instalar containers nem alterar produção agora** | ADR-014 — este doc é o único artefato produzido |

---

## 2. Estado real do host (medido 18/11/2026 ~12:55 BRT)

### 2.1 Recursos

| Recurso | Valor | Impacto no plano |
|---|---|---|
| RAM total | 24 GB | — |
| RAM usada | 16,7 GB | — |
| RAM **disponível** | **7,28 GB** | Teto de 4,5 GB do stack **cabe**, mas com folga curta |
| Swap | 4 GB — **4095/4095 MB em uso (100%)** | 🚩 Sinal vermelho: o host já está trocando disco/memória |
| Disco `/` | 387 GB total · 197 GB usados · **190 GB livres** | Imagens Docker + volumes do Fleetbase OK (orçamento: 25 GB) |
| vCPU | 8 | OK para o stack (LiveKit + VROOM são os mais pesados) |

> ⚠️ **Leitura honesta:** com swap em 100% e 7,28 GB disponíveis, subir 4,5 GB de
> stack agora é **tecnicamente possível e operacionalmente irresponsável**. Por
> isso o ADR-006 define um **gate de pré-deploy** (F1) que exige folga real
> antes de qualquer `docker compose up`. Alternativa recomendada em §10:
> rodar o stack de mídia (LiveKit + Coturn) em uma micro-VPS de 2 GB
> (~R$ 40/mês) e deixar só o core Fleetbase na `hermes-prod`.

### 2.2 Portas TCP já em uso (medido com `ss -ltn`)

`22 25 631 2000 2005 2006 2022 3000 3001 3002 3007 3010 3012 3015 3016 3017 3018 3019 3020 3021 3025 3035 3080 3082 3100 3101 3105 4096 5001 5050 5056 5436 5678 7777 8001 8085 8086 8088 8090 8095 8096 8099 8123 8129 8642–8648 8765 8775 8787 8890 9010 9015 9016 9020 9090 9119 9121 9122 9130–9143 9443 9900 9901 9905 9906 9907 11025 15432 16379 18025 19100 19101 20128 20241 20242 24678 25432 26543 27017 28000 33208 40692 42155 42159 45857 48293`

**Livres e candidatos** (confirmado): `4200`, `8000`, `8087`, `8088→ocupado`, `8097`, `8098`, `5437`, `3478`, `5349`, `7880`, `7881`, `7882`, `7883`, `38000`, `49160–49260/udp`.

**Serviços que não podem ser tocados** (contratoimplícito do host):
Mendes Delivery (`:3000` + tunnel `mendes-teste.automacaojs.us`), CRM-Hermes (`:3010`),
Supabase (`:28000` Kong, `:25432`/`:26543` pooler), n8n (`:5678`), Evolution GO (`:8096`),
AzuraCast (`:9010`/`:9015`/`:9020`/`:9090`/`:9443`), 9Router (`:20128`),
Astracalls (`:8085` + **`50000/udp`**), Dockge (`:5001`), Prospector (`:3012`/`:9121`),
Hermes A2A (`:9905`/`:9906`/`:9907`).

### 2.3 Postgres existente (a base da T-2)

| Item | Valor medido |
|---|---|
| Container | `supabase-db` — imagem `supabase/postgres:17.6.1.136`, **PostgreSQL 17.6** |
| Rede | `supabase_default` (id `2652d791…`), IP do container `10.0.19.8` |
| Porta | `5432/tcp` **sem publicação no host** → só alcançável por dentro da rede Docker |
| Databases | `postgres`, `_supabase` (+ `template0/1`) |
| `pg_hba.conf` | `local all all trust` · `host all all 127.0.0.1/32 trust` · `host all all all scram-sha-256` |
| Pooler | `supabase-pooler` (`:25432` transacional, `:26543` session) — **contornar**, ver ADR-002 |

O `host all all all scram-sha-256` confirma: **um role novo com senha conecta
pela rede sem gambiarra**. O pooler do Supabase **não** pode ser usado: ele
gerencia pool de transações e não serve como porta de entrada para um
`DATABASE_URL` de aplicação.

### 2.4 Rotas do Cloudflare Tunnel já existentes

O túnel tem **47 hostnames**. Relevantes para este projeto:

| Hostname | Destino atual | Uso neste projeto |
|---|---|---|
| `livekit.automacaojs.us` | `http://localhost:7880` | **já reservado** para o LiveKit — reaproveitar |
| `evo.automacaojs.us` | `http://10.0.4.4:8080` | Evolution API (host g) — não confundir com o Evolution GO |
| `evo-go.automacaojs.us` | `http://127.0.0.1:9121` | Evolution **GO** (`:8096` real, `:9121` é o proxy) |
| `prospector-webhook.automacaojs.us` | `http://127.0.0.1:9121` | — |

Nenhum hostname livre com nome "fleet"/"logistica" existe ainda → **2 rotas novas
a criar** (ver §8).

### 2.5 O que **não** existe no host (verificado)

`livekit/livekit-server` ❌ · `coturn` ❌ · VROOM ❌ · Valhalla ❌ · Valhalla ❌ ·
qualquer container Fleetbase ❌ · qualquer serviço systemd `livekit*`/`coturn*` ❌ ·
nada escutando em `7880` ❌ (a rota do tunnel existe, o backend não).

---

## 3. Visão de arquitetura

```
                                   ┌──────────────────────────────────────────┐
   📱 Navigator App (Android)      │            VPS hermes-prod               │
   ┌───────────────────────────┐   │                                          │
   │ fleetbase/navigator-app   │   │   ┌──────────────┐   ┌────────────────┐  │
   │ (fork, MIT)               │   │   │ fleetbase-api │   │ fleetbase-     │  │
   │ + geolocation-service     │──►│──►│ (Laravel)     │   │ socket         │  │
   │ + livekit RN + kiosk mode │   │   │ 1024 MB       │   │ (websocket)    │  │
   │ + TTS + MMKV/SQLite buf   │   │   └──────┬────────┘   │ 256 MB         │  │
   └───────────────────────────┘   │          │            └────────────────┘  │
            │  ▲                    │   ┌──────┴───────┐   ┌────────────────┐  │
            │  │ UDP 7882 / TURN   │   │ redis:7      │   │ vroom (FASE 2) │  │
            │  │ 3478 / relay      │   │ 160 MB       │   │ 256 MB (opt)   │  │
            │  │                   │   └──────────────┘   └────────────────┘  │
            │  └──────────────────────── LiveKit Server (512 MB) ──────────┐  │
            │                             Coturn (192 MB)                   │  │
            ▼                                                            ▼  │
   ┌────────────────────────┐        ┌──────────────────────────────────────┐ │
   │ web-radio-panel        │◄──────►│ fleetbase-api  (API + webhooks)      │ │
   │ (proprietário, nós)    │  HTTP  │ console removido → painel próprio    │ │
   │ 256 MB                 │        └──────┬───────────────────────────────┘ │
   └────────────────────────┘               │ psql 10.0.19.8:5432/fleetbase_db│
                                             ▼                                  │
                                   ┌──────────────────────────┐                │
                                   │ supabase-db (EXISTENTE)  │                │
                                   │ fleetbase_db (isolado)   │                │
                                   └──────────────────────────┘                │
                                            ┌──────────────────┐                 │
                                            │ Evolution GO     │                 │
                                            │ :8096 (WhatsApp) │◄────────────────┘
                                            └──────────────────┘   webhooks
```

**Três planos, três responsabilidades:**

| Plano | Componentes | Natureza |
|---|---|---|
| **Core** (dados) | `fleetbase-api` (app), `fleetbase-api` (queue), `fleetbase-api` (scheduler), `fleetbase-socket`, `redis` | AGPL — é o Fleetbase |
| **Mídia** (tempo real) | `livekit-server`, `coturn` | Apache-2.0 / BSD-3 — nosso, mas não-GPL |
| **Extensões** (produto) | `web-radio-panel`, `bridge-whatsapp` | **proprietário** — precisa ficar fora do core AGPL (ADR-011) |

---

## 4. Decisões

Formato: **Contexto → Decisão → Consequências → Alternativas descartadas.**

---

### ADR-001 — O que compõe o stack, e o que sai do Fleetbase upstream

**Contexto.** O compose upstream (`fleetbase/fleetbase`, `docker-compose.yml`, 157 linhas) sobe 7 serviços: `cache` (redis:4), `database` (mysql:8.0), `socket`, `scheduler`, `queue`, `console` (Ember, build local), `application` (Laravel/Octane) e `httpd` (nginx, build local). Dois deles (`console`, `httpd`) são **buildados do fonte** e o `console` é a UI de dispatch padrão do Fleetbase.

**Decisão.** Adoptar o core upstream **sem `console` e sem `httpd`**, e sem `database`:
- `console` → substituído pelo **`web-radio-panel` proprietário** (ADR-011), que já entrega mapa + rádio + câmera na v1 (BRD §9). O console padrão do Fleetbase é bonito e genérico, mas não conhece PTT, Olho Vivo nem DVIR — mantê-lo seria manter duas UIs.
- `httpd` → substituído pelo **nginx do host** (que já serve 14 sites em `/etc/nginx/sites-enabled/`), acessado via rota nova de tunnel.
- `database` → **removido**: é a T-2 (ADR-002).
- `cache` → mantido, mas **Redis 7 dedicado** (ADR-003).

**Consequências.**
- ✅ Corta ~2 containers, ~2 build de imagem (tempo) e ~400 MB de RAM.
- ✅ Um lugar só de UI → menos surface de suporte.
- ⚠️ Perdemos o `fleetbase.config.json` padrão do console; o `web-radio-panel` precisa consumir a API do Fleetbase diretamente (`/int/v1/...`).
- ⚠️ O core do Fleetbase original continua AGPL e precisa ser oferecido como source (BRD §10) — manter o núcleo **sem modificá-lo** é o que mantém a ext. proprietária desacoplada.

**Alternativas descartadas.**
- *Manter o console upstream* → duas UIs para o mesmo gestor; +256 MB; o gestor teria duas contas.
- *Buildar o httpd local* → nginx do host já resolve, com menos uma imagem.

---

### ADR-002 — Banco de dados: reuso do Postgres do Supabase (com risco alto e gate)

**Contexto (a premissa mais delicada do projeto).** A T-2 manda **não subir container de banco novo** e reusar o Postgres ativo, criando `fleetbase_db` isolado. Verifiquei o upstream:

| Evidência | Resultado medido |
|---|---|
| `api/config/database.php` (master) | `'default' => env('DB_CONNECTION', 'mysql')` e **`'connections' => []`** (array vazio) |
| `api/.env.example` | `DB_CONNECTION=mysql`, `DB_HOST=127.0.0.1`, `DB_PORT=3306` |
| `scripts/docker-install.sh` | oferece **apenas** "Bundled Docker MySQL (recomendado)" ou "External MySQL server"; monta `DATABASE_URL="mysql://…"` |
| `api/bootstrap/app.php` | comentário: "…`database.connections.mysql` then wins over the one core-api registers, which reads `DATABASE_URL`" |

→ **O Fleetbase upstream é MySQL-first. Não há caminho oficial para Postgres.**

**Decisão.** **Executar a T-2 (reuso do Postgres) como plano principal, mas apenas atrás de um gate técnico explícito**, e com dois planos de fuga prontos:

- **Plano A (T-2, preferido):** database isolado `fleetbase_db` + role `fleetbase_app` no `supabase-db` (10.0.19.8:5432), conectado **direto** (sem pooler), com `DATABASE_URL` em formato `pgsql://`.
- **Plano B (fallback, custo ~640 MB):** `mysql:8.0` dedicado com `innodb_buffer_pool_size=128M`, `performance_schema=OFF`, `skip-log-bin` — cabe no teto, mas consome 640 MB que hoje estão sobrando.
- **Plano C (fallback mais limpo, custo externo):** mesmo core, mas banco + mídia numa micro-VPS de 2 GB.

**Consequências.**
- ⚠️ **Risco R-02 (alto):** as migrations do Fleetbase são escritas para MySQL (`ENUM`, `JSON`, index FULLTEXT, `utf8mb4_0900_ai_ci`, `ON DUPLICATE KEY`, functions de data). Mesmo que o `DB_CONNECTION=pgsql` seja aceito, **várias migrations vão falhar** e o schema não é idêntico. *Isso não se resolve documentando — se resolve testando.*
- ✅ Ganho de ~1 GB de RAM e ~10 GB de disco se funcionar (era o objetivo da T-2).
- ✅ Isolamento total: `fleetbase_db` + role próprio + `search_path` restrito → o stack do Fleetbase **não toca** `postgres`, `_supabase` nem os dados do CRM/Supabase.
- ⚠️ Risco de operação: o `supabase-db` é o Postgres do **Supabase Auth/Realtime/Storage**. Um `CREATE DATABASE` errado ou um `DROP` acidental affecta a autenticação do CRM-Hermes. Por isso: **role sem superuser**, `REVOKE` de `CREATEDB`, backup do `pg_hba.conf` antes.

**Gate obrigatório (P0 — bloqueia qualquer deploy):**
```
F1-VAL-001  Clonar fleetbase/fleetbase, apontar DATABASE_URL=pgsql://…/fleetbase_db,
            rodar `php artisan migrate --force` limpo e medir: (a) roda? (b) quanto RAM?
            (c) o console/leitura da API funciona?
            PASS = 0 erros de migration. FAIL = switch automático para Plano B.
```

**Alternativas descartadas.**
- *Subir MySQL sem gate* → consome 640 MB de um host com swap em 100% e pode não ser necessário.
- *MySQL no mesmo container do Postgres* → impossível/ilego.
- *Rodar o Fleetbase em SQLite* → não serve: multi-tenant, fila e concorrência.

---

### ADR-003 — Redis dedicado (não reaproveitar o Redis existente)

**Contexto.** Há dois Redis no host: `redis-phwrk0sgwwaew76zjepyno4z` (redis:7, **do Evolution API**) e `searxng-valkey` (valkey:9). O Fleetbase usa Redis como **cache, fila e pub/sub do SocketCluster**.

**Decisão.** Redis **7-alpine dedicado**, `192 MB` de limite, `maxmemory-policy noeviction` (fila **não** pode perder chave sob pressão), `prefix=fleetbase_`, `appendonly no` (cache/fila são reconstruíveis), rede interna `fleetbase_net` + `supabase_default` (para o Pub/Sub do socket).

**Consequências.**
- ✅ Isolamento total: se o Redis do Evolution cair, a fila do Fleetbase não é afetada; e vice-versa.
- ✅ `noeviction` impede o modo silencioso "fila perdeu job" que derruba o dispatch.
- ⚠️ +192 MB no orçamento (já contado no §6).
- ⚠️ Redis 7 vs o `redis:4-alpine` do upstream: o Fleetbase usa comandos idempotentes (GET/SET/PUBLISH/LPUSH) — compatíveis. **[A VERIFICAR]** `SOCKETCLUSTER` pode usar comandos específicos.

**Alternativas descartadas.**
- *Reusar o Redis do Evolution com `db=3`* → `maxmemory-policy allkeys-lru` do host vizinho + `flushall` de manutenção mataria a fila do Fleetbase. **Rejeitado.**
- *Valkey* → compatível, mas sem ganho real aqui.

---

### ADR-004 — VROOM adiado para a fase 2 (decisão minha, contra a premissa original)

**Contexto.** A T-4 pede "só o container leve do VROOM (256 MB) apontado por env var `ROUTER_URL` para uma API OSM externa". O VROOM **é** o otimizador multi-ponto; o `ROUTER_URL` é o *roteador* que ele consulta. Se o roteador é externo (FOSSGIS / OpenRouteService), o VROOM local vira um **proxy de otimização** sobre uma API que já resolve rota simples.

Verificação de imagem: `gis-ops/docker-vroom` **não existe mais** no Docker Hub (HTTP 404); o tag upstream vive no GHCR e exige token. [A VERIFICAR] a tag exata antes de qualquer build.

**Decisão.** **Fase 1 (piloto) roda sem VROOM.** O `ROUTER_URL`/`OSRM_HOST` aponta direto para o FOSSGIS
(`https://routing.openstreetmap.de/routed-car/route/v1/driving/`), e o
Fleetbase resolve rota simples sem otimizador multi-ponto. **VROOM entra na fase 2**
(quando houver OS multi-parada de verdade, ex.: caçamba que pega 4 pontos), com
imagem fixada por digest e limite de 256 MB — mesma variável de ambiente,
**sem mudança de código** (é exatamente para isso que a `ROUTER_URL` existe).

**Consequências.**
- ✅ Economiza 256 MB no teto de 4,5 GB **e** uma imagem de ~800 MB no disco.
- ✅ Menos uma peça para o time aprender.
- ⚠️ **Perda**: sem otimização multi-ponto no piloto. Aceitável: as 5 verticais do
  BRD beginm com rotas de 1–2 pontos; otimização vira P2 da fase 2.
- ⚠️ O FOSSGIS é um serviço gratuito e comunitário, sem SLA. Mitigação: teto
  configurável por tenant + cache de rotas (Redis, TTL 24 h) + fallback para o
  OSRM público do projeto (`router.project-osrm.org`, já é o default do upstream).

**Alternativas descartadas.**
- *VROOM na fase 1* → 256 MB + imagem + latência extra para um ganho que o piloto não usa.
- *Valhalla local* → proibido pela T-4 (RAM) e por ser o motor pesado (1 GB+).

---
---

### ADR-005 — Portas: bloco próprio, zero conflito

**Decisão.** Um bloco **8600–8610** para o app + **3478/5349** (TURN) + **7880–7882** (LiveKit) + **38000** (SocketCluster), mais **49160–49260/udp** (relay TURN).

| Porta | Proto | Serviço | Bind no host | Conflito? |
|---|---|---|---|---|
| `8000` | tcp | fleetbase-api (Laravel/Octane) | `127.0.0.1:8000` | ✅ livre (8001 está ocupado pelo Evolution) |
| `4200` | tcp | reservado — painel legado Fleetbase (fora da v1) | — | ✅ livre |
| `38000` | tcp | fleetbase-socket (websocket público) | `127.0.0.1:38000` | ✅ livre |
| `3478` | tcp+udp | coturn (STUN/TURN) | `0.0.0.0:3478` | ✅ livre — **precisa ser público** |
| `5349` | tcp | coturn (TURN over TLS) | `0.0.0.0:5349` | ✅ livre |
| `49160–49260` | udp | coturn (relay range) | `0.0.0.0:49160-49260/udp` | ✅ livre — **não colide com `50000/udp` do Astracalls** |
| `7880` | tcp | livekit-server (HTTP/WS — sinalização) | `127.0.0.1:7880` | ✅ livre; **hostname já reservado** |
| `7881` | tcp | livekit-server (RTC over TCP) | `0.0.0.0:7881` | ✅ livre |
| `7882` | udp | livekit-server (mídia UDP) | `0.0.0.0:7882/udp` | ✅ livre |
| `7883` | udp | livekit-server (mídia UDP reserva) | `0.0.0.0:7883/udp` | ✅ livre |
| `5432` | tcp | **Postgres do Supabase** (em `10.0.19.8`) | **rede interna only** | ✅ sem publicação; conecta por rede Docker |
| `6379` | tcp | redis do fleetbase | **rede interna only** | ✅ sem publicação |

**Regras duras de publicação:**
1. Tudo que é **HTTP/WS** fica `127.0.0.1` → exposto **só** via nginx + Cloudflare Tunnel (que já é o padrão do host: 47 hostnames).
2. Só o **TURN/UDP** sai para `0.0.0.0` — porque **o Cloudflare Tunnel não transporta UDP arbitrário**. É a única exceção, e é inevitável: sem ele o vídeo não funciona em 4G com CGNAT (NF-07).
3. `50000/udp` (Astracalls) fica **intocável** — o relay do TURN usa 49160–49260 para não encostar nele.

**Consequências.** Zero porta em conflito com Mendes/Supabase/n8n/Evolution GO (`§2.2`).
**Alternativas descartadas.** *Usar 7880–7883 para outra coisa* → já são do LiveKit upstream. *Publicar a API em `0.0.0.0`* → Nginx expõe; container em `0.0.0.0` só quando necessário (TURN).

---

### ADR-006 — Orçamento de RAM: teto rígido de 4,5 GB (NF-06)

**Decisão.** Todo container com `deploy.resources.limits.memory` (T-3). **Soma planejada = 3,56 GB**; teto contratual = 4,5 GB (folga de 0,94 GB para o kernel/socket buffers/page cache do Docker).

| Container | Imagem | `mem_limit` | `mem_reservation` | CPU | Papel |
|---|---|---|---|---|---|
| `fleetbase-api` | `fleetbase/fleetbase-api:latest` | **1024 MB** | 512 MB | 1,5 | API HTTP + REST + webhooks |
| `fleetbase-queue` | `fleetbase/fleetbase-api:latest` | **512 MB** | 256 MB | 1,0 | `queue:work` (jobs de telemetria, webhook) |
| `fleetbase-scheduler` | `fleetbase/fleetbase-api:latest` | **256 MB** | 128 MB | 0,5 | `go-crond` |
| `fleetbase-socket` | `fleetbase/fleetbase-socket:latest` | **256 MB** | 128 MB | 0,5 | SocketCluster (eventos ao vivo) |
| `fleetbase-redis` | `redis:7-alpine` | **160 MB** | 80 MB | 0,3 | cache + fila + pubsub |
| `livekit` | `livekit/livekit-server` | **512 MB** | 256 MB | 1,0 | WebRTC (PTT + Olho Vivo) |
| `coturn` | `coturn/coturn` | **192 MB** | 96 MB | 0,5 | TURN/STUN (CGNAT) |
| `web-radio-panel` | `node:22-alpine` + build local | **256 MB** | 128 MB | 0,5 | painel de rádio/câmera (proprietário) |
| `bridge-whatsapp` | `node:22-alpine` + build local | **192 MB** | 96 MB | 0,3 | ponte Evolution GO ↔ Fleetbase (proprietário) |
| **TOTAL fase 1** | | **3 360 MB (3,28 GB)** | | **6,1 CPU** | folga de **1,14 GB** no teto |
| `vroom` *(fase 2)* | `ghcr.io/gis-ops/docker-vroom` | **256 MB** | 128 MB | 0,5 | otimizador multi-ponto |
| `mysql` *(plano B, ADR-002)* | `mysql:8.0` | **640 MB** | 320 MB | 0,5 | fallback de banco |
| **TOTAL fase 1 + VROOM** | | **3 616 MB (3,53 GB)** | | | folga de **0,94 GB** |
| **TOTAL fase 1 + VROOM + MySQL** | | **4 256 MB (4,16 GB)** | | | folga de **0,34 GB** ⚠️ |

**Consequências.**
- ✅ Sob o teto de 4,5 GB mesmo no pior caso (Plano B + VROOM).
- ⚠️ **O pior caso deixa só 340 MB de folga num host com swap em 100%.** É por isso que o gate F1 (§10) exige ≥ 6 GB **disponíveis** (não "totais") antes do deploy.
- ⚠️ `mem_limit` do Docker **não** impede OOM do host se o container estourar rápido demais; por isso `memory_reservation` + `memswap_limit` igual ao `mem_limit` (sem swap por container) — o OOM killer do container mata o processo, não o host.

**Alternativas descartadas.**
- *Subir Valhalla local* → ~1 GB, proibido pela T-4.
- *Rodar LiveKit fora do Docker* → mesma RAM, menos isolamento.
- *MySQL em vez de Postgres sem medir* → 640 MB jogados fora se o Plano A funcionar.

---

### ADR-007 — CGNAT: Coturn dedicado + LiveKit com RTC direto (a parte que faz o produto funcionar)

**Contexto.** O motorista está em 4G/5G, atrás de CGNAT. O fluxo do navegador do LiveKit tenta: (1) UDP direto para a porta RTC → bloqueado por CGNAT; (2) TCP no 7881 → às vezes passa; (3) **TURN relay** → sempre passa (é UDP dentro de UDP/TCP encapsulado, gerenciado pelo servidor TURN). Sem TURN, o cliente cai para ICE "relay" só se houver servidor TURN configurado.

**Decisão.**
- **Coturn dedicado** (`coturn/coturn`), com `--use-auth-secret` (segredo compartilhado com o LiveKit), realm `fleetbase.automacaojs.us`, `--external-ip=156.67.31.108` (fixa o IP público — obrigatório atrás de NAT), `--min-port=49160 --max-port=49260`, `--no-cli`, `--no-multicast-peers`, `--log-file=/var/log/coturn/turn.log`.
- **LiveKit** com `turn.enabled: true`, `turn.domain: <ip ou dns>`, `turn.udp_port: 3478`, `turn.relay_port_range: "49160-49260"`, `turn.secure: false` (o TLS do TURN em 5349 fica como upgrade futuro), `rtc.udp_port: 7882`, `rtc.tcp_port: 7881`, `rtc.use_external_tcp: true`.
- **Só a sinalização** (WS/HTTP na 7880) passa pelo Cloudflare Tunnel (`livekit.automacaojs.us` → `http://localhost:7880`); **a mídia vai direto para `156.67.31.108:7882/udp` ou `3478/udp`** — o tunnel **não transporta UDP**.
- O app usa `@livekit/react-native` (3.2.0) com `region` fixo, `adaptiveStream: true`, `dynacast: true` e **`videoCapture` desligado por padrão**.

**Consequências.**
- ✅ O vídeo funciona em 4G com CGNAT (NF-07) — é o requisito que mata a concorrência ("precisa de rastreador dedicado").
- ✅ 480p/15fps (T-5) ≈ 0,4–0,8 Mbps por fluxo — cabe em 4G ruim.
- ⚠️ O relay TURN consome **banda do servidor** (o dono do cliente paga a VPS, não o motorista). Com 1 sessão de vídeo por vez, ~1 Mbps por sessão → 3 sessões = 3 Mbps de saída. Aceitável.
- ⚠️ **O TURN precisa de porta UDP aberta no host.** O `DOCKER-USER` está vazio (medido) → publicação de porta = aberta no mundo. Precisamos de regra explícita (§7).

**Alternativas descartadas.**
- *TURN embutido no LiveKit* (`turn.enabled` com `redis`/`turn.embedded`) → menos um container, **mas** o coturn dedicado dá controle de porta/log/rotação de segredo e sobrevive a crash do LiveKit. *(O modo embutido fica como plano B se o coturn der problema.)*
- *WebRTC só via TCP* → pior latência e bandwidth que o relay.
- *VPN mesh* → inválido para Centauro/motoboy com CGNAT.

---

### ADR-008 — WhatsApp: Evolution GO como bridge (o `:8096` que já existe)

**Contexto.** O host já tem **Evolution GO** em `127.0.0.1:8096` (container `evolution-go` + `evolution-go-postgres`, de pé há 2 dias). É ele que manda WhatsApp. A T-6 pede: webhooks do Fleetbase → Evolution GO para (a) link de rastreio temporário e (b) alertas operacionais.

**Decisão.**
- O **`web-radio-panel`/serviço `bridge-whatsapp`** (proprietário, ADR-011) é o **único** que fala com a Evolution GO. O core Fleetbase **nunca** fala com Evolution — ele emite **eventos** e o bridge consome.
- Contrato: Fleetbase → `POST {BRIDGE_URL}/events` (JSON, HMAC) → bridge decide a mensagem → `POST {EVOLUTION_URL}/message/sendText/{instance}`.
- O link de rastreio é **auto-expirável** (assinado, TTL padrão 6 h, revogável) — requisito do BRD/PRD (US-INT-01, US-CL-02) e da LGPD.
- A Evolution GO **não** é exposta publicamente; só o bridge fala com ela, em `127.0.0.1:8096`.

**Consequências.**
- ✅ Nenhuma porta nova, nenhum segredo da Evolution no core.
- ✅ O core AGPL não fica acoplado à nossa stack de WhatsApp (regra de compatibilidade).
- ⚠️ Depende da Evolution GO estar **logada** (o TAREFA registra que o WhatsApp do *Prospector* estava "Logged out"; a Evolution GO do Mendes/Formiga é outra instância). Precisa de checagem antes do piloto.
- ⚠️ A T-6 original dizia "Evolution GO (:8096)" — confirmado que `:8096` é a GO. A **Evolution API v2** (`api-phwrk0sgwwaew76zjepyno4z`, porta interna 8080) é **outro** produto, usado pelo CRM-Hermes. Não misturar.

---

### ADR-009 — Segredos: cofre, nunca no repositório

**Decisão.**
- Todo valor sensível vive em `~/claudinho-secrets/<projeto>.env` (chmod 600) e é referenciado como `$VAR`.
- O `.env.shared` do SPEC-KIT tem **chaves e comentários**, **nunca valores**.
- Chaves do LiveKit (`LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`) → no cofre; o `livekit.yaml` referencia `${LIVEKIT_API_KEY}`.
- Segredo do TURN (`TURN_SECRET`) → cofre, idem `LIVEKIT_TURN_SECRET` — **o mesmo valor** nos dois lados.
- HMAC dos webhooks (`WEBHOOK_HMAC_SECRET`) → cofre; o header `X-Fleetbase-Signature: sha256=<hmac>` é calculado com ele.
- **Token de tracking** (link do cliente) é gerado por origem, não lido do cofre: `base64url(tenant.ordenada_vehicle.ordem.exp.nonce)` assinado com `APP_KEY` e TTL embutido.

**Consequências.** ✅ Nenhum segredo em git, em log, ou em resposta de Telegram.

---

### ADR-010 — Rede: dois externals, um bridge

**Decisão.**
```
networks:
  fleetbase_net:      # interna do stack (redis, api, livekit, coturn)
    driver: bridge
  supabase_default:   # EXTERNAL — para alcançar 10.0.19.8:5432
    external: true
```
O `fleetbase-api` participa **das duas** redes; `redis`, `livekit`, `coturn` e `web-radio-panel` ficam só na `fleetbase_net`; `bridge-whatsapp` fica na `fleetbase_net` e fala com a Evolution GO por `host.docker.internal` / `127.0.0.1:8096` via `extra_hosts`.

**Consequências.**
- ✅ O Postgres **não** é publicado no host — só acessível pela rede Docker.
- ✅ Nenhum container novo entra na `supabase_default` além do `fleetbase-api` (superfície mínima).
- ⚠️ `supabase_default` é compartilhada com Supabase Auth/Realtime/Storage — o `fleetbase-api` aparece lá. Sem regra de firewall por container, o vínculo é por nome/senha do role. Aceitável: o role do Fleetbase não tem acesso aos outros DBs.

---

### ADR-011 — Conformidade AGPL-3.0 (mantém o número citado no BRD §10)

**Decisão.** O **core Fleetbase (AGPL-3.0-or-later) fica intacto** e é oferecido como source. **Tudo que é nosso e proprietário** (painel de rádio/câmera, ponte WhatsApp, regras de DVIR/alertas, app fork do Navigator) roda em **serviços separados** que falam com o core **por API pública/webhooks** — nunca por alteração do core, nunca por código servido por ele.

| Componente | Licença | Papel |
|---|---|---|
| `fleetbase/fleetbase` (core) | AGPL-3.0 | core — **não modificado** |
| `fleetbase/fleetops` | AGPL-3.0-or-later | extensão de dispatch — **não modificada** |
| `fleetbase/navigator-app` | MIT (verificar `LICENSE` no clone) | app do motorista — fork **nosso**, MIT não viraliza |
| `livekit-server` + `@livekit/react-native` | Apache-2.0 | mídia |
| `coturn` | BSD-3 | NAT traversal |
| `vroom` | LGPL-2.1 | roteamento (fase 2) — usar como serviço, sem linkar |
| `web-radio-panel`, `bridge-whatsapp`, regras de negócio | **nossa** | serviços desacoplados |

**Consequências.**
- ✅ O produto proprietário não é "derivado" do AGPL: é **cliente da API**.
- ✅ Se um cliente exigir o source do core, entregamos o core **sem** o nosso painel.
- ⚠️ Se em algum momento alguém **modificar** o core (ex.: um `Observer` PHP dentro do Laravel), o core modificado vira AGPL e precisa ser oferecido. Regra da casa: **toda regra de negócio vai em `bridge-*` ou `web-radio-panel`, nunca no core**.

---

### ADR-012 — Observabilidade sem stack novo

**Decisão.** Sem Prometheus/Grafana/ELK (RAM). O que já existe no host e é reutilizado:
- `docker stats` + `journalctl` para RAM dos containers.
- **`ntfy`** (`ntfy-server` em `:8088`, com `ntfy.automacaojs.us` no tunnel) para alertas deops — é o canal que o host já usa.
- **LiveKit traz** `/` (health), `/metrics` (Prometheus-format, opcional) e `turn` logs.
- `healthcheck` Docker em todos os containers (`/health`, `redis-cli ping`, `php artisan queue:status`).
- Logs em JSON no stdout (Docker) com rotação do daemon — **não** criar volume de log.

**Consequências.** ✅ Zero RAM extra. ⚠️ Sem dashboard de RAM por container — o `US-SA-03` (PRD) pede "health do stack"; implementar com `docker stats --no-stream` coletado pelo `bridge-whatsapp` (ou um cron de 5 min) publicando no ntfy.

---

### ADR-013 — Olho Vivo e PTT: sessão sob demanda, sem gravação

**Decisão (detalhe técnico da T-5).**
- **Câmera OFF por padrão**: no `connect()`, `camera: false`; só liga quando o gestor pede.
- A sessão de vídeo é **on-demand e temporária**: TTL padrão **10 min** (configurável — a pergunta P-B5 do PRD está em aberto; default Conservative = 10 min), encerrada pelo servidor ao expirar.
- **480p / 15 fps** fixos (`videoCapture: {resolution: VideoPresets.h480.resolution, frameRate: 15}`).
- Comando pelo **DataChannel** (mensagem confiável):
  ```json
  {"action":"stream_video","state":true,"facing":"back"}
  ```
  → o app liga a câmera traseira; `facing:"front"` → cabine; `state:false` → desliga.
- **PTT**: botão na tela do app, **barra de espaço** no painel web, e botão Bluetooth do volante (via `react-native` BLE — [A VERIFICAR] suporte a PTT por BLE no Android Auto).
  - Ao apertar: mic `unmute`, toca o **beep** (`react-native-sound`), aplica **audio ducking** (volume do app em 30% enquanto fala).
  - Ao soltar: mic `mute`, beep de fim.
- **Sala fixa** `radio-frota-geral` em **escuta passiva** por default (o app conecta com `audio: false` e só ativa o mic no PTT) → o motorista **não gasta banda** ouvindo.
- **TTS**: `react-native-tts` lê as mensagens de texto do chat nativo do Fleetbase em voz alta (P-B2 do PRD: default = **desligado**, ligado por config do veículo — postura de bateria).
- **Nenhuma gravação** de áudio ou vídeo (BRD §9: fora do escopo da v1) → também resolve parte da LGPD.

**Consequências.**
- ✅ Bateria e banda (NF-01/NF-02) respeitadas: upload em repouso ≈ 0.
- ✅ Segurança: sem gravação, sem "botão vermelho" acidental que deixe a câmera aberta.
- ⚠️ `react-native-geolocation-service` **5.3.1** foi publicado em set/2022 → sem manutenção há 3 anos. [A VERIFICAR] compatibilidade com Android 14/15 (`FOREGROUND_SERVICE_LOCATION`) e com o `react-native-maps` fork. **Alternativa**: `react-native-background-geolocation` (pago, T-4 proíbe) ou **escrever 80 linhas de módulo nativo** sobre `LocationManager` — é o plano C se a lib quebrar.

---

### ADR-014 — Fases e gates (a trava "não mexa em produção" vira cronograma)

**Decisão.** Nenhum deploy agora. O trabalho é fatiado em fases, e cada fase tem um **gate verificável**:

| Fase | Entrega | Gate (saída) | Allowed em produção? |
|---|---|---|---|
| **F0** (agora) | 4 docs do dossiê | Isaías aprova BRD/PRD/ADR/SPEC-KIT | ✅ só papel |
| **F1** | Spike técnico em `hermes-prod` **isolado** (compose de teste, sem publicar porta) | F1-VAL-001 (migrations no Postgres) PASS + RAM medida ≤ 1,2 GB | ⚠️ containers de teste, sem tráfego |
| **F2** | Stack completo up, **sem domain público** | `docker stats` dentro do teto; healthchecks verdes; sem OOM | ⚠️ local, porta em `127.0.0.1` |
| **F3** | TURN/LiveKit testados de 4G real | vídeo + PTT com 2 aparelhos em rede CGNAT | ✅ porta UDP aberta |
| **F4** | Rotas de tunnel + domínio | `https://fleetbase.automacaojs.us` 200; `livekit.automacaojs.us` WS handshake | ✅ público |
| **F5** | Piloto com 1 frota âncora (BRD Fase 0) | 3–5 frotas, 60 dias, telemetria + DVIR + link | ✅ comercial |

**Consequências.**
- ✅ Nenhuma mudança em produção até F1, e F1 é reversível (`docker compose down` + `rm` do volume de teste).
- ✅ Cada fase tem critério objetivo — não depende de "acho que tá pronto".

---

### ADR-015 — Rollback

**Decisão.** Cada fase tem rollback de 1 comando, definido antes de subir:
- F1: `docker compose -p fbtest down -v` (volume de teste separado).
- F2: `docker compose -p fleetbase down` + `docker network rm fleetbase_net`. **O Postgres não é tocado** — `fleetbase_db` fica (dados inertes) e é removido só com `DROP DATABASE` explícito.
- F3/F4: fechar as portas no `DOCKER-USER` + remover as 2 rotas do tunnel (PUT na API — skill `cf-tunnel-edge-sync`).
- **Regras de volumes e registros:** `docker compose` sempre com `-p fleetbase` (projeto nomeado) e volumes com prefixo `fleetbase_`, para `docker volume prune` nunca tocar o stack.

---

### ADR-016 a ADR-025 — as decisões da rodada de 18/11/2026

As dez ADRs que nasceram das 22 decisões aprovadas pelo Isaac em 18/11/2026 estão
detalhadas em **§12.2**, junto do registro completo (Q-001..Q-110) em §12.1:

| ADR | Assunto | Decisão |
|---|---|---|
| **ADR-016** | Plano de mídia desacoplado por variável de host | `LIVEKIT_HOST`, `TURN_EXTERNAL_IP`, `RADIO_PUBLIC_URL`… — virada para a VPS-2 sem mudar código |
| **ADR-017** | TURN em subdomínio DNS-only | `turn.automacaojs.us` sem proxy Cloudflare (UDP não passa pelo tunnel) |
| **ADR-018** | Fuso horário por tenant | `tenant.timezone` (IANA) no modelo desde a fase 1 |
| **ADR-019** | Olho Vivo: só o Gestor solicita na v1 | permissão por tenant, receptor = solicitante + gestor |
| **ADR-020** | Idempotência | `event_id` da origem + `idempotency_key` determinística |
| **ADR-021** | Link de rastreio por evento | expira na conclusão da OS, teto de 24 h |
| **ADR-022** | TTS só em movimento | liga com o veículo em movimento (GPS, com histerese) |
| **ADR-023** | Limiares de alerta | desvio 300 m / 10 min; parada 15 min |
| **ADR-024** | Teto de RAM | 4,5 GB formal, 3,6 GB real (VROOM e MySQL exclusivos) |
| **ADR-025** | Telemetria e buffer | polling 30 s / 60 s em background; buffer SQLite |

---

## 5. Matriz de portas (verificação de conflito)

| Porta | Tipo | Usada hoje por | Stack novo | Veredito |
|---|---|---|---|---|
| 8000 | tcp | — | fleetbase-api | ✅ livre |
| 4200 | tcp | — | (reservado) | ✅ livre |
| 38000 | tcp | — | fleetbase-socket | ✅ livre |
| 3478 | tcp/udp | — | coturn | ✅ livre |
| 5349 | tcp | — | coturn (TLS) | ✅ livre |
| 49160–49260 | udp | — | coturn relay | ✅ livre |
| 7880 | tcp | — | livekit (sinalização) | ✅ livre (rota já reservada) |
| 7881 | tcp | — | livekit (RTC/TCP) | ✅ livre |
| 7882 | udp | — | livekit (mídia) | ✅ livre |
| 7883 | udp | — | livekit (mídia reserva) | ✅ livre |
| 5432 | tcp | supabase-db (10.0.19.8) | **reuso, sem publicação** | ✅ sem conflito |
| 6379 | tcp | redis do Evolution / valkey | **redis novo, rede interna** | ✅ sem conflito |
| 8096 | tcp | **evolution-go** | (só o bridge fala) | ✅ intocado |
| 50000 | udp | **astracalls-engine** | **evitado de propósito** | ✅ intocado |

**Comando de conferência antes do deploy (read-only):**
```bash
for p in 8000 4200 38000 3478 5349 7880 7881 7882 7883; do
  ss -ltn "sport = :$p" | tail -n +2 | grep -q . && echo "⚠️  $p OCUPADA" || echo "✅ $p livre"
done
ss -lun | grep -E ':(3478|7882|7883|4916[0-9]|49[2-6][0-9])' | grep -v 50000
```

---
## 6. Orçamento de RAM detalhado (leitura de container)

### 6.1 Teto contratual vs. disponível

| Métrica | Valor | Fonte | Leitura |
|---|---|---|---|
| RAM total | 24,0 GB | `/proc/meminfo` | OK |
| RAM **disponível** | **7,28 GB** | `/proc/meminfo` | ⚠️ folga apertada: o host já roda 20+ containers |
| Swap total | 4095 MB | `free -h` | — |
| Swap **usado** | **4095 MB (100%)** | `free -h` | 🔴 **sinal de pressão de memória já existente** |
| Disco livre | 190 GB | `df -h /` | OK (mas cuidado com `docker prune`) |
| vCPU | 8 | `nproc` | OK (orçamento total: 6,1 CPU) |

> **Regra dura (gate G-RAM):** o stack só sobe se `MemAvailable ≥ 6 GB` **e** swap usada ≤ 80 % no momento do deploy. Se não houver, o **plano de mídia** (LiveKit + Coturn = 704 MB + NAT traversal pesado) vai para um micro-VPS de 2 GB (ADR-002 Plano C / §10 F1.5) — sem isso o OOM killer do host começa a matar container dos outros projetos.

### 6.2 Consumo por container (orçamento)

| Container | `mem_limit` | `mem_reservation` | `memswap_limit` | Pico real estimado | Observação |
|---|---|---|---|---|---|
| `fleetbase-api` | 1024 MB | 512 MB | 1024 MB | ~600 MB | Laravel/Octane; o `api` faz o parse de telemetria em lote |
| `fleetbase-queue` | 512 MB | 256 MB | 512 MB | ~200 MB | 1 worker; `queue:work --sleep=3` |
| `fleetbase-scheduler` | 256 MB | 128 MB | 256 MB | ~40 MB | `go-crond` dorme 99 % do tempo |
| `fleetbase-socket` | 256 MB | 128 MB | 256 MB | ~90 MB | 1 processo Node; escala horizontal só se necessário |
| `fleetbase-redis` | 160 MB | 80 MB | 160 MB | ~60 MB | `maxmemory 96mb` + `noeviction` |
| `livekit` | 512 MB | 256 MB | 512 MB | ~350 MB | 1 sala; o consumo cresce com o número deTracks |
| `coturn` | 192 MB | 96 MB | 192 MB | ~70 MB | relay de 1 sessão |
| `web-radio-panel` | 256 MB | 128 MB | 256 MB | ~120 MB | Next/Vite estático + API fina |
| `bridge-whatsapp` | 192 MB | 96 MB | 192 MB | ~90 MB | Node + Evolution client |
| **SOMA (fase 1)** | **3 360 MB** | 1 696 MB | 3 360 MB | **~1,62 GB** | folga de **1,14 GB** até o teto de 4,5 GB |
| `vroom` (fase 2) | 256 MB | 128 MB | 256 MB | ~180 MB | deixa a folga em **0,94 GB** |
| `mysql` (Plano B) | 640 MB | 320 MB | 640 MB | ~300 MB | deixa a folga em **0,34 GB** ⚠️ |

### 6.3 `mem_limit` ≠ garantia

`deploy.resources.limits.memory` (v2) e `mem_limit` (v1) **limitam** o container; o kernel ainda pode demorar a matar. Mitigação no compose: `memswap_limit == mem_limit` (sem swap por container → o OOM killer do **container** age antes de o do **host**) + `memory_reservation` (o soft limit evita que o container *roube* memória dos vizinhos).

---

## 7. Rede e firewall

### 7.1 Topologia de rede

```
internet (4G/5G, CGNAT)
   │  udp/7882 (mídia)  ┐
   │  tcp/7881 (RTC)    ├──► livekit  (0.0.0.0:7881-7883)
   │  udp/3478 (TURN)   ┘        coturn  (0.0.0.0:3478, 49160-49260)
   │  ws/443 (sinalização) ──► Cloudflare Tunnel ──► livekit.automacaojs.us → 127.0.0.1:7880
   │  https/443 ──────────► Cloudflare Tunnel ──► fleetbase.automacaojs.us → 127.0.0.1:8000
   │
   └──► rede Docker `fleetbase_net` (bridge, sem host)
          fleetbase-api ──► fleetbase-redis (6379)
                         └► fleetbase-socket (8000 interno)
                         └► supabase_default (10.0.19.8:5432)  [Postgres: fleetbase_db]
          livekit ──► (nada externo; fala com clients via IP público)
          bridge-whatsapp ──► host.docker.internal:8096 (Evolution GO)
```

### 7.2 Firewall — sem `ufw` no host

Medido: **`ufw` não existe** neste host e a chain `DOCKER-USER` do iptables está **vazia** (sem filtro). Portanto a única alavanca de filtragem é o `DOCKER-USER` + as regras do `DOCKER` chain (que, com publicação de porta, faz NAT e **deixa passar**).

**Regras mínimas propostas (F3 — a partir daí)** — **NÃO aplicadas agora**:

```bash
# 1).default: tudo que não for o stack é DROP no DOCKER-USER (começar com policy DROP só após teste)
iptables -N FLEETBASE-IN 2>/dev/null || true
iptables -A DOCKER-USER -s 10.0.19.8/32 -j ACCEPT          # Postgres do Supabase (rede interna)
iptables -A DOCKER-USER -p udp --dport 3478 -j ACCEPT      # TURN STUN
iptables -A DOCKER-USER -p udp --dport 49160:49260 -j ACCEPT # relay TURN
iptables -A DOCKER-USER -p udp --dport 7882:7883 -j ACCEPT  # mídia LiveKit
iptables -A DOCKER-USER -p tcp --dport 7881 -j ACCEPT       # RTC TCP
iptables -A DOCKER-USER -p tcp --dport 5349 -j ACCEPT       # TURN TLS
# 2) protect o host das portas que NÃO são do stack
iptables -A DOCKER-USER -p tcp --dport 5001 -j DROP         # Dockge (só local)  [A VERIFICAR se já há regra]
iptables -A DOCKER-USER -p tcp --dport 3000 -j DROP         # Mendes app
```

> ⚠️ **Cuidado operacional:** mexer na `DOCKER-USER` afeta **todos** os containers do host. A regra 1 acima (Postgres) é obrigatória — sem ela o `fleetbase-api` pode perder acesso ao banco. Recomendo aplicar **depois** de o gate F2, com `iptables-save > /root/backups/iptables-YYYYMMDD-HHMM.rules` antes, e **testar o rollback**.

### 7.3 DNS e hostname

- `fleetbase.automacaojs.us` → `http://localhost:8000` (novo hostname; precisa ser adicionado na Edge do tunnel via **PUT na API da Cloudflare** — skill `cf-tunnel-edge-sync`, nunca editando o disco).
- `livekit.automacaojs.us` → `http://localhost:7880` (**já reservado** no disco; confirmar que está **também** na Edge — os dois podem divergir, ver `cf-tunnel-edge-sync`).
- `track.automacaojs.us` → servidor de link de rastreio auto-expirável (serviço do `web-radio-panel`, TTL 6 h).

---

## 8. Reverse proxy e exposição

**Nginx do host** (`/etc/nginx/sites-enabled/`) — o host já serve ~14 sites nesse padrão; o Fleetbase entra como mais um `server` block:

```nginx
# /etc/nginx/sites-available/fleetbase  (pré-requisito: symlink em sites-enabled)
server {
    listen 443 ssl http2;
    server_name fleetbase.automacaojs.us;

    location / {
        proxy_pass http://127.0.0.1:8000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # WebSocket do SocketCluster (telemetria ao vivo)
    location ~ ^/socket/ {
        proxy_pass http://127.0.0.1:38000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 3600s;
    }
}
```

**Regras:**
- O container `httpd` do upstream Fleetbase **não** é usado (ADR-001) — nginx do host faz o papel e reaproveita o TLS do Cloudflare (origin Full/Strict).
- O painel de rádio (`web-radio-panel`) entra como **outro** `server` block, ou como subpath `/radio` — [A VERIFICAR] se o tunnel atual faz path-based routing.
- `livekit.automacaojs.us` é handshake WS direto no tunnel para `127.0.0.1:7880` — sem nginx (o LiveKit já serve TLS atrás do tunnel).
- **Nada de porta 8000/38000 publicada em `0.0.0.0`.**

---

## 9. Riscos e mitigações

| ID | Risco | Prob. | Impacto | Mitigação | Dono |
|---|---|---|---|---|---|
| R-00 | **Fleetbase não roda em Postgres** (upstream é MySQL-only) | **Alta** | **Alto** | Gate F1-VAL-001 com 3 planos (A/B/C) — ADR-002 | Claudinho |
| R-01 | RAM: OOM do host derruba outros projetos | Média | **Alto** | `mem_limit` + `memswap` + gate MemAvailable ≥ 6 GB + mídia em micro-VPS se preciso | Claudinho |
| R-02 | Swap 100 % cheia já agora | **Alta** | Alto | Ação antes do F1: identificar e/ou reiniciar o culpado; ver `project-vps-load-diagnostico-20261117` | Isaías |
| R-03 | CGNAT: vídeo não abre em 4G | Média | Alto | Coturn dedicado + relay range (ADR-007) + teste com 2 chips reais | F3 |
| R-04 | `react-native-geolocation-service` sem manutenção desde 2022 | Média | Alto | Fallback: módulo nativo próprio sobre `LocationManager` (ADR-013) | F2 |
| R-05 | `react-native-maps` (Google/paid) ainda no Navigator | **Alta** | Médio | Remover/substituir por OSM (react-native-maps-url / WebView leaflet) — T-4 | F2 |
| R-06 | Evolution GO deslogada → alertas WhatsApp não saem | Média | Alto | Checagem de sessão antes do piloto + fila/retry no bridge | F5 |
| R-07 | AGPL: alguém modifica o core e vaza IP | Baixa | **Alto** | ADR-011 + regra "toda regra no `bridge-*`" + revisão de PR | Isaías |
| R-08 | Vazamento de áudio/vídeo (LGPD) | Baixa | Alto | Sem gravação; TTL de 10 min; log de quem pediu a sessão (AUDIT) | F3 |
| R-09 | Link de rastreio vazado (cliente vê rota de outro) | Média | Alto | Token assinado + TTL 6 h + revogação + escopo por tenant | F2 |
| R-10 | Fila do `queue:work` acumula e estoura RAM | Média | Médio | `mem_limit` 512 MB + `--max-jobs` + monitoramento de profundidade | F2 |
| R-11 | `docker prune` apaga volume do stack | Baixa | Alto | Prefixo `fleetbase_` + projeto nomeado `-p fleetbase` (ADR-015) | Claudinho |
| R-12 | Drift tunnel (disco ≠ Edge) → 404 no domínio | **Alta** | Médio | PUT na API da Cloudflare (skill `cf-tunnel-edge-sync`) como passo obrigatório do F4 | Claudinho |
| R-13 | Evolution GO ≠ Evolution API v2 — integrar a errada | Média | Alto | ADR-008 fixa `:8096` = GO; documentar na spec (Q-00x) | Claudinho |
| R-14 | Host sem espaço em disco para 9 containers | Baixa | Alto | `df` + política de imagens (prune manual com tag) | Claudinho |

---

## 10. Fases de implantação e gates

```
F0 ──(papel)──▶ F1 ──(spike)──▶ F2 ──(stack local)──▶ F3 ──(4G real)──▶ F4 ──(público)──▶ F5 ──(piloto)
  │                │                │                    │                   │                │
docs            F1-VAL-001      G-RAM                 2 chips           DNS+Edge        3-5 frotas
aprovados       migrations OK   MemAvail>=6GB         vídeo+PTT        200 + WS        60 dias
                RAM<=1,2GB      sem OOM                                  handshake
```

### Gate F1-VAL-001 (o mais crítico — banco)

**Objetivo:** provar (ou derrubar) a hipótese do ADR-002 Plano A.

```bash
# 1) criar DB + role isolado no Postgres existente (READ-ONLY check antes)
docker exec supabase-db psql -U postgres -c "SELECT datname FROM pg_database;"

# 2) criar role e banco (F1 — ainda não feito)
#    CREATE ROLE fleetbase_app LOGIN PASSWORD '<do cofre>' NOSUPERUSER NOCREATEDB;
#    CREATE DATABASE fleetbase_db OWNER fleetbase_app;

# 3) subir a API com DATABASE_URL=pgsql://fleetbase_app:<senha>@supabase-db:5432/fleetbase_db
# 4) o teste que decide:
docker exec -it fb-api php artisan migrate --force
#    PASS  = 0 erros de migration  → segui com Plano A
#    FAIL  = qualquer erro         → switch para Plano B (MySQL 640 MB) ou C (micro-VPS)
```

**Sem o gate F1-VAL-001 PASS, nenhuma das fases seguintes começa.**

---

## 11. Checklist pré-deploy (read-only, executável hoje sem mudar nada)

```bash
# 1) RAM e swap
grep -E 'MemTotal|MemAvailable' /proc/meminfo
free -h | head -3

# 2) portas livres do bloco do stack
for p in 8000 4200 38000 3478 5349 7880 7881 7882 7883; do
  ss -ltn "sport = :$p" | tail -n +2 | grep -q . && echo "OCUPADA $p" || echo "livre  $p"
done

# 3) relay range TURN livre (e 50000/udp intacto)
ss -lun | grep -E ':(49[1-6][0-9]|49[2-6][0-9]|50000)' || echo "range livre"

# 4) Postgres acessível na rede do Supabase
docker exec supabase-db psql -U postgres -tAc "select version();"
docker network inspect supabase_default --format '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}'

# 5) volume do stack inexistente (nada criado ainda)
docker volume ls | grep -i fleetbase || echo "sem volumes fleetbase (ok)"

# 6) Evolution GO viva em :8096
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8096/

# 7) imagem do VROOM existe? (fase 2)
docker manifest inspect ghcr.io/gis-ops/docker-vroom:latest >/dev/null 2>&1 \
  && echo "vroom OK" || echo "vroom INDISPONIVEL -> usar FOSSGIS (ADR-004)"

# 8) chain DOCKER-USER (deve estar vazia hoje)
iptables -S DOCKER-USER | head -20
```

---

## 12. Decisões fechadas (18/11/2026 — aprovadas pelo Isaac)

> As **22 perguntas** (Q-001..Q-012 + Q-101..Q-110) foram respondidas em uma rodada
> única em 18/11/2026. A partir daqui elas **não são mais perguntas**: são decisões
> registradas. As que mexem na arquitetura viraram ADR nova (ADR-016..ADR-025).
> O material usado para decidir está em `05-DECISOES-PENDENTES.md`.

### 12.1 Registro das 22 decisões

| ID | Pergunta original | Decisão aprovada (18/11/2026) | Efeito na arquitetura |
|---|---|---|---|
| Q-001 | Postgres ou MySQL? | **Opção A** — Postgres reusando o Supabase, **condicionada ao gate F1-VAL-001** (`php artisan migrate --force` limpo). Plano B (MySQL 8, 640 MB) como **fallback automático** | ADR-002 mantida. O compose final só é fechado após o gate |
| Q-002 | Onde roda LiveKit + Coturn (704 MB)? | **Opção A agora** — na `hermes-prod`, **se** `MemAvailable ≥ 6 GB` após limpeza de swap. **Regra de contingência e escala**: ao contratar a **VPS-2 (Mídia & Streaming)**, migrar **todo** o bloco de mídia (LiveKit + Coturn) **e** o stack de Rádios (`radio.automacaojs.us` / `radio-louvor`) para a VPS-2, deixando a `hermes-prod` **100 % dedicada** a bancos, APIs e SaaS | **ADR-016** (nova) + topologia preparada em §12.3 |
| Q-003 | Nomes de domínio? | **Opção A** — `fleetbase`, `livekit`, `radio` e `track` em `.automacaojs.us`, **com subdomínio TURN em DNS-only (sem proxy Cloudflare)** para tráfego UDP | **ADR-017** (nova) |
| Q-004 + Q-110 | PTT via Bluetooth do volante na v1? | **Opção A na v1** — PTT de tela + barra de espaço. **BLE HID genérico na v1.1** | ADR-013 mantida; BLE vira tarefa da fase 2 |
| Q-005 + Q-107 + Q-108 | Quem pode pedir vídeo? | **Opção B na v1** — **somente o Gestor** solicita; **receptor = solicitante + gestor**. Evolui para **permissão por tenant**. O motorista **não** solicita na v1 | **ADR-019** (nova) |
| Q-006 | Duração da sessão de vídeo | **Opção C** — 10 min default, **configurável por tenant**, com **teto rígido de 30 min** | ADR-013 atualizada |
| Q-007 | TTS do chat: ligado ou desligado? | **Opção A + C** — desligado por padrão e **liga automaticamente só quando o veículo está em movimento (GPS)** | **ADR-022** (nova) |
| Q-008 | Validade do link de rastreio | **Opção D** — link válido **até a conclusão da OS**, com **teto máximo de 24 h** | **ADR-021** (nova) |
| Q-009 + Q-101 | Chave de idempotência | **Opção C** — `event_id` (UUID da origem) **+** `idempotency_key` determinística calculada no servidor | **ADR-020** (nova) |
| Q-010 | Honduras (UTC-6) na fase 1? | **Opção C** — **fuso horário por tenant no modelo desde a fase 1** (Brasil UTC-3, Honduras UTC-6) | **ADR-018** (nova) |
| Q-011 | Fleet-Ops entra na fase 1? | **Opção A** — sim, como extensão do core, substituindo o `console` pelo Nginx do host | ADR-001 mantida |
| Q-012 | Teto de RAM: 4,5 GB ou 3,5 GB? | **Opção C** — teto **formal de 4,5 GB**, com **exclusão mútua VROOM/MySQL** mantendo consumo real **≤ 3,6 GB** | **ADR-024** (nova) |
| Q-102 | Telemetria: push ou polling? | **Confirmado** — polling 30 s (60 s em background) | **ADR-025** (nova) |
| Q-103 | Buffer offline: SQLite ou MMKV? | **Confirmado** — SQLite | **ADR-025** (nova) |
| Q-104 | Limiar de desvio | **Opção B** — **300 m por 10 min** | **ADR-023** (nova) |
| Q-105 | Parada prolongada | **Opção A** — **15 min** | **ADR-023** (nova) |
| Q-106 | Cliente final vê ETA? | **Confirmado** — **só posição** na v1 | PRD US-CL-01 (mantido) |
| Q-109 | `facing` default | **Confirmado** — `back` (estrada) | ADR-013 mantida |

### 12.2 As decisões que viraram ADR nova

#### ADR-016 — Plano de mídia desacoplado por variável de host (virada para a VPS-2 sem refator)

**Contexto.** A decisão Q-002 fixa a mídia na `hermes-prod` **enquanto couber** e define a
contingência: quando existir a **VPS-2 (Mídia & Streaming)**, LiveKit + Coturn + o stack de
Rádios migram para lá e a `hermes-prod` fica só com bancos, APIs e SaaS. Uma migração dessas
no meio de uma operação rodando (frotas na rua, rádio ativo) não pode exigir mudança de
código — só de configuração.

**Decisão.** **Nenhum host é escrito no código.** Tudo que aponta para o plano de mídia
passa a ser variável de ambiente, lida de um único lugar:

| Variável | Hoje (hermes-prod) | Depois (VPS-2) | Quem lê |
|---|---|---|---|
| `LIVEKIT_HOST` | `livekit.automacaojs.us` | `livekit.<vps2>` ou o mesmo nome apontando para a VPS-2 | app (RN), painel web, bridge |
| `LIVEKIT_URL` | `wss://livekit.automacaojs.us` | idem, com o DNS trocado | app, painel |
| `TURN_EXTERNAL_IP` | `156.67.31.108` | `<ip-publico-vps2>` | `turnserver.conf`, `livekit.yaml` |
| `LIVEKIT_TURN_DOMAIN` | `turn.automacaojs.us` | idem | coturn (`realm`), livekit (`turn.domain`) |
| `LIVEKIT_RELAY_MIN_PORT` / `LIVEKIT_RELAY_MAX_PORT` | `49160` / `49260` | idem | coturn, livekit (`relay_range`) |
| `RADIO_PUBLIC_URL` | `radio.automacaojs.us` | idem (DNS para a VPS-2) | app, painel |
| `RADIO_LOUVOR_URL` | `radio-louvor.<host>` | idem | app, painel |

> **Nomenclatura canônica = SPEC-KIT §3.1.** O ADR-016 e o SPEC §10.5.2 apontam para a
> mesma lista de nomes — não criar duas nomes para a mesma variável.

O `livekit.yaml` e o `turnserver.conf` passam a ser **templates renderizados a partir do
`.env.shared`** (já existente no SPEC-KIT §3) — nunca valores literais.

**Consequências.**
- ✅ A virada para a VPS-2 é: trocar o DNS (registro A de `turn`/`livekit`), renderizar o
  `livekit.yaml` com o novo `TURN_EXTERNAL_IP`, reiniciar LiveKit + Coturn. **Sem mudança de
  código, sem novo deploy do app.**
- ✅ A `hermes-prod` volta a ser só "dados e API" — o que libera RAM para o F1 e para o
  resto dos projetos (vide §12.4).
- ⚠️ **O `external-ip` do coturn e do LiveKit precisam bater com o IP público real da
  VPS-2** — erro aqui é o sintoma clássico de "vídeo não abre em 4G". Mitigação: o checklist
  de cutover em §12.3 exige `dig +short` do hostname e conferência do IP antes de cortar.
- ⚠️ O relay UDP do TURN precisa estar **aberto no firewall da VPS-2** (`3478/udp` +
  `49160-49260/udp`). Na `hermes-prod` isso é iptables/DOCKER-USER (ADR §7.2); na VPS-2
  será firewall do provedor ou `ufw`.

**Alternativas descartadas.**
- *Varrer o host do LiveKit no código* → refator na hora da virada, com risco em produção.
- *Já nativer na VPS-2 desde o início* → 704 MB de RAM do `hermes-prod` economizados cedo,
  mas o custo de operar 2 máquinas desde o dia 1 do piloto, sem o piloto pagando por isso.

---

#### ADR-017 — TURN em subdomínio próprio, DNS-only (sem proxy Cloudflare)

**Contexto.** O Cloudflare Tunnel **não transporta UDP**. Se o hostname do TURN passar pelo
proxy do Cloudflare, o cliente tenta falar com o proxy e falha — o sintoma é "no wi-fi
funciona, em 4G não". O hostname do LiveKit (sinalização WS) **pode** ir pelo tunnel.

**Decisão.** **O TURN ganha hostname próprio** — `turn.automacaojs.us` — registrado como
**DNS-only (nuvem cinza, sem proxy)**, apontando para o IP público direto do host que roda o
Coturn (`156.67.31.108` hoje; `<ip-vps2>` depois). `livekit.automacaojs.us` **continua** pelo
tunnel (é só sinalização WS/HTTP, já reservado na Edge).

**Consequências.**
- ✅ A mídia UDP nunca depende do Cloudflare — que é justamente o ponto.
- ✅ `turn.automacaojs.us` continua resolvendo para o mesmo nome quando a mídia migrar para a
  VPS-2: **só o registro A muda**.
- ⚠️ O registro DNS **tem que ficar em "DNS only"** — se alguém ligar o proxy laranja por
  engano, o Olho Vivo em 4G morre sem erro visível. Mitigação:
  item no checklist pré-deploy (§11) e no de cutover (§12.3).

**Alternativas descartadas.**
- *TURN atrás do tunnel* → impossível, o tunnel é TCP/HTTP.
- *TURN em `livekit.automacaojs.us` com proxy* → mesmo problema, e mistura sinalização com mídia.

---

#### ADR-018 — Fuso horário por tenant no modelo, desde a fase 1

**Contexto.** O sistema armazena **sempre UTC** (NF-14) e exibe no fuso do tenant. Com a
decisão Q-010 (Opção C), o fuso **entra no modelo agora** — Brasil UTC-3, Honduras UTC-6 —
para não ter retrofit depois. O `NF-14` original só previa BRT.

**Decisão.** Campo `timezone` (IANA, ex.: `America/Sao_Paulo`, `America/Tegucigalpa`) na
entidade **tenant**, com default `America/Sao_Paulo`. Todo carimbo de tempo gravado é UTC
com `Z`; **toda exibição** converte para o fuso do tenant. O endereço do cliente final e o
horário do link de rastreio seguem o fuso do tenant.

**Consequências.**
- ✅ Honduras (UTC-6) e qualquer outro mercado entram sem mudança de esquema.
- ✅ O "6 h" do link de rastreio (que virou "até a OS / teto 24 h", ADR-021) é sempre
  computado em UTC — imune a horário de verão e a mudança de fuso do tenant.
- ⚠️ Todo relatório que agrupa por dia precisa usar o fuso do tenant, não UTC — é o erro
  clássico de "o relatório de ontem inclui o pedido de hoje". Regra na SPEC §5.

**Alternativas descartadas.**
- *Fuso fixo BRT e.converter na hora de abrir o mercado hondurenho* → retrofit em todo
  relatório já existente.

---

#### ADR-019 — Olho Vivo: só o Gestor solicita na v1, permissão por tenant

**Contexto.** Decisão Q-005/Q-107/Q-108. O item mais sensível do produto: liga a câmera do
veículo de um motorista. "Quem tem o botão" é decisão de permissão, de auditoria e de
confiança do motorista — e o risco real é a **cultura**: se o motorista acha que está sendo
vigiado o tempo todo, o produto quebra na rua.

**Decisão.**
- **v1: somente o perfil Gestor** pode solicitar uma sessão de vídeo.
- **Receptores: solicitante + gestor** (mínimo necessário para a operação; nada de "sala
  inteira" e nada de OTHER empresa).
- **O motorista nunca solicita** o vídeo da própria câmera na v1 (decisão explícita).
- **O embarcador de outra empresa não solicita** na v1.
- A permissão evolui para **por tenant** (flag `tenant.can_request_video`), com o default
  herdado da decisão: **somente gestor**.
- **Toda solicitação gera evento de auditoria**: quem pediu, de qual tenant, para qual
  veículo, quando, e quando a sessão começou e terminou.

**Consequências.**
- ✅ Escopo mínimo, risco mínimo, e o "quem pode" vira **configuração**, não código, quando
  o cliente pedir para o embarcador entrar.
- ✅ O app do motorista nunca expõe o botão de câmera — nem por engano, nem por bug de
  permissão.
- ⚠️ Se um cliente piloto exigir que o embarcador veja a carga, é **config** (flag do
  tenant) + um receptor a mais. É a evolução planejada, não um retrabalho.

**Alternativas descartadas.**
- *Embarcador solicitante na v1* → camera de motorista acessada por empresa de fora sem
  acordo formal; risco de confiança e de LGPD sem preparação.
- *Motorista solicitando a própria câmera* → inverte a lógica de surveillance do produto.

---

#### ADR-020 — Idempotência: `event_id` da origem + chave determinística no servidor

**Contexto.** Decisão Q-009/Q-101 (Opção C). O core reenvia webhook 5 vezes com backoff; o
bridge precisa saber se já processou. Só um dos dois lados cobre o problema todo.

**Decisão.**
- `event_id` — **UUID gerado na origem** (app ou core), identifica o **evento**.
- `idempotency_key` — **determinística, calculada no servidor receptor**:
  `sha256(event_type + subject.id + occurred_at + sha256(payload))`.
- `correlation_id` — atravessa a cadeia (um `os_id` ou `turno_id`).
- Duas fontes de duplicidade são tratadas por campos diferentes: **reenvio** (mesmo
  `event_id`) → colide no `event_id`; **fato repetido** (o app reemite o mesmo desvio com
  `event_id` novo) → colide na `idempotency_key` **se** `occurred_at` for o mesmo.

**Consequências.**
- ✅ O receptor guarda `event_id` **e** `idempotency_key` (índice único nos dois) e descarta
  o duplicado sem recomputar efeito.
- ✅ O envelope continua com **campos desconhecidos ignorados** (SPEC §4.1) — evoluir o
  contrato não quebra nenhum dos lados.
- ⚠️ O `occurred_at` precisa vir do **servidor de origem**, não do relógio do celular — o
  app envia o timestamp do servidor que recebeu o batch. Contrato: SPEC §5.1.

**Alternativas descartadas.**
- *Só `event_id`* → o app recriando o id num retry duplica efeito.
- *Chave por (evento, OS, minuto) — a "opção B" do pacote* → janela de 1 minuto deixa passar
  o mesmo evento em horário de pico.

---

#### ADR-021 — Link de rastreio por evento de negócio, teto de 24 h

**Contexto.** Decisão Q-008 (Opção D). O link é assinado (JWT), revogável e dá ao cliente a
posição do veículo. Validade por relógio é arbitrária; a fronteira natural é o **fim da OS**.

**Decisão.** O link expira quando a **OS é concluída** (evento `carga.descarga.concluida` /
`os.concluida`), com **teto duro de 24 h** mesmo que a OS nunca seja concluída. A revogação
manual continua disponível (e é o que o gestor usa para "o cliente desistiu").

**Consequências.**
- ✅ O cliente final acompanha **até o fim real** da entrega, sem precisar pedir novo link.
- ✅ A janela de exposição fica no mínimo necessário, sem depender de relógio do servidor.
- ⚠️ Se a OS ficar parada (OS aberta que ninguém fecha), o link vive 24 h. Mitigação: job
  de expiração em `SPEC §10` que revoga na expiração mesmo sem conclusão da OS.
- ⚠️ O "fim da OS" precisa ser um evento confiável — se o app ficar offline no ato da
  descarga, o link só morre no teto de 24 h. Aceitável.

**Alternativas descartadas.**
- *6 h fixas* → o cliente perde o acesso no meio de uma viagem longa (era exatamente a
  pergunta do pacote).
- *24 h fixas sem evento* → mantém o link vivo depois da entrega, sem motivo.

---

#### ADR-022 — TTS do chat só em movimento (GPS)

**Contexto.** Decisão Q-007 (Opção A + C). O app é o canal do motorista: o gestor manda
texto e o motorista, dirigindo, não lê. Mas ligar o TTS parado significa falar em voz alta
com passageiro/cliente ao lado.

**Decisão.** O TTS do chat é **desligado por default** e **liga automaticamente quando o
veículo está em movimento** (velocidade detectada pela telemetria de GPS acima de ~5 km/h),
e **desliga de novo** quando o veículo para. Cada mensagem é lida **uma vez**; o app não
mantém um loop de leitura. O comportamento é **configurável por veículo** (quem prefere
sempre ligado ou sempre desligado).

**Consequências.**
- ✅ Ganho real de segurança (é justamente dirigindo que o motorista precisa ouvir) sem
  obrigar TTS no trânsito parado com passageiro.
- ✅ Bateria: nada de TTS em péngulo parado, que é onde o aparelho fica no suporte.
- ⚠️ "Em movimento" depende da telemetria de GPS — e o GPS é justamente o que falha dentro
  de garagem/túnel. Mitigação: a decisão usa a **última velocidade conhecida**, com
  histerese (liga acima de 5 km/h, desliga abaixo de 2 km/h) para não oscilar.

**Alternativas descartadas.**
- *TTS sempre ligado* → fala em voz alta no ponto de carga, na cara do cliente.
- *TTS nunca na v1* → o motorista continua sem voz; a diferença de segurança é o argumento
  de venda do Olho Vivo.

---

#### ADR-023 — Limiares: desvio 300 m / 10 min, parada 15 min

**Contexto.** Decisões Q-104 (Opção B) e Q-105 (Opção A). Alarme falso é o que mata o uso de
um alerta — se o "desvio" dispara toda semana sem ser nada, o gestor desliga. E o alerta
vira **mensagem de WhatsApp** (AC-205), onde o falso positivo custa caro.

**Decisão.**
- **Desvio de rota: 300 m em 10 min** (era 200 m / 5 min). O valor é a distância mínima
  **fora da faixa** da rota, comparada com o deslocamento real do veículo.
- **Parada prolongada: 15 min**, fora de ponto de carga/descarga cadastrado.
- Parada dentro de ponto cadastrado **nunca** gera alerta de parada prolongada.

**Consequências.**
- ✅ Menos falso positivo em área urbana (obra, trânsito, alagamento, cesna de recarga).
- ✅ 15 min de parada é o limiar em que "parou" já virou "algo errado" para a operação.
- ⚠️ Desvio real de 200 m em 5 min deixa de alertar — aceito: desvio de 200 m dentro de área
  urbana raramente muda a operação; o que importa é o desvio grande.
- ⚠️ Os dois limiares passam a ser **constantes de configuração**, não código — calibrar por
  tenant depois do piloto é trivial.

**Alternativas descartadas.**
- *200 m / 5 min* → alarme falso constante em cidade (o problema original).
- *20 min de parada* → esconde o caso real de "parou e não voltou".

---

#### ADR-024 — Teto de RAM: 4,5 GB formal, 3,6 GB real (VROOM e MySQL mutuamente exclusivos)

**Contexto.** Decisão Q-012 (Opção C). A soma planejada é 3.360 MB; com VROOM (256 MB) e
MySQL (640 MB) juntos, 4.256 MB — folga de 340 MB num host que (em 18/11) tem **swap 100 %
ocupada** (vide §12.4).

**Decisão.** O teto **formal** continua **4,5 GB** (NF-06 do PRD, sem briga). Mas **VROOM e
MySQL são mutuamente exclusivos**:
- **Plano A (Postgres, gate F1-VAL-001 passando):** sem MySQL, sem VROOM → **3.360 MB**.
- **Plano B (MySQL):** entra MySQL (640 MB), **VROOM continua fora** (fase 2) → **4.000 MB**.
- **Fase 2 com VROOM:** entra VROOM (256 MB) **e** o MySQL já saiu (Plano A confirmado) →
  **3.616 MB**.
- **Nunca os três juntos.** O `compose.routers.yml` já separa os perfis `router` (VROOM) e
  `fallback-mysql` (MySQL) — o gate é **não ativar os dois perfis ao mesmo tempo**.

**Consequências.**
- ✅ O pior caso real cai para **3.616 MB**, com folga de ~900 MB no teto de 4,5 GB.
- ✅ A exclusão mútua é **estrutural** (perfis de compose diferentes), não uma regra escrita
  num README.
- ⚠️ Se o gate F1-VAL-001 falhar **e** a fase 2 do VROOM entrar antes de resolver o banco,
  o compose estoura o teto — o gate de deploy (§11) precisa checar os **perfis ativos**, não
  só a soma.

**Alternativas descartadas.**
- *Teto de 3,5 GB* → briga com o NF-06 do PRD e tira o MySQL como plano B — sem plano B
  o F1 vira ponto único de falha.
- *VROOM e MySQL juntos* → 4.256 MB no pior caso, folga de 340 MB. Não.

---

#### ADR-025 — Telemetria por polling 30 s, buffer offline em SQLite

**Contexto.** Decisões Q-102 e Q-106 confirmadas (mais Q-103). Push consome bateria e
complica o buffer offline; polling é previsível e barato em 4G.

**Decisão.**
- **Polling a 30 s** com o app em primeiro plano; **60 s** em background.
- **Buffer offline em SQLite** (consulta ordenada e consulta por janela de tempo; MMKV é
  key-value e não serve).
- O flush envia o lote e o servidor **deduplica** pelo contrato de idempotência (ADR-020).
- O cliente final vê **só posição** na v1 — sem ETA.

**Consequências.**
- ✅ Custo de dados previsível e controlado; nada de push que acorda o app a cada 500 m.
- ✅ O buffer sobrevive a sinal de 4G ruim em área sem cobertura (cavernas, subsolo de
  shopping, rota serrana) sem perder posição.
- ⚠️ 30 s de polling = ~2.880 pontos/dia por veículo ativo — precisa de política de
  retenção (raw em tabela curta, agregado por hora para relatório).

**Alternativas descartadas.**
- *Push do servidor para o app* → waking do app, bateria, e o app em background com
  `FOREGROUND_SERVICE` é mais frágil que polling.

### 12.3 Topologia preparada para a VPS-2 (Mídia & Streaming)

**Estado atual (decisão Q-002 Opção A) — tudo na `hermes-prod` (156.67.31.108):**

```
Internet (4G/5G com CGNAT)
   │
   │  UDP direto (o tunnel NÃO transporta UDP)
   ▼
┌─────────────────────────────────── hermes-prod ───────────────────────────────┐
│                                                                              │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐   ┌──────────────┐  │
│  │ Coturn       │   │ LiveKit      │   │ Painel Rádio │   │ Rádios       │  │
│  │ 3478/udp     │   │ 7880/7881/2  │   │ :8601        │   │ radio-louvor │  │
│  │ 49160-49260  │   │ sinalização  │   │ web-radio-   │   │ Liquidsoap   │  │
│  │ 192 MB       │   │ 512 MB       │   │ panel 256 MB │   │              │  │
│  └──────┬───────┘   └──────┬───────┘   └──────────────┘   └──────────────┘  │
│         │                  │                                                      │
│  ┌──────┴──────────────────┴───────────────────────────────────────────────┐  │
│  │  fleetbase-api 1024 │ queue 512 │ scheduler 256 │ socket 256 │ redis 160│  │
│  │  Postgres fleetbase_db (dentro do supabase-db, sem porta publicada)    │  │
│  └────────────────────────────────────────────────────────────────────────┘  │
│                       ▲ tunnel CF (só HTTP/WS)                               │
└───────────────────────┼──────────────────────────────────────────────────────┘
                        │
                  App Android · Painel Web · Link do cliente
```

**Estado alvo (quando a VPS-2 existir) — a `hermes-prod` fica só com dados e API:**

```
┌──────────── hermes-prod (156.67.31.108) ────────────┐   ┌──── VPS-2 (Mídia) ────┐
│  fleetbase-api · queue · scheduler · socket · redis   │   │  Coturn  3478/udp      │
│  Postgres fleetbase_db · bridge-whatsapp · Evolution   │   │  LiveKit 7880/7881/2  │
│  (TUDO que é dado ou API fica aqui)                   │   │  Painel Rádio :8601   │
│                                                       │   │  Rádios / Liquidsoap  │
└───────────────────────────────────────────────────────┘   └──────────┬───────────┘
              ▲ tunnel CF (WS)                                          │
              └──────────── livekit.automacaojs.us (sinalização) ◄─────┘
                                              turn.<host>  ──DNS only──► IP público da VPS-2
```

**O que muda no dia da virada (e o que NÃO muda):**

| Item | Muda? | Como |
|---|---|---|
| Registro DNS de `turn.<host>` | **Sim** | Aponta para o IP público da VPS-2, **permanece DNS-only** (ADR-017) |
| Registro DNS de `livekit.<host>` | **Sim** | Continua no tunnel, mas o tunnel agora aponta para `127.0.0.1:7880` **da VPS-2** |
| `livekit.yaml` / `turnserver.conf` | **Sim** | Re-renderizados com `TURN_EXTERNAL_IP` e `LIVEKIT_TURN_DOMAIN` novos (template do `.env.shared`) |
| Firewall | **Sim** | `3478/udp` + `49160-49260/udp` abertos na VPS-2; fechados na `hermes-prod` |
| Compose do `hermes-prod` | **Sim** | Perfil `media` sai do `docker compose up` (perfil, não delete de imagem) |
| **Código do app** | **Não** | O app lê `LIVEKIT_HOST` / `LIVEKIT_URL` do servidor — nenhum host no código |
| **Contratos JSON** | **Não** | O envelope, o DataChannel e os webhooks não carregam host nenhum |
| **Dados (Postgres)** | **Não** | O banco não se move: a VPS-2 fala com a `hermes-prod` pela rede do core |

**Checklist de cutover (a ser executado quando a VPS-2 for contratada):**
1. `dig +short turn.<host>` e `dig +short livekit.<host>` — confirmar para onde apuntan.
2. Registrar o IP público da VPS-2 em `TURN_EXTERNAL_IP` **e** conferir `external-ip` no
   `turnserver.conf` e `use_external_ip` no `livekit.yaml` — os três têm que bater.
3. Abrir `3478/udp` e `49160-49260/udp` na VPS-2; `nc -uzv <ip> 3478` de fora.
4. Testar de um 4G real (não de dentro da VPS): entrar na sala `radio-frota-geral` e
   confirmar **áudio** e **vídeo**.
5. Só então desligar o perfil `media` na `hermes-prod` e fechar as portas UDP de lá.
6. Repontar `radio.automacaojs.us` e `radio-louvor` para a VPS-2 (tunnel ou DNS).

> **Por que o desenho é este:** o `radio-louvor` (Liquidsoap + AzuraCast) é stack de rádio
> puro — ele vai junto com a mídia porque é exatamente o tipo de carga que faz o
> `hermes-prod` pesado (467 MB + 227 MB de swap no AzuraCast hoje). Deixar o rádio na
> `hermes-prod` e mover só o LiveKit não libera quase nada.

---

### 12.4 Diagnóstico de RAM e swap do host (18/11/2026, 14:20 BRT)

> Medido com `free -h`, `/proc/meminfo`, `docker stats --no-stream`, `vmstat 1 8`,
> `/proc/pressure/*` e leitura direta de `memory.current` / `memory.swap.current` dos
> cgroups. **Nenhum serviço foi parado ou reiniciado para esta medição.**

#### 12.4.1 Números

| Métrica | Valor | Leitura |
|---|---|---|
| Load average | **14,5 → 17,0** (8 vCPU) | ⚠️ **sobrecarregado** — fila de execução de 13 a 55 processos |
| RAM total | 24.608.564 kB (23,47 GiB) | — |
| RAM usada | 13,2 GiB | — |
| RAM **disponível** | **10,4 GiB** | ✅ **o gate `MemAvailable ≥ 6 GB` PASSA** |
| Swap total | 4.194.300 kB (4,0 GiB) | — |
| Swap **usada** | **4.166.636 kB (99,8 %) — 8,4 MiB livres** | ⚠️ **sem folga nenhuma** |
| `vm.swappiness` | 10 | já baixo (o que é bom) |
| PSI memória | some 0,42 · full 0,40 (avg10) | ✅ **sem pressão de memória agora** |
| PSI **I/O** | some **32,20** · full **13,93** (avg10) | ⚠️ **o gargalo real é I/O, não RAM** |
| `vmstat` si/so | ≈ 0 | ✅ **não há thrash** — o swap está cheio de páginas *frias*, não em troca |
| `vmstat` wa | 10 % a 25 % | ⚠️ espera de disco alta |
| `dockerd` | 383 threads | ✅ (era 2516 no incidente de 15/11) |
| Zumbis | 26 (filhos de `npm run start:prod`) | sem consumo; só falta *reaping* |

**Leitura curta:** o host **não** está sem memória. Ele tem 10,4 GB disponíveis. O que está
cheio é o **swap** (páginas frias de processos ociosos, paradas ali há dias) e o **I/O** — o
`wa` de 20 % e o PSI de I/O em 32 % dizem que o gargalo é disco, não RAM. O `si/so ≈ 0`
confirma: **não** está fazendo troca de páginas agora, então o swap cheio **não** está
matando nada neste momento.

#### 12.4.2 Quem está ocupando a RAM (host + containers)

| Consumidor | RAM | Swap | Leitura |
|---|---|---|---|
| **Antigravity / Gemini (`node` + `agy --hub`)** | **≈ 3,65 GB** | 137 MB | ✅ **ATIVO E ESPERADO** — o Isaac confirmou (18/11) que o Antigravity está trabalhando e é pesado por natureza. **Não é vazamento. Não tocar.** |
| CRM-Hermes API (`uvicorn webhook_server:app :3010`) | 1,52 GB | 23 MB | ⚠️ **1,5 GB para um servidor FastAPI de webhook** — o maior desperdício individual do host |
| `hermes gateway run` | 514 MB | 48 MB | em uso normal |
| `opencode serve :4096` | 363 MB | 99 MB | o assistente do Isaac |
| Leitor Inteligente (`upload_book.py`) | 323 MB | 120 MB | projeto em produção |
| Containers (33 rodando) | ≈ 1,70 GB | 1.213 MB | ver 12.4.3 |
| AzuraCast (rádio) | 467 MB | 227 MB | ⚠️ maior container em RAM **e** em swap |

**Conclusão:** **não há vazamento de memória.** O consumo é de processo pesado em uso
(Antigravity), de um serviço dimensionado errado (CRM-Hermes a 1,5 GB) e de projetos
legítimos. **O F1 não precisa de 3,6 GB de RAM livre — precisa de CPU e de I/O.**

#### 12.4.3 Quem está ocupando o swap (4,08 GB)

**Em containers — 1.213 MB:**

| Container | Swap | RAM |
|---|---|---|
| `azuracast` | 227 MB | 467 MB |
| `supabase-pooler` (supavisor, Erlang) | 173 MB | 64 MB |
| `realtime-dev.supabase-realtime` | 142 MB | 95 MB |
| `n8n-stack` | 100 MB | 282 MB |
| `searxng-core` | 100 MB | 14 MB |
| `dockge` | 77 MB | 82 MB |
| `supabase-storage` | 52 MB | 78 MB |
| `evolution-go-postgres` | 50 MB | 30 MB |
| `postgres-phwrk0sgwwaew76zjepyno4z` | 47 MB | 238 MB |
| `supabase-db` | 45 MB | 127 MB |
| `api-phwrk0sgwwaew76zjepyno4z` (Evolution API **v2**, não o GO) | 43 MB | 166 MB |
| demais 10 containers | 105 MB | 251 MB |

**Em processos de host — ≈ 2.870 MB:**

| Processo | Swap | RAM | Serviço |
|---|---|---|---|
| `fabricante_server.py` | 209 MB | 10 MB | Leitor Inteligente |
| `semantic_server.py` | 202 MB | 25 MB | Leitor Inteligente |
| `upload_book.py` | 120 MB | 323 MB | Leitor Inteligente |
| `beam.smp` (supavisor, erts-15) | 172 MB | 46 MB | supabase-pooler |
| `beam.smp` (erts-16) | 118 MB | 70 MB | evolution-go |
| `mariadbd` | 104 MB | 56 MB | Evolution API v2 |
| `opencode` | 99 MB | 363 MB | assistente |
| `n8n` (node) | 99 MB | 265 MB | n8n |
| `node` (Antigravity) | 95 + 82 + 55 MB | ≈ 3,05 GB | **Antigravity — esperado** |
| `hermes gateway` | 48 MB | 514 MB | Hermes |
| `notebooklm-mcp` | 57 MB | 5 MB | MCP |
| `searxng worker` | 74 MB | 92 MB | busca |

**Padrão:** o swap está cheio de **páginas de processos ociosos** (os 3 servidores do Leitor
Inteligente somam 531 MB de swap com apenas 358 MB de RSS total — estão praticamente
inteiros no disco). Nada disso é "consumidor ativo"; é **cache frio** de processos que
estão parados há dias.

#### 12.4.4 Achados que exigem ação (nenhum involve parar serviço)

1. **Um `find` travado em estado D há 603 s** — `find /root /opt -name "*google*" -o -name
   "*client_secret*"`, filho do `agy --hub` (Antigravity), em espera de I/O. É um comando
   **read-only** e está segurando o disco. ⚠️ Matar **este `find`** não derruba o
   Antigravity (o hub continua), mas é processo de outra sessão — **aguarda autorização**.
2. **26 processos zumbi**, todos filhos de `npm run start:prod` (ppid 48330). Não consomem
   RAM; ficam pendurados porque o pai não faz *reaping*. Corrigir exige reiniciar o pai —
   **não mexer agora**.
3. **CRM-Hermes API a 1,52 GB** para um servidor de webhook. Candidato a `--max-old-space-size`
   e a revisão de cache — mas é serviço **em produção**, fora do escopo do F1.
4. **Token de bot do Telegram em texto puro no crontab do root.** Não é a_memory leak,
   mas é um segredo exposto em arquivo legível — migrar para o cofre
   (`~/claudinho-secrets/`) na próxima manutenção. **Valor não reproduzido aqui.**

#### 12.4.5 Veredito para o F1

| Gate | Exigido | Medido | Resultado |
|---|---|---|---|
| `MemAvailable ≥ 6 GB` | 6 GB | **10,4 GB** | ✅ **PASSA** (remedir na hora do deploy — parte do available é o Antigravity) |
| Teto do stack ≤ 4,5 GB | 4,5 GB | 3,36 GB (fase 1, ADR-024) | ✅ PASSA |
| Swap com folga | — | **0%** | ⚠️ **não bloqueia, mas reduz a margem de erro** |
| Load / I/O | — | load 14–17 em 8 vCPU, wa 20 % | ⚠️ **este é o gargalo real** |

**Recomendação de sequência para o F1 (nada sobe antes):**
1. **Não subir LiveKit/Coturn ainda** (704 MB) — só depois do gate do banco passar.
2. **Primeiro** o gate do banco, que é barato em RAM e caro em CPU: `fleetbase_db` + role no
   Postgres → `redis` + `fleetbase-api` com limite de 1 GB → `php artisan migrate --force`.
   PASS → Plano A confirmado; FAIL → Plano B (MySQL 640 MB).
3. Rodar o F1 **de madrugada ou fora do horário de uso** — o `migrate` de Laravel/Octane
   consome CPU e I/O, que hoje é o que está saturado.
4. Se possível, **liberar swap antes** reiniciando de forma programada **só** os 3 serviços
   ociosos do Leitor Inteligente (devolve ≈ 531 MB de swap e libera o caminho para o
   `swapoff` completo mais adiante) — sem tocar no Antigravity.
5. A carga do host é alta **hoje**; o gate de RAM passa, o de CPU/I-O é o que precisa de
   janela.

#### 12.4.6 Segunda medição (18/11/2026, 14:43 BRT) — causa raiz do I/O identificada

> Segunda passagem, feita **depois** da primeira, para **confirmar** o diagnóstico em vez de
> repetir suposição. Nenhum serviço foi parado, reiniciado ou modificado nas duas passagens.
> O Isaac hadou explicitamente: *"o antigravity tá trabalhando, ele pesa muito na VPS — cuidado
> para não parar ele e para não ser impreciso nos diagnósticos"*. Esta seção existe para
> **separar a carga esperada do Antigravity do que é, de fato, um travamento**.

**Números reconciliados (a soma bate):**

| Métrica | 14:20 BRT | 14:43 BRT | Leitura |
|---|---|---|---|
| `MemAvailable` | 10,4 GiB | **12,52 GiB** (13.123.444 kB) | ✅ **sobeu** — o gate `≥ 6 GB` segue PASSANDO com folga |
| Swap usada | 4.166.636 kB | **3.927.032 kB** (261 MB livres) | ⚠️ cheia, mas **sem folga** |
| `vmstat` si/so | ≈ 0 | **si = 0, so = 0** | ✅ **sem thrash** — página fria, não troca |
| Load average | 14,5 → 17,0 | **20,08 / 23,37 / 21,06** | ⚠️ **subiu** — a causa está em 12.4.6.2 |
| PSI I/O (avg10) | some 32,20 · full 13,93 | **some 59,51 · full 16,58** | ⚠️ **piorou ~2×** |
| PSI memória (avg10) | some 0,42 · full 0,40 | **some 4,02 · full 1,96** | ✅ ainda baixo (a RAM não é o gargalo) |
| `vmstat` wa | 10 % → 25 % | **15 % → 25 %** | ⚠️ disco saturado |
| Zumbis | 26 | **27** | sem custo de RAM |
| Containers | 33 | **34** | — |

**Atribuição do swap (a soma fecha):**

| Bucket | Swap | Como foi medido |
|---|---|---|
| Soma de `VmSwap` de **todos** os processos do host | **4.038 MB** | ≈ 3,94 GB = o swap inteiro (coerente) |
| ... dos quais **containers** (cgroup `memory.swap.current`) | **1.332 MB** | azuracast 242 · supabase-pooler 172 · realtime 142 · searxng 100 · n8n-stack 100 · dockge 78 · supabase-storage 51 · evolution-go-postgres 50 · postgres 46 · supabase-db 45 |
| ... **fora de container** (host puro) | **2.706 MB** | tsserver do cardápio 331 + 95 · Leitor Inteligente 531 (fabrican 209 + semantic 203 + upload_book 120) · beam.smp 172 + 118 · mariadbd 104 · n8n 100 · opencode 100 + 75 |

#### 12.4.6.1 Precisão sobre o Antigravity — ativo, esperado, **preservado**

| Item | Medido | Leitura |
|---|---|---|
| Processos vivos | 9 (2 sessões: IDE server antiga de 5h10 + sessão nova de 10 min) | ✅ **de pé, nada foi parado** |
| RSS somado da árvore | **≈ 1.885 GB** (node IDE 295 + 304 + 133 + 416 + 60 · `agy --hub` 532 · read-mcp 260 · sessão antiga 109 + 29) | ⚠️ maior fatia isolada de RAM — **mas RSS conta página compartilhada N vezes** |
| **Swap do Antigravity** | **12 MB** (só a sessão antiga) | ✅ **ele NÃO está enchendo o swap** — o consumo dele é RAM *quente*, de processo em uso |
| `pnpm build` / `nest build` ativo na árvore | **≈ 1.654 MB** (909047 = 1.420 MB + pnpm 143 + 90) | ✅ build legítimo em andamento |
| **Total real da árvore, com o build** | **≈ 4,4 GB** | ✅ **carga esperada** — o Isaac confirmou que está trabalhando |

> **Correção de precisão:** a 1ª passagem atribuiu ≈ 3,65 GB ao Antigravity medindo apenas os
> `node` do IDE. A 2ª passagem mediu a **árvore inteira** (incluindo `agy --hub`, o read-mcp e o
> build ativo) = **≈ 4,4 GB**, e confirmou que **em swap ele tem 12 MB**. Conclusão mantida, com
> número corrigido: **o Antigravity pesa em RAM porque está trabalhando — e isso não é a causa do
> swap cheio nem do I/O saturado.**

#### 12.4.6.2 Causa raiz do I/O: 8 varreduras de disco inteiro travadas em estado D

A 2ª passagem achou o que a 1ª só viu como sintoma (1 `find` em D). **Não é um `find` — são 8.**

| PID | Comando | Em D há | RSS | Pai |
|---|---|---|---|---|
| 833550 | `grep -rn "qYIA" /root/ /opt/ /etc/` | 27 min | 46 MB | `bash -c` (reatribuído a init) |
| 843748 | `find /root /opt -name "*google*" -o -name "*client_secret*"` | 22 min | 6 MB | `bash -c` (reatribuído a init) |
| 885437 | `grep -rn "qYIA" /root/ /opt/ /etc/` | 7 min | 46 MB | `agy --hub` (877893) |
| 887503 | `grep -rn "80253758444" /root/ /opt/ /etc/ /var/` | 6 min | 46 MB | `agy --hub` (877893) |
| 888496 | `grep -rn "GOCSPX" /root/.hermes/ /root/projetos/ /opt/` | ~6 min | 46 MB | `agy --hub` (877893) |
| 891284 | `grep -rn "GOOGLE_CLIENT_SECRET" /root/ /opt/ /etc/ /var/` | 4 min | 46 MB | `agy --hub` (877893) |
| 897091 | `grep -rn "qYIA" /opt/ /root/ /var/ /etc/` | ~3 min | 9 MB | `agy --hub` (877893) |
| 898350 | `grep -rn -I "qYIA" /root /opt /etc /home /var` | ~3 min | 46 MB | `agy --hub` (877893) |
| 901407 | `find /root /opt /etc /home /var/www -name "*secret*.json" -o ...` | < 1 min | 6 MB | `agy --hub` (877893) |
| 902164 | `find /opt/prospector /root/prospector ... -name "*.json"` | < 1 min | 6 MB | `agy --hub` (877893) |

**Por que isso explica os números:** cada `grep -rn` percorre `/root`, `/opt`, `/etc` e `/var`
**inteiros** — hundreds de milhares de arquivos, atravessando `node_modules`, `.git` e caches do
PM2. Vários rodam **em paralelo**, todos ao mesmo tempo. O resultado é exatamente o que a
medição mostra: `wa` de 15–25 %, PSI de I/O em `some 59,51`, load de 20 em 8 vCPU e 4 process
runnable na fila.

**Distinção que o Isaac pediu explicitamente:** **isso não é "o Antigravity trabalhando".**
O Antigravity *disparou* essas buscas — o hub (`agy --hub`) é o pai de 7 delas — mas a busca em
si é um subprocesso de leitura de disco que **emperrou**. Matar **esses** subprocessos:

- ✅ **libera o I/O imediatamente** (o gargalo real do F1);
- ✅ **NÃO derruba o Antigravity** — o `agy --hub`, o node do IDE e o build continuam de pé;
- ⚠️ mas são **processos de outra sessão** → **aguarda autorização explícita do Isaac**.

> Regra: **nada foi morto, nada foi reiniciado, nenhum container do F1 subiu.** As duas leituras
> foram 100 % read-only.

#### 12.4.6.3 Sequência F1 revisada (a mesma, com o I/O como variável principal)

| Ordem | Ação | Por quê |
|---|---|---|
| 0 | *(opcional, com autorização)* matar as 8 varreduras em D | derruba `wa` e o PSI de I/O; **não toca no Antigravity** |
| 0' | *(opcional, com autorização)* reiniciar **só** os 3 python ociosos do Leitor Inteligente | devolve ≈ 531 MB de swap; serviço ocioso, sem tráfego |
| 1 | `fleetbase_db` + role no Postgres + `redis` + `fleetbase-api` (limite 1 GB) | barato em RAM; é o **gate F1-VAL-001** |
| 2 | `php artisan migrate --force` | **PASS → Plano A (Postgres)** · **FAIL → Plano B (MySQL 640 MB)** |
| 3 | **só depois** LiveKit + Coturn (704 MB) | o media plane é o mais pesado e não é o gate |
| 4 | tudo de madrugada / fora do horário de uso | `migrate` de Laravel/Octane é CPU + I/O bound |

---

### 12.5 Gate F1-VAL-001 — resultado (18/11/2026, 15:02–16:04 BRT)

O Isaac autorizou o gate **isolado** (Telegram 6351): subir **só**
`fleetbase-redis` + `fleetbase-api` na rede interna, **sem porta pública**, e
rodar `php artisan migrate --force`. LiveKit/Coturn ficaram **fora** (trava de
segurança do próprio Isaac). Regra automática: *se o Postgres falhar numa
migration nativa do Fleetbase, parar o teste, avisar e acionar o **Plano B**
(MySQL 8, 640 MB) — sem hackear o core*.

#### 12.5.1 Plano A (Postgres) — **FAIL**

```
$ php artisan migrate --force
In DatabaseManager.php line 221:
    Database connection [pgsql] not configured.
```

Causa raiz — **3 camadas**, todas verificadas dentro da imagem:

| # | Verificação | Resultado |
|---|---|---|
| 1 | Extensões PDO da imagem | `pdo_mysql`, `pdo_sqlite` — **sem `pdo_pgsql`** |
| 2 | Conexões definidas pelo core | `vendor/fleetbase/core-api/config/database.connections.php` → **só `'mysql'`** e `'sandbox'` (ambos `driver => mysql`) |
| 3 | Leitura do `DATABASE_URL` | `Fleetbase\Support\Utils::parseUrl` extrai **host/user/pass/database**; o **esquema da URL é ignorado** e o driver é fixo `'mysql'` |

O `config/database.php` da API tem `'connections' => []` e default
`env('DB_CONNECTION', 'mysql')` — mas `DB_CONNECTION=pgsql` aponta para um nome
de conexão que **não existe** no core.

⇒ **Postgres exigiria reescrever o core ou buildar imagem própria com
`pdo_pgsql`** — exatamente o que o Isaac proibiu ("não perca tempo tentando
hackear o core"). **Gate FAIL ⇒ Plano B.**

*Registro:* o role `fleetbase` e o banco `fleetbase_db` **foram** criados no
Postgres do Supabase (10.0.19.8:5432, owner `fleetbase`, GRANT correto) e
ficam de pé como evidência/rollback. **Nenhuma** migration rodou contra eles.

#### 12.5.2 Plano B (MySQL 8, 640 MB) — montado e no ar

| Item | Valor |
|---|---|
| Imagem | `mysql:8.0` → **8.0.46** |
| Limite / reserva de RAM | **640 MB** / 320 MB (ADR-002) |
| Tuning | `innodb_buffer_pool_size=128M`, `performance_schema=OFF`, `skip-log-bin`, `max-connections=60` |
| Perfil Compose | `fallback-mysql` — **mutuamente exclusivo** com `router`/VROOM (ADR-024) |
| Exposição | rede interna `fleetbase_net`; **sem porta pública** |
| Arquivos | `infra/docker/compose.f1.planb.yml` (override) · `infra/env/fleetbase.mysql.env` (600, gitignored) · chaves `MYSQL_*` no cofre `/root/claudinho-secrets/fleetbase.env` |

Stack no ar e medida: `fleetbase-mysql` **188,6 MB**/640 MB ·
`fleetbase-api` **320,5 MB**/1 GB · `fleetbase-redis` **6,2 MB**/160 MB =
**≈ 515 MB reais** (teto ADR-024: 4,5 GB).

> **Armadilha registrada (18/11):** o primeiro `migrate` foi cortado pelo
> `timeout` do cliente `docker compose exec` — o **PHP continuou rodando dentro
> do container** (o `exec` é cliente, não o processo) e o re-run devolveu
> `1826 Duplicate foreign key constraint name`, **erro fantasma** de dois runs
> concorrentes, **não** incompatibilidade do Fleetbase com MySQL 8. O schema foi
> zerado e o gate re-run **em processo único**, com log em arquivo.
> (skill `compose-exec-orphan-timeout`)

#### 12.5.3 Provisionamento: o core usa **3 schemas**, não 1

Achado do 2º run do gate — **não** é incompatibilidade do Fleetbase com MySQL 8,
é **provisioning** incompleto. O core registra **três** conexões MySQL:

| Conexão | Schema | Onde é definida |
|---|---|---|
| `mysql` (default) | `fleetbase_db` | `core-api/config/database.connections.php` |
| `storefront` | `fleetbase_db` **`_storefront`** | `storefront-api/server/config/database.connections.php` (`'database' => $database . '_storefront'`) |
| `sandbox` | `fleetbase_db` **`_sandbox`** | `core-api/config/database.connections.php` (`'database' => $database . '_sandbox'`) |

O erro que parou o run foi `1044 Access denied for user 'fleetbase'@'%' to
database 'fleetbase_db_storefront'` na migration
`2023_05_03_025307_create_carts_table` — o usuário existia, mas **só** no
schema principal.

⇒ **Regra de provisioning (Plano B):** criar os **3** schemas com
`utf8mb4 / utf8mb4_unicode_ci` e dar `GRANT ALL` ao usuário do app em **cada
um**. E fixar `STOREFRONT_DB_PORT` explicitamente (a conexão storefront usa
`env('STOREFRONT_DB_PORT', env('DB_PORT'))` — herdar `DB_PORT=5432` do
Plano A seria o mesmo bug).

**Toda** migration nativa do core roda MySQL 8 **sem erro de dialeto** até aqui
(≈ 100 migrations, incluindo os 66 `add_foreign_keys_to_*`, que são os mais
exigentes em `ALTER TABLE`).

#### 12.5.4 Veredito do gate: **PASS no Plano B (MySQL 8)**

| Item | Resultado |
|---|---|
| `php artisan migrate --force` (schema zerado, processo único) | **EXIT=0** — **395 migrations** aplicadas, **0 falhas** |
| Re-run (idempotência) | `INFO Nothing to migrate.` · **EXIT=0** |
| `migrate:status` | **0 pendentes** |
| Tabelas criadas | `fleetbase_db` **154** · `fleetbase_db_storefront` **33** = **187** |
| `fleetbase_db_sandbox` | criado (usado só pelo `CreateDatabase`/modo sandbox) |
| API | `/health` → **200** |

⇒ **O core do Fleetbase roda 100 % em MySQL 8.** Nenhuma migration nativa
falhou por dialeto. O único ajuste necessário foi de **provisioning** (os 3
schemas, §12.5.3) — não de código.

**Custo medido do stack do gate** (Limites / uso real):

| Container | Limite | Uso real | % |
|---|---|---|---|
| `fleetbase-mysql` | 640 MB | **300,8 MB** | 47 % |
| `fleetbase-api` | 1.024 MB | **233,1 MB** | 23 % |
| `fleetbase-redis` | 160 MB | **6,2 MB** | 4 % |
| **total** | **1.824 MB** | **≈ 540 MB** | — |

**Estado do spike (18/11 16:04 BRT):** isolado, **sem porta pública**
(só `127.0.0.1:8000` na api; mysql e redis **sem** binding no host),
**LiveKit/Coturn não subiram** (trava do Isaac), nada de produção tocado.

**O que o gate NÃO decided** (continua valendo a trava): LiveKit + Coturn
(704 MB) só entram **depois** do gate, em horário de menor carga — e nunca
junto com o VROOM (ADR-024). **Decisão do Isaac (Telegram 6354, 16:13 BRT):
adiado para depois das 22 h ou de manhã (18/11).** O stack do gate segue no ar
(≈ 540 MB, `restart: unless-stopped`), isolado, sem porta pública.

**Linha do tempo do gate** (evidência: `docker inspect` + mtime dos logs):
redis 15:02 BRT · mysql 8.0.46 pronto 15:09 BRT · api recriada com o env do
Plano B 15:34 BRT · `migrate` completo 16:03 BRT (`/tmp/mig4.log`, EXIT=0) ·
re-run 16:03 BRT (`/tmp/mig5.log`, `Nothing to migrate`).

### 12.6 Plano de migração para a VPS-2 (18/11/2026) — RASCUNHO para revisão do Isaac

> Origem: Telegram 6355 — o Isaac fechou a compra de uma VPS de **6 núcleos,
> 12 GB RAM, 100 GB disco, US$ 5,28/mês**. Esta seção define o **papel** dela
> dentro da plataforma e a ordem de migração. Ela é a materialização da
> topologia já preparada no §12.3 (a "VPS-2 de Mídia & Streaming"), ampliada
> para absorver também o **tier de build** e os **apps sem dado crítico**.

#### 12.6.1 Papel da VPS-2

| | `hermes-prod` (atual) | VPS-2 (nova) |
|---|---|---|
| Papel | **dados + API + tunnels + bots** | **mídia + build + apps sem dado** |
| Hospeda | Postgres/Supabase, CRM-Hermes, Evolution API, bridge WhatsApp, n8n, tunnel CF, Telegram bridge, Leitor (API) | LiveKit, Coturn, AzuraCast/rádios, Liquidsoap relay, toolchain de build, cache npm/gradle, ava-mentingo, opencode+OpenBot, servidores de IA do Leitor |
| Não hospeda (nunca) | — | **nenhum banco de produção**, Evolution API, tunnel CF principal |

> **Princípio:** dado não se move sem janela e backup. Serviço sem estado
> persistente se move como commodity.

#### 12.6.2 Fotografia da `hermes-prod` (18/11/2026, 16:15–16:30 BRT)

Medido com `free -h`, `nproc`, `df -h`, `docker stats --no-stream`, `ps -eo rss,args`,
`pm2 list`, `du -sh`.

| Recurso | Valor | Leitura |
|---|---|---|
| RAM | 23 GB total · 10 GB usados · **13 GB disponíveis** | folgado, mas o swap é que dói |
| Swap | 4,0 GB · **3,1 GB usados** | `so=0`, `si` alto = kernel rebalanceando, não é thrash |
| CPU | **8 núcleos** · load 10-12 | a VPS nova tem **6** — ganho não é CPU |
| Disco | 387 GB · 203 GB usados · **185 GB livres** | sem pressão de disco hoje |
| Containers | **37** · 2,6 GB no total | o peso **não** está aqui |
| Processos soltos (host) | **≈ 4 GB** | ver abaixo — é aqui que dói |

**Processos soltos, do maior para o menor:**

| Processo | RAM | Observação |
|---|---|---|
| `crm-hermes` → `uvicorn webhook_server:app` (:3010) | **1,5 GB** | o **maior processo da máquina** (PM2) |
| `tsserver.js` (Mendes) | 746 MB | IDE — some quando o IDE não está aberto |
| `next build` (Mendes) | 721 MB | **transiente**, mas é o que causa o pico de I/O |
| `ava-mentingo` api (`apps/api/dist/src/main.js`) | 696 MB | PM2 `ava-api` |
| `opencode serve --port 4096` | 628 MB | estado: `auth.json` + `opencode.db` |
| `hermes_cli` (python) | 516 MB | sessão longa de 20 h — **candidato a revirar** |
| `claude` (esta sessão Telegram) | 462 MB | o próprio agente |
| `hermes dashboard` (:9119) | 375 MB | tooling interno |
| Leitor `semantic_server.py` + `fabricante_server.py` | 528 MB | sem estado (IA) |

**Docker (2,6 GB em 37 containers):** `azuracast` 387 · `fleetbase-mysql` 301 ·
`fleetbase-api` 233 · `n8n-stack` 295 (+runner 79 +mcp 43) · Supabase ≈ 860 em
8 containers (`supabase-db` 135, `imgproxy` 89, `realtime` 82, `pooler` 63,
`rest` 52, `storage` 47, `envoy` 26, `postgres` 178, `api` 166, `redis` 27) ·
`9router` 83 · `dockge` 73 · `ava-mentingo-db` 95 · `evolution-go` 37.

**Disco: os 83 GB do `/root`** (medido com `du -sh --max-depth=0`, 18/11):

| Caminho | Tamanho | Destino natural |
|---|---|---|
| `.npm` | **15 GB** | cache → VPS-2 (build) |
| `.local` | 9,9 GB | toolchains → **não mover** (em uso) |
| `projetos` | 9,8 GB | parte vai pro build (Mendes) |
| `.hermes` | ≈ 9,3 GB | **não mover** (estado dos agentes) |
| `radio-libertacao-music` | **8,4 GB** | → **VPS-2 (mídia)** |
| `backup_devocional12_v1_estavel` | **8,3 GB** | backup → destino externo |
| `.bun` | 4,9 GB | toolchain → VPS-2 (build) |
| `openbot-official-repo` | 4,3 GB | → VPS-2 (build/OpenBot) |
| `backups` | 4,3 GB | backup → destino externo |
| `.gradle` | 2,0 GB | cache → VPS-2 (build) |
| `.rustup` / `.gemini` | 2,0 GB / 2,0 GB | toolchain → VPS-2 (build) |
| `go` · `wacrm` · `.cargo` | 1,4 / 1,1 / 963 MB | build / Evolution (fica) |
| `apps` · `litellm-env` · `rea` · `open-design` | 719 / 687 / 645 / 578 MB | revisar caso a caso |

Detalhe do `.hermes`: `state.db` 2,2 GB · `node` 2,0 · `tools` 1,5 · `installs` 1,1
· `state.db.bak-E10-20260809` 745 MB · `profiles` 421 MB · `state-snapshots` 400 MB
· `cache` 354 MB · `logs` 117 MB · `skills` 93 MB. Em `/opt`: `buzz-src` 1,6 GB ·
`supabase` 1,4 GB · `ocv2` 962 MB · `ghidra` 882 MB · `autogen-env` 781 MB ·
`android-sdk` 750 MB · `OpenBot` 646 MB · `google` 434 MB.

> **Leitura:** dos 83 GB do `/root`, **≈ 45 GB** são candidatos naturais à VPS-2
> (caches npm/gradle, toolchains de build, `openbot-official-repo`, a música do
> rádio e os repos de build de `/opt`). `radio-libertacao-music` (8,4 GB) é
> coerente com a onda 1: o `radio-louvor`/`radio-libertacao` é stack de rádio
> puro, que é exatamente o tipo de carga que pesa a `hermes-prod`. **Os backups
> (12,6 GB) não devem ficar na VPS-2** — backup na mesma máquina que roda o
> serviço não é backup.

#### 12.6.3 Onda 1 — mídia + build (risco baixo, ganho alto)

**Escopo:** LiveKit + Coturn + AzuraCast/rádios + Liquidsoap relay + tier de
build (workspace, SDKs e caches).

| Item | Onde vai | Ganho na `hermes-prod` | Risco |
|---|---|---|---|
| LiveKit | VPS-2 | 512 MB | Baixo (§12.3 já tem o desenho) |
| Coturn | VPS-2 | 192 MB | Baixo, **exige IPv4 fixo** |
| AzuraCast + rádios + relay | VPS-2 | 387 MB + 227 MB de swap | **Médio** — rotas do tunnel e volumes |
| `next build` / `tsserver` / workspaces | VPS-2 | até 1,5 GB de RAM em pico | Baixo |
| cache npm + gradle (17 GB) | VPS-2 | 17 GB de disco | **Zero** — é cache |

**Ganho consolidado da onda 1:** ≈ 1,1 GB de RAM (mídia) + até 1,5 GB de RAM em
pico de build + 17 GB de disco + a folga de I/O. É a onda que mais alivia o
`load` — o `next build` (721 MB) e o `tsserver` (746 MB) são os causadores da
pressão de I/O que enche o swap.

#### 12.6.4 Onda 2 — apps sem dado crítico (mês seguinte)

| Item | RAM na VPS-2 | Pré-requisito |
|---|---|---|
| `ava-mentingo` (api + web + db + rustfs) | ≈ 1,3 GB | DNS + Tailscale |
| `opencode serve` + OpenBot | ≈ 0,7 GB | sincronizar `auth.json` + `opencode.db` |
| Leitor `semantic_server` + `fabricante_server` | ≈ 0,5 GB | apontar o PWA para o novo host |
| `hermes dashboard` + CLI | ≈ 0,9 GB | revisar `hermes_cli` de 20 h antes |

**Total da onda 2: ≈ 3,4–4 GB fora da principal.** Todos são serviços HTTP sem
banco próprio — a migração é "copiar, apontar, testar, desligar".

#### 12.6.5 Onda 3 — dados (NÃO agora; exige janela e backup)

| Item | RAM | Por que é a última |
|---|---|---|
| Supabase self-hosted (8 containers) | ≈ 860 MB | é o Postgres do CRM **e** do Leitor |
| `crm-hermes` (:3010) | **1,5 GB** | Regra de Ouro de isolamento do tenant (1111 travado / 3333 Demo) |

**Condições para abrir a onda 3:**
1. Backup íntegro e **testado** (restaurar em staging, não só gerar).
2. Janela com o Isaac presente e um rollback testado.
3. Plano de DNS/tunnel para o CRM e para o painel do Leitor.
4. Verificar se o `phwrk` stack (postgres+api+redis) é do CRM ou de outro
   produto — **não mover antes de saber**.

#### 12.6.6 O que NÃO se move

| Item | Por quê |
|---|---|
| Evolution API | sessão do WhatsApp é **stateful** — trocar host quebra QR e webhook |
| Tunnel CF principal | é o ponto de entrada; mudar o tunnel é mudar tudo |
| Postgres do CRM | dado + Regra de Ouro do tenant |
| `hermes/state.db` e perfis | estado dos agentes e das skills |

#### 12.6.7 Rede — sem rota nova na Cloudflare no dia 1

1. A VPS-2 entra na **rede Tailscale** (a `hermes-prod` já usa — o dashboard
   escuta em IP Tailscale).
2. O nginx da `hermes-prod` passa a fazer **upstream** para o IP Tailscale do
   serviço movido. Nenhuma alteração na Cloudflare, nenhum downtime.
3. Só depois, se quiser isolamento de hostname, um **segundo `cloudflared`** na
   VPS-2 com hostnames próprios (`livekit.`, `radio.`, `ava.`).
4. O TURN segue **DNS-only** (ADR-017) apontando para o **IP público da VPS-2**.

#### 12.6.8 Pré-condições ANTES de fechar a compra

| Verificar | Por quê |
|---|---|
| vCPU **dedicado** vs shared | 6 vCPUs compartilhados não sustentam build + mídia |
| **IPv4 público fixo** | o Coturn exige (`--external-ip`) e fica atrás de NAT |
| Docker em **KVM** | senão é LXC e quebra rede/iptables |
| **Backup** (destino fora da VPS) | a VPS-2 vai Concentrar build e mídia, não só banco |
| Banda/tráfego | build e vídeo pesado |

#### 12.6.9 Ordem de execução e rollback

1. Provisionar a VPS-2 (Tailscale, Docker, hardening) — sem tocar na principal.
2. Subir **LiveKit + Coturn** na VPS-2 (é o teste real da máquina) e fazer o
   checklist de cutover do §12.3.
3. Mover o **tier de build** e os caches (npm/gradle) — sem risco de produto.
4. Onda 2, um serviço por vez: copiar → apontar → testar → desligar o antigo.
5. Onda 3 só com backup testado e janela.

**Rollback de cada onda:** os serviços antigos **permanecem no ar** até o novo
passar no teste; o corte é o desligamento do antigo, que é reversível em
minutos (religar o processo e voltar o upstream do nginx).

---

---

## 13. Rastreabilidade (BRD/PRD → ADR)

| Origem | Destino |
|---|---|
| BRD §8 R-01 (RAM) | ADR-006, §6, R-01/R-02 |
| BRD §8 R-02 (CGNAT) | ADR-007, R-03 |
| BRD §8 R-07 (AGPL) | **ADR-011** |
| BRD §9 (escopo v1) | ADR-014, ADR-015 |
| BRD §10 (conformidade) | ADR-011 |
| PRD NF-01/NF-02 (bateria/banda) | ADR-013, ADR-005 |
| PRD NF-06 (RAM ≤ 4,5 GB) | ADR-006, §6 |
| PRD NF-07 (CGNAT/TURN) | ADR-007 |
| PRD NF-13 (idempotência) | **ADR-020** (§12.2) + SPEC-KIT §4.1 |
| PRD NF-14 (UTC/BRT, Honduras) | **ADR-018** (§12.2) + SPEC-KIT (contratos de timestamp) |
| PRD US-INT-01..04 (WhatsApp) | ADR-008 |
| PRD US-CL-01..03 (link de rastreio) | **ADR-021** (§12.2), ADR-008, §7.3, R-09 |
| PRD P-B2/P-B4/P-B5 | ADR-013, **ADR-019 / ADR-021 / ADR-022** (§12.2) |
| Trava T-2 (sem banco novo) | ADR-002, gate F1-VAL-001 |
| Trava T-3 (limites de RAM) | ADR-006, §6.2 |
| Trava T-4 (rotas zero-custo) | ADR-004, §12 Q-001 |
| Trava T-5 (Olho Vivo/PTT) | ADR-013, ADR-007 |
| Trava T-6 (WhatsApp) | ADR-008 |
| Trava T-7 (AGPL) | ADR-011 |

---

**Fim do documento 03-ARCHITECTURE-ADR.md.** Nada foi instalado, nenhum serviço de produção foi alterado: este documento é o *plano*, e os gates §10 decidem o que entra em produção e quando.

