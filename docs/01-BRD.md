# 01-BRD.md — Business Requirements Document
## Hermes Logística & Olho Vivo (Fleetbase + Navigator + LiveKit PTT/Vision)

| Campo | Valor |
|---|---|
| Produto | Hermes Logística & Olho Vivo |
| Versão do doc | 1.0 (fundacional) |
| Data | 18/11/2026 |
| Autor | Arquitetura Principal (Claude Code) |
| Status | DRAFT para revisão do Isaías |
| Stack de referência | Fleetbase (Fleet-Ops) + navigator-app + LiveKit/Coturn + VROOM |
| Ambiente alvo | VPS `hermes-prod` — 8 vCPU / 23 GB RAM (~8 GB *available* no momento da medição, swap 3/3 GB em uso) |

> **Nota de honestidade:** este BRD é documento de *planejamento*. Nenhum container foi
> instalado, nenhum serviço de produção foi alterado. Valores de receita, preço e
> volume são **hipóteses de trabalho** a validar com o primeiro cliente-piloto.

---

## 1. Resumo executivo

**Hermes Logística & Olho Vivo** é uma plataforma B2Bwhite-label de gestão de
frotas e logística em tempo real, com três módulos que formam o diferencial
comercial:

1. **Telemetria** — GPS, velocidade, paradas, rotas, telemetria veicular.
2. **Olho Vivo** — câmera frontal/traseira sob demanda (vídeo, não stream contínuo).
3. **Rádio PTT** — rádio talkie de frota, sala fixa por frota, sem hardware dedicado.

O diferencial não é o dashboard: é **entregar os três juntos, em um celular Android
de médio porte, sem exigir rastreador dedicado, sem mensalidade de mapa pago e sem
consumir banda de vídeo 24/7**. O cliente paga por **veículo/turno**, não por
hardware instalado.

O produto nasce sobre **Fleetbase** (open-source, AGPL-3.0) com o **Fleet-Ops**
(extensão oficial de dispatch e fleet management) e o **navigator-app** (React
Native, o app de motorista do próprio Fleetbase) — reaproveitados, não reescritos.

**O primeiro mercado é Natal/RN** (capital com forte presença de mineração, caçamba
e transporte escolar), com **Honduras** como segundo mercado de expansão — região
onde o problema de CGNAT/rastreamento e de comunicação em campo é pior e a
disposição a pagar por visibilidade operacional é maior.

---

## 2. O problema

### 2.1 Para o operador de frota (o pagador)
- O rastreador dedicado (GPS tracker de hardware) custa R$ 300–1.200 por veículo,
  tem mensalidade por SIM e **não mostra vídeo nem voz** — quando há um
  sinistro ou dano de carga, o dono do caminhão não tem nenhuma prova.
- Quando o motorista liga o celular e liga o app de mapas, **ninguém na
  central vê a rota**: a informação existe no celular do motorista, não no
  lugar onde a decisão é tomada.
- Comunicação por WhatsApp/rádio Nextel cobre o **áudio**, mas não deixa
  registro, não georreferencia, e consome o plano de dados do motorista.

### 2.2 Para o motorista (o usuário)
- Apps de fleet management pagos (por exemplo, solutions com telemetria) exigem
  **carroceria dedicada ou um celular de topo de linha**, e cobram do motorista
 Battery que ele não tem.
- Falta de bateria, falta de dados, ambiente com sol forte, estrada sem sinal:
  o app precisa **funcionar degradado**, com buffer local e reconciliação
  posterior.

### 2.3 Para o embarcador / lojista
- Não sabe onde a carga está; o "cadê o caminhão" vira ligação de WhatsApp.
- Prova de entrega é papel, quando existe. Sem foto e sem assinatura digital.

### 2.4 Para o cliente final (acompanhamento)
- rastreamento por link é normal em e-commerce, mas em transporte de carga /
  motoboy / escolinha **o acompanhamento é fragmentado** (o motorista tem um
  WhatsApp, a empresa tem um sistema, o cliente recebe SMS).

