# 02-PRD.md — Product Requirements Document
## Hermes Logística & Olho Vivo — requisitos funcionais por perfil

| Campo | Valor |
|---|---|
| Versão | 1.0 (fundacional) |
| Data | 18/11/2026 |
| Derivado de | `01-BRD.md` |
| Formato | User Stories + Given/When/Then, prioridade P1/P2/P3 |
| Escopo | 5 perfis: Super Admin, Gestor/Encarregado, Lojista/Embarcador, Motorista (Navigator App), Cliente/Pai |

> **Leitura:** este PRD é o **documento de negócio** — descreve *o que* o produto
> faz, para *quem*, sem entrar em tecnologia. A tecnologia aparece apenas no
> `03-ARCHITECTURE-ADR.md` (PLAN) e no `04-SPEC-KIT.md` (contratos).
> Nenhuma implementação foi feita; este documento define o alvo.

---

## 0. Convenções

**Prioridades**
- **P1** — sem isso não há produto vendável (bloqueante do piloto).
- **P2** — importante para venda enterprise / vertical pesado.
- **P3** — evolução posterior (v2).

**Perfis (RBAC)**
| Perfil | Quem é | Dispositivo principal |
|---|---|---|
| **Super Admin** | Operador do SaaS (nós) | Web |
| **Gestor/Encarregado de Frota** | Dono/CTB/Coordenador do cliente | Web (painel) + Push no celular |
| **Lojista/Embarcador** | Quem carrega/descarga (expedição, armazém, obra) | Web + app do motorista |
| **Motorista** | Condutor | App Navigator (Android) |
| **Cliente/Pai** | Quem recebe o serviço / acompanha | Link web (sem login) |

**Vocabulário canônico (nomes idênticos em UI, API e banco)**
`frota` · `veículo` · `motorista` · `turno` · `ordem de serviço (OS)` ·
`vistoria DVIR` · `ponto de carregamento` · `ponto de descarga` ·
`parada` · `desvio` · `sessão de vídeo` · `sala de rádio` · `alerta`.

---

## 1. Super Admin (operador do SaaS)

### US-SA-01 — Tenants (contas) e isolamento *(P1)*
> Como operador do SaaS, quero cadastrar cada cliente como uma conta isolada
> para que dados de uma empresa nunca vazem para outra.

**Given** uma conta nova paga **Given** o contrato define N veículos
**When** o cadastro é criado **Then** é gerado um tenant isolado com N veículos
virtualizados, 1 gestor e 1 link de acesso, e nenhum dado de outro tenant é
visível por API, painel ou banco.

**Regras**
- Isolamento aplicado na **camada de dados** (schema/banco por tenant), não só na UI.
- Todo acesso de painel é filtrado por tenant_id; **sem** consulta "sem filtro" disponível.
- Super Admin vê métricas agregadas de todos os tenants, mas para abrir um tenant
  precisa de ação explícita e auditada.
- Encerramento de tenant = desativação (não delete), preservando o histórico.

### US-SA-02 — Cadastro e cobrança *(P2)*
> Como operador, quero registrar planos, valores e data de cobrança por tenant.

- Planos: Start / Pro / Enterprise (definidos no BRD §3.2).
- Campos: plano, qtd. de veículos, valor, dia de cobrança, status
  (ativo / inadimplente / suspenso).
- **Suspensão automática** ao inadimplir: após 5 dias, o tenant perde o acesso aos
  módulos pagos (vídeo/PTT) mas **mantém** telemetria básica — o cliente não pode
  "perder" a visibilidade da carga por inadimplência (risco de operação).

### US-SA-03 — Health do stack e guardas de recurso *(P1)*
> Como operador, quero saber que o stack está dentro do teto de RAM e que
> nenhuma falha de um tenant derruba os demais.

