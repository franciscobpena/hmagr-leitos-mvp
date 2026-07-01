/**
 * Unit tests: chip de pendência de reconciliação (lib/reconcile-ui.js) — HMAGR Fase 2, T16/T17
 * Roda com: node --test tests/unit/reconcile-ui.test.js
 * CA-13.1 (prioridade Dar baixa > Duplicado > Conferir dado + sufixo +N), CA-13.4 (diff
 * campo-a-campo do modal "Conferir dado").
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { simNome, LIMIAR_MESMO } = require('../../lib/reconcile');
const { ehProvavelDuplicado, escolherChipDoLeito, diffsParaModal, CAMPO_INPUT_MAP, LIMIAR_DUPLICADO } = require('../../lib/reconcile-ui');

// ── ehProvavelDuplicado ──
describe('ehProvavelDuplicado (heurística Duplicado, HIPÓTESE spec §5)', () => {
  it('false se a pendência não é tipo giro', () => {
    const pend = { tipo: 'divergente', payload_ocr: { nome: 'JOAO SILVA' }, cur_id: 'A' };
    assert.equal(ehProvavelDuplicado(pend, [{ idEpisodio: 'B', nomePaciente: 'JOAO SILVA' }], simNome), false);
  });

  it('false se não há nome na foto', () => {
    const pend = { tipo: 'giro', payload_ocr: {}, cur_id: 'A' };
    assert.equal(ehProvavelDuplicado(pend, [{ idEpisodio: 'B', nomePaciente: 'JOAO SILVA' }], simNome), false);
  });

  it('false se nenhum outro paciente ativo tem nome parecido', () => {
    const pend = { tipo: 'giro', payload_ocr: { nome: 'MARIA OLIVEIRA' }, cur_id: 'A' };
    assert.equal(ehProvavelDuplicado(pend, [{ idEpisodio: 'B', nomePaciente: 'JOAO SILVA' }], simNome), false);
  });

  it('true se outro paciente ATIVO em leito diferente bate por nome (score >= 0.85)', () => {
    const pend = { tipo: 'giro', payload_ocr: { nome: 'JOAO DA SILVA' }, cur_id: 'A' };
    const outros = [{ idEpisodio: 'B', nomePaciente: 'JOAO DA SILVA' }];
    assert.equal(ehProvavelDuplicado(pend, outros, simNome), true);
  });

  it('false se o "outro paciente" é o próprio ocupante do leito (mesmo cur_id/idEpisodio)', () => {
    const pend = { tipo: 'giro', payload_ocr: { nome: 'JOAO DA SILVA' }, cur_id: 'A' };
    const outros = [{ idEpisodio: 'A', nomePaciente: 'JOAO DA SILVA' }];
    assert.equal(ehProvavelDuplicado(pend, outros, simNome), false);
  });
});

// ── escolherChipDoLeito ──
describe('escolherChipDoLeito (CA-13.1 — prioridade Dar baixa > Duplicado > Conferir dado)', () => {
  it('null se a lista de pendências está vazia', () => {
    assert.equal(escolherChipDoLeito([], [], simNome), null);
  });

  it('giro (sem heurística de duplicado) vence — tipoChip=baixa', () => {
    const lista = [
      { id: 1, tipo: 'divergente', payload_ocr: {}, cur_id: 'A' },
      { id: 2, tipo: 'giro', payload_ocr: { nome: 'PACIENTE X' }, cur_id: 'A' }
    ];
    const r = escolherChipDoLeito(lista, [], simNome);
    assert.equal(r.tipoChip, 'baixa');
    assert.equal(r.principal.id, 2);
    assert.equal(r.extra, 1);
  });

  it('giro simples vence giro-duplicado quando os dois coexistem no mesmo leito', () => {
    const lista = [
      { id: 1, tipo: 'giro', payload_ocr: { nome: 'JOAO DA SILVA' }, cur_id: 'A' }, // duplicado (bate com outro ativo)
      { id: 2, tipo: 'giro', payload_ocr: { nome: 'PACIENTE NOVO' }, cur_id: 'A' } // sem match -> simples
    ];
    const outros = [{ idEpisodio: 'B', nomePaciente: 'JOAO DA SILVA' }];
    const r = escolherChipDoLeito(lista, outros, simNome);
    assert.equal(r.tipoChip, 'baixa');
    assert.equal(r.principal.id, 2);
  });

  it('sem giro simples, giro-duplicado vence "conferir" — tipoChip=duplicado', () => {
    const lista = [
      { id: 1, tipo: 'sugestao_campo', payload_ocr: {}, cur_id: 'A' },
      { id: 2, tipo: 'giro', payload_ocr: { nome: 'JOAO DA SILVA' }, cur_id: 'A' }
    ];
    const outros = [{ idEpisodio: 'B', nomePaciente: 'JOAO DA SILVA' }];
    const r = escolherChipDoLeito(lista, outros, simNome);
    assert.equal(r.tipoChip, 'duplicado');
    assert.equal(r.principal.id, 2);
  });

  it('só divergente/sugestao_campo -> tipoChip=conferir', () => {
    const lista = [{ id: 1, tipo: 'sugestao_campo', payload_ocr: {}, cur_id: 'A' }];
    const r = escolherChipDoLeito(lista, [], simNome);
    assert.equal(r.tipoChip, 'conferir');
    assert.equal(r.extra, 0);
  });

  it('sufixo +N conta as pendências além da escolhida', () => {
    const lista = [
      { id: 1, tipo: 'giro', payload_ocr: { nome: 'X' }, cur_id: 'A' },
      { id: 2, tipo: 'divergente', payload_ocr: {}, cur_id: 'A' },
      { id: 3, tipo: 'sugestao_campo', payload_ocr: {}, cur_id: 'A' }
    ];
    const r = escolherChipDoLeito(lista, [], simNome);
    assert.equal(r.extra, 2);
  });
});

// ── diffsParaModal ──
describe('diffsParaModal (CA-13.4 — diff campo digitado x lido no modal "Conferir dado")', () => {
  it('pendência null -> lista vazia', () => {
    assert.deepEqual(diffsParaModal(null, {}), []);
  });

  it('usa campos_divergentes (granular, branch sugestao_campo/CA-09.2) quando presente', () => {
    const pend = {
      payload_ocr: {
        campos_divergentes: [
          { campo: 'diagnostico', valorAtual: 'IAM', valorFoto: 'AVC' },
          { campo: 'data_admissao', valorAtual: '2026-06-10', valorFoto: '2026-06-10' } // igual -> não é diff
        ]
      }
    };
    const atuais = { diagnostico: 'IAM', data_admissao: '2026-06-10' };
    const diffs = diffsParaModal(pend, atuais);
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].campo, 'diagnostico');
    assert.equal(diffs[0].valorFoto, 'AVC');
    assert.equal(diffs[0].meta.input, 'el-hip');
  });

  it('sem campos_divergentes (branch divergente/AMBIGUO), cai pro registro inteiro da foto filtrado pelo mapa de campos editáveis', () => {
    const pend = { payload_ocr: { nome: 'JOAO SILVA', data_admissao: '2026-06-20', idade: 50 } };
    const atuais = { data_admissao: '2026-06-10' };
    const diffs = diffsParaModal(pend, atuais);
    // 'nome' e 'idade' não têm equivalente em CAMPO_INPUT_MAP -> não entram
    assert.equal(diffs.length, 1);
    assert.equal(diffs[0].campo, 'data_admissao');
    assert.equal(diffs[0].valorFoto, '2026-06-20');
  });

  it('campo igual ao atual não entra na lista de diffs', () => {
    const pend = { payload_ocr: { data_admissao: '2026-06-10' } };
    const atuais = { data_admissao: '2026-06-10' };
    assert.deepEqual(diffsParaModal(pend, atuais), []);
  });

  it('CAMPO_INPUT_MAP não inclui campos sem equivalente no form (num_leito/setor/especialidade)', () => {
    assert.equal(CAMPO_INPUT_MAP.especialidade, undefined);
    assert.equal(CAMPO_INPUT_MAP.setor, undefined);
    assert.equal(CAMPO_INPUT_MAP.num_leito, undefined);
  });
});

// ── S3 do review (01/jul): LIMIAR_DUPLICADO reusa LIMIAR_MESMO, não duplica o número mágico ──
describe('LIMIAR_DUPLICADO (reuso de LIMIAR_MESMO de reconcile.js)', () => {
  it('é o mesmo valor de LIMIAR_MESMO — fonte única, não duplicada', () => {
    assert.equal(LIMIAR_DUPLICADO, LIMIAR_MESMO);
  });
});
