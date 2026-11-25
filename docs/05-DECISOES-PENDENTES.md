# 05-DECISOES-PENDENTES.md — Pacote de Decisão

**Projeto:** Hermes Logística & Olho Vivo (Fleetbase + Navigator + LiveKit PTT/Vision)
**Para:** o Isaías decidir — com apoio de outro assistente
**Data:** 18/11/2026 · **Documentos-fonte:** `01-BRD.md` · `02-PRD.md` · `03-ARCHITECTURE-ADR.md` · `04-SPEC-KIT.md`
**Estado:** 4 documentos de especificação prontos (172 KB). **Nada instalado, nenhum serviço de produção alterado.**

> ## ⚠️ RESOLVIDO EM 18/11/2026 — 17:17 BRT (documento histórico)
>
> **As 22 decisões foram aprovadas pelo Isaías** e já estão **gravadas** nos documentos-fonte.
> Este arquivo vira **registro histórico** do pacote de decisão — **não é mais uma lista de
> perguntas abertas**. O conteúdo de §1 a §3 é preservado como está, para auditoria.
>
> | Onde a decisão está registrada | O que foi escrito |
> |---|---|
> | `03-ARCHITECTURE-ADR.md` **§12.1** | tabela das 22 decisões aprovadas (ID · pergunta · decisão · efeito) |
> | `03-ARCHITECTURE-ADR.md` **§12.2** | **ADR-016 a ADR-025** — contexto, decisão, consequências, alternativas descartadas |
> | `03-ARCHITECTURE-ADR.md` **§12.3** | topologia da **VPS-2 (Mídia & Streaming)** + checklist de cutover |
> | `03-ARCHITECTURE-ADR.md` **§12.4** | diagnóstico de RAM/swap do host (2 leituras, read-only) |
> | `04-SPEC-KIT.md` **§10.5** | tabela das 22 decisões + §10.5.1 (regras contra-normativas) + §10.5.2 (variáveis de mídia) |
> | `04-SPEC-KIT.md` **AC-016, AC-017, AC-018, AC-105, AC-106, AC-113** | critérios de aceite reescritos para casar com as decisões |
> | `04-SPEC-KIT.md` **§3.1** | variáveis novas (`TURN_EXTERNAL_IP`, `LIVEKIT_HOST`, `RADIO_PUBLIC_URL`, `RADIO_LOUVOR_URL`, `TENANT_DEFAULT_TIMEZONE`) |
>
> **O que continua pendente (não é decisão de produto — é execução):**
> o **gate F1-VAL-001** (`php artisan migrate --force` limpo) ainda não rodou, então o **Plano A
> (Postgres) vs Plano B (MySQL 640 MB)** ainda é decided **por medição, não por decisão**.
> Nenhum container do F1 subiu; nada de produção foi alterado.

---

## 0. Instruções para o assistente que vai ajudar

Você vai ajudar o Isaías a tomar **22 decisões de produto e arquitetura** sobre um projeto de software já especificado. Seu papel é **apresentar opções com trade-offs claros e uma recomendação**, não decidir por ele.

### 0.1 O que você recebe

| Documento | O que tem | Tamanho |
|---|---|---|
| `01-BRD.md` | Negócio, planos de preço, 5 verticais, riscos de negócio | 20 KB |
| `02-PRD.md` | Requisitos funcionais por perfil, 41 histórias de usuário, 14 não-funcionais, bloqueadores | 23 KB |
| `03-ARCHITECTURE-ADR.md` | 15 decisões de arquitetura já tomadas, medição do host, riscos técnicos | 54 KB |
| `04-SPEC-KIT.md` | Contratos de API/JSON, compose, 214 critérios de aceite, 75 tasks | 75 KB |

Você **não precisa ler tudo** para decidir. Este documento contém o resumo executivo de cada decisão pendente. Se precisar do detalhe, os caminhos estão em §6.

### 0.2 O projeto em 8 linhas

