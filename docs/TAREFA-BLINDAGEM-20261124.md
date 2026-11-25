# Blindagem pré-piloto — Hermes Logística & Olho Vivo

Início: 24/11/2026 · Executor: Claudinho (Claude Code / MiniMax-M3)
Escopo: **apenas** `web-radio-panel`, `integrations/bridge-whatsapp`, `mobile-navigator`, `infra/`.
NUNCA tocar: `fleetbase-api` (AGPL), Mendes Delivery, Mercado Express, CRM Hermes,
Supabase, Evolution GO :8096, rádios Devocional 12 / Libertação.
RAM: teto rígido **128 MB** por container próprio (já configurado nos dois).

## Prompt 1 — Blindagem pré-piloto (6 entregas)
- [x] 1.1 `olho_vivo_audit_logs` + sem áudio oculto + sem gravação em disco
- [x] 1.2 App: banner vermelho fixo + bipe (VisionController + tela principal)
- [x] 1.3 Fila offline de posições (AsyncStorage, 2000 pts) + POST /api/driver/telemetry/batch
- [x] 1.4 Tela "Otimização de Bateria" (MIUI/OneUI/Motorola)
- [x] 1.5 Central: sem sinal >3min + bateria <=15% → badge + NTFY
- [x] 1.6 `infra/backup-daily.sh` (cron 03:00) + `infra/watchdog-ntfy.sh` (2 min)
- [x] 1.7 DEMO_MODE estrito (só login real em produção)
- [x] 1.8 Suíte de evidências (concorrência 1x200 + 1x409, batch, auditoria, backup/restore, E2E)

## Prompt 2 — Vistoria Fotográfica Obrigatória (DVIR) (6 entregas)
- [x] 2.1 Migração `hj_*` idempotente (4 tabelas + 4 templates + retenção 12m)
- [x] 2.2 Upload streaming (`@fastify/multipart`), magic bytes, ≤2MB, UUID v4 isolado por org
- [x] 2.3 sha256 em streaming + duplicata = fraude + GPS + hora do servidor + imutável (403)
- [x] 2.4 Bloqueio de veículo reprovado (fila + accept = 403) + NTFY + WhatsApp
- [x] 2.5 `GET /api/dvir/photos/:photoId` (401 sem login / 403 outra org / sem path traversal)
- [x] 2.6 Painel: galeria comparativa entrada vs saída + filtros + modais auditados
- [x] 2.7 App: `DvirInspectionScreen.tsx` + `OfflineDvirQueue.ts` (só câmera, ~200KB, GPS)
- [x] 2.8 `infra/dvir-retention-cleanup.sh` (cron 04:00) + alerta disco >80%
- [x] 2.9 Suíte positiva + negativa

## Estado
_(atualizado a cada lote)_

**24/11 → 25/11/2026 — Lote "app mobile blindado" (1.2, 1.3, 1.4, 2.7) concluído.**
Relatório completo em `docs/MOBILE-BLINDAGEM-20261124.md`.
Escopo tocado: **só** `mobile-navigator`. Painel e `infra/` **não** foram alterados.
Pendências do lote:
- `yarn install` no `mobile-navigator` (novas deps nativas: `@react-native-async-storage/async-storage`,
  `react-native-sound`) + **commit do `yarn.lock`** (o CI usa `yarn install --immutable`);
- rebuild do APK e **teste em aparelho** (banner, bipe, câmera travada, filas offline);
- `npx tsc --noEmit` (não foi possível rodar sem `node_modules`).
Nada foi commitado nem publicado (sem `git push`, sem container, sem `docker`).


**25/11/2026 — Lote "blindagem concluída + evidências reais".**
Todas as 14 entregas (1.1–1.8 / 2.1–2.9) estão **feitas e verificadas**.

Suítes de evidência (scripts reproduzíveis em `infra/evidence/`):
- `node prompt1.mjs` → **42/42 OK · 0 falhas · 45,2 s**
  (log: `docs/evidencias/prompt1-20261125.log`)
- `node prompt2.mjs` → **50/50 OK · 0 falhas · 11,9 s**
  (log: `docs/evidencias/prompt2-20261125.log`)

Containers próprios no ar, teto de RAM respeitado:
- `fleetbase-web-radio-panel` — imagem `6.1`, `mem=134217728 / swap=268435456`, uso real **34,99 MiB / 128 MiB**, `https://frota.automacaojs.us/health` → 200.
- `fleetbase-bridge-whatsapp` — imagem `3.0`, `mem=134217728 / swap=268435456`, uso real **18,65 MiB / 128 MiB**.

Backups e jobs de infra (cron):
- `/etc/cron.d/hermes-fleetbase-backup` (03:00) → `backup-daily.sh`; último run com **restauração real**:
  171 tabelas restauradas em `fleetbase_db_sandbox` (o usuário da app não tem `CREATE DATABASE`),
  8 tabelas `hj_*`, 7 pedidos — e o sandbox foi limpo depois, como estava.
- `/etc/cron.d/hermes-fleetbase-watchdog` (2 min) → `watchdog-ntfy.sh`; rodou sem alarme com os dois containers no ar.
- `/etc/cron.d/hermes-fleetbase-dvir-cleanup` (04:00) → `dvir-retention-cleanup.sh`;
  expurgo rodado: 0 foto expirada, disco de uploads em **55%** (limite 80%).

Pendências que ficam para o piloto (não bloqueiam a blindagem):
- `yarn install` no `mobile-navigator` + commit do `yarn.lock` (deps nativas novas:
  `@react-native-async-storage/async-storage`, `react-native-sound`); o CI usa `--immutable`.
- rebuild do APK e **teste em aparelho** (banner, bipe, câmera travada, filas offline, tela de bateria).
- `npx tsc --noEmit` (precisa de `node_modules`).
- Risco conhecido: `react-native-sound` 0.13.0 com New Architecture ligada pode não tocar som —
  o fallback por vibração já cobre. `__tests__/LocationTrackingLifecycle-test.js` já estava quebrado
  antes desta entrega (importa `isLocationTrackingAllowed`, removido na reescrita do `LocationContext`).
- Base de teste: as suítes deixaram ~20 vistorias e alguns pedidos `E2E-*` no banco — são a evidência
  viva; o expurgo de 12 meses limpa depois.

**25/11/2026 03:20 — correção do canal de WhatsApp (bug real encontrado na validação).**
O alerta de WhatsApp do DVIR (bloqueio/fraude/liberação) estava **silenciosamente quebrado**:
o container `evolution-go` publica a porta só em `127.0.0.1` do host, então
`http://host.docker.internal:8096` de dentro do bridge devolvia `fetch failed` — o painel
recebia 200 do `/v1/events` e achava que tinha disparado (falso positivo silencioso).
Correção **sem tocar no Evolution GO**: o bridge passou a entrar na rede `evolution-go-net`
e a falar com `http://evolution-go:8080`. Agora as 6 notificações da suíte saem de verdade.

Também neste lote:
- `infra/own-services.sh` — script único para subir/reiniciar os 2 serviços próprios
  (env persistente em `infra/env/*.env` chmod 600, `--restart unless-stopped`, teto 128 MB).
  O env do painel estava em `/tmp` (some no reboot) — movido para `infra/env/`.
- A suíte DVIR passou a mandar `telefone_gestor` **fictício** (5584999999999), então o
  teste dispara WhatsApp de verdade sem spammar o número real do Isaías.

Resultado final: **prompt1 42/42 · prompt2 50/50** com a deployment final no ar.
