# tasks: Reconciliação foto-OCR (HMAGR)

Referência: `docs/spec-fase2-reconciliacao-ocr.md`. Ordem obrigatória: fundação → reconcile → shadow mode → UI. Migration (T0) vem primeiro só porque o nome das colunas é pré-requisito de leitura para quem escreve o código — a **aplicação** dela no Supabase fica pendente (ver spec §5), e nenhuma task de 1-9 depende de ela estar de fato aplicada (todas usam mocks/lógica pura). T10 em diante (integração real com `index.html`/Supabase) sim depende da aplicação real.

Convenção de teste: `node --test` (padrão do repo, ver `package.json`), arquivos novos em `tests/unit/`. E2E com Playwright em `tests/e2e/`. IDs de acceptance criteria (CA-XX.Y) seguem a sequência já usada no repo (CA-01 a CA-07 existentes; esta entrega usa CA-08 a CA-14).

---

## T0 — Migration aditiva (schema de referência para as tasks seguintes)

- **O quê:** gerar o `.sql` com `campos_travados jsonb`, `leito_status text`, `foto_ultima_vista timestamptz` (ADD COLUMN IF NOT EXISTS em `internacoes_hmsa`) + tabela nova `kanban_reconcile_pendencias`.
- **Onde:** `docs/migrations/2026-07-01-reconciliacao-ocr-hmagr.sql` (já entregue por este spec-planner, ver arquivo).
- **Depende de:** nada.
- **Reusa:** padrão estrutural de `hjxxiii-leitos/docs/migrations/2026-07-01-auditoria-evolucoes-hjxxiii.sql` (CREATE TABLE IF NOT EXISTS, RLS permissiva única, GRANT anon/authenticated).
- **Pronto quando:** arquivo existe, é só aditivo (CA-14.1), comando de verificação pós-aplicação documentado no topo do arquivo.
- **Testes:** nenhum automatizado (é SQL não aplicado). QA visual = leitura do diff.
- **Gate:** aplicação real fica pendente de sessão com Supabase MCP ou SQL editor do Maestro. Rodar o comentário de verificação (`SELECT hospital, count(*) FROM internacoes_hmsa GROUP BY hospital`) antes e depois de aplicar, comparar. **Bloqueante para T10-T11, T13, T17 (que tocam Supabase real); não bloqueia T1-T9, T12, T15.**

---

## Fundação (bloqueia tudo abaixo)

### T1 — `lib/reconcile.js`: `buildIdEpisodio(hospital, leito, dataKanban)`
- **O quê:** função pura que gera `${hospital}_ocr_${leito}_${dataKanban}`, determinística.
- **Onde:** novo arquivo `lib/reconcile.js`.
- **Depende de:** nada.
- **Reusa:** padrão de `lib/dhash.js` (módulo Node puro, `module.exports`, sem I/O). Nota pro builder: `index.html` hoje NÃO importa `lib/dhash.js` — duplica a lógica inline no browser (`index.html:27403`). Para `reconcile.js`, que é lógica de negócio crítica (não perceptual hash), recomenda-se evitar essa duplicação: escrever o módulo em formato dual (`if (typeof module !== 'undefined') module.exports = {...}; else window.Reconcile = {...}`) e importar via `<script src="lib/reconcile.js">` em `index.html`, em vez de reimplementar. Decisão do builder, não é acceptance criteria.
- **Pronto quando:** CA-08.2 passa.
- **Testes:** `tests/unit/reconcile.test.js` (novo).
- **Gate:** `node --test tests/unit/reconcile.test.js`.

### T2 — `lib/reconcile.js`: `applyFieldLock(payload, camposTravados)`
- **O quê:** remove do payload OCR as chaves marcadas como travadas.
- **Onde:** `lib/reconcile.js`.
- **Depende de:** T1 (mesmo arquivo).
- **Reusa:** nada externo.
- **Pronto quando:** CA-08.4 e CA-08.6 passam (incluindo teste negativo: campo travado nunca aparece no payload, mesmo com valor divergente na foto).
- **Testes:** `tests/unit/reconcile.test.js`.
- **Gate:** `node --test`.