Plataforma SaaS multi-tenant de gestão de frotas: o embarcador cria uma **ordem de serviço (OS)**, o motorista executa em um app Android, o gestor acompanha ao vivo e fala com a frota por **rádio PTT**, e o **Olho Vivo** liga a câmera do veículo sob demanda (480p/15fps) quando há dúvida em uma carga. O cliente final acompanha por um **link de rastreio temporário** e recebe avisos no **WhatsApp**. Duas verticais de entrada: **transporte pesado** (Cavalo Mecânico) e **motoboys** (Centauro). Diferencial comercial: **um só app** que serve embarcador, gestor, motorista e cliente — os concorrentes têm um rastreador de hardware para o gestor e um WhatsApp separado para o cliente.

### 0.3 Restrições **duras** — NÃO proponha violar

Estas cinco foram fixadas pelo Isaac. Qualquer proposta que as quebre está descartada, mesmo que pareça melhor:

1. **Não criar container de banco de dados novo.** O Postgres já está rodando (Supabase self-hosted) — reusar é obrigatório, ou o stack não cabe no orçamento de RAM.
2. **Orçamento rígido de 4,5 GB de RAM** para o stack inteiro (o ADR fecha em 3,36 GB).
3. **Zero custo em mapas e roteamento.** Nada de API paga de mapas/rota, nada de motor de roteamento local pesado (Valhalla forbidden), nada de biblioteca de geolocalização paga.
4. **Câmera do veículo começa DESLIGADA** e só liga sob comando explícito; fixo em 480p/15fps; PTT é falar-e-segurar.
5. **AGPL-3.0 no core Fleetbase** — tudo que for proprietário (painel de rádio, ponte WhatsApp, regras de negócio) vive em **serviços separados** que conversam com o core por API/webhook. Nenhuma regra de negócio dentro do core.

### 0.4 Fatos **medidos** (18/11/2026) — não são opinião, use como verdade

- Host `hermes-prod`: 8 vCPU, 24 GB RAM, mas **só 7,28 GB disponíveis** e **swap 100 % ocupada**.
- **Fleetbase upstream é MySQL-only** (`DATABASE_URL=mysql://`, `config/database.php` com `connections => []`). Reusar o Postgres é um **desvio** → virou gate de validação **F1-VAL-001** (rodar `php artisan migrate --force` e ver se passa limpo). Falhando: MySQL dedicado (640 MB) ou micro-VPS (2 GB).
- Free tier de CGNAT: celular em 4G/5G atrás de CGNAT **não** consegue UDP direto. O **TURN relay é obrigatório**, com porta UDP pública (3478 + faixa 49160-49260/udp). O Cloudflare Tunnel **não transporta UDP**.
- `react-native-geolocation-service` está **sem manutenção desde set/2022** (risco real de compatibilidade Android 14/15).
- `react-native-maps` (Google) é **pago** — precisa sair do app.
- Evolução GO (WhatsApp) já roda no host em `:8096`; a Evolution API v2 (`:8080`) é **outro produto** e não deve ser misturada.
- Preço: Start R$39 / Pro R$89 / Enterprise R$149 por veículo-mês. Piloto: 3–5 frotas, 60 dias.

### 0.5 Como responder

Para **cada uma das 18 decisões abertas** (as 4 já respondidas estão marcadas), entregue:

1. **Recomendação** — 1 opção, com 1 frase de justificativa.
2. **Por que não as outras** — a consequência concreta de cada alternativa descartada.
3. **O que quebra se eu decidir diferente** — quais documentos, tasks, contratos ou telas mudam.
4. **O que precisa ser verdade** para a recomendação funcionar (uma suposição verificável).

Ao final, uma **tabela-resumo** com: ID · decisão · recomendação · impacto se adiado (Alto/Médio/Baixo) · qual gate ela trava (F1/F2/F3/F4/F5).

