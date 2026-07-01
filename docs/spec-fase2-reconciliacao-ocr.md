# spec: Reconciliação foto-OCR → quadro de leitos (HMAGR)

| campo | valor |
|---|---|
| id | spec-2026-07-01-reconciliacao-ocr-hmagr |
| data | 2026-07-01 |
| autor | sd-spec-planner (Squad Soluções Digitais), a partir de briefing resolvido do Maestro |
| hospital(s) alvo | **HMAGR** (este documento). HJXXIII é projeto irmão com spec própria em `hjxxiii-leitos/docs/spec-fase2-reconciliacao-ocr.md` — fora de escopo aqui. |
| status | draft |
| branch | `feat/reconciliacao-foto-ocr` (a partir de `feat/hmsa-parity`) |
| repo | `claude-cowork/hmagr-leitos-mvp` |

## 1. Dor (1-3 frases)

[FATO, verificado em código] `kfExecutarGravacao` (`index.html:27721-27762`) faz `POST internacoes_hmsa` com `Prefer: resolution=merge-duplicates,return=minimal`, `id=HMAGR_int_<leito>` — a chave de conflito é o LEITO, não o paciente, e não há leitura prévia do estado atual. Toda foto tirada do quadro físico reescreve nome/diagnóstico/pendência/data do leito inteiro, sem log, mesmo quando o paciente mudou (troca sem baixa) ou quando um EGA/NIR corrigiu o dado manualmente há 5 minutos (edição apagada sem aviso). As 3 regras de negócio esperadas (mantém-se-mesmo-paciente / bloqueia-se-diferente / protege-edição-manual) hoje estão **todas violadas por construção**, não por bug pontual.

## 2. Valor / critério de sucesso (1 frase)

Depois desta entrega, gravar uma foto do quadro nunca mais sobrescreve dado clínico sem passar por decisão auditável (INSERT/MERGE protegido/BLOQUEIO com fila de baixa manual/REVISÃO), e a baixa de paciente continua sendo sempre um ato humano — verificável rodando o fluxo em modo sombra e comparando o log de decisões contra o estado real do banco (nenhuma linha muda em `internacoes_hmsa`).

## 3. Escopo

**Dentro:**
- Fundação: read-before-write, `idEpisodio` determinístico por leito+data (não mais só leito), invalidação de overrides do episódio antigo no giro, exclusão de campos travados do payload OCR, sinal explícito `leitos_vazios` no `extract.js`, precedência humano > foto documentada e aplicada em código.
- Máquina de estados `reconcile()` (lib pura, testável): VAZIO→INSERT, MESMO→merge protegido, DIFERENTE→bloqueia+fila, AMBÍGUO→revisão. Invariante: `reconcile()` nunca muda `status_internacao` para valor diferente de `'ativa'`.
- Match âncora (`data_admissao`) + fuzzy nome (`simNome`), limiares MESMO≥0.85 / DIFERENTE<0.60 / AMBÍGUO no meio.
- Field-lock: coluna `campos_travados jsonb` em `internacoes_hmsa`, SET no confirm de edição manual, APLICA no merge, CLEAR obrigatório no giro/baixa.
- Modo sombra (dry-run) como comportamento **default e único habilitado nesta entrega**: calcula e loga o que faria, sem aplicar no banco.
- UI: 1 chip violeta por leito (reusa `.badge-ov`, `index.html:528`), prioridade Dar baixa > Duplicado > Conferir dado, sufixo `+N`, sem nome (LGPD), clique reusa fluxos existentes de baixa manual e cadastro inline.
- Migration aditiva/nullable gerada (arquivo `.sql`), cobrindo `campos_travados`, `leito_status`, `foto_ultima_vista` em `internacoes_hmsa` + tabela nova `kanban_reconcile_pendencias`.

**Fora (explícito):**
- HJXXIII (projeto irmão, spec própria, não implementado aqui).
- Ligar o modo real (toggle de aplicação de fato no banco). Fica no código como feature flag, default desligado. Ligar é decisão futura do Maestro após período de observação do shadow-mode.
- Deploy de produção (Vercel `--prod`).
- Aplicação da migration no Supabase. Este squad não tem acesso a MCP Supabase nesta sessão — o `.sql` é gerado e revisado, mas a aplicação fica pendente de sessão com Supabase MCP ou SQL editor do Maestro (ver seção 5).
- Coluna de nº de prontuário/AIH no quadro físico (melhoraria precisão do match para determinístico) — mudança operacional fora do controle deste squad, mencionada só como frontier futura.
- Redesenho do modal de baixa manual ou de cadastro inline — o chip reusa os fluxos existentes tal como estão.

