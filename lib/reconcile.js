/**
 * Reconciliação foto-OCR → quadro de leitos (HMAGR) — Fase 2
 * Lógica pura, sem I/O, testável com `node --test`.
 * Ver docs/spec-fase2-reconciliacao-ocr.md (CA-08.2, CA-08.4/08.6, CA-09.x, CA-10.x, CA-12.1).
 *
 * PRECEDÊNCIA HUMANO > FOTO (CA-08.6): correção humana sempre ganha do OCR.
 * `campos_travados` só barra a foto de sobrescrever — nunca barra uma edição
 * humana subsequente. `applyFieldLock` remove a chave travada do payload da
 * foto por completo (não grava, não sugere valor errado como se fosse atual);
 * a UI (fora deste módulo) é quem decide mostrar a divergência como sugestão.
 *
 * INVARIANTE CA-09.5: nenhuma das 4 decisões de `reconcile()` (insert/merge/
 * bloqueia/revisao) jamais retorna `payload.status_internacao` diferente de
 * 'ativa'. Baixa/alta/óbito/transferência/evasão são sempre ato humano fora
 * deste módulo. `extract.js` já ignora a coluna STATUS do quadro físico, mas
 * este módulo também blinda defensivamente (`stripStatus`) contra qualquer
 * chave `status_internacao` que porventura chegue no `ocrRow`.
 *
 * Módulo dual Node/browser — sem duplicar lógica em index.html (nota do T1).
 */

/** Enum de motivo de giro — usado pela fila de baixa manual (T11, fora de escopo aqui). */
const GIRO_MOTIVOS = ['alta', 'transferencia', 'evasao', 'obito', 'duplicado'];

/** Limiares de match (CA-10.1/10.2/10.3). */
const LIMIAR_MESMO = 0.85;
const LIMIAR_DIFERENTE = 0.60;

/**
 * Id determinístico do episódio: leito + data do kanban (não mais só leito).
 * CA-08.2: dois envios do mesmo leito em datas diferentes geram ids diferentes.
 */
function buildIdEpisodio(hospital, leito, dataKanban) {
  return `${hospital}_ocr_${leito}_${dataKanban}`;
}

/**
 * Remove do payload as chaves marcadas como travadas (campos_travados).
 * Aceita `camposTravados` como array de nomes de campo (`['diagnostico']`)
 * ou como objeto-mapa de booleanos (`{diagnostico: true}`) — schema da coluna
 * jsonb ainda não fixado pela migration (ver spec §5, inferência do planner).
 * CA-08.4/CA-08.6: campo travado nunca aparece no payload, mesmo com valor
 * divergente na foto (teste negativo explícito).
 */
function applyFieldLock(payload, camposTravados) {
  const locked = listaCamposTravados(camposTravados);
  const out = { ...(payload || {}) };
  for (const campo of locked) delete out[campo];
  return out;
}

function listaCamposTravados(camposTravados) {
  if (!camposTravados) return [];
  if (Array.isArray(camposTravados)) return camposTravados;
  return Object.keys(camposTravados).filter((k) => camposTravados[k]);
}

/** Remove `status_internacao` de um objeto, defensivamente (CA-09.5). */
function stripStatus(obj) {
  if (!obj) return obj;
  const { status_internacao, ...rest } = obj;
  return rest;
}

// ── normalização + Levenshtein (sem lib externa, RT-06 — mesmo espírito de lib/dhash.js) ──

function normalize(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // remove acentos (marcas de combinação NFD)
    .toUpperCase()
    .replace(/[^A-Z0-9\s]/g, ' ') // remove pontuação
    .replace(/\s+/g, ' ')
    .trim();
}

/** `true` se a string é um padrão de iniciais separadas por ponto (ex. "F.J.A."). */
function isInitialsPattern(s) {
  if (!s) return false;
  return /^([A-Za-zÀ-ÿ]\.\s*){2,}$/.test(String(s).trim());
}