**Prioridade de decisão:** o bloco A trava o **F1** (spike técnico). O bloco B trava o **F3** (mídia em 4G real). O bloco C trava o **F4/F5** (público e piloto). Se o tempo do Isaac for curto, decida o bloco A primeiro.

---

## 1. Bloco A — travam o F1 (decisões técnicas, maior impacto)

### Q-001 — O banco é Postgres (reusando o Supabase) ou MySQL dedicado?

- **Contexto.** O Isaac pediu para reusar o Postgres já ativo em vez de subir um MySQL novo (economia de ~640 MB). O upstream do Fleetbase é MySQL-only, então isso é um desvio que precisa ser provado, não assumido.
- **Opções.**
  - **A. Postgres (Plano A)** — `fleetbase_db` + role `fleetbase_app` sem superuser, `REVOKE CREATEDB`, conexão pela rede Docker interna (10.0.19.8:5432, sem publicar porta). Economiza 640 MB. **Condicionado ao gate F1-VAL-001.**
  - **B. MySQL 8 dedicado no host** — `innodb_buffer_pool_size=128M`, `performance_schema=OFF`, `skip-log-bin`, 640 MB. É o caminho testado pelo upstream.
  - **C. Banco em micro-VPS de 2 GB** — tira 640 MB do host, custa uma máquina a mais e latência de rede.
- **Default já assumido nos documentos.** Plano A, com B e C prontos como fallback.
- **Recomendação do Arquiteto.** **A, com gate obrigatório.** O gate é barato (é rodar as migrations); o ganho de RAM é real e o teto de 4,5 GB fica com folga de sobra. Manter B e C escritos é o plano de fuga.
- **Se decidir diferente.** B muda o compose (`compose.routers.yml` já tem o serviço pronto), exige `DATABASE_URL=mysql://` e muda o gate F1-VAL-001 para "migrations no MySQL".
- **Bloqueia.** F1 inteiro. **Risco se adiado:** R-00 (probabilidade alta, impacto alto).

### Q-002 — O plano de mídia (LiveKit + Coturn, 704 MB) roda no hermes-prod ou num micro-VPS de 2 GB?

- **Contexto.** O teto de RAM fecha (3,36 GB < 4,5 GB), mas o host tem só 7,28 GB disponíveis e swap lotada. Além disso, o servidor TURN precisa de **porta UDP pública no IP do host** — se o LiveKit estiver em outra máquina, o IP público muda e o `external-ip` do coturn tem que acompanhar.
- **Opções.**
  - **A. Tudo no hermes-prod** — mais simples, um IP público, um firewall. Consome 704 MB do host apertado.
  - **B. Mídia em micro-VPS de 2 GB** (mesmo IP? não) — alivia o host; exige ajustar `external-ip`, DNS/turn domain e o firewall de dois lados.
  - **C. Híbrido: LiveKit no host, TURN em outra máquina** — o mais complexo; Split Horizon de ICE costuma dar dor de cabeça.
- **Default já assumido.** A, **com** B como plano caso o gate de RAM (`MemAvailable ≥ 6 GB`) falhe.
- **Recomendação do Arquiteto.** **A agora, B como plano de fuga.** Decidir B de antemão só faz sentido se o gate de RAM já estiver falhando hoje — e isso é medido, não adivinhado.
- **Se decidir diferente.** B mexe em `ADR-005` (portas), `ADR-007` (CGNAT), `ADR-010` (redes), `SPEC §7.1` (compose), `SPEC §8.2` (coturn `external-ip`) e no `livekit.yaml`.
- **Bloqueia.** F1/F3. **Risco se adiado:** R-01/R-02 (host com swap em 100 %).

### Q-009 + Q-101 — Qual é a chave de idempotência dos webhooks?