- Painel mostra uso de RAM do stack vs. teto de 4,5 GB.
- Alerta quando qualquer container passa de 85% do seu `limit`.
- Isolamento: falha do LiveKit **não** derruba o rastreamento por GPS (são
  serviços independentes) e vice-versa.
- Kill-switch documentado: derrubar o stack inteiro sem afetar Mendes/Supabase/n8n/Evolution.

### US-SA-04 — Auditoria *(P2)*
> Como operador, quero auditar ações sensíveis (vídeo, retenção, delete).

- Log imutável de: abertura de sessão de vídeo, acesso a áudio de PTT, leitura de
  fotos de carga/descarga, exportação de dados e delete de tenant.
- Retenção do log: 12 meses.

---

## 2. Gestor / Encarregado de Frota

### US-GF-01 — Mapa da frota ao vivo *(P1)*
> Como gestor, quero ver todos os veículos da minha frota em um mapa, em tempo real.

- Cada veículo: posição, velocidade, heading, última atualização, estado da conexão
  (online / sem sinal / offline).
- **Atualização visual < 15 s** quando o sinal existe.
- Filtros: por veículo, por motorista, por estado (parado / em rota / offline).
- **Sem preço de mapa**: tiles OpenStreetMap.
- **Sem promise de tempo real absoluto**: a tela mostra sempre "última posição há X min".

### US-GF-02 — Linha do tempo do turno *(P1)*
> Como gestor, quero ver a rota percorrida e as paradas do turno atual.

- Trajetória do turno com marcação de início/fim.
- Paradas detectadas: ponto, hora início, hora fim, duração.
- **Dwell-time (tempo parado)**: destaque visual para paradas > 15 min (configurável
  por perfil de frota) — é o sinal que "a carga parou onde não devia".

### US-GF-03 — Alertas operacionais *(P1)*
> Como gestor, quero ser avisado quando algo sai do previsto, sem ficar olhando tela.

**Tipos de alerta (v1):**

| ID | Alerta | Gatilho | Severidade |
|---|---|---|---|
| AL-01 | **Desvio de rota** | o veículo se afasta > 500 m da polyline prevista por > 10 min | alta |
| AL-02 | **Parada prolongada** | parado > 15 min fora de ponto de carga/descarga known | alta |
| AL-03 | **Carga/descarga concluída** | foto + geolocalização registradas no ponto | info |
| AL-04 | **DVIR reprovado** | vistoria com item crítico falho | crítica |
| AL-05 | **Sinal perdido** | sem posição por > 30 min com veículo em turno | média |
| AL-06 | **Sessão de vídeo solicitada** | alguém pediu a câmera | info (auditoria) |
| AL-07 | **PTT em rota** | rádio acionado durante o turno | info (auditoria) |

- Canais: **push** no app, **WhatsApp** (Evolution GO), **e-mail** (P2), **web** (in-app).
- Cada alerta é **deduplicado** por (veículo, tipo, janela de 15 min).
- Configurável por frota: raio de desvio, minutos de parada, silêncios (ex.: noturno).

### US-GF-04 — Olho Vivo sob demanda (câmera) *(P1)*
> Como gestor, quero **pedir** a câmera do veículo quando precisar saber o que está
> acontecendo — sem o motorista ligar a câmera o tempo todo.

**Fluxo**
1. Gestor seleciona o veículo → "Abrir câmera".
2. Sistema **convida** o motorista para a sessão (o app do motorista precisa estar
   aberto e com permissão de câmera; se estiver em background, ele recebe push).
3. Motorista **aceita** (toque) → a câmera liga no app dele.
4. Gestor vê o vídeo ao vivo.
5. Motorista ou gestor encerra → a câmera desliga.

**Regras (não negociáveis — origem: baterias/banda)**
- A câmera **nunca** fica ligada por conta própria. Ela começa **desligada**.
- Qualidade fixa: **480p / 15 fps** (não negociável na v1).
- Comandos pela central (combo cabine/estrada):
  `{"action":"stream_video","state":true|false,"facing":"front"|"back"}`