### 2.5 Resumo do problema em uma frase
> **Ninguém do lado da operação vê, ouve e prova o que acontece na estrada, sem
> instalar hardware dedicado e sem depender de um app pago e pesado.**

---

## 3. Modelo de negócio

### 3.1 Forma de cobrança
Assinatura **por veículo ativo por mês** (não por usuário). Motivo: o valor
percebido (visibilidade da carga) é por ativo em campo, e o motorista pode
variar; o veículo é o denominador estável. Inclui **turnos ilimitados** de
rastreamento — o custo marginal de um turno é banda e bateria, não licenças.

### 3.2 Planos

| Plano | Preço (hipótese BRD) | Inclui | Público |
|---|---|---|---|
| **Start** | R$ 39 /veículo/mês | Telemetria + rastreamento de carga + app do motorista + link de rastreio ao cliente | Cooperativas de motoboy, equipes técnicas de campo, frotas de 1–5 veículos |
| **Pro** | R$ 89 /veículo/mês | Start + **Olho Vivo** (câmera sob demanda) + **Rádio PTT** (sala da frota) + alerts de desvio/parada + checklist DVIR | Distribuidoras/last-mile, transporte escolar, frotas de 6–50 veículos |
| **Enterprise** | R$ 149 /veículo/mês | Pro + multi-frota + API/webhooks + SLA + painéis customizados + white-label do app | Transporte pesado, mineração, caçambas, contratos anuais |

**Add-ons (opcional, sem hardware):**
- Turns extras de vídeo sob demanda (uso eventual): R$ 1,90 por sessão de 10 min
  (custo real de banda do operador).
- PTT "escuta + fala" em frota grande, com gravação opcional: R$ 12/veículo/mês.
- Armazenamento de provas fotográficas (30 dias inclusos, depois R$ 0,35/GB).

**Margem-alvo:** 78–84% (custo de infra por veículo ≈ R$ 11–16/mês em Pro,
calculado no ADR com o teto de RAM de 4,5 GB).

### 3.3 Vertical × plano × preço de entrada (BR, Natal/RN)

| Vertical | Plano típico | Ticket médio mensal | Nº veículos típico | Entrada no mercado |
|---|---|---|---|---|
| Transporte pesado (caçamba, pedra, areia, minério, construção) | Enterprise | R$ 5.960 | 40 | Contrato anual, 3–5 frotas âncora |
| Cooperativas de motoboy | Start | R$ 780 | 20 | Venda por WhatsApp, baixo CAC |
| Distribuidoras / last-mile | Pro | R$ 1.780 | 20 | Integração com sistema de pedidos (ERP) |
| Transporte escolar / fretamento | Pro | R$ 1.335 | 15 | licensed + seguro + responsável legal |
| Equipes técnicas em campo | Start | R$ 390 | 10 | Venda porVertical, sem compliance pesado |

### 3.4 Expansão internacional — Honduras
- **Por que Honduras:** mercado com frota de transporte heavy menor e menos
  digitalizado, **alto índice de CGNAT em operadoras móveis** (o que torna
  obrigatório o TURN/Coturn — o tracker do produto quebra sem ele), e rotas
  comcoverage de sinal irregular.
- **Adaptações necessárias:** locale es/HT, moeda Lempira, fuso
  `America/Tegucigalpa` (UTC-6, **sem horário de verão** — o Brasil tem DST
  histórico, então nunca usar offset fixo), unidades métricas já iguais,
  numeração de telefone com 8 dígitos.
- **Modelo:** mesmo SaaS, contratos em USD,cobrar em Dólares; nenhum
  componente self-hosted em Honduras (multi-tenant único na VPS Natal) — decisão
  de custo, registrada no ADR.

### 3.5 Unit economics (hipótese, Pro, 1 veículo)