- **Contexto.** O core reenvia webhook 5 vezes (backoff). O bridge precisa saber se já processou. Duas chaves possíveis: **por evento** (`event_id` gerado na origem) ou **por (evento, OS, minuto)** (determinístico, protege contra o app reenviar o mesmo fato com id novo).
- **Opções.**
  - **A. `sha256(event_type + subject.id + occurred_at + hash(payload))`** — determinístico no servidor; reenvio com o mesmo conteúdo = mesma chave. Boa para idempotência **técnica**.
  - **B. `event_id` (uuid) da origem** — o app gera; o servidor confia. Simples, mas se o app recriar o id num retry, duplica.
  - **C. Combinação**: `event_id` no envelope + `idempotency_key` determinística calculada no servidor. Aceita duplicatas reais (dois eventos iguais no mesmo minuto) **e** bloqueia reenvio.
- **Default já assumido.** C (o envelope já tem `event_id` + `correlation_id` + `idempotency_key`).
- **Recomendação do Arquiteto.** **C.** É a única que protege dos dois lados; o custo é um campo a mais no contrato, que já existe.
- **Se decidir diferente.** Muda `SPEC §4.1`, `SPEC §5.1..5.10` e o `envelope.schema.json` (tarefa T-040).
- **Bloqueia.** F2 (bridge).

### Q-011 — O Fleet-Ops entra na fase 1?

- **Contexto.** Fleet-Ops = `@fleetbase/fleetops-engine` (UI Ember) + `fleetbase/fleetops-api` (modelos/jobs Laravel). É um *layer* de dispatch sobre o core. Não traz compose próprio. Incluir = mais UI e mais regras de dispatch prontas; excluir = menos superfície, menos risco de conflito com a camada AGPL/proprietária.
- **Opções.**
  - **A. Entra na fase 1** (com `console` substituído pelo nginx do host) — reaproveita muito e entrega painel de despacho.
  - **B. Entra na fase 2** — fase 1 fica só com API + app + mídia.
  - **C. Não entra** — só o core puro; a gente constrói o painel do zero (muito mais caro).
- **Default já assumido.** A.
- **Recomendação do Arquiteto.** **A**, mas com a suposição **ASM-010** verificada antes (o `fleetops-engine` roda sem alteração no core?).
- **Se decidir diferente.** B/C reduzem o compose e o RAM, mas aumentam o escopo de frontend.
- **Bloqueia.** F2 (escopo do compose).

### Q-012 — O teto de RAM é 4,5 GB ou 3,5 GB?

- **Contexto.** NF-06 do PRD diz 4,5 GB. A soma planejada é 3,36 GB, e com VROOM + MySQL (pior caso) 4,26 GB — folga de 340 MB num host com swap lotada.
- **Opções.**
  - **A. Teto 4,5 GB** — bate com o PRD; folga mínima de 340 MB no pior caso.
  - **B. Teto 3,5 GB** — mais seguro para o host; **exige** cortar VROOM da fase 1 e/ou tirar o MySQL (logo, exigiria o Postgres funcionar).
  - **C. Teto 4,5 GB mas com VROOM e MySQL proibidos simultaneamente** (mutuamente exclusivos) — o plano real fica em 3,6 GB.
- **Default já assumido.** A (4,5 GB), com ressalva explícita de que o pior caso deixa 340 MB.
- **Recomendação do Arquiteto.** **C.** O teto formal continua 4,5 GB (não briga com o PRD), mas com exclusão mútua VROOM/MySQL, de modo que o pior caso real seja 3,6 GB. Assim a folga real é de ~900 MB.
- **Se decidir diferente.** B muda o ADR §6 inteiro e provavelmente a ordem das fases.
- **Bloqueia.** F1 (definir o `mem_limit` de cada container).

### Q-003 — Os nomes de domínio são esses?