- **Troca de câmera = cabine ↔ estrada** (`front`/`back`).
- Duração máxima de sessão: 10 min (renovável, com aviso).
- Em qualquer condição de bateria crítica (< 15%) o app **desliga a câmera e avisa**.
- A sessão é **auditada** (AL-06) e **nunca é gravada por padrão** (gravação é P3 e
  exige consentimento).
- **Modo Alfred** (nome do painel interno de câmera): o gestor vê um quadrante
  "Alfred" fixo na tela com a imagem da câmera ativa, e o app do motorista mostra
  um **overlay discreto** indicando que a câmera está sendo observada (transparência).

### US-GF-05 — Rádio PTT *(P1)*
> Como gestor, quero falar com a frota em canal aberto, com botão PTT, sem gastar dados
> do motorista.

**Regras**
- **Sala fixa por frota**: `radio-frota-geral` (sala de escuta passiva por padrão).
- Cada gestor tem **sua própria sala** (`radio-<fleetId>-<userId>`) para falar com
  um motorista específico.
- **PTT** = pressionar e segurar:
  - no **app do motorista**: botão grande no rodapé;
  - no **painel web**: botão ou **barra de espaço**;
  - **Bluetooth**: botão do volante (via headset BLE) — P2.
- Ao falar: **beep** de rádio antes de abrir o microfone (feedback), **audio ducking**
  (volume do sistema cai enquanto o PTT está ativo) e a UI mostra "falando".
- Ao soltar: o microfone fecha, o beep de fim toca, o áudio é transmitido.
- **Escuta passiva por padrão**: o motorista entra na sala e ouve sem consumir banda
  de upload (o áudio só sobe quando ele aperta PTT) — **isso é o que torna viável
  no 4G/CGNAT**.
- **Limite anti-áudio de.loop**: se 2 pitted devices emitem juntos, o sistema
  identifica e mostra "2 estão falando" (P2).

### US-GF-06 — Checklist DVIR antes da partida *(P1)*
> Como gestor, quero que nenhum veículo saia sem vistoria registrada.

- O app do motorista **bloqueia a partida** (não deixa iniciar o turno) até a
  vistoria ser concluída.
- Itens do checklist (v1):
  - **Pneus** (pressão/estado, estepe presente)
  - **Freios**
  - **Óleo / fluidos**
  - **Luzes** (farol, pisca, lanterna)
  - **Limpadores / vidros**
  - **Sinalização / extintor** (P2)
  - **Documentação** (P2)
- Cada item: **aprovado / reprovado / não se aplica** + foto opcional + observação.
- Item **crítico** reprovado (pneu, freios) = **partida bloqueada** e alerta AL-04.
- O gestor vê a última vistoria de cada veículo (data, responsável, resultado).
- Histórico de vistorias consultável por veículo (relatório de manutenção — P2 exporta PDF).

### US-GF-07 — Registro fotográfico de carga e descarga *(P1)*
> Como gestor, quero prova fotográfica de que a carga entrou/saiu, com hora e local.

- No ponto de carregamento: foto da carga embarcada (mínimo 1, ideal 2: geral + placa).
- No ponto de descarga: foto da carga/mercadoria + **assinatura do recebedor** (P2).
- Cada foto: **geolocalização**, **hora**, **veículo**, **motorista**, **OS**,
  carimbo de "não editável".
- **Fuso horário do servidor** é sempre `America/Sao_Paulo` para exibição BR;
  o armazenamento é sempre **UTC** (ISO 8601). Honduras usa `America/Tegucigalpa` (UTC-6 fixo).
- Retenção por plano (padrão v1): Start 7 dias, Pro 30 dias, Enterprise 90 dias.

### US-GF-08 — Link de acompanhamento para o cliente *(P1)*
> Como gestor, quero gerar um link com auto-expiração para o cliente acompanhar.