```
Receita                      R$ 89,00/mês
Custo de infra (RAM, banda, storage)  -R$ 14,00
WhatsApp (Evolution GO, ~120 msgs/mês) -R$ 3,50
Custo operacional (suporte 1:200 veículos) -R$ 8,00
                                      ---------
Margem de contribuição       R$ 63,50  (71%)
```
- **CAC estimado:** R$ 180–320 (venda presencial em Natal/RN, demonstração com
  celular da própria empresa).
- **LTV (Start, churn 4%/mês):** R$ 39 × 25 meses ≈ R$ 975 → LTV/CAC ≈ 3,0.
  Meta do plano: **LTV/CAC ≥ 4,0** reduzindo churn para 2,5%/mês (o gargalo
  real do fleet é *adoção*, não venda).

---

## 4. As 5 verticais

### 4.1 Transporte Pesado & Frotas de Caminhões/Caçambas
**Cliente:** transportadoras de pedra, areia, minério, construção civil, caçamba.
**Dor crítica:** carga de alto valor em rota longa; prova de entrega e condição
da carga é onde mora o dinheiro do seguro.
**Como o Hermes resolve:**
- Telemetria de rota + alerta de **desvio** e de **parada prolongada** (carga
  parada em local não planejado).
- **Olho Vivo sob demanda**: o gestor pede a câmera da cabine quando o
  motorista está em local não previsto — "onde você parou?" vira uma imagem em
  3 segundos, sem ligar a câmera do motorista o tempo todo.
- **PTT**: rádio por frota para a operação de carga e descarga (embarque,
  conferência de caçamba, alinhamento de posição em fila).
- Foto obrigatória na carga/descarga com geolocalização e hora.
**Metriz de sucesso:** redução de 30% em deslocamentos de carga não autorizada e
-25% em Claims de sinistro sem prova.
**Requisito crítico:** o app tem que funcionar com **pouca bateria** e **sol** —
daí o modo câmera **desligado por padrão** e o 480p/15fps.

### 4.2 Cooperativas de Motoboys
**Cliente:** cooperativas com 10–80 moto-boys (Natal/RN tem Sidra, Raízes etc.).
**Dor:** o despacho é por WhatsApp/rádio, o motoboy liga de volta, o preço é
negociado por corrida e o cliente não sabe se o pedido chegou.
**Como o Hermes resolve:**
- Rastreamento da corrida em tempo real + **link temporário** para o cliente.
- **PTT** substitui a.groups de rádio/Wattsapp (comunicação de frota sem gastar
  dados do motoboy).
- Checklist DVIR reduzido a 4 itens para motos (pneu, luz, brakes, bagagem).
- Alerts de "parou há 12 min" → gestor redistribui a corrida.
**Metriz:** -20% em cancelamento por atraso; +15% de corridas/dia por motoboy.
**Por que é o beachhead:** preço baixo de entrada (Start), venda direta, e o
dono de cooperativa **vê valor em 1 dia** (rastreio do motoboy em rota).

### 4.3 Distribuidoras / Last-Mile
**Cliente:** distribuidoras com rota diária fixa, entregadores em vans/motos.
**Dor:** janela de entrega furada, cliente reclamando por telefone, e o
estoque mal posicionado.
**Como o Hermes resolve:**
- **ETA real** (VROOM/OSRM) por janela, com alerta de desvio de rota.
- Foto da entrega (proof) + assinatura + geolocalização.
- PTT para a equipe de rua e para a central.
- Webhooks para o ERP/WMS do cliente (o Hermes **não** quer ser o ERP).
**Metrica:** -25% de "não entregue na janela".
**Integração-chave:** webhooks de saída (order created/assigned/completed) em
JSON documentado — ver `04-SPEC-KIT.md`.