- **Contexto.** Propostos: `fleetbase.automacaojs.us` (API + socket), `livekit.automacaojs.us` (sinalização LiveKit — **já reservado** no tunnel), `radio.automacaojs.us` (painel), `track.automacaojs.us` (link do cliente). O host já tem ~47 hostnames no mesmo tunnel.
- **Opções.**
  - **A. Manter os 4 nomes** — consistente, e reaproveita a reserva do `livekit`.
  - **B. Consolidar**: `fleetbase.automacaojs.us` serve API, socket, painel e link (subpaths) — menos nomes, mais superfície num host só.
  - **C. Nomes próprios do produto** (ex.: `rastreio.<marca>.com.br`) — melhor para o cliente final (marca white-label), mas exige DNS/Edge extras.
- **Default já assumido.** A.
- **Recomendação do Arquiteto.** **A para o piloto, C como plano de white-label.** Atenção: alterar rota do Cloudflare **só** por PUT na API (o disco e a Edge divergem com frequência — skill `cf-tunnel-edge-sync`).
- **Se decidir diferente.** Muda o `nginx` (`SPEC §9`), o `SPEC §7.3` e o passo F4.

---

## 2. Bloco B — travam o F3 (produto e mídia)

### Q-005 + Q-107 + Q-108 — Quem pode pedir vídeo, e para quem ele vai?

- **Contexto.** Este é o item mais sensível do produto: liga a câmera do veículo de um motorista. "Quem tem botão" é decisão de permissão, de auditoria e de confiança do motorista.
- **Opções (quem solicita).**
  - **A. Gestor da frota + dono do veículo** — padrão do ADR.
  - **B. Somente gestor** — mais simples, menos exposição.
  - **C. Gestor + embarcador** — o embarcador vê a carga antes de entrar; bem alinhado ao caso de uso (carga friada, divergência de quantidade), mas é o embarcador de **outra** empresa.
  - **D. Também pelo motorista** (câmera do próprio veículo, para o embarcador ver) — inverte o fluxo de vigilância e é sensível demais para a v1.
- **Opções (para quem o vídeo vai).**
  - **1. Só o solicitante** — 1 receptor, banda mínima.
  - **2. Solicitante + gestor da frota** — cobre o caso "embarcador pede, gestor precisa ver".
  - **3. Sala de rádio inteira** — mais simples de implementar, mas multiplica o custo de banda do relay.
- **Default já assumido.** Solicitante: gestor + dono do veículo. Receptores: solicitante + quem está na sala.
- **Recomendação do Arquiteto.** **B (só gestor) como v1, com C e o dono do veículo como permissão por tenant** (o `tenant` já tem esse modelo no PRD). Receptores: **opção 1 + gestor**. Ou seja: permissão **por tenant**, receptor **mínimo**. E abrir mão da opção D na v1.
- **Se decidir diferente.** Muda `SPEC §10.2 AC-106`, o middleware de permissão no painel (T-062), a auditoria (T-014/AC-214) e o PRD P-B4.
- **Bloqueia.** F3.

### Q-006 — Duração da sessão de vídeo: 10 min fixo ou configurável?

- **Contexto.** O TTL é o que protege bateria, banda e privacidade (o app desliga a câmera sozinho no fim). O default atual é 10 min, configurável.
- **Opções.** **A.** 10 min fixo · **B.** 5 min fixo · **C.** configurável por tenant, com 10 min como default e teto de 30 min · **D.** configurável livre (risco de sessão esquecida com a câmera aberta).
- **Default já assumido.** C (10 min default).
- **Recomendação do Arquiteto.** **C, com teto duro de 30 min.** O manual de uso real (verificar carga, falar com o motorista) cabe em 10; mas auditoria e gestão de incidente pedem ajuste sem novo deploy. O teto de 30 min é o que impede "esqueci a câmera aberta o dia todo".
- **Se decidir diferente.** Muda `ADR-013`, `SPEC §6.4` (job de expiração), `AC-105` e o token LiveKit (TTL).

### Q-008 — Validade do link de rastreio: 6 h é OK?

