# HOB — Sistema de Gestão Lean (contexto arquitetural)

> **Carregado em qualquer sessão dentro de `hob-leitos/`. Restrição permanente.**

---

## Hospital

**HOB** = Hospital Metropolitano Odilon Behrens · Belo Horizonte/MG

**HOSPITAL_ID** no schema Supabase: `'HOB'` (multi-tenant, mesma base do HMSA e HJXXIII).

**Origem do código:** clone do `hmsa-leitos` em 2026-05-07 via padrão A+(iii) — cópia exata + troca de HOSPITAL_ID + textos visíveis. Identidade do HMSA (Silvio Avidos · Colatina/ES) substituída pra HOB. Mecânica preservada idêntica.

---

## Posição do frontend no produto

`index.html` consome a mesma camada Supabase do HMSA/HJXXIII. Tabelas multi-tenant (boarding_episodios, internacoes_hmsa, lp_cases, actions, config_retaguarda_ps, config_hospital, etc.) filtradas por `hospital_id='HOB'` ou `hospital='HOB'` conforme o schema da tabela.

**Memória `internacoes-hmsa-campo-hospital`** vale aqui também: a tabela continua se chamando `internacoes_hmsa` (legado naming) mas usa coluna `hospital` que aceita 'HOB'. Não criar `internacoes_hob` — multi-tenant é via valor do campo, não via tabela nova.

---

## Guardrails permanentes (mesmos do HMSA)

### G1 — Frontend é consumidor, não fonte

### G2 — Enfermaria ≠ Especialidade

### G3 — Não misturar 4 naturezas
Operação diária / Indicador executivo / Projeto Kaizen / Governança de dado.

### G4 — Sem PII na camada visual

### G5 — Schema Supabase compartilhado
Migration nova exige avaliar impacto em HMSA + HJXXIII + HOB.

### G6 — Compatibilidade multi-tenant
Toda query nova começa com `WHERE hospital='HOB'` (ou `hospital_id='HOB'` dependendo da tabela).

### G7 — Persistência local com escopo definido
`localStorage` aceitável só pra estado UI. Nunca pra dados clínicos.

### G8 — Avaliar 3 níveis antes de propor
Local (interface) · Modelo (schema) · Pipeline (Supabase compartilhado).

---

## Estado de partida (07/mai/2026)

- Cópia exata do HMSA em prod no momento da clonagem
- 4 entregas Retaguarda PS funcionais (Fila / Leitos / Barreiras / Histórico)
- Settings calibráveis (LP threshold + capacidade + label da unidade)
- Patch Larissa (data/hora customizadas no popover de saída) ativo
- Boarding com form em cima de "Em espera agora"
- Sem dados HOB em prod ainda — equipe HOB começa do zero

**Próximos passos esperados:**
- Equipe HOB cadastra suas próprias especialidades/diagnósticos/destinos via UI (Listas)
- Cadastro de unidades Retaguarda PS HOB via Settings ⚙ (capacidades reais)
- Personalizar label da aba Retaguarda via Settings se HOB não usar termo "Retaguarda PS"

---

## Direção da evolução

HMSA é o "main branch" do produto; HOB recebe ports estáveis. Não fazer feature nova SEM passar pelo HMSA primeiro, exceto quando equipe HOB pedir algo específico (validar com Maestro antes).

---

*Mantido pelo Claude sob revisão de Francisco.*