### 4.4 Transporte Escolar / Fretamento
**Cliente:** redes de escolinha, prefeituras (frotas de fretamento), empresas
com shuttle de colaboradores.
**Dor:** **segurança e responsabilidade legal.** Precisa-se saber: quem estava
no veículo, estava no ponto às 07h10, o condutor estava acordado.
**Como o Hermes resolve:**
- **Checklist DVIR obrigatório antes da partida** (pneus, freios, óleo, luzes,
  estepe) com registro do condutor — evidência de manutenção.
- **Alerta de parada prolongada** = alerta de desvio de rota em rota escolar.
- Olho Vivo sob demanda, com **retenção mínima** e consentimento.
- Link de acompanhamento para o responsável (verba: cliente/Pai).
**Metrica:** -50% de ocorrência de "ônibus não chegou / parada não autorizada".
**Cuidado legal:** consentimento (LGPD art. 5º/8º e, no caso de crianças,
responsável legal) e política de retenção curta e auditável. **Sem isso, o
vertical não é vendável** — ver risco R-02.

### 4.5 Equipes Técnicas em Campo
**Cliente:** prestadores de serviço (ar-condicionado, elétrica, fibra,
manutenção de rede, instalação de equipamento).
**Dor:** o técnico vai, o cliente não está em casa, o técnico "esqueceu" o
material, a empresa não sabe se o serviço foi feito.
**Como o Hermes resolve:**
- **Olho Vivo sob demanda** como diferenciador real: o gestor vê o técnico
  chegando, vê a instalação, resolve a disputa de "não fiz" sem deslocar
  ninguém.
- **TTS + chat nativo do Fleetbase** → o técnico **ouve** as instruções da
  central sem tirar os olhos da rua (mãos ocupadas, sol forte).
- PTT para a equipe no campo.
- Checklist de serviço (não de veículo) + foto obrigatória do serviço.
**Metrica:** -35% de retrabalho; +20% de serviços por técnico/dia.
**É o vertical com melhor fit com "Olho Vivo" e o pior fit com "PTT"** —
priorizar câmera + TTS aqui.

---

## 5. Diferencial comercial (o que ninguém vende junto)

| Proposta | Concorrente A (rastreador dedicado) | Concorrente B (app fleet pago) | **Hermes** |
|---|---|---|---|
| Veículo/turno | Hardware + SIM + mensalidade | Licença por veículo | **Sem hardware, sem SIM dedicado** |
| Vídeo | ✗ | ✓ (stream contínuo, caro) | **✓ sob demanda, 480p/15fps** |
| Voz/Rádio | ✗ | ✗ | **✓ PTT em sala por frota** |
| Custo de mapa | incluso (mas hardware) | Google Maps (pago) | **OSM + VROOM/ORS free** |
| Offline | limitado | limitado | **Buffer SQLite/MMKV + reconciliação** |
| Preço de entrada | R$ 300–1.200 hardware | R$ 60–150/veículo/mês | **R$ 39/veículo/mês** |

**A frase de venda (testada em campo, 5–8 palavras):**
> "Vídeo, voz e GPS da sua frota, no celular do motorista, sem comprar rastreador."

---

## 6. Go-to-market

### Fase 0 — Piloto pago (Natal/RN, 60 dias, 3–5 frotas âncora)
- 1 cooperativa de motoboy (20–40 motos) — **beachhead**.
- 1 transportadora de caçamba/pedra (8–15 trucks) —_cases de alto valor.
- 1 equipe técnica (10) — câmera.
- **Preço piloto:** Start/Pro com 3 meses de lock-in de preço, escopo limitado
  (não mais que 25% da frota da conta âncora), suporte por WhatsApp (nós
  mesmos).
- **Sucesso do piloto:** ≥ 2 das 3 contas renovam no preço cheio + 1
  testimonial em vídeo.

### Fase 1 — Natal/RN completo (6 meses)
- 25–40 contas, 400–700 veículos.
- Venda presencial com **demo no celular da empresa** (sem hardware = demo em
  2 minutos).
- Parceria: contabilidade/transportadoras (canal de revenda).