- **Contexto.** O link é assinado (JWT), revogável e dá ao cliente final a posição do veículo. Validade longa = cliente feliz; validade curta = menos exposição (LGPD) e menos risco de vazar com quem não devia.
- **Opções.** **A.** 6 h (default) · **B.** 12 h (cobre viagem longa) · **C.** 24 h (cofre até a entrega) · **D.** até a conclusão da OS (evento, não tempo) · **E.** 6 h renovável com 1 clique.
- **Default já assumido.** A.
- **Recomendação do Arquiteto.** **E (6 h renovável) ou D (até a OS concluir, com teto de 24 h).** Em logística, a pergunta natural do cliente é "e depois?"; o renovável resolve sem segurar o link aceso mais do que o necessário. Se for para escolher **uma** sem mais info: **D com teto de 24 h** — o fim do rastreio é um evento de negócio, não um relógio.
- **Se decidir diferente.** Muda `SPEC §5.6`, o `token.ts` (T-052), `AC-018`, `AC-211` e a página do cliente (T-066).

### Q-104 — Limiar de desvio de rota: 200 m por 5 min?

- **Contexto.** Dispara alerta de desvio. Cedo demais = alarme falso em área urbana, trânsito, obras e becos; tarde demais = o motorista já saiu da rota.
- **Opções.** **A.** 200 m / 5 min (default) · **B.** 300 m / 10 min (conservador, menos falso positivo) · **C.** 500 m / 5 min (só desvio claro) · **D.** Dinâmico por contexto: 150 m na cidade, 500 m na estrada.
- **Default já assumido.** A.
- **Recomendação do Arquiteto.** **B como default, com C para rota rural/rodoviária.** Falso positivo em desvio operacional é o que mata o uso do alerta: se o alerta dispara toda semana sem ser nada, o gestor desliga. 300 m / 10 min elimina boa parte do ruído de área urbana sem perder o desvio grande (que é o que interessa).
- **Se decidir diferente.** Muda `AC-016`, a regra de desvio no core e o formato da mensagem (T-049).

### Q-105 — Parada prolongada: 15 min ou 20 min?

- **Contexto.** Parada fora de ponto de carga/descarga. Parada curta = trânsito, fila de posto, baldeação, cliente. Parada longa = problema real.
- **Opções.** **A.** 15 min (default) · **B.** 20 min · **C.** 30 min · **D.** por tipo de rota (urbano 15, rodoviário 30).
- **Default já assumido.** A.
- **Recomendação do Arquiteto.** **A (15 min) como default, com regra por contexto na v2.** Nota: o impacto real é que parada prolongada também vira **mensagem de WhatsApp** (AC-205) — alarme falso custa caro no WhatsApp do cliente.
- **Se decidir diferente.** Muda `AC-017` e a regra de parada (T-050).

### Q-004 + Q-110 — PTT pelo botão Bluetooth do volante entra na v1?

- **Contexto.** O PTT de tela e a barra de espaço no painel já cobrem o uso. O botão do volante (BLE) é o que o motorista realmente usa dirigindo, mas é integração BLE por Hardware, com.android particular, sem documentação do fabricante do volante.
- **Opções.** **A.** Fora da v1 (default) · **B.** Na v1, com suporte a 2 ou 3 modelos de volante específicos · **C.** Genérico via BLE HID (qualquer botão que emule teclado) · **D.** Na v1 com o app como "controle remoto" genérico.
- **Default já assumido.** A (v1.1).
- **Recomendação do Arquiteto.** **A na v1, C na v1.1.** BLE HID genérico é mais barato que o suporte a modelos específicos e cobre a maior parte dos volantes (muitos emulam teclado). Se algum cliente piloto tiver o volante já comprado, esse vira requisito de v1.
- **Se decidir diferente.** Adiciona task no app (módulo BLE) e permissão `BLUETOOTH_CONNECT` no manifest.

### Q-007 — O TTS do chat lê as mensagens em voz alta: ligado ou desligado por padrão?