- Link: `https://{dominio}/t/{token}` — **sem login**, acesso por token.
- Auto-expiração: **default 72 h** (configurável 1 h–30 d).
- Mostra: posição do veículo (aprox., com grão de 50 m), status (carregando / em rota /
 _parado_ / entregue), ETA quando disponível.
- **Nunca** mostra: câmera, PTT, dados do motorista (telefone, nome completo) — só
  o primeiro nome ou um código ("Motorista A-12").
- Opção "link revogado" manual.
- Um link por OS; OS concluída → link expirado automaticamente.

### US-GF-09 — Painel de carga da frota *(P2)*
> Como gestor, quero ver todas as OS do dia com status, para replanejar.

- Kanban: Planejada → Em carga → Em rota → Parada → Descarga → Concluída.
- Filtros por motorista, veículo, cliente, vertical.
- Atraso previsto em Vermelho.
- Exportação CSV/Excel.

### US-GF-10 — Relatórios *(P3)*
- Tempo de parada médio, tempo de espera em carga, KM rodado por veículo, custo de
  vídeo por veículo, taxa de vistorias reprovadas.

---

## 3. Lojista / Embarcador

### US-EM-01 — Criar e despachar uma OS *(P1)*
> Como embarcador, quero registrar a carga e despachar o veículo.

- OS: cliente, tipo de carga, origem, destino, volume/peso, janela de tempo,
  veículo sugerido (o sistema sugere por proximidade/capacidade/disponibilidade).
- Status: `rascunho → planejada → despachada → em_carga → em_rota → em_descarga → concluída`
  (+ `cancelada`, `retornada`).
- Código curto por OS (ex.: `OS-2481`) para citar por rádio e WhatsApp.

### US-EM-02 — Foto da carga ao embarcar *(P1)*
> Como embarcador, quero registrar a foto da carga no momento do embarque.

- Foto via **app do motorista** (o embarcador não precisa de app próprio na v1 —
  o embarcador fotografa pelo celular do motorista ou pelo link web do ponto).
- Metadados obrigatórios: hora, geolocalização, OS, veículo.
- Bloqueio: OS não avança para `em_rota` sem a foto (configurável por perfil).

### US-EM-03 — Confirmação de descarga *(P1)*
> Como embarcador, quero receber a prova de que a descarga foi concluída.

- O motorista marca "descarga concluída" + foto + (opcional) assinatura do recebedor.
- Dispara: AL-03 (alerta operacional) + evento para a ponte de WhatsApp (vide US-INT-03).

### US-EM-04 — Consultar o que está em rota *(P2)*
- Lista de OS em rota com última posição e ETA. Sem câmera.

### US-EM-05 — Cadastro de pontos de carga/descarga *(P2)*
- Endereço, janela de atendimento, geofence (raio de 200 m) para validar arrival.

---

## 4. Motorista (Navigator App — Android)

> Este é o perfil que carrega o produto no dia a dia. Tudo aqui é **otimizado
> para uma mão, sol forte, bateria fraca e dados ruins**.

### US-MT-01 — Entrar e ver o turno do dia *(P1)*
- Login por telefone + senha (ou QR code do gestor — P2).
- Tela inicial: **minhas OS de hoje**, com botão grande "Iniciar turno".
- Funciona **offline**: já baixou as OS do dia; mostra "sem sinal" com honestidade.

### US-MT-02 — Checklist DVIR no celular *(P1)*
> Como motorista, quero um checklist rápido antes de sair, para não perder tempo
> e para me proteger.

- 5–7 itens, um toque cada: **aprovado / não**.
- Foto só quando reprovado (é o que importa).
- Cronômetro: "vistoria leva < 60 s" (meta de UX; medir).
- Se item crítico reprovado → o app **não deixa iniciar o turno** e mostra o que
  fazer ("chamar o gestor").
- **Bypass**: gestor pode autorizar partida com pendência (registra quem autorizou) —
  para não travar a operação em campo.