### T3 — `api/extract.js`: sinal `leitos_vazios`
- **O quê:** adicionar instrução no `buildSystemPrompt()` para o modelo emitir `leitos_vazios` (array de leitos visivelmente sem ocupante — distinto de `leitos_inativos`, que é bloqueado/reforma), few-shot atualizado, e incluir `leitos_vazios: []` no mock de resposta sem `ANTHROPIC_API_KEY`.
- **Onde:** `api/extract.js:21-90` (`buildSystemPrompt`), `api/extract.js:~152-172` (mock).
- **Depende de:** nada.
- **Reusa:** o array irmão `leitos_inativos` já existe no schema — mesmo padrão, campo novo ao lado.
- **Pronto quando:** CA-08.5. Exportar `buildSystemPrompt` do módulo (hoje é função interna, não exportada) para ser testável sem chamada de rede.
- **Testes:** `tests/unit/extract-prompt.test.js` (novo) — assert que a string retornada por `buildSystemPrompt()` menciona `leitos_vazios` e que o mock JSON (chamar handler sem `ANTHROPIC_API_KEY` no env) inclui a chave.
- **Gate:** `node --test tests/unit/extract-prompt.test.js`.

### T4 — `index.html`: read-before-write em `kfExecutarGravacao`
- **O quê:** antes de qualquer escrita, `GET internacoes_hmsa?leito=eq.X&hospital=eq.HMAGR&status_internacao=eq.ativa` por leito do payload; remover o `POST` cego atual.
- **Onde:** `index.html:27721-27762` (bloco "1. Upsert pacientes").
- **Depende de:** T1, T2. (Aplicação real contra Supabase depende de T0 aplicado — ver nota do T0.)
- **Reusa:** mesmo padrão de leitura já usado em `index.html:8823-8830` e `13726` (`fetch` com `hospital=eq.` + `status_internacao=eq.ativa`).
- **Pronto quando:** CA-08.1.
- **Testes:** `tests/unit/reconcile.test.js` (lógica isolada, fetch mockado) + cenário novo em `tests/e2e/kanban-foto.spec.js`.
- **Gate:** `node --test` + `npx playwright test -g "read-before-write"`.

### T5 — `index.html`: `idEpisodio` real + invalidação de overrides no giro
- **O quê:** trocar `id: HMAGR_int_${leito}` por `buildIdEpisodio()`; ao confirmar GIRO, limpar overrides do `idEpisodio` anterior.
- **Onde:** `index.html:27726-27745` (payload map) + integração com `KaizenAPI` (`16677-16709`).
- **Depende de:** T1, T4.
- **Reusa:** `KaizenAPI.resetLeitoOverride` / `deleteLeitoOverride` (`index.html:16693-16709`) já existentes — não reinventar CRUD de override.
- **Pronto quando:** CA-08.2, CA-08.3.
- **Testes:** `tests/unit/reconcile.test.js` + cenário e2e "giro limpa override antigo".
- **Gate:** `node --test` + playwright.

### T6 — Documentar precedência humano > foto no código
- **O quê:** comentário explícito no topo de `lib/reconcile.js` / junto de `applyFieldLock`: "correção humana sempre ganha do OCR; field-lock só barra a foto, nunca o humano".
- **Onde:** `lib/reconcile.js`.
- **Depende de:** T2.
- **Reusa:** nada.
- **Pronto quando:** CA-08.6 (já coberto em T2, este item garante o comentário/documentação, não só o comportamento).
- **Testes:** revisão de código (não automatizado além do já coberto em T2).
- **Gate:** revisão manual no PR.

---

## Reconcile (depende 100% da fundação acima)

### T7 — `lib/reconcile.js`: `simNome(a, b)`
- **O quê:** normaliza (upper/sem acento/sem pontuação) + Levenshtein/token-sort; iniciais (ex. "F.J.A.") comparam como conjunto exato.
- **Onde:** `lib/reconcile.js`.
- **Depende de:** T1.
- **Reusa:** sem lib externa (mesmo espírito de `lib/dhash.js`, "sem lib externa RT-06").
- **Pronto quando:** CA-10.1, CA-10.2, CA-10.3, CA-10.4.
- **Testes:** `tests/unit/reconcile.test.js`.
- **Gate:** `node --test`.

### T8 — `lib/reconcile.js`: `matchOccupant(cur, ocrRow)` → `MESMO|DIFERENTE|AMBIGUO|VAZIO`
- **O quê:** `cur == null` → `VAZIO`; combina `simNome` + âncora `data_admissao`; aplica limiares 0.85/0.60.
- **Onde:** `lib/reconcile.js`.
- **Depende de:** T7.
- **Reusa:** `simNome` (T7).
- **Pronto quando:** CA-09.1 (parte VAZIO), CA-10.1-10.4.
- **Testes:** `tests/unit/reconcile.test.js`.
- **Gate:** `node --test`.

