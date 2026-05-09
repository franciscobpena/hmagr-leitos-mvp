# HMAGR — Sistema de Gestão Lean (contexto arquitetural)

> **Carregado em qualquer sessão dentro de `hmagr-leitos-mvp/`. Restrição permanente.**

---

## Hospital

**HMAGR** = Hospital Municipal de Caucaia Abelardo Gadelha da Rocha · Caucaia/CE

**HOSPITAL_ID** no schema Supabase: `'HMAGR'` (multi-tenant, mesma base do HMSA, HJXXIII e HOB).

**Origem do código:** clone do `hob-leitos` em 2026-05-09 (commit base `b96ef66`). HOB foi escolhido como origem (não HMSA) pra herdar Settings dinâmica de Gestão de Leitos + 5 guards anti-leak MOCK_PROJETOS já estáveis. Identidade do HOB (Odilon Behrens · Belo Horizonte/MG) substituída pra HMAGR.

**Legado preservado:** `claude-cowork/hmagr-leitos-legacy/` (apps script + planilhas, abr/2026). Vercel project antigo `hmagr-leitos` (não confundir com `hmagr-leitos-mvp`).

---

## Posição do frontend no produto

`index.html` consome a mesma camada Supabase do HMSA/HJXXIII/HOB. Tabelas multi-tenant (boarding_episodios, internacoes_hmsa, lp_cases, actions, config_retaguarda_ps, config_hospital, config_gestao_leitos, etc.) filtradas por `hospital_id='HMAGR'` ou `hospital='HMAGR'` conforme schema da tabela.

**Memória `internacoes-hmsa-campo-hospital`** vale aqui também: a tabela continua `internacoes_hmsa` (legado naming) mas usa coluna `hospital` que aceita 'HMAGR'. Não criar `internacoes_hmagr` — multi-tenant é via valor do campo, não via tabela nova.

---

## Guardrails permanentes (mesmos do HMSA/HOB)

### G1 — Frontend é consumidor, não fonte

### G2 — Enfermaria ≠ Especialidade

### G3 — Não misturar 4 naturezas
Operação diária / Indicador executivo / Projeto Kaizen / Governança de dado.

### G4 — Sem PII na camada visual

### G5 — Schema Supabase compartilhado
Migration nova exige avaliar impacto em HMSA + HJXXIII + HOB + HMAGR.

### G6 — Compatibilidade multi-tenant
Toda query nova começa com `WHERE hospital='HMAGR'` (ou `hospital_id='HMAGR'` dependendo da tabela).

### G7 — Persistência local com escopo definido
`localStorage` aceitável só pra estado UI. Nunca pra dados clínicos.

### G8 — Avaliar 3 níveis antes de propor
Local (interface) · Modelo (schema) · Pipeline (Supabase compartilhado).

---

## Estado de partida (09/mai/2026)

- Cópia exata do HOB no momento da clonagem (que por sua vez é HMSA + Settings dinâmica + 5 guards)
- 4 entregas Retaguarda PS funcionais (Fila / Leitos / Barreiras / Histórico)
- Settings calibráveis (LP threshold + capacidade + label da unidade + Gestão de Leitos)
- Boarding com form em cima de "Em espera agora"
- Sem dados clínicos HMAGR em prod ainda — equipe HMAGR começa do zero
- Supabase: 1 row config_hospital + 2 rows config_retaguarda_ps (Retaguarda 1, Retaguarda 2 · capacidade 5 cada · placeholders, EGA ajusta via Settings)

**Próximos passos esperados:**
- Equipe HMAGR cadastra suas próprias especialidades/diagnósticos/destinos via UI (Listas)
- Cadastro de capacidades reais Retaguarda PS via Settings ⚙
- Cadastro de categorias de Gestão de Leitos via Settings ⚙ no dashboard
- Personalizar label da aba Retaguarda via Settings se HMAGR não usar termo "Retaguarda PS"

---

## Direção da evolução

HMSA é o "main branch" do produto; HMAGR recebe ports estáveis via HOB (clone-of-clone). Não fazer feature nova SEM passar pelo HMSA primeiro, exceto quando equipe HMAGR pedir algo específico (validar com Maestro antes).

---

*Mantido pelo Claude sob revisão de Francisco.*