## 4. Acceptance criteria (testável — o QA roda isto)

### Fundação
- [ ] **CA-08.1** Given uma foto processada com um paciente no leito X, When `kfExecutarGravacao` roda, Then o código executa um `GET internacoes_hmsa?leito=eq.X&hospital=eq.HMAGR&status_internacao=eq.ativa` antes de qualquer `POST`/`PATCH` para aquele leito (sem GET prévio = falha).
- [ ] **CA-08.2** Given dois envios de foto do mesmo leito em datas diferentes, When o id do episódio é gerado, Then o id inclui leito E data do kanban (não é mais determinado só pelo leito) — `buildIdEpisodio('HMAGR', leito, dataKanban)` é determinístico e muda quando a data muda.
- [ ] **CA-08.3** Given um leito passa por GIRO (paciente diferente confirmado), When o giro é resolvido, Then os overrides (`leito_overrides`) do idEpisodio anterior são removidos/invalidados e não aparecem associados ao novo paciente.
- [ ] **CA-08.4** Given um campo do leito está marcado como travado (`campos_travados`), When o payload OCR é montado para gravação, Then esse campo não aparece no payload enviado ao banco (chave omitida), independente do valor lido na foto.
- [ ] **CA-08.5** Given um setor do quadro físico com um leito visivelmente sem ocupante, When `api/extract.js` processa a imagem, Then o JSON de saída inclui esse leito no array `leitos_vazios` (distinto de `leitos_inativos`, que é bloqueado/reforma).
- [ ] **CA-08.6** Given um campo travado por edição humana E a foto traz um valor diferente para o mesmo campo, When `reconcile()`/`applyFieldLock` processa, Then o valor humano prevalece sempre (nunca é sobrescrito pela foto) — teste negativo explícito.

### Máquina de estados reconcile()
- [ ] **CA-09.1** Given `cur == null` E o leito está no array `leitos_vazios` (não apenas ausente da lista de pacientes), When `reconcile()` roda, Then a ação é `insert` com `fonte='foto'`.
- [ ] **CA-09.2** Given o paciente da foto é o MESMO do ocupante atual (score ≥0.85), When `reconcile()` roda, Then a ação é `merge` e só campos não-travados mudam; campo travado com valor divergente gera sugestão/badge, nunca overwrite.
- [ ] **CA-09.3** Given o paciente da foto é DIFERENTE do ocupante atual (score <0.60), When `reconcile()` roda, Then a ação é `bloqueia`: o registro atual não é tocado, o payload da foto vai para `kanban_reconcile_pendencias` com `tipo='giro'`, e giro só se completa com `giro_motivo` preenchido (enum: alta|transferencia|evasao|obito|duplicado).
- [ ] **CA-09.4** Given o score de match cai na faixa intermediária (0.60 ≤ score < 0.85), When `reconcile()` roda, Then a ação é `revisao` — nunca decide sozinho entre MESMO e DIFERENTE.
- [ ] **CA-09.5 (invariante)** Given qualquer combinação de entrada nos 4 branches acima, When `reconcile()` roda, Then o payload retornado nunca contém `status_internacao` com valor diferente de `'ativa'` (baixa/alta/óbito/transferência/evasão são sempre um ato humano fora de `reconcile()`).

### Match
- [ ] **CA-10.1** Given nome+data com score ≥0.85, resultado é MESMO.
- [ ] **CA-10.2** Given nome+data com score <0.60, resultado é DIFERENTE.
- [ ] **CA-10.3** Given score entre 0.60 e 0.85 (exclusive dos extremos), resultado é AMBÍGUO.
- [ ] **CA-10.4** Given `data_admissao` bate mas nome só parcialmente reconhecível (iniciais tipo "F.J.A."), When comparado contra nome completo compatível, Then o match usa iniciais como conjunto exato (não Levenshtein cru) e a âncora de data pesa mais que a divergência de formato de nome.