/** Extrai o conjunto de iniciais: da própria string se já é padrão de iniciais, senão a 1ª letra de cada token do nome completo. */
function extractInitials(s) {
  if (isInitialsPattern(s)) {
    return (String(s).match(/[A-Za-zÀ-ÿ]/g) || []).map((c) => c.toUpperCase());
  }
  return normalize(s)
    .split(' ')
    .filter(Boolean)
    .map((w) => w[0]);
}

/** Distância de Levenshtein clássica (DP iterativo). */
function levenshtein(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = new Array(n + 1);
  let curr = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/**
 * Similaridade de nome, 0..1.
 * CA-10.4: quando um dos lados é padrão de iniciais (ex. "F.J.A."), a
 * comparação usa o CONJUNTO de iniciais (não Levenshtein cru na string crua,
 * que penalizaria injustamente a diferença de formato/comprimento).
 */
function simNome(a, b) {
  if (!a || !b) return 0;
  if (isInitialsPattern(a) || isInitialsPattern(b)) {
    const ia = extractInitials(a);
    const ib = extractInitials(b);
    const setA = new Set(ia);
    const setB = new Set(ib);
    const inter = [...setA].filter((x) => setB.has(x)).length;
    const union = new Set([...ia, ...ib]).size;
    if (union === 0) return 0;
    const jaccard = inter / union;
    // conjunto exato de iniciais bate -> score alto, mas deixa a âncora de
    // data (matchOccupant) empurrar pra MESMO, em vez de decidir sozinho.
    return jaccard === 1 ? 0.8 : jaccard * 0.5;
  }
  const na = normalize(a);
  const nb = normalize(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  // token-sort: tolera reordenação de nome/sobrenome
  const ta = na.split(' ').filter(Boolean).sort().join(' ');
  const tb = nb.split(' ').filter(Boolean).sort().join(' ');
  const dist = levenshtein(ta, tb);
  const maxLen = Math.max(ta.length, tb.length, 1);
  return Math.max(0, 1 - dist / maxLen);
}

/**
 * Classifica o ocupante atual (`cur`, registro de internacoes_hmsa ou null)
 * contra a linha extraída da foto (`ocrRow`).
 * Retorna { resultado: 'VAZIO'|'MESMO'|'DIFERENTE'|'AMBIGUO', score }.
 * CA-09.1 (parte VAZIO), CA-10.1-10.4.
 */
function matchOccupant(cur, ocrRow) {
  if (cur == null) return { resultado: 'VAZIO', score: null };
  const nameSim = simNome(cur.nome, ocrRow && ocrRow.nome);
  const dateMatch = !!(
    cur.data_admissao &&
    ocrRow &&
    ocrRow.data_admissao &&
    cur.data_admissao === ocrRow.data_admissao
  );
  // âncora de data pesa mais que divergência de formato de nome (CA-10.4):
  // data batendo garante piso 0.9 (dentro da faixa MESMO), mesmo se o nome
  // só bateu por conjunto-de-iniciais (score bruto abaixo do limiar).
  const score = dateMatch ? Math.max(nameSim, 0.9) : nameSim;
  let resultado;
  if (score >= LIMIAR_MESMO) resultado = 'MESMO';
  else if (score < LIMIAR_DIFERENTE) resultado = 'DIFERENTE';
  else resultado = 'AMBIGUO';
  return { resultado, score, nameSim, dateMatch };
}

/** Monta o payload de INSERT (leito vazio confirmado). Sempre `status_internacao: 'ativa'`. */
function buildInsertPayload(hospital, leito, dataKanban, ocrRow) {
  const clean = stripStatus(ocrRow || {});
  return {
    id: buildIdEpisodio(hospital, leito, dataKanban),
    hospital,
    leito,
    ...clean,
    status_internacao: 'ativa',
    fonte: 'foto'
  };
}

/**
 * Compara campos travados contra o valor lido na foto; onde divergir, gera
 * item de sugestão (badge) — nunca overwrite (CA-09.2).
 */
function buildSugestoes(ocrRow, camposTravados, cur) {
  const locked = listaCamposTravados(camposTravados);
  const out = [];
  for (const campo of locked) {
    if (!ocrRow || !(campo in ocrRow)) continue;
    const valorFoto = ocrRow[campo];
    const valorAtual = cur ? cur[campo] : undefined;
    if (valorFoto !== undefined && valorFoto !== null && valorFoto !== valorAtual) {
      out.push({ campo, valorAtual, valorFoto });
    }
  }
  return out;
}

/**
 * Máquina de estados principal. Orquestra `matchOccupant` + `applyFieldLock`.
 * `cur`: registro atual de internacoes_hmsa (ou null se ausente da lista).
 * `ocrRow`: linha extraída da foto para o leito (`{leito, nome, data_admissao, ...}`).
 * `camposTravados`: array/objeto de campos travados do leito.
 * `leitosVazios`: array de leitos que a foto reportou como visivelmente vazios
 *   (`leitos_vazios` do extract.js — distinto de simplesmente ausente da lista).
 * `opts.dryRun`: função já é pura/sem I/O em qualquer caso; o flag só é
 *   ecoado em `applied` para o CALLER decidir aplicar ou não (T12).
 *
 * Retorna { action, payload, pendencia, applied, score }.
 * action ∈ {insert, merge, bloqueia, revisao}.
 * CA-09.1 a CA-09.5.
 */
function reconcile(cur, ocrRow, camposTravados, leitosVazios, opts) {
  const options = opts || {};
  const dryRun = !!options.dryRun;
  const applied = !dryRun;
  const hospital = options.hospital || (cur && cur.hospital) || 'HMAGR';
  const leito = (ocrRow && ocrRow.leito) || (cur && cur.leito);
  const dataKanban = options.dataKanban || (ocrRow && ocrRow.data_kanban);
  const vazios = Array.isArray(leitosVazios) ? leitosVazios : [];

  const match = matchOccupant(cur, ocrRow);

  if (match.resultado === 'VAZIO') {
    // CA-09.1: só é insert se o leito está confirmado vazio na foto
    // (leitos_vazios), não apenas ausente da lista de pacientes extraída.
    if (!vazios.includes(leito)) {
      return {
        action: 'revisao',
        payload: null,
        pendencia: {
          tipo: 'revisao',
          motivo: 'leito_ausente_sem_confirmacao_vazio',
          payload_ocr: stripStatus(ocrRow)
        },
        applied,
        score: null
      };
    }
    return {
      action: 'insert',
      payload: buildInsertPayload(hospital, leito, dataKanban, ocrRow),
      pendencia: null,
      applied,
      score: null
    };
  }

  if (match.resultado === 'MESMO') {
    const locked = applyFieldLock(stripStatus(ocrRow), camposTravados);
    delete locked.leito;
    delete locked.hospital;
    delete locked.id;
    const payload = {
      id: (cur && cur.id) || buildIdEpisodio(hospital, leito, dataKanban),
      hospital,
      leito,
      ...locked,
      status_internacao: 'ativa'
    };
    const sugestoes = buildSugestoes(ocrRow, camposTravados, cur);
    return {
      action: 'merge',
      payload,
      pendencia: sugestoes.length ? { tipo: 'sugestao_campo', campos: sugestoes } : null,
      applied,
      score: match.score
    };
  }

  if (match.resultado === 'DIFERENTE') {
    // Registro atual não é tocado (payload=null); a foto vira pendência de
    // giro, que só se completa com giro_motivo preenchido (T11, fora daqui).
    return {
      action: 'bloqueia',
      payload: null,
      pendencia: {
        tipo: 'giro',
        payload_ocr: stripStatus(ocrRow),
        giro_motivo: null,
        score: match.score
      },
      applied,
      score: match.score
    };
  }

  // AMBIGUO — nunca decide sozinho entre MESMO e DIFERENTE (CA-09.4).
  return {
    action: 'revisao',
    payload: null,
    pendencia: { tipo: 'revisao', payload_ocr: stripStatus(ocrRow), score: match.score },
    applied,
    score: match.score
  };
}

const api = {
  GIRO_MOTIVOS,
  buildIdEpisodio,
  applyFieldLock,
  simNome,
  matchOccupant,
  reconcile
};

if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;
} else {
  window.Reconcile = api;
}