- **Contexto.** O app é o canal do motorista: o gestor manda texto no chat e o motorista, dirigindo, não lê. Ligar o TTS por default é um ganho real de segurança, mas consome bateria e é falado em voz alta dentro da cabine (o cliente ou o passageiro ouve).
- **Opções.** **A.** Desligado por default, ligável por veículo (default) · **B.** Ligado por default · **C.** Ligado só quando o veículo está em movimento (GPS) · **D.** Desligado sempre na v1.
- **Default já assumido.** A.
- **Recomendação do Arquiteto.** **A, com o "C" como bônus:** o melhor dos dois é ler **em movimento** (é quando faz sentido) e não parado (quando o motorista está com o celular na mão, lendo é melhor). Isso dá o ganho de segurança sem obrigar o TTS no trânsito parado com passageiro.
- **Se decidir diferente.** Muda `AC-112/AC-113`, o módulo TTS (T-027) e a config do veículo.

---

## 3. Bloco C — travam o F4/F5 (público e piloto)

### Q-010 — Honduras (UTC-6) entra na fase 1?

- **Contexto.** O BRD posiciona Honduras como segundo mercado. O sistema armazena **sempre UTC** e exibe em BRT; adaptar Honduras é mostrar em UTC-6.
- **Opções.** **A.** Fase 2 (default) · **B.** Fase 1, só na exibição (sem mudar o armazenamento) · **C.** Fase 1 com fuso por tenant já no modelo.
- **Default já assumido.** A.
- **Recomendação do Arquiteto.** **B.** O custo é quase zero se o campo de fuso entrar no tenant desde já (uma coluna e uma regra de exibição), e o ganho comercial é o 2º mercado mais rápido. **C** é o que evita retrabalho — se você já tem clientes hondurenhos mapeados, vá de C.
- **Se decidir diferente.** Muda `NF-14`, o modelo de tenant, o formatador BRT (T-054) e os testes de contrato.

### (Bloco C — já respondidas, apenas confirmar)

| ID | Pergunta | Resposta assumida |
|---|---|---|
| Q-102 | Telemetria por push ou polling? | **Polling** a 30 s (e 60 s em background). Push consome bateria e complica o buffer offline. |
| Q-103 | Buffer offline em SQLite ou MMKV? | **SQLite** (consulta ordenada e consulta por janela de tempo; MMKV é key-value). |
| Q-106 | O cliente final vê ETA ou só posição? | **Só posição** na v1. ETA sem modelo de trânsito é prometer imprecisão. |
| Q-109 | `facing` default: `back` (estrada) ou `front` (cabine)? | **`back`** — o valor da dúvida de carga é ver a carga/estrada, não o motorista. |

---

## 4. Decisões **já tomadas** (não reabrir — estão travadas nos 4 documentos)

| ID | Decisão | Onde |
|---|---|---|
| ADR-001 | Sai `console`, `httpd` e `database` do compose upstream; entra nginx do host + Postgres reusado | ADR §4 |
| ADR-002 | Plano A Postgres com gate F1-VAL-001; Planos B (MySQL 640 MB) e C (micro-VPS) como fuga | ADR §4 |
| ADR-003 | Redis 7 dedicado, 160 MB, `noeviction`, prefixo `fleetbase_` | ADR §4 |
| ADR-004 | VROOM **adiado** para fase 2; rota zero-custo = FOSSGIS via `ROUTER_URL` | ADR §4 |
| ADR-005 | Bloco de portas próprio (8000/4200/38000/3478/5349/7880-7883/49160-49260) — zero conflito com Mendes, Supabase, n8n, Evolution GO, Astracalls | ADR §5 |
| ADR-006 | Todo container com `deploy.resources.limits.memory`; teto 4,5 GB | ADR §6 |
| ADR-007 | Coturn dedicado (relay range 49160-49260), mídia UDP fora do tunnel, signaling via tunnel | ADR §4 |
| ADR-008 | Evolution GO (`:8096`) é o único WhatsApp; o core nunca fala com ela | ADR §4 |
| ADR-011 | Core AGPL **intacto**; proprietário em serviços separados por API/webhook | ADR §4 |
| ADR-013 | Olho Vivo e PTT sob comando, sem gravação, TTL de sessão | ADR §4 |
| ADR-014 | Fases F0→F5 com gates objetivos; deploy só após aprovação | ADR §10 |
| — | Link de rastreio assinado, com TTL e revogável | PRD US-CL-01/02 |
| — | DVIR reprovado bloqueia a saída do veículo | PRD US-GF-06 |
| — | Foto obrigatória na carga/descarga | PRD US-GF-07 |
| — | Preço Start R$39 / Pro R$89 / Enterprise R$149 por veículo-mês | BRD §3 |

