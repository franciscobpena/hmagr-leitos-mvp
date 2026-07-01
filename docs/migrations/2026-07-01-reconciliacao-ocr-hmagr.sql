-- Migration: reconciliacao_ocr_hmagr (Fase 2, spec-2026-07-01-reconciliacao-ocr-hmagr)
-- Projeto Supabase: smzejxtnykpjmxvxfzet (compartilhado por HMSA/HOB/HMAGR/HJXXIII)
-- Aditiva/isolada: ALTER TABLE ... ADD COLUMN IF NOT EXISTS (colunas nullable, sem default
-- destrutivo) + CREATE TABLE IF NOT EXISTS (tabela dedicada, hospital-scoped). Não é
-- DROP/DELETE/TRUNCATE nem ALTER destrutivo. Não altera comportamento de HMSA/HJXXIII/HOB —
-- colunas novas ficam NULL para todo registro existente.
--
-- ATENÇÃO: gerada por leitura de código (sem MCP Supabase disponível nesta sessão). Antes de
-- aplicar, confirmar tipo real da PK de internacoes_hmsa.id (assumido text, ex. 'HMAGR_int_301')
-- via information_schema.columns. Nenhuma FK foi criada de kanban_reconcile_pendencias.cur_id
-- para internacoes_hmsa.id de propósito — reduz risco de a migration falhar por divergência de
-- tipo/valor entre hospitais; a referência é lógica (aplicação), não de banco.
--
-- APLICAÇÃO PENDENTE: este squad (sd-spec-planner) não tem acesso a Supabase MCP nesta sessão.
-- Rodar via sessão futura com MCP Supabase ou SQL editor do Maestro. Antes de aplicar, capturar
-- snapshot: SELECT hospital, count(*) FROM internacoes_hmsa GROUP BY hospital;
-- Depois de aplicar, rodar a mesma query e comparar (deve bater 1:1 com o snapshot).

-- ── 1. Colunas aditivas em internacoes_hmsa (compartilhada — nullable, não quebra os outros 3 hospitais) ──

ALTER TABLE internacoes_hmsa ADD COLUMN IF NOT EXISTS campos_travados jsonb NULL;
COMMENT ON COLUMN internacoes_hmsa.campos_travados IS
  'Fase 2 reconciliação OCR (HMAGR): mapa {campo: true} de campos travados por edição humana. '
  'SET no confirm de edição manual; APLICA (pula campo) no merge do reconcile(); CLEAR '
  'obrigatório no giro/baixa. NULL = nenhum campo travado.';

ALTER TABLE internacoes_hmsa ADD COLUMN IF NOT EXISTS leito_status text NULL;
COMMENT ON COLUMN internacoes_hmsa.leito_status IS
  'Fase 2 reconciliação OCR (HMAGR): giro_pendente | revisao_divergente | NULL (sem pendência). '
  'Não é status_internacao — não afeta ocupação/alta, só sinaliza fila de conferência humana.';

ALTER TABLE internacoes_hmsa ADD COLUMN IF NOT EXISTS foto_ultima_vista timestamptz NULL;
COMMENT ON COLUMN internacoes_hmsa.foto_ultima_vista IS
  'Fase 2 reconciliação OCR (HMAGR): timestamp da última foto que reconheceu este leito/paciente. '
  'Usado como nudge de stale (dado desatualizado), nunca dispara ação automática.';

-- ── 2. Tabela nova: fila de pendências de reconciliação (hospital-scoped) ──

CREATE TABLE IF NOT EXISTS kanban_reconcile_pendencias (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  hospital_id text NOT NULL DEFAULT 'HMAGR',
  tipo text NOT NULL CHECK (tipo IN ('giro', 'divergente', 'sugestao_campo')),
  payload_ocr jsonb NOT NULL,
  cur_id text NULL, -- referência lógica a internacoes_hmsa.id (sem FK, ver nota de topo)
  giro_motivo text NULL CHECK (
    giro_motivo IS NULL OR giro_motivo IN ('alta', 'transferencia', 'evasao', 'obito', 'duplicado')
  ),
  status text NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente', 'resolvida', 'descartada')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE kanban_reconcile_pendencias IS
  'Fase 2 reconciliação OCR: fila de decisões que reconcile() não pode tomar sozinho '
  '(paciente diferente = giro, campo divergente = sugestão, match ambíguo = revisão). '
  'reconcile() nunca decide baixa/giro sozinho — resolução é sempre humana via UI (chip).';

CREATE INDEX IF NOT EXISTS idx_kanban_reconcile_pendencias_hospital_status
  ON kanban_reconcile_pendencias (hospital_id, status);

-- RLS permissiva, espelhando o padrão real observado nas tabelas irmãs deste pipeline
-- (kanban_snapshots, kanban_image_hashes, leito_overrides): 1 policy única FOR ALL TO public.
ALTER TABLE kanban_reconcile_pendencias ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "kanban_reconcile_pendencias_all" ON kanban_reconcile_pendencias;
CREATE POLICY "kanban_reconcile_pendencias_all" ON kanban_reconcile_pendencias
  FOR ALL TO public USING (true) WITH CHECK (true);

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE kanban_reconcile_pendencias TO anon, authenticated;
GRANT USAGE, SELECT ON SEQUENCE kanban_reconcile_pendencias_id_seq TO anon, authenticated;

-- ── Verificação pós-migração (CA-14.2) ──
-- 1. Confirma que os outros 3 hospitais não foram afetados (contagem deve bater com snapshot pré-migração):
--    SELECT hospital, count(*) FROM internacoes_hmsa GROUP BY hospital;
-- 2. Confirma que as colunas novas existem e são nullable:
--    SELECT column_name, is_nullable FROM information_schema.columns
--    WHERE table_name = 'internacoes_hmsa' AND column_name IN ('campos_travados','leito_status','foto_ultima_vista');
-- 3. Confirma que a tabela nova existe:
--    SELECT to_regclass('public.kanban_reconcile_pendencias');