### US-MT-03 — Rastreamento de rota com buffer offline *(P1)*
> Como motorista, quero que meu trajeto seja registrado mesmo sem sinal.

- Foreground service de localização com **buffer local em SQLite/MMKV**.
- Envio em lotes quando há rede (batch de N pontos ou a cada 60 s).
- **Dedupe** e **descarta de pontos incoerentes** (salto > 500 km/h = ruído).
- Bateria: modo "economia" (intervalo maior) quando a tela está apagada e não há
  ordem ativa; modo "preciso" com a OS ativa.
- Indicador honesto: "sendo registrado" vs. "pendente: 12 pontos" vs. "sincronizado".
- **Nunca** pedir acesso à localização em background sem explicar o porquê na tela.

### US-MT-04 — Câmera sob demanda (Olho Vivo) *(P1)*
> Como motorista, quero ligar a câmera **só quando pedirem**, e saber que estou
> sendo assistido.

- Estado inicial: `setCameraEnabled(false)` — **câmera desligada**.
- Recebe **convite de sessão** (push + som) → aparece o overlay "O gestor pediu a câmera".
- Aceitar → liga; recusar → registra recusa (o gestor vê "recusado" e decide).
- While ligado: mostra o indicador visível de câmera ativa (Android exige).
- Comandos do gestor chegam por DataChannel: ligar/desligar, alternar
  `front`/`back` (cabine ↔ estrada).
- **Bateria < 15%** → desliga e avisa (regra dura).
- **Modo retrato/estrada** alterna a câmera traseira para filmar a carga e o entorno.
- A **nada** de fluxo contínuo: sem ninguém assistindo, zero upload de vídeo.

### US-MT-05 — Rádio PTT *(P1)*
> Como motorista, quero falar com a central e com a frota sem custo de dados.

- **Botão PTT grande** no rodapé (segurar para falar).
- Toque de rádio (beep) ao abrir e ao fechar.
- **Audio ducking** automático.
- **Escuta passiva**: ouço o gestor sem gastar upload.
- Sala por frota (`radio-frota-geral`);Rooms Individuais com o gestor.
- **Falar por WhatsApp não substitui** — o PTT é leve e fica no app.
- **Botão do volante Bluetooth** (P2): headset BLE com botão PTT.
- Sem rede → botão mostra "sem sinal" e **não grava nem tenta retransmitir** (PTT é
  tempo real; não faz sentido bufferizar áudio).

### US-MT-06 — Leitura de mensagens em voz (TTS) *(P1)*
> Como motorista, quero ouvir a mensagem da central sem tirar os olhos da rua.

- O chat nativo do Fleetbase recebe mensagem da central → **TTS lê em voz alta**.
- **Configurável e desligável** (importante: em ambiente ruidoso pode incomodar).
- Botão "ouvir de novo" e "parar de ler".
- Idioma: pt-BR (es-HT em v2).
- **Fila**: se chegam 3 mensagens, lê em sequência sem sobrepor.
- Se o celular está em modo "não perturbe" e há um pedido de voz, mostra notificação
  visual e **não** força o áudio (respeitar o usuário).

### US-MT-07 — Marcar carga/descarga com foto *(P1)*
- Botão grande "Fotografar carga" / "Fotografar descarga" no contexto da OS.
- Auto-geolocização + hora; sem câmera contínua.
- Foto válida: mínimo 1 por evento.

### US-MT-08 — Kiosk Mode no veículo *(P2)*
> Como motorista, quero que o celular não apague a tela nem consuma a bateria
> durante o trajeto.

- App em **modo kiosk** (tela ligada, brilho mínimo, apps bloqueados) quando:
  app em foreground + turno ativo + carregando + FGS de localização ativa.
- **Sai do kiosk** ao terminar o turno ou desconectar o carregador.
- Notificação persistente com o estado do turno.
- Permissões explícitas no `AndroidManifest` (ver SPEC-KIT §4).