### Fase 2 — Honduras (9–12 meses)
- 2–3 contas âncora + um parceiro local (associación de transportistas).
- Dependência de **CGNAT** resolvida com TURN (Coturn) — o produto só funciona
  lá com o TURN bem configurado.
- Fuso e locale como código de config, não hardcode.

---

## 7. Métricas de sucesso (North Star + guardrails)

**North Star:** *veículos ativos por dia com sinal enviado* (VAD).

| Camada | Métrica | Meta 6 meses | Meta 12 meses |
|---|---|---|---|
| Aquisição | Contas pagantes | 25 | 60 (BR) + 5 (HT) |
| Ativação | Frota ativada em ≤ 7 dias da assinatura | 80% | 85% |
| Engajamento | VAD / veículos contratados | ≥ 55% | ≥ 65% |
| Retenção | Churn mensal de veículos | ≤ 4% | ≤ 2,5% |
| Qualidade | Turnos com vídeo sob demanda corrompidos | < 1% | < 0,5% |
| Qualidade | Posições perdidas (buffer) | < 2% | < 1% |
| Financeiro | LTV/CAC | ≥ 3,0 | ≥ 4,0 |
| Operacional | RAM do stack / teto | < 70% de 4,5 GB | < 60% de 4,5 GB |

**Guardrails (nunca quebrar):** RAM do stack < 4,5 GB; sem subir container novo
em produção sem `deploy.resources.limits.memory`; sem chave em repositório;
sem stream de vídeo contínuo.

---

## 8. Riscos (com mitigação, não só lista)

| ID | Risco | Prob. | Impacto | Mitigação |
|---|---|---|---|---|
| R-01 | **RAM**: stack estoura o host e derruba produção existente (Mendes, Supabase, Evolution) | Média | **Catastrófico** | Teto rígido 4,5 GB com `limits`; stack em rede Docker isolada; `docker compose down` como kill-switch; nunca `restart: unless-stopped` sem limit; monitorar `docker stats` (skill `guardiao-performance-vps`) |
| R-02 | **Cobrança de imagem de menores** (transporte escolar) | Média | Alto (legal) | Consentimento do responsável como feature bloqueante; retenção 7 dias; auditoria de acesso; desligamento remoto da câmera |
| R-03 | **react-native-geolocation-service sem manutenção** (última release 2022) | Média | Médio | Fixar versão; preparar fork interno com PRs Android 14/15 (foreground service types); plano B: `@mauron85/react-native-background-geolocation` |
| R-04 | **Free tier do OSM/ORS cai** (cota, política, servidor fora) | Média | Médio | `ROUTER_URL` como env → trocar backend sem tocar código (decisão D-02); cache de rota 24h; fallback OSRM público |
| R-05 | **CGNAT** quebra mídia sem TURN | **Alta** | Alto | Coturn obrigatório (D-03); UDP 3478/5349 abertos; relay range fixo e documentado |
| R-06 | **Bateria/overheat** do celular em 8h de estrada | Média | Alto | Câmera OFF por padrão (D-04); 480p/15fps; foreground service só com location; sem tela sempre ligada (Modo Kiosk) |
| R-07 | **AGPL "viral"** contaminar código proprietário | Baixa | Alto | Toda extensão proprietária em serviço separado (API/webhook), sem link estático com o core AGPL (ver ADR) |
| R-08 | **Frota para de usar** (adoção) — o produto é ótimo e ninguém liga | **Alta** | Alto | TripWizard de 3 minutos, onboarding presencial, gamificação simples (streak de vistoria), suporte por WhatsApp |
| R-09 | **Dependência upstream Fleetbase** (emulator, breaking changes) | Média | Médio | Pinar tags/digests; adapter layer (`/integrations`) isolando o SDK; plano de "upstream vs fork" documentado |
| R-10 | **Custo de banda** do vídeo derrete a margem | Média | Médio | 480p/15fps, H.264, gravação só sob demanda, precificação por sessão |