### T9 — `lib/reconcile.js`: `reconcile(cur, ocrRow, camposTravados, leitosVazios, opts)`
- **O quê:** função principal — orquestra `matchOccupant` + `applyFieldLock`, retorna `{action, payload, pendencia}` com `action ∈ {insert, merge, bloqueia, revisao}`.
- **Onde:** `lib/reconcile.js`.
- **Depende de:** T2, T8.
- **Reusa:** `applyFieldLock` (T2), `matchOccupant` (T8).
- **Pronto quando:** CA-09.1 a CA-09.5 — **CA-09.5 é o teste mais importante desta task**: para os 4 branches, assert que `payload.status_internacao` nunca é setado para valor diferente de `'ativa'` (ou fica ausente do payload).
- **Testes:** `tests/unit/reconcile.test.js` — incluir teste parametrizado rodando os 4 branches e checando a invariante em todos.
- **Gate:** `node --test`.

### T10 — `index.html`: `kfExecutarGravacao` chama `reconcile()` por paciente
- **O quê:** substituir o `POST` batch cego por loop `reconcile(cur, ocrRow, ...)` por paciente; `insert`/`merge` aplicam escrita real; `bloqueia`/`revisao` gravam em `kanban_reconcile_pendencias` sem tocar `internacoes_hmsa`.
- **Onde:** `index.html:27721-27762`.
- **Depende de:** T4, T5, T9, **T0 aplicado** (precisa da tabela `kanban_reconcile_pendencias` existir para os branches `bloqueia`/`revisao`).
- **Reusa:** inclusão de `lib/reconcile.js` (ver nota T1) em vez de duplicar lógica no browser.
- **Pronto quando:** cenários e2e dos 4 branches passam.
- **Testes:** `tests/e2e/kanban-foto.spec.js` (4 cenários novos: VAZIO/MESMO/DIFERENTE/AMBÍGUO).
- **Gate:** `npx playwright test`.

### T11 — `index.html`: fila de pendências + baixa manual com `giro_motivo`
- **O quê:** ao clicar "Dar baixa" no chip de giro pendente, abrir fluxo de baixa manual existente exigindo `giro_motivo` (enum: alta|transferencia|evasao|obito|duplicado) antes de admitir o novo paciente do `payload_ocr`.
- **Onde:** próximo a `_intHandlerDarAlta` (`index.html:~9307`) e ao PATCH de baixa existente (`index.html:~15830`).
- **Depende de:** T10, T0 aplicado.
- **Reusa:** modal/fluxo de baixa manual já existente — só adiciona campo `giro_motivo`, não cria modal novo.
- **Pronto quando:** CA-09.3 (parte UI) e CA-13.4 (parte "Dar baixa").
- **Testes:** cenário e2e "resolver giro via chip".
- **Gate:** playwright.

---

## Modo sombra (depende do reconcile pronto)

### T12 — `lib/reconcile.js`: flag `dryRun` em `reconcile()`
- **O quê:** `reconcile(..., { dryRun: true })` retorna a mesma decisão com `applied: false`, sem side-effect (a função já é pura — o flag é consumido por quem chama, não por I/O dentro dela).
- **Onde:** `lib/reconcile.js`.
- **Depende de:** T9.
- **Reusa:** mesma função `reconcile()`, sem duplicar lógica.
- **Pronto quando:** CA-12.1 (parte lógica).
- **Testes:** `tests/unit/reconcile.test.js`.
- **Gate:** `node --test`.

### T13 — `index.html`: `kfExecutarGravacao` roda em modo sombra por default
- **O quê:** o fluxo completo de gravação (T10) calcula tudo via `reconcile(..., {dryRun:true})` e loga contagem/detalhe de inseridos/atualizados/sugestões/giros/revisões, sem aplicar PATCH/POST real em `internacoes_hmsa`.
- **Onde:** `index.html` (integração de T10) + log (tabela `kanban_reconcile_pendencias` com `tipo='sugestao_campo'` para sugestões, ou `console.info` estruturado — decisão do builder, não é AC).
- **Depende de:** T10, T12, T0 aplicado (se o log usar a tabela nova).
- **Reusa:** padrão de log já usado em `logExtracao` (`api/extract.js:93-102`, best-effort, não bloqueia fluxo).
- **Pronto quando:** CA-12.1, CA-12.2 — snapshot de `internacoes_hmsa` antes e depois do fluxo é idêntico.
- **Testes:** cenário e2e "modo sombra não aplica" (GET antes/depois, assert igual).
- **Gate:** playwright.