### US-MT-09 — Offline-first *(P1)*
- OS do dia, checklist, fotos e ações ficam em **SQLite local** (react-native-mmkv
  para preferências/estado; SQLite para a fila de pontos e fotos).
- Reconciliação por `client_id` idempotente — **reenvio não duplica**.
- Conflito: última escreve (last-write-wins) com log de conflito para auditoria.

### US-MT-10 — Bateria / consumo de dados *(P2)*
- Relatório no app: "bateria desde o início do turno", "dados usados".
- Desligar captura de tela? (P3)

---

## 5. Cliente / Pai acompanhando o rastreio

### US-CL-01 — Acompanhar pelo link *(P1)*
> Como cliente, quero abrir um link e ver onde está a minha carga/filho, sem
> criar conta e sem instalar app.

- Página leve (web), **carregamento < 2 s em 3G** (sem mapa pesado — tile estático
  + polyline, não mapa interativo completo).
- Mostra: status, última posição (hora), ETA aproximada, Motorista (código), veículo
  (final da placa, ex.: "...A3").
- **Sem** dados sensíveis do motorista, sem câmera, sem PTT.
- **Link expira** sozinho (72 h) e mostra "rastreio encerrado" ao expirar.

### US-CL-02 — Fim do rastreio *(P2)*
- Ao concluir a OS: página mostra "entregue/concluído" + hora.
- Ao expirar: "rastreio encerrado" (não erro 404).

### US-CL-03 — Canal alternativo (P3)*
- Botão "falar com a central" → abre WhatsApp com mensagem pré-preenchida.

---

## 6. Integrações (transversal — não é um perfil, é requisito)

### US-INT-01 — WhatsApp: link de rastreio automático *(P1)*
> Como gestor, quero que o cliente receba o link de rastreio por WhatsApp
> automaticamente, sem eu copiar e colar.

- Evento `os.despachada` → a ponte (Evolution GO, :8096) envia mensagem com o link.
- **Auto-expiração** embutida no token do link (mesma regra de 72 h).
- Opt-out: o cliente pode responder "SAIR" e parar de receber.
- **Custo**: Evolution GO (self-hosted) — sem custo por mensagem no volume do piloto.

### US-INT-02 — WhatsApp: alertas operacionais *(P1)*
- Eventos `alerta.desvio`, `alerta.parada_prolongada`, `os.descarga_concluida` →
  mensagem formatada e curta.
- **Dedupe**: 1 alerta por (OS, tipo, 30 min).
- Horário respeitado: nada de madrugada (janela 07:00–21:00 por padrão).
- Link de "ver no mapa" embutido.

### US-INT-03 — Webhooks para o ERP do cliente *(P2)*
- JSON documentado e versionado (`v1`) — contrato no `04-SPEC-KIT.md` §5.
- Eventos: `os.criada`, `os.despachada`, `os.em_rota`, `os.descarga_concluida`,
  `os.concluida`, `alerta.desvio`, `alerta.parada_prolongada`, `veiculo.dvir_reprovado`.
- Assinatura HMAC-SHA256 no header `X-Hermes-Signature` + `X-Hermes-Timestamp`.
- Retry exponencial (1m, 5m, 30m, 2h, 12h) com idempotency key.

### US-INT-04 — Evolution GO é o WhatsApp bridge *(P1 — travado pelo Isaac)*
- Evolution GO existente na VPS (`:8096`) é o **único** gateway WhatsApp do Hermes.
- Não subir WAHA (não existe no host; e seria +RAM contra o teto de 4,5 GB).
- A ponte do Hermes é um **serviço HTTP pequeno** que consome o webhook do Evolution
  e publica eventos internos (ver SPEC-KIT §6).

---

## 7. Requisitos não-funcionais (consolidado)