---

## 9. Escopo da v1 (o que entra)

**Incluído:**
- Telemetria + rastreamento + link temporário para o cliente.
- App do motorista com checklist DVIR e foto de carga/descarga.
- Olho Vivo sob demanda (vídeo, alternância cabine/estrada por comando).
- Rádio PTT (sala por frota) + TTS.
- Dispatch básico (pedidos, atribuição, status) via Fleet-Ops.
- Alertas: desvio, parada prolongada, carga/descarga concluída.
- Integração WhatsApp (Evolution GO) para link de rastreio e alertas.
- Painel web: mapa ao vivo + painel de rádio/câmera (web-radio-panel).

**Fora da v1 (explícito):**
- Manutenção de frota (peças, revision) — só o checklist.
- Billing/integração fiscal.
- Roteirização própria (usa VROOM/OSRM).
- Multilíngue completo (v1 = pt-BR; es-HT em v2).
- App do cliente branco-label (v1 = link web).

---

## 10. Conformidade e licenses

| Item | Licença | Impacto |
|---|---|---|
| Fleetbase (core + emulators) | AGPL-3.0 | Rede modifyada → oferecer source do core modificado |
| Fleet-Ops (`@fleetbase/fleetops-engine`, `fleetbase/fleetops-api`) | AGPL-3.0-or-later | Mesma regra |
| navigator-app | MIT (verificar `LICENSE` do repo) | Sem viralidade para o app cliente |
| LiveKit server | Apache-2.0 | Sem restrição |
| LiveKit client RN (`@livekit/react-native`) | Apache-2.0 | OK |
| Coturn | BSD-3 | OK |
| VROOM | LGPL-2.1 (servidor) | OK se não linkar em proprietary |
| Extensões proprietárias (rádio/câmera/whatsapp) | **Nossa** | Precisam ficar em serviço separado (D-08) |

**Decisão de compliance (ADR-011):** o painel de rádio/câmera e a ponte WhatsApp
rodam como **serviços desacoplados** atrás de API/webhooks, nunca como código
servido pelo core AGPL. Assim o core fica AGPL (e oferecemos o source), e as
nossas extensões proprietárias não são derivadas do core.

---

## 11. Decisões de negócio que precisam do Isaías (bloqueadores)

| # | Decisão | Por que bloqueia |
|---|---|---|
| B-1 | Faixa de preço final (Start/Pro/Enterprise) | BRD inteiro se apoia nos números |
| B-2 | vertical beachhead (motoboy vs pesado vs técnico) | Define o que entra na v1 |
| B-3 | Compra de SMS/whatsapp vs Evolution GO próprio | Custo variável |
| B-4 | Nome comercial final ("Hermes Logística"?) | Domínio, AGPL, contratos |
| B-5 | Retenção de vídeo/foto por plano (7/30/90 dias) | LGPD + custo de storage |
| B-6 | Se a operação é multi-tenant (várias cidades) desde o v1 | Schema do Fleetbase |
| B-7 | Orçamento de infra aprovado (teto 4,5 GB já travado) | precisa de aval do "não derrubar produção" |

---

## 12. Próximos artefatos

```
01-BRD.md   (este)  → o quê e por quê (negócio)
02-PRD.md            → requisitos funcionais por perfil (Given/When/Then)
03-ARCHITECTURE-ADR.md → decisões de arquitetura (números reais da VPS)
04-SPEC-KIT.md       → contratos técnicos + divisão de trabalho entre agentes
```
Cadeia SDD: **BRD → PRD → SPEC → PLAN → TASKS → IMPLEMENT → CONVERGE**.
Este conjunto cobre BRD (1), PRD (2) e PLAN/ADR (3); o SPEC-KIT (4) fecha os
contratos para execução paralela.

---

*Documento gerado em 18/11/2026. Nenhuma mudança foi aplicada em produção.*