### T14 — `index.html`: feature flag do modo real (default desligado)
- **O quê:** flag (`config_hospital` ou `localStorage`, conforme G7 do `CLAUDE.md` do repo — localStorage só para estado de UI) que ligaria o modo real; **nesta entrega o valor default é ausente/false** e nenhum caminho de código liga automaticamente.
- **Onde:** `index.html`, próximo a `HOSPITAL_ID`.
- **Depende de:** T13.
- **Reusa:** padrão `config_hospital` já existente no repo.
- **Pronto quando:** CA-12.3.
- **Testes:** `tests/unit/reconcile.test.js` ou e2e — assert que o default do flag é shadow.
- **Gate:** `node --test` ou playwright.

---

## UI (pode rodar em paralelo com Reconcile/Shadow, mas o wiring real de T16-T17 depende de T10-T11)

### T15 — CSS do chip (paralelizável — não depende de nada acima)
- **O quê:** estender `.badge-ov` com variante de chip: acento de borda esquerda 3px, versão icon-only responsiva.
- **Onde:** `index.html:528` (`.badge-ov`), extensão via nova classe (não substituir a existente — `badge-ov` continua servindo o caso "OV" já em produção).
- **Depende de:** nada.
- **Reusa:** cor/token `.badge-ov` (`rgba(167,139,250,.85)`) já existente.
- **Pronto quando:** CA-13.2.
- **Testes:** nenhum automatizado (CSS puro). QA visual manual (screenshot).
- **Gate:** revisão visual — não bloqueia CI, mas bloqueia "pronto para review" do PR.

### T16 — Render do chip no bed-card
- **O quê:** 1 chip por leito com prioridade Dar baixa > Duplicado > Conferir dado, sufixo `+N`, sem nome no texto/title/aria-label.
- **Onde:** `index.html:9297-9313` (bloco `bedsHtml`, junto de `hasOv`/`badge-ov` em `9305`).
- **Depende de:** T10 (precisa de `leito_status`/pendência calculados), T15.
- **Reusa:** mesmo template de badge (`9305`), mesmo padrão `idEpAttr`/`aria` já usado no card.
- **Pronto quando:** CA-13.1, CA-13.3.
- **Testes:** e2e — assert texto do chip não contém `nome_paciente`; assert prioridade quando há giro+divergência simultâneos no mesmo leito.
- **Gate:** playwright.

### T17 — Clique do chip reusa fluxos existentes
- **O quê:** clique em "Dar baixa" → fluxo de baixa manual (T11); clique em "Conferir dado" → fluxo de edição/cadastro inline existente, com diff campo digitado × lido em destaque.
- **Onde:** `index.html`, handler novo próximo a `_intHandlerDarAlta` (`~9307`) e `abrirEditarLeito` (`~9310`).
- **Depende de:** T11, T16, T0 aplicado.
- **Reusa:** `_intHandlerDarAlta` e `abrirEditarLeito` já existentes — nenhum modal novo criado.
- **Pronto quando:** CA-13.4.
- **Testes:** e2e.
- **Gate:** playwright.

---

## Resumo de dependência (ordem de execução)

```
T0 (migration, gerada — aplicação pendente)
 └─ T1 → T2 → T6
         ↘
T1 → T7 → T8 ─┐
T2 ───────────┴─ T9 (reconcile principal, invariante CA-09.5)
T3 (extract.js, paralelo, sem dependência)

Fundação (T1-T6) + T9 completos
 → T4 → T5 → T10 [precisa T0 aplicado] → T11 [precisa T0 aplicado]
                → T12 → T13 [precisa T0 aplicado se log em tabela] → T14

T15 (CSS, paralelo, sem dependência)
T10 + T15 → T16 → T17 [precisa T0 aplicado]
```

Comando de teste único (unitários): `npm test` (roda `tests/unit/*.test.js` conforme `package.json` — **adicionar `tests/unit/reconcile.test.js` e `tests/unit/extract-prompt.test.js` ao script `test:unit`** quando criados). E2E: `npm run test:e2e`.
