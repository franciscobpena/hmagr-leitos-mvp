/**
 * Lógica pura de apoio ao chip de pendência de reconciliação (Fase 2 HMAGR — T16/T17).
 * Ver docs/spec-fase2-reconciliacao-ocr.md (CA-13.1, CA-13.4).
 *
 * Deliberadamente SEPARADO de lib/reconcile.js — não altera o módulo já testado das
 * Partes 1/2 (103/103 testes verdes antes desta entrega). Este arquivo lida só com
 * PRIORIZAÇÃO/CLASSIFICAÇÃO de pendências já persistidas em kanban_reconcile_pendencias
 * (leitura), não com a máquina de estados reconcile() em si (escrita/decisão).
 *
 * Módulo dual Node/browser, mesmo padrão de lib/reconcile.js (nota do T1).
 */

/** Mesmo limiar MESMO de reconcile.js (CA-10.1) — reusado da fonte, não duplicado como
 *  número mágico separado (S3 do review). Módulo dual: Node exige direto, browser lê de
 *  window.Reconcile (já carregado antes deste script, ver index.html). */
const LIMIAR_DUPLICADO =
  (typeof module !== 'undefined' && module.exports)
    ? require('./reconcile').LIMIAR_MESMO
    : window.Reconcile.LIMIAR_MESMO;

/**
 * [HIPÓTESE, não validada em produção — revisitar após uso real, spec §5] O schema da
 * migration só tem o tipo 'giro' em kanban_reconcile_pendencias — 'duplicado' é um
 * giro_motivo de RESOLUÇÃO (enum GIRO_MOTIVOS de reconcile.js), não um tipo de pendência
 * distinto. Sem esta heurística, os chips "Dar baixa" e "Duplicado" seriam idênticos.
 * Critério: o nome sugerido pela foto (`pendencia.payload_ocr.nome` — nunca exibido em UI,
 * só comparado aqui) bate, via `simNomeFn` (injetado — normalmente Reconcile.simNome), com
 * outro paciente já ativo em leito diferente (`cur_id` distinto) = provável recadastro
 * duplicado.
 */
function ehProvavelDuplicado(pendencia, outrosPacientesAtivos, simNomeFn) {
  if (!pendencia || pendencia.tipo !== 'giro') return false;
  const nomeFoto = pendencia.payload_ocr && pendencia.payload_ocr.nome;
  if (!nomeFoto || typeof simNomeFn !== 'function') return false;
  return (outrosPacientesAtivos || []).some(
    (p) => p.idEpisodio !== pendencia.cur_id && simNomeFn(nomeFoto, p.nomePaciente) >= LIMIAR_DUPLICADO
  );
}

/**
 * Escolhe a pendência mais prioritária dentre uma lista de pendências pendentes de um
 * mesmo leito. Ordem fixa (CA-13.1): Dar baixa (giro) > Duplicado (giro + heurística de
 * nome repetido) > Conferir dado (divergente/sugestao_campo). Retorna null se a lista
 * estiver vazia. `extra` é o total de pendências além da escolhida (sufixo "+N").
 */
function escolherChipDoLeito(listaPendencias, outrosPacientesAtivos, simNomeFn) {
  const lista = listaPendencias || [];
  if (!lista.length) return null;
  const giros = lista.filter((p) => p.tipo === 'giro');
  const outros = lista.filter((p) => p.tipo !== 'giro');
  const girosDuplicados = giros.filter((p) => ehProvavelDuplicado(p, outrosPacientesAtivos, simNomeFn));
  const girosSimples = giros.filter((p) => !ehProvavelDuplicado(p, outrosPacientesAtivos, simNomeFn));

  let principal;
  let tipoChip;
  if (girosSimples.length) {
    principal = girosSimples[0];
    tipoChip = 'baixa';
  } else if (girosDuplicados.length) {
    principal = girosDuplicados[0];
    tipoChip = 'duplicado';
  } else {
    principal = outros[0];
    tipoChip = 'conferir';
  }
  return { principal, tipoChip, extra: lista.length - 1 };
}

/**
 * Vocabulário do modal de edição (abrirEditarLeito, index.html) -> vocabulário de
 * reconcile.js (único que applyFieldLock entende). Campos do modal SEM equivalente aqui
 * (num_leito, setor, especialidade — extract.js não extrai especialidade por paciente da
 * foto) não entram: a foto nunca escreve neles, não há risco de sobrescrita a proteger.
 */
const CAMPO_INPUT_MAP = {
  data_admissao: { input: 'el-dadm', label: 'Data de admissão' },
  data_provavel_alta: { input: 'el-prev', label: 'Previsão de alta' },
  diagnostico: { input: 'el-hip', label: 'Hipótese diagnóstica' },
  pendencias: { input: 'el-statusp', label: 'Status pendência' }
};

/**
 * [T17, CA-13.4 "Conferir dado"] Calcula os campos onde o valor sugerido pela foto
 * (`pendencia.payload_ocr`) diverge do valor atualmente preenchido no form de edição.
 * Duas fontes possíveis em payload_ocr: `campos_divergentes` (lista granular, gerada só
 * no branch sugestao_campo/CA-09.2) ou, na ausência dela (branch divergente/AMBIGUO, sem
 * granularidade por campo), os próprios campos do registro sugerido pela foto que têm
 * equivalente editável no form.
 */
function diffsParaModal(pendencia, valoresAtuais) {
  if (!pendencia) return [];
  const ocr = pendencia.payload_ocr || {};
  const atuais = valoresAtuais || {};
  const pares =
    Array.isArray(ocr.campos_divergentes) && ocr.campos_divergentes.length
      ? ocr.campos_divergentes.map((d) => [d.campo, d.valorFoto])
      : Object.keys(CAMPO_INPUT_MAP)
          .filter((k) => k in ocr)
          .map((k) => [k, ocr[k]]);
  return pares
    .filter(([campo]) => CAMPO_INPUT_MAP[campo])
    .map(([campo, valorFoto]) => ({
      campo,
      valorFoto,
      meta: CAMPO_INPUT_MAP[campo],
      valorAtual: atuais[campo] || ''
    }))
    .filter((d) => String(d.valorFoto || '') !== String(d.valorAtual || ''));
}

// Nome proprio, nao `api`: este arquivo e lib/reconcile.js sao carregados como <script>
// classicos no index.html, e scripts classicos compartilham UM unico escopo global. Dois
// `const api` no top-level fazem o SEGUNDO arquivo morrer inteiro no parse com
// "Identifier 'api' has already been declared" -- window.ReconcileUI nunca e definido, e
// o consumidor top-level (index.html:9942, `const RECONCILE_CAMPO_INPUT_MAP =
// ReconcileUI.CAMPO_INPUT_MAP`) estoura ReferenceError e ABORTA o script principal dali
// pra baixo. As `function` sobrevivem (hoisting), mas as 106 `const`/`let` declaradas
// depois ficam em TDZ: KaizenStore, HMSA_TOKEN_KEY (token de escrita!), MOCK_INDICADORES,
// NIR_PERGUNTAS, NEDOCS_CLASSES... todas mortas em runtime.
// Provado no navegador antes e depois. Mesmo bug corrigido no HJXXIII em 13/jul.
const apiUI = {
  LIMIAR_DUPLICADO,
  ehProvavelDuplicado,
  escolherChipDoLeito,
  CAMPO_INPUT_MAP,
  diffsParaModal
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = apiUI;
} else {
  window.ReconcileUI = apiUI;
}
