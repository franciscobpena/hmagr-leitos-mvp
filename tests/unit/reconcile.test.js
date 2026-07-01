/**
 * Unit tests: reconciliação foto-OCR (lib/reconcile.js) — HMAGR Fase 2
 * Roda com: node --test tests/unit/reconcile.test.js
 * CA-08.2, CA-08.4, CA-08.5(via extract-prompt.test.js), CA-08.6,
 * CA-09.1 a CA-09.5, CA-10.1 a CA-10.4, CA-12.1 (parte lógica, dryRun).
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  buildIdEpisodio,
  applyFieldLock,
  simNome,
  matchOccupant,
  reconcile,
  GIRO_MOTIVOS,
  mapDbRowToReconcile,
  mapOcrPacienteToReconcileRow,
  mapReconcilePayloadToDb,
  mapPendenciaTipoToDb
} = require('../../lib/reconcile');

// ── T1: buildIdEpisodio ──
describe('buildIdEpisodio (CA-08.2)', () => {
  it('é determinístico — mesma entrada, mesmo id', () => {
    const a = buildIdEpisodio('HMAGR', '301', '2026-06-15');
    const b = buildIdEpisodio('HMAGR', '301', '2026-06-15');
    assert.equal(a, b);
  });

  it('muda quando a data muda (mesmo leito, envios em datas diferentes)', () => {
    const d1 = buildIdEpisodio('HMAGR', '301', '2026-06-15');
    const d2 = buildIdEpisodio('HMAGR', '301', '2026-06-16');
    assert.notEqual(d1, d2);
  });

  it('inclui hospital, leito e data no id', () => {
    const id = buildIdEpisodio('HMAGR', '301', '2026-06-15');
    assert.match(id, /HMAGR/);
    assert.match(id, /301/);
    assert.match(id, /2026-06-15/);
  });
});

// ── T2: applyFieldLock ──
describe('applyFieldLock (CA-08.4, CA-08.6)', () => {
  it('remove chave travada do payload (array de campos)', () => {
    const payload = { diagnostico: 'IAM (foto)', pendencias: 'ATB', nome: 'J.M.S.' };
    const out = applyFieldLock(payload, ['diagnostico']);
    assert.equal('diagnostico' in out, false);
    assert.equal(out.pendencias, 'ATB');
  });

  it('remove chave travada do payload (objeto-mapa de booleanos)', () => {
    const payload = { diagnostico: 'IAM (foto)', pendencias: 'ATB' };
    const out = applyFieldLock(payload, { diagnostico: true, pendencias: false });
    assert.equal('diagnostico' in out, false);
    assert.equal(out.pendencias, 'ATB');
  });

  it('CA-08.6 teste negativo: campo travado nunca aparece, mesmo com valor divergente na foto', () => {
    const payload = { diagnostico: 'VALOR ERRADO DA FOTO' };
    const out = applyFieldLock(payload, ['diagnostico']);
    assert.equal(out.diagnostico, undefined);
    assert.equal(JSON.stringify(out).includes('VALOR ERRADO'), false);
  });

  it('sem campos travados, payload passa intacto', () => {
    const payload = { diagnostico: 'IAM', pendencias: 'ATB' };
    const out = applyFieldLock(payload, []);
    assert.deepEqual(out, payload);
  });

  it('camposTravados null/undefined não quebra', () => {
    const payload = { diagnostico: 'IAM' };
    assert.deepEqual(applyFieldLock(payload, null), payload);
    assert.deepEqual(applyFieldLock(payload, undefined), payload);
  });
});

// ── T7: simNome ──
describe('simNome (CA-10.1 a CA-10.4)', () => {
  it('CA-10.1: nomes idênticos -> score >= 0.85', () => {
    assert.ok(simNome('MARIA DA SILVA', 'MARIA DA SILVA') >= 0.85);
  });

  it('CA-10.1: nomes iguais reordenados -> score >= 0.85 (token-sort)', () => {
    assert.ok(simNome('SILVA MARIA DA', 'MARIA DA SILVA') >= 0.85);
  });

  it('CA-10.2: nomes totalmente diferentes -> score < 0.60', () => {
    assert.ok(simNome('MARIA DA SILVA', 'JOAO PEREIRA COSTA') < 0.60);
  });

  it('CA-10.3: nomes parcialmente parecidos -> score entre 0.60 e 0.85', () => {
    // mesma base, 1 sobrenome a mais (diferença moderada, não trivial nem oposta)
    const s = simNome('MARIA DA SILVA', 'MARIA DA SILVA SANTOS');
    assert.ok(s >= 0.60 && s < 0.85, `esperado [0.60,0.85), obtido ${s}`);
  });

  it('CA-10.4: iniciais comparam como conjunto exato, não Levenshtein cru', () => {
    // Levenshtein cru entre "F.J.A." e "FRANCISCO JOSE ALMEIDA" seria péssimo
    // (comprimentos muito diferentes); via conjunto de iniciais o score é alto.
    const s = simNome('F.J.A.', 'FRANCISCO JOSE ALMEIDA');
    assert.ok(s > 0.5, `iniciais exatas devem pontuar bem acima do Levenshtein cru, obtido ${s}`);
  });

  it('iniciais parcialmente divergentes pontuam mais baixo que conjunto exato', () => {
    const exato = simNome('F.J.A.', 'FRANCISCO JOSE ALMEIDA');
    const parcial = simNome('F.X.A.', 'FRANCISCO JOSE ALMEIDA');
    assert.ok(parcial < exato);
  });

  it('string vazia/nula -> score 0', () => {
    assert.equal(simNome('', 'MARIA'), 0);
    assert.equal(simNome(null, 'MARIA'), 0);
    assert.equal(simNome('MARIA', undefined), 0);
  });
});

// ── T8: matchOccupant ──
describe('matchOccupant', () => {
  it('cur == null -> VAZIO, score null', () => {
    const r = matchOccupant(null, { nome: 'J.M.S.', data_admissao: '2026-06-10' });
    assert.equal(r.resultado, 'VAZIO');
    assert.equal(r.score, null);
  });

  it('CA-10.1: nome+data batendo -> MESMO (score >= 0.85)', () => {
    const cur = { nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' };
    const ocr = { nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' };
    const r = matchOccupant(cur, ocr);
    assert.equal(r.resultado, 'MESMO');
    assert.ok(r.score >= 0.85);
  });

  it('CA-10.2: nome+data completamente diferentes -> DIFERENTE (score < 0.60)', () => {
    const cur = { nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' };
    const ocr = { nome: 'JOAO PEREIRA COSTA', data_admissao: '2026-05-01' };
    const r = matchOccupant(cur, ocr);
    assert.equal(r.resultado, 'DIFERENTE');
    assert.ok(r.score < 0.60);
  });

  it('CA-10.3: score na faixa intermediária -> AMBIGUO', () => {
    const cur = { nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' };
    const ocr = { nome: 'MARIA DA SILVA SANTOS', data_admissao: '2026-05-01' }; // data não bate, nome moderado
    const r = matchOccupant(cur, ocr);
    assert.equal(r.resultado, 'AMBIGUO');
  });

  it('CA-10.4: data bate + iniciais compatíveis com nome completo -> MESMO (âncora de data pesa mais)', () => {
    const cur = { nome: 'FRANCISCO JOSE ALMEIDA', data_admissao: '2026-06-10' };
    const ocr = { nome: 'F.J.A.', data_admissao: '2026-06-10' };
    const r = matchOccupant(cur, ocr);
    assert.equal(r.resultado, 'MESMO');
  });
});

// ── T9: reconcile — 4 branches ──
describe('reconcile()', () => {
  it('CA-09.1: cur nulo + leito em leitos_vazios -> insert, fonte=foto', () => {
    const ocr = { leito: '301', nome: 'J.M.S.', data_admissao: '2026-06-15', data_kanban: '2026-06-15' };
    const r = reconcile(null, ocr, [], ['301']);
    assert.equal(r.action, 'insert');
    assert.equal(r.payload.fonte, 'foto');
    assert.equal(r.payload.leito, '301');
  });

  it('CA-09.1: cur nulo mas leito NÃO confirmado em leitos_vazios -> não insere sozinho (revisao)', () => {
    const ocr = { leito: '302', nome: 'J.M.S.', data_admissao: '2026-06-15', data_kanban: '2026-06-15' };
    const r = reconcile(null, ocr, [], []); // leito ausente da lista, sem confirmação de vazio
    assert.notEqual(r.action, 'insert');
    assert.equal(r.action, 'revisao');
  });

  it('CA-09.2: mesmo paciente (score>=0.85) -> merge, só campos não-travados mudam', () => {
    const cur = { id: 'HMAGR_ocr_301_2026-06-14', hospital: 'HMAGR', leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10', diagnostico: 'DIAGNOSTICO CONFIRMADO PELO EGA' };
    const ocr = { leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10', diagnostico: 'DIAGNOSTICO ERRADO DA FOTO', pendencias: 'ATB' };
    const r = reconcile(cur, ocr, ['diagnostico'], []);
    assert.equal(r.action, 'merge');
    assert.equal('diagnostico' in r.payload, false, 'campo travado não deve aparecer no payload de merge');
    assert.equal(r.payload.pendencias, 'ATB', 'campo não-travado deve mudar');
    assert.ok(r.pendencia && r.pendencia.tipo === 'sugestao_campo', 'divergência em campo travado gera sugestão/badge');
    assert.equal(r.pendencia.campos[0].campo, 'diagnostico');
  });

  it('CA-09.3: paciente diferente (score<0.60) -> bloqueia, registro atual intocado, pendência de giro', () => {
    const cur = { id: 'x', hospital: 'HMAGR', leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' };
    const ocr = { leito: '301', nome: 'JOAO PEREIRA COSTA', data_admissao: '2026-05-01' };
    const r = reconcile(cur, ocr, [], []);
    assert.equal(r.action, 'bloqueia');
    assert.equal(r.payload, null, 'registro atual não é tocado');
    assert.equal(r.pendencia.tipo, 'giro');
    assert.equal(r.pendencia.giro_motivo, null, 'giro só se completa com giro_motivo preenchido depois');
    assert.deepEqual(r.pendencia.payload_ocr.nome, 'JOAO PEREIRA COSTA');
  });

  it('CA-09.4: score intermediário -> revisao, nunca decide sozinho entre MESMO e DIFERENTE', () => {
    const cur = { id: 'x', hospital: 'HMAGR', leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' };
    const ocr = { leito: '301', nome: 'MARIA DA SILVA SANTOS', data_admissao: '2026-05-01' };
    const r = reconcile(cur, ocr, [], []);
    assert.equal(r.action, 'revisao');
    assert.equal(r.payload, null);
  });

  it('GIRO_MOTIVOS expõe o enum esperado', () => {
    assert.deepEqual(GIRO_MOTIVOS, ['alta', 'transferencia', 'evasao', 'obito', 'duplicado']);
  });

  // ── CA-09.5 (invariante S1) — parametrizado nos 4 branches ──
  describe('CA-09.5 invariante: status_internacao nunca != "ativa" em nenhum branch', () => {
    const casos = [
      {
        nome: 'insert (VAZIO confirmado)',
        cur: null,
        ocr: { leito: '301', nome: 'J.M.S.', data_admissao: '2026-06-15', data_kanban: '2026-06-15' },
        travados: [],
        vazios: ['301']
      },
      {
        nome: 'merge (MESMO)',
        cur: { id: 'x', hospital: 'HMAGR', leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' },
        ocr: { leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10', diagnostico: 'IAM' },
        travados: [],
        vazios: []
      },
      {
        nome: 'bloqueia (DIFERENTE)',
        cur: { id: 'x', hospital: 'HMAGR', leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' },
        ocr: { leito: '301', nome: 'JOAO PEREIRA COSTA', data_admissao: '2026-05-01' },
        travados: [],
        vazios: []
      },
      {
        nome: 'revisao (AMBIGUO)',
        cur: { id: 'x', hospital: 'HMAGR', leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' },
        ocr: { leito: '301', nome: 'MARIA DA SILVA SANTOS', data_admissao: '2026-05-01' },
        travados: [],
        vazios: []
      }
    ];

    for (const c of casos) {
      it(`branch: ${c.nome}`, () => {
        const r = reconcile(c.cur, c.ocr, c.travados, c.vazios);
        const okPayload = !r.payload || r.payload.status_internacao === undefined || r.payload.status_internacao === 'ativa';
        assert.ok(okPayload, `payload.status_internacao inválido no branch ${c.nome}: ${JSON.stringify(r.payload)}`);
        // defesa extra: também não deve vazar em pendencia.payload_ocr
        const pOcr = r.pendencia && r.pendencia.payload_ocr;
        const okPendencia = !pOcr || pOcr.status_internacao === undefined;
        assert.ok(okPendencia, `pendencia.payload_ocr vazou status_internacao no branch ${c.nome}`);
      });
    }

    it('mesmo tentando injetar status_internacao malicioso no ocrRow, nunca escapa diferente de "ativa"', () => {
      const cur = { id: 'x', hospital: 'HMAGR', leito: '301', nome: 'MARIA DA SILVA', data_admissao: '2026-06-10' };
      const ocrComStatusMalicioso = {
        leito: '301',
        nome: 'MARIA DA SILVA',
        data_admissao: '2026-06-10',
        status_internacao: 'baixa' // não deveria existir no schema real do extract.js, mas blindamos
      };
      const r = reconcile(cur, ocrComStatusMalicioso, [], []);
      assert.equal(r.action, 'merge');
      assert.equal(r.payload.status_internacao, 'ativa');
    });
  });
});

// ── T12: flag dryRun ──
describe('reconcile() com dryRun (CA-12.1, parte lógica)', () => {
  it('dryRun:true retorna a mesma decisão com applied:false, sem side-effect', () => {
    const cur = null;
    const ocr = { leito: '301', nome: 'J.M.S.', data_admissao: '2026-06-15', data_kanban: '2026-06-15' };
    const real = reconcile(cur, ocr, [], ['301'], { dryRun: false });
    const sombra = reconcile(cur, ocr, [], ['301'], { dryRun: true });
    assert.equal(real.action, sombra.action);
    assert.deepEqual(real.payload, sombra.payload);
    assert.equal(real.applied, true);
    assert.equal(sombra.applied, false);
  });

  it('dryRun ausente (default) equivale a applied:true — função é pura em ambos os casos (sem I/O)', () => {
    const r = reconcile(null, { leito: '301', nome: 'X', data_admissao: '2026-06-01', data_kanban: '2026-06-01' }, [], ['301']);
    assert.equal(r.applied, true);
  });
});

// ── T4/T5/T10: adapters DB <-> shape de reconcile() ──
describe('mapDbRowToReconcile (adapter internacoes_hmsa -> reconcile)', () => {
  it('mapeia colunas reais para o shape esperado por matchOccupant/reconcile', () => {
    const row = {
      id: 'HMAGR_ocr_301_2026-06-10', hospital: 'HMAGR', leito: '301',
      nome_paciente: 'MARIA DA SILVA', idade: 67, cid_principal: 'IAM',
      data_internacao: '2026-06-10', previsao_kanban: '2026-06-20',
      pendencia: 'ATB', perfil_sala_alta: true, campos_travados: { diagnostico: true }
    };
    const r = mapDbRowToReconcile(row);
    assert.equal(r.nome, 'MARIA DA SILVA');
    assert.equal(r.diagnostico, 'IAM');
    assert.equal(r.data_admissao, '2026-06-10');
    assert.equal(r.data_provavel_alta, '2026-06-20');
    assert.equal(r.pendencias, 'ATB');
    assert.deepEqual(r.campos_travados, { diagnostico: true });
  });

  it('row null/undefined -> null (equivale a leito vazio pro matchOccupant)', () => {
    assert.equal(mapDbRowToReconcile(null), null);
    assert.equal(mapDbRowToReconcile(undefined), null);
  });
});

describe('mapOcrPacienteToReconcileRow (adapter kfState.pacientes -> reconcile ocrRow)', () => {
  it('mapeia paciente extraído + dataKanban', () => {
    const p = { leito: ' 301 ', nome: 'J.M.S.', idade: 67, diagnostico: 'IAM', data_admissao: '2026-06-10', data_provavel_alta: '2026-06-20', pendencias: 'ATB', perfil_sala_alta: false };
    const r = mapOcrPacienteToReconcileRow(p, '2026-06-15');
    assert.equal(r.leito, '301', 'leito deve ser trimado');
    assert.equal(r.nome, 'J.M.S.');
    assert.equal(r.data_kanban, '2026-06-15');
  });
});

describe('mapReconcilePayloadToDb (adapter reconcile payload -> internacoes_hmsa)', () => {
  it('mapeia payload de insert (com fonte=foto) para fonte_criacao=migracao_planilha (CHECK constraint)', () => {
    const payload = { id: 'HMAGR_ocr_301_2026-06-15', hospital: 'HMAGR', leito: '301', nome: 'J.M.S.', diagnostico: 'IAM', status_internacao: 'ativa', fonte: 'foto' };
    const db = mapReconcilePayloadToDb(payload, { setor: 'CM' });
    assert.equal(db.nome_paciente, 'J.M.S.');
    assert.equal(db.cid_principal, 'IAM');
    assert.equal(db.setor, 'CM');
    assert.equal(db.fonte_criacao, 'migracao_planilha');
    assert.equal(db.created_by, 'kanban_foto');
    assert.equal(db.status_internacao, 'ativa');
  });

  it('mapeia payload de merge (sem fonte) sem incluir fonte_criacao/created_by', () => {
    const payload = { id: 'x', hospital: 'HMAGR', leito: '301', pendencias: 'ATB', status_internacao: 'ativa' };
    const db = mapReconcilePayloadToDb(payload, {});
    assert.equal('fonte_criacao' in db, false);
    assert.equal(db.pendencia, 'ATB');
  });

  it('payload null -> null', () => {
    assert.equal(mapReconcilePayloadToDb(null), null);
  });
});

describe('mapPendenciaTipoToDb (adapter pendencia.tipo -> enum kanban_reconcile_pendencias.tipo)', () => {
  it('giro -> giro', () => { assert.equal(mapPendenciaTipoToDb('giro'), 'giro'); });
  it('sugestao_campo -> sugestao_campo', () => { assert.equal(mapPendenciaTipoToDb('sugestao_campo'), 'sugestao_campo'); });
  it('revisao (fora do enum da migration) -> divergente', () => { assert.equal(mapPendenciaTipoToDb('revisao'), 'divergente'); });
});