### Field-lock lifecycle
- [ ] **CA-11.1** Given um EGA/NIR confirma edição manual de um campo do leito, When o PATCH de confirmação roda, Then `campos_travados` do leito passa a incluir aquele campo.
- [ ] **CA-11.2** Given um leito é dado baixa ou passa por giro confirmado, When a baixa/giro é concluído, Then `campos_travados` daquele leito é limpo (senão o lock do paciente anterior contamina o próximo ocupante do mesmo leito).

### Modo sombra
- [ ] **CA-12.1** Given o modo sombra está ativo (default desta entrega), When uma foto é gravada, Then nenhuma linha de `internacoes_hmsa` muda (comparar snapshot antes/depois do fluxo — idêntico).
- [ ] **CA-12.2** Given o modo sombra rodou, When se inspeciona o log gerado, Then ele lista contagem/detalhe de inseridos, atualizados, sugestões, giros e revisões que TERIAM sido aplicados.
- [ ] **CA-12.3** Given o código desta entrega, When se inspeciona a feature flag do modo real, Then o valor default é desligado — nenhum caminho de código liga automaticamente o modo real.

### UI (chip)
- [ ] **CA-13.1** Given um leito com giro pendente E divergência de campo simultaneamente, When o card é renderizado, Then aparece exatamente 1 chip (prioridade Dar baixa > Duplicado > Conferir dado) com sufixo `+N` se houver mais pendências do mesmo leito.
- [ ] **CA-13.2** Given o chip é renderizado, When se inspeciona o CSS aplicado, Then ele reusa a cor/token de `.badge-ov` (`rgba(167,139,250,...)`) e tem acento de borda esquerda de 3px.
- [ ] **CA-13.3** Given o chip é renderizado, When se inspeciona o texto/title/aria-label, Then não há nome de paciente em nenhum desses campos (LGPD) — nome só aparece nos modais, abreviado.
- [ ] **CA-13.4** Given o usuário clica no chip "Dar baixa" ou "Conferir dado", When o clique é processado, Then abre o fluxo de baixa manual ou de cadastro/edição inline já existentes (não um modal novo).

### Migration
- [ ] **CA-14.1** Given o arquivo `docs/migrations/2026-07-01-reconciliacao-ocr-hmagr.sql`, When inspecionado, Then contém apenas `CREATE TABLE IF NOT EXISTS` / `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` com colunas nullable — zero `DROP`, zero `ALTER ... NOT NULL` sem default, zero `DELETE`/`TRUNCATE`.
- [ ] **CA-14.2** Given a migration é aplicada (por sessão futura com Supabase MCP/SQL editor), When se roda `SELECT hospital, count(*) FROM internacoes_hmsa GROUP BY hospital`, Then a contagem por hospital (HMSA/HJXXIII/HOB/HMAGR) bate com o snapshot pré-migração — nenhum hospital além de HMAGR é afetado.

## 5. A validar / incertezas

- [HIPÓTESE] O quadro físico HMAGR não tem coluna de nº de prontuário/AIH (confirmado empiricamente no briefing via `extract.js:37`), então o match "mesmo vs. outro paciente" é probabilístico por natureza — a faixa AMBÍGUO pode ser frequente na prática. Calibração dos limiares (0.85/0.60) é o que o modo sombra existe para validar antes de ligar o modo real; não travar aqui.
- [INFERÊNCIA] `leito_overrides` (Fase 47, infra Sheets-era) e `campos_travados` (novo, nesta migration) são mecanismos DISTINTOS: `leito_overrides` guarda valores de correção por campo (usado por EGA/NIR), `campos_travados` é só o sinal booleano "não deixe a foto tocar este campo". Reusar a infra de CRUD/`idEpisodio` do primeiro (`KaizenAPI`/`KaizenStore`, `index.html:11561-11668` e `16677-16709`) para operar o segundo é aceitável; forçar os dois no mesmo objeto não é — o mapeamento de campos entre as duas estruturas não é 1:1 hoje. Builder decide o encaixe exato; não é acceptance criteria porque é detalhe de implementação, não de comportamento observável.
- [A confirmar com Maestro] SLA/dono da fila `kanban_reconcile_pendencias` (briefing já default: operador do kanban/EGA/NIR, revisitar após shadow-mode) — não bloqueia esta entrega.
- Pergunta aberta pro Maestro: aplicar a migration nesta sessão (via Supabase MCP, se disponível numa sessão futura) antes ou depois do build do código? Recomendação: aplicar antes de rodar os testes E2E que tocam Supabase real (os testes unitários de `reconcile()` não dependem disso).