---

## 5. Riscos que somem quando a decisão é tomada

| Risco | Some quando | ID |
|---|---|---|
| Fleetbase não roda em Postgres | Q-001 decidido **e** F1-VAL-001 rodado | R-00 |
| OOM do host derruba outros projetos | Q-002 e Q-012 decididos **e** gate de RAM passado | R-01/R-02 |
| Vídeo não abre em 4G com CGNAT | Q-002 decidido (TURN com `external-ip` certo) | R-03 |
| Alarme falso de desvio/parada mata o uso do alerta | Q-104 e Q-105 calibrados | R-16 (novo) |
| Motorista não confia no Olho Vivo | Q-005/Q-108 (quem pode pedir) + Q-006 (duração) | R-08 |
| Cliente reclama que o link de rastreio morreu | Q-008 decidido com renovação | R-09 |
| Alerta de WhatsApp duplicado ou perdido | Q-009/Q-101 decidido | NF-13 |

---

## 6. Índice de referência para quem for ler o detalhe

| Se a dúvida for sobre… | Ler |
|---|---|
| Preço, vertical, mercado, piloto | `01-BRD.md` §3, §4, §6 |
| Requisito funcional de um perfil | `02-PRD.md` §1 a §6 |
| Exigência não funcional (RAM, CGNAT, idempotência, fuso) | `02-PRD.md` §7 |
| Por que a escolha técnica foi feita | `03-ARCHITECTURE-ADR.md` §4 (ADR-001 a ADR-015) |
| Estado real do host medido | `03-ARCHITECTURE-ADR.md` §2 |
| Risco de RAM e orçamento | `03-ARCHITECTURE-ADR.md` §6 |
| Formato exato dos JSONs (webhook, DataChannel) | `04-SPEC-KIT.md` §4, §5, §6 |
| Critério de aceite de cada história | `04-SPEC-KIT.md` §10 |
| Como o time é dividido para trabalhar em paralelo | `04-SPEC-KIT.md` §1, §11 |
| Ordem de subida e gates | `03-ARCHITECTURE-ADR.md` §10 + `04-SPEC-KIT.md` §15 |

**Comandos de conferência do host** (todos read-only, não mudam nada):
```bash
grep -E 'MemTotal|MemAvailable' /proc/meminfo; free -h | head -3
for p in 8000 3478 5349 7880 7881 7882 38000; do
  ss -ltn "sport = :$p" | tail -n +2 | grep -q . && echo "OCUPADA $p" || echo "livre $p"; done
docker exec supabase-db psql -U postgres -tAc "select version();"
```

---

## 7. Como registrar a decisão

Cada resposta entra em uma linha do ADR (§12) e do SPEC-KIT (§10.5), com a **data**, o **motivo** e o **impacto**, e vira uma tarefa nova se mexer em contrato ou tela.

> ✅ **Feito em 18/11/2026.** As 22 respostas entraram no ADR §12.1/§12.2/§12.3/§12.4 e no
> SPEC-KIT §10.5 (+ §3.1 e os AC-016/017/018/105/106/113). Ver o banner do topo deste arquivo. Depois de decidir o **Bloco A**, o próximo passo é autorizar o **F1** (spike isolado: criar o `fleetbase_db`, rodar as migrations, subir o compose de teste sem publicar porta).
