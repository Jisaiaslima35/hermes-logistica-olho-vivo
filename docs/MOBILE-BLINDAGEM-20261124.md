# Blindagem do app mobile — Hermes Logística & Olho Vivo

**Data:** 24/11/2026 (atualizado 25/11/2026)
**Executor:** Claudinho (Claude Code / MiniMax-M3)
**Escopo EXCLUSIVO desta entrega:** `/opt/hermes-fleetbase/mobile-navigator`
**Não tocado:** `web-radio-panel`, `integrations/bridge-whatsapp`, container/imagem `fleetbase-api`,
`infra/`, e qualquer outro projeto da VPS (Mendes Delivery, Mercado Express, CRM Hermes,
Supabase, Evolution GO :8096, rádios). Sem git push, sem restart de container, sem `docker`,
sem `npm install` / `yarn` executados.

Backend: **já implementado e no ar** — painel `fleetbase-web-radio-panel`,
público em `https://frota.automacaojs.us` → `127.0.0.1:8601`.
As rotas novas vivem no **PAINEL**, não no `fleetbase-api`.

---

## 1. Resumo do que foi entregue

| # | Entrega | Situação |
|---|---------|----------|
| 1.2 | Banner vermelho fixo "Olho Vivo" + bipe audível | **OK** — código pronto, falta APK rebuild + teste real |
| 1.3 | Fila offline de posições (2000 pts) → `POST /api/driver/telemetry/batch` | **OK** — falta APK rebuild + teste real |
| 1.4 | Tela "Otimização de Bateria (Não Deixar o Android Fechar)" | **OK** — falta APK rebuild + teste real |
| 2.7 | `DvirInspectionScreen.tsx` + `OfflineDvirQueue.ts` (só câmera, ~200 KB, GPS) | **OK** — falta APK rebuild + teste real |

> **Nada foi testado em dispositivo.** O host não tem `node_modules`, não há TypeScript
> disponível e o APK atual não contém as dependências nativas novas. A validação é de
> leitura do contrato do backend + revisão estática. Ver a seção **7 (verificação em
> aparelho)**.

---

## 2. Arquivos CRIADOS

Todos dentro de `/opt/hermes-fleetbase/mobile-navigator`.

| Arquivo | Papel |
|---|---|
| `src/config/panel.ts` | Configuração única do painel (`PANEL_BASE_URL`, `PANEL_ORGANIZATION_ID`) + `panelFetch()` com injeção de token **de sessão do painel** (nunca o `_driver_token` do fleetbase-api, que causaria 401) + `readPanelError()` + helpers de vehicle_id. |
| `src/modules/beep/Beep.ts` | Bipe do Olho Vivo. Degradação: `react-native-sound` → `Vibration.vibrate([0,120,80,120])`. Nunca lança. |
| `src/components/OlhoVivoBanner.tsx` | Faixa vermelha fixa. Sem botão de fechar, sem estado de dispensado, sem gesto. `pointerEvents="none"`, `zIndex 9999`, safe-area aware. Exporta a constante `OLHO_VIVO_BANNER_TEXT`. |
| `src/hooks/use-olho-vivo-camera-state.ts` | Hook que assina `visionController.onCameraStateChange()` e devolve `true` enquanto a câmera transmite. |
| `src/modules/telemetry/OfflineLocationQueue.ts` | Fila store-and-forward de posições (AsyncStorage protegido + fallback em memória, teto 2000 pts, lotes de 500, ordenação por `recorded_at` original, remoção só em 2xx). |
| `src/modules/dvir/OfflineDvirQueue.ts` | Fila offline de vistorias DVIR: metadados em AsyncStorage, JPEGs em `RNFS.DocumentDirectoryPath + '/dvir-queue/'`, reenvio automático (AppState foreground + backoff 5s/15s/45s/120s + `setInterval`), idempotência por `client_id`. |
| `src/screens/BatteryOptimizationScreen.tsx` | Passo a passo por fabricante (Xiaomi/MIUI/HyperOS, Samsung/OneUI, Motorola, Android 13+ genérico) + botão "ABRIR CONFIGURAÇÕES DO ANDROID". |
| `src/screens/DvirInspectionScreen.tsx` | Vistoria fotográfica obrigatória: templates, entrada/saída, checklist ok/não-ok, odômetro, avaria, 6 slots de foto, **somente câmera**, GPS na captura, compressão, multipart, tratamento de 400/413 e fila offline. |
| `assets/beep.wav` | WAV PCM mono 16-bit, 44 100 Hz, ~0,25 s, seno 880 Hz com envelope (ataque 10 ms / release 50 ms), amplitude 0,6 — 22 094 bytes. |
| `android/app/src/main/res/raw/beep.wav` | Cópia do mesmo WAV para o `react-native-sound` resolver no Android (`R.raw.beep`). |