| ID | Requisito | Métrica |
|---|---|---|
| NF-01 | Bateria do celular | turno de 8 h sem aquecimento; consumo < 8%/h em modo economia |
| NF-02 | Banda | upload em repouso = ~0; só vídeo quando pedido |
| NF-03 | Latência de posição (com sinal) | p95 < 20 s do evento ao mapa |
| NF-04 | Tamanho do app | < 60 MB (APK/AAB) |
| NF-05 | Cold start do app | < 4 s em Android mid-range |
| NF-06 | RAM do stack na VPS | ≤ 4,5 GB (teto rígido) |
| NF-07 | CGNAT | TURN obrigatório; vídeo funciona em 4G com CGNAT |
| NF-08 | Perda de dados | 0 posições perdidas com sinal; fila offline reconciliada em ≤ 5 min |
| NF-09 | Disponibilidade | tracking disponível mesmo se LiveKit/VROOM caírem |
| NF-10 | Offline | app do motorista operável 100% sem rede (exceto PTT/vídeo) |
| NF-11 | Acessibilidade | alvos de toque ≥ 48 dp; contraste alto (sol) |
| NF-12 | LGPD | consentimento p/ câmera e voz; retenção curta; log de acesso |
| NF-13 | Idempotência | reenvio de ponto/foto/evento nunca duplica |
| NF-14 | Fuso | armazenamento UTC; exibição BRT; Honduras UTC-6 |

---

## 8. Rastreabilidade BRD → PRD

| BRD | PRD | Evidência de que está coberto |
|---|---|---|
| §4.1 Transporte pesado | US-GF-01..08, US-MT-01..07 | desvio, parada, prova de carga, olho vivo, PTT |
| §4.2 Motoboy | US-MT-05, US-GF-08, US-INT-01 | PTT substitui WhatsApp, link de corrida |
| §4.3 Distribuidora | US-GF-09, US-INT-03 | ETA, webhooks para ERP |
| §4.4 Transporte escolar | US-GF-06, US-GF-08, US-CL-01 | DVIR bloqueia partida, link para o responsável |
| §4.5 Equipes técnicas | US-GF-04, US-MT-06 | câmera sob demanda + TTS |
| §5 Diferencial comercial | US-GF-04, US-GF-05, US-MT-03 | vídeo+PTT+GPS sem hardware |
| §7 Métricas | US-GF-03, US-SA-03 | VAD, alertas, RAM |
| §8 Riscos R-02..R-06 | NF-07, NF-12, US-MT-04, US-MT-06 | CGNAT, LGPD, bateria, CGNAT |

---

## 9. Fora do escopo da v1 (declarado para não crescer)

Manutenção/frota de peças · billing e nota fiscal · roteirização própria (usa VROOM) ·
iOS (só Android na v1) · gravação de vídeo · app branco-label do cliente ·
multi-idioma (só pt-BR) · SSO/SAML · self-hosted por cliente.

---

## 10. Bloqueadores que precisam de decisão do Isaac

| # | Bloqueio | Efeito |
|---|---|---|
| P-B1 | Bloqueio de partida por DVIR reprovado pode travar a operação? | US-GF-06 / US-MT-02 |
| P-B2 | TTS ligado por padrão ou desligado? | US-MT-06 (impacto em UX e bateria) |
| P-B3 | Link de rastreio mostra nome do motorista ou código? | US-CL-01 (LGPD) |
| P-B4 | Quem pode pedir vídeo? (todo gestor ou só supervisor?) | US-GF-04 (segurança) |
| P-B5 | Duração da sessão de vídeo: 10 min fixo ou configurável? | US-GF-04 (banda) |
| P-B6 | WhatsApp obrigatório no plano Start? | §3.2 do BRD |
| P-B7 | Retenção de fotos: 7/30/90 dias por plano — confirmar | US-GF-07 |

---

*PRD v1.0 — 18/11/2026. Nenhum código foi escrito; nenhum serviço foi tocado.*