## 3. Arquivos ALTERADOS

| Arquivo | O que mudou |
|---|---|
| `src/modules/vision/VisionController.ts` | **API pública preservada.** Adicionado: `isCameraActive()`, `onCameraStateChange(listener)`, `setCameraActive()` (interno, avisa listeners), `getAuditContext()`, `reportCameraState()` (POST fire-and-forget em `/api/driver/olho-vivo/camera-state`). Em `startStream()`: após `setCameraEnabled` → `setCameraActive(true)` + `playBeep()` + `reportCameraState(true)`. Em `stopStream()`: `setCameraActive(false)` + report em ambos os caminhos. **Preservado:** resolução 640×480@15fps, TTL de 600 000 ms, `switchFacing`, `attachRoom`, DataChannel (`stream_video` / `switch_camera` / `ptt` / `tts` / `ack`). |
| `src/layouts/DriverLayout.tsx` | Renderiza `<OlhoVivoBanner />` dentro do layout do motorista — a faixa aparece em **todas** as telas do driver. Além disso, o **auto-flush da fila offline de vistorias** mora aqui (com cleanup no unmount), para que a fila reenvie mesmo que o motorista não abra a tela de DVIR depois de um turno sem sinal. |
| `src/contexts/LocationContext.tsx` | Importa `offlineLocationQueue` e `DeviceInfo`. Em `handlePositionUpdate`: enfileira cada ponto com o **timestamp original do dispositivo** (`pos.timestamp`), `speed_kph`, `heading_deg`, `battery_pct` (leitura com cache de 60 s), `deviation_m`, `stopped_s`. Novo `useEffect`: `offlineLocationQueue.load()` + `startAutoFlush(60000)` com cleanup. |
| `src/navigation/DriverNavigator.tsx` | Duas rotas novas no stack `DriverDashboardTab`: `BatteryOptimization` e `DvirInspection` (`headerShown: false`). |
| `src/screens/DriverDashboardScreen.tsx` | Botões visíveis "Vistoria do veículo (DVIR)" e "Bateria"; widget **Filas offline** com "N ponto(s)" de telemetria e "N vistoria(s)" pendentes. Assina `offlineLocationQueue.onChange()` e `offlineDvirQueue.onChange()`. Nada removido. |
| `package.json` | **Só acrescimos:** `@react-native-async-storage/async-storage ^2.1.0` e `react-native-sound ^0.13.0`. Nenhuma dependência existente foi removida ou alterada. |

---

## 4. Contrato de API usado

Base: `https://frota.automacaojs.us` (constante `PANEL_BASE_URL` em `src/config/panel.ts`).
Organização: `5b4e40e1-0348-4051-835d-4cbc33b9cf36` (`PANEL_ORGANIZATION_ID`).

### 4.1 `POST /api/driver/telemetry/batch`
Headers: `Content-Type: application/json`, `X-Organization-Id: <org>`.
```json
{
  "vehicle_id": "VH-001",
  "driver_id": "<id do registro driver no MMKV>",
  "order_id": null,
  "points": [
    { "lat": -5.79, "lon": -35.37, "speed_kph": 42.5, "heading_deg": 180,
      "battery_pct": 88, "deviation_m": null, "stopped_s": 0,
      "recorded_at": "2026-11-24T18:04:11.000Z" }
  ]
}
```
Regras do cliente: máximo **2000 pontos** na fila (descarta os mais antigos), lote de **500**,
ordenado crescentemente por `recorded_at`, e **o ponto só sai da fila com HTTP 2xx**.

### 4.2 `GET /api/dvir/templates`
Resposta (array):
```json
[{ "id": "...", "vehicle_category": "moto|utilitario|bau|carreta",
   "label": "Moto / Mototáxi",
   "required_items": ["pneu_pressao","freios","..."],
   "required_photos": ["frente","lateral_esquerda","lateral_direita","pneus","velocimetro"] }]
```
O app mapeia as chaves de item para rótulo legível (`pneu_pressao` → "Pneu pressao") e
aceita `bau` **e** `caminhao_bau` como a mesma categoria.

### 4.3 `POST /api/driver/dvir` (multipart/form-data)
Campos de texto:
`vehicle_id`, `driver_id`, `shift_type` (`entrada`|`saida`), `checklist` (JSON string),
`has_damage` (`'1'`|`'0'`), `damage_notes`, `odometer_km`, `gps_lat`, `gps_lng`,
`organization_id`, `paired_inspection_id`, `client_id`.
Fotos — **o nome do campo do multipart É o nome do slot**:
`frente`, `lateral_esquerda`, `lateral_direita`, `pneus`, `velocimetro`, `avaria`
(cada uma como arquivo `image/jpeg`).

Resposta: **201** com `{ id, organization_id, vehicle_id, shift_type, status, locked_immutable,
has_damage, paired_inspection_id, vehicle_blocked, photos: [...], blocked_message }`.

Erros tratados na tela: **400** (ex.: "É obrigatória ao menos uma foto", "shift_type deve ser
'entrada' ou 'saida'", "Vistoria com avaria exige damage_notes preenchido", "Slot de foto
inválido", "Arquivo não é um JPEG válido") e **413** (foto acima do limite).

### 4.4 `POST /api/driver/olho-vivo/camera-state`
```json
{ "active": true, "vehicle_id": "...", "driver_id": "...", "organization_id": "..." }
```
Fire-and-forget: falha de rede aqui **nunca** derruba a câmera.

### 4.5 Autenticação (ponto crítico)
O painel valida **JWT de sessão próprio** (`verifySessionToken`). O token que o app já guardava
(`_driver_token`) é do **fleetbase-api** e **não é válido no painel** — enviá-lo derrubaria a
requisição com 401. Por isso `panelFetch()` só injeta `Authorization: Bearer` quando existe um
token **do painel** (`_panel_session_token`, via `setPanelSessionToken()`), e as rotas de
motorista seguem funcionando sem token porque o backend resolve a organização pelo
`organization_id` enviado no body (fallback documentado em `src/dvir.js` → `resolveOrganization`).

---

## 5. Blindagem do fluxo DVIR — galeria TRAVADA

Requisito crítico do briefing. Como foi garantido:

1. `DvirInspectionScreen.tsx` **não importa** `react-native-image-picker` e **não chama**
   `launchImageLibrary` em nenhum ponto.
2. O componente `src/components/CameraCapture.tsx` **não foi reaproveitado** — ele tem botão
   de galeria. O DVIR usa um componente **interno** (`DvirCamera`, dentro do próprio arquivo)
   que chama apenas `cameraRef.current.takePhoto()`.
3. A UI mostra o aviso **"Galeria bloqueada — apenas câmera"** no topo da tela e sobre o
   botão de captura.
4. A captura é **obrigatória e na hora**: as fotos só existem se o motorista fotografar
   naquele momento; não há caminho para reaproveitar imagem existente.

Compressão: `@bam.tech/react-native-image-resizer` —
`createResizedImage(uri, 1280, 960, 'JPEG', 80, 0, undefined, false, { mode:'contain', onlyScaleDown:true })`.
Se o resultado passar de **400 KB**, reprocessa em 1024×768 qualidade 55. O tamanho final é
exibido na tela (e no log).

GPS: `react-native-geolocation-service.getCurrentPosition` é chamado **no momento da captura**
(high accuracy, timeout 15 s, `maximumAge` 5 s). Se o GPS falhar, o app usa a última posição
conhecida do `LocationContext` como fallback e mostra "sem GPS" na linha do slot.

Fila offline: se a POST falhar por rede (exceção do `fetch`) ou o painel responder 5xx/408/429,
a vistoria é guardada **com os JPEGs copiados para disco** e reenviada automaticamente.
Erros 4xx (conteúdo inválido) **não** entram na fila — são mostrados na tela para correção.

---

## 6. Como rebuildar o APK (passo a passo)

Duas dependências **nativas** entram nesta entrega. Sem rebuild, o app **ainda abre**
(os dois módulos são carregados com `require` dinâmico protegido + fallback), mas:

* a fila offline de telemetria e a de DVIR passam a ser **só em memória** (somem ao fechar o app);
* o bipe cai para **vibração** em vez de som.

### 6.1 Dependências nativas novas
| Pacote | Tipo | O que entra |
|---|---|---|
| `@react-native-async-storage/async-storage ^2.1.0` | nativo (autolink) | persistência das duas filas offline |
| `react-native-sound ^0.13.0` | nativo (autolink) | bipe audível do Olho Vivo |

Nenhuma permission Android nova é necessária (áudio não precisa de permission; o
`MODIFY_AUDIO_SETTINGS` já existe no `AndroidManifest.xml`).

### 6.2 Passos
```bash
cd /opt/hermes-fleetbase/mobile-navigator

# 1) reinstalar dependências (OBRIGATÓRIO: yarn.lock ainda não tem os pacotes novos)
yarn install

# 2) build do Android
yarn android          # ou: cd android && ./gradlew assembleRelease
```
O autolinking do React Native detecta os dois pacotes novos e modifica
`android/app/build.gradle` automaticamente — **não** é preciso editar Gradle na mão.

### 6.3 ATENÇÃO — `yarn.lock`
O CI usa `yarn install --immutable` (`.github/workflows/react-native-ci.yml`).
Como `package.json` mudou, **o `yarn.lock` precisa ser regenerado e commitado**
(`yarn install` faz isso). Sem isso, o CI quebra com "lockfile would have been modified".
Este passo **não** foi executado aqui porque o briefing proíbe rodar `yarn`/`npm install`
no host (sem `node_modules`, sem download).

### 6.4 iOS (se necessário)
`cd ios && pod install` — os dois pacotes exigem pods. Não executado neste ambiente (host Linux).

### 6.5 Asset do bipe
`assets/beep.wav` já está no repositório e a cópia para
`android/app/src/main/res/raw/beep.wav` também. **Nada a fazer** — o `react-native-sound`
no Android resolve `R.raw.beep` pelo nome `beep` (minúsculo, sem extensão).

---

## 7. O que precisa ser verificado em aparelho real

Nada disso foi testado — o APK atual não tem as deps novas. Checklist para o teste de campo:

**A. Banner do Olho Vivo (obrigatório, não pode falhar)**
- [ ] Com a Central mandando `stream_video` (DataChannel LiveKit), a faixa vermelha aparece
      **no topo, fixa**, em todas as telas do driver.
- [ ] O texto é **exatamente** `CÂMERA OLHO VIVO ATIVA — TRANSMITINDO PARA A CENTRAL`.
- [ ] **Não existe** X de fechar, nem arrastar para dispensar, nem "não mostrar de novo".
      Recarregar a tela / navegar não pode tirar a faixa.
- [ ] A faixa **não bloqueia** toques na UI (é `pointerEvents="none"`).
- [ ] Ela some quando a Central desliga a câmera (`stream_video` com `state:false`).
- [ ] A faixa aparece **acima** da status bar (safe-area) e não fica escondida atrás dela.

**B. Bipe (obrigatório)**
- [ ] Ao ativar a câmera, toca um bipe **audível** no volume do aparelho.
- [ ] Se o `react-native-sound` não tocar (APK sem rebuild), a **vibração** assume — e isso
      precisa estar documentado para o motorista (vibração ≠ bipe).
- [ ] O bipe **não** derruba a câmera nem trava a tela se o áudio falhar.
- [ ] Conferir se o `react-native-sound` 0.13.0 roda bem com **New Architecture**
      (`newArchEnabled=true` no `android/gradle.properties`). Se não rodar, considerar
      `react-native-sound-player` ou manter a vibração como padrão.

**C. Fila offline de telemetria**
- [ ] Pilotar em área **sem sinal** (por exemplo, subsolo/garagem) por alguns minutos.
- [ ] O painel deve receber os pontos quando o sinal voltar, **com o horário original** do
      dispositivo (não o horário do flush).
- [ ] Dashboard mostra "N ponto(s)" aguardando; depois do envio, zera.
- [ ] Com 2000+ pontos, os **mais antigos** são descartados (teto).

**D. Vistoria DVIR**
- [ ] "Vistoria do veículo (DVIR)" aparece no dashboard e abre a tela.
- [ ] O checklist carrega do backend conforme a categoria do veículo.
- [ ] **A captura abre SÓ a câmera** — não existe nenhuma opção de galeria em nenhum caminho
      da tela (nem com o botão "Refazer").
- [ ] Cada foto sai com tamanho exibido em KB (ideal ~150–350 KB) e GPS preenchido.
- [ ] Foto > 400 KB é recomprimida automaticamente.
- [ ] Envio com `has_damage = SIM` **sem** `damage_notes` é bloqueado pelo painel (400) e a
      mensagem aparece na tela.
- [ ] Envio **sem rede**: aparece "N vistoria(s) aguardando envio"; ao voltar a ter rede
      (app em foreground), a vistoria é reenviada sozinha e o contador zera.
- [ ] O JPEG chega íntegro no painel (o backend valida magic bytes e o sha256) e aparece na
      galeria comparativa entrada × saída.

**E. Tela de bateria**
- [ ] Abre pelo botão "Bateria" no dashboard.
- [ ] O caminho exibido bate com o fabricante real do aparelho (Xiaomi, Samsung, Motorola ou genérico).
- [ ] O botão abre as configurações do Android (ou as configurações do app na ROM).

**F. Navegação / regressões**
- [ ] Dashboard continua abrindo, com "Tracking", "Location", "Active Orders" e "Speed".
- [ ] Nenhuma tela do driver ficou sem a faixa quando a câmera está ativa.

---

## 8. Riscos, limitações e pendências

1. **Sem typecheck.** Não há `node_modules` no host e o briefing proíbe instalar. A
   tipagem foi feita à mão, com atenção especial a:
   - `declare const require: (moduleId: string) => any;` declarado no **escopo do módulo**
     (nos arquivos `Beep.ts`, `VisionController.ts`, `OfflineLocationQueue.ts`,
     `OfflineDvirQueue.ts`, `config/panel.ts`) — evita `TS2580` e não colide com
     declaração global do React Native;
   - `PHOTO_SLOTS` tipado como `string[]` (não `as const`) para o `.includes(slot)`
     não quebrar com `string`;
   - `useRef<CameraRef>(null)` com `import type { Camera as CameraRef }`.
   **Rodar `npx tsc --noEmit` depois do `yarn install` é o primeiro passo do QA.**

2. **`react-native-sound` + New Architecture.** Ver item B da seção 7. É o único ponto
   com risco real de não funcionar como esperado — a degradação para vibração já está
   implementada e cobre o caso.

3. **`yarn.lock` desatualizado** — bloqueia o CI até `yarn install` ser rodado (seção 6.3).

4. **Teste preexistente quebrado (NÃO é desta entrega).**
   `__tests__/LocationTrackingLifecycle-test.js` importa `isLocationTrackingAllowed` de
   `LocationContext`, e essa função **não existe** no arquivo. A suíte já estava vermelha
   antes desta blindagem. Não foi corrigida aqui porque está fora do escopo do briefing;
   se for corrigir, é uma linha exportada em `src/contexts/LocationContext.tsx`.

5. **`vehicle_id` no aparelho.** O app não tem conceito de "veículo vinculado" — o id vem
   do storage (`_panel_vehicle_id`) ou é digitado pelo motorista na tela de DVIR (campo
   "ID do veículo (obrigatório)"). Depois de uma vistoria enviada com sucesso, o id digitado
   é gravado no storage e passa a ser usado também pela telemetria. As colunas do painel
   são `VARCHAR(64)`, então qualquer id textual serve.

6. **Fora do escopo desta entrega** (existem, mas são do painel/`infra`, não do app):
   badge de "sem sinal > 3 min" na Central, NTFY de bateria <= 15%, scripts de backup e
   watchdog, `DEMO_MODE` estrito, retenção de DVIR e limpeza de disco.

7. **Nenhum commit foi feito.** As mudanças estão no working tree de
   `/opt/hermes-fleetbase/mobile-navigator` (arquivos de `src/modules/`, `src/config/`,
   `src/components/OlhoVivoBanner.tsx`, `src/hooks/use-olho-vivo-camera-state.ts`,
   `src/screens/BatteryOptimizationScreen.tsx`, `src/screens/DvirInspectionScreen.tsx`,
   `assets/beep.wav`, `android/app/src/main/res/raw/beep.wav` aparecem como **untracked**).
   Como o briefing proíbe `git push`, nada foi publicado.

---

## 9. Mapa rápido: onde mexer

| Preciso mexer em... | Arquivo |
|---|---|
| Endereço do painel / org / token | `src/config/panel.ts` |
| Aviso visual da câmera | `src/components/OlhoVivoBanner.tsx` |
| Bipe | `src/modules/beep/Beep.ts` (+ `assets/beep.wav`, `android/app/src/main/res/raw/beep.wav`) |
| Ligar/desligar câmera + auditoria | `src/modules/vision/VisionController.ts` |
| Fila de posições | `src/modules/telemetry/OfflineLocationQueue.ts` (+ `src/contexts/LocationContext.tsx`) |
| Fila de vistorias | `src/modules/dvir/OfflineDvirQueue.ts` |
| Tela de vistoria | `src/screens/DvirInspectionScreen.tsx` |
| Tela de bateria | `src/screens/BatteryOptimizationScreen.tsx` |
| Rotas | `src/navigation/DriverNavigator.tsx` (stack `DriverDashboardTab`) |
| Botões e contadores | `src/screens/DriverDashboardScreen.tsx` |
