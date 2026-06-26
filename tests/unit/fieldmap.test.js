/**
 * Unit tests: mapeamento campos extraídos → colunas internacoes_hmsa
 * Valida que o payload do upsert está correto antes de ir ao Supabase.
 * Roda com: node --test tests/unit/fieldmap.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Mapeia um paciente extraído + metadados do snapshot → payload do upsert em internacoes_hmsa.
 * Regra: id = 'HMAGR_int_' + leito
 * CA-02.2: 9 campos do quadro mapeados. STATUS (cor) é ignorado; status_internacao = 'ativa'.
 * fonte_criacao = 'migracao_planilha' (único valor aceito além de 'manual' pelo CHECK constraint).
 */
function mapPacienteToInternacao(paciente, setor) {
  const leito = String(paciente.leito || '').trim();
  if (!leito) throw new Error('leito é obrigatório');

  return {
    id: `HMAGR_int_${leito}`,
    hospital: 'HMAGR',
    atendimento: leito,
    nome_paciente: paciente.nome || null,
    setor: setor,
    leito: leito,
    especialidade: null, // quadro HMAGR não tem coluna especialidade; derivado do setor
    cid_principal: paciente.diagnostico || null,
    idade: typeof paciente.idade === 'number' ? paciente.idade : null,
    data_internacao: paciente.data_admissao || null,
    previsao_kanban: paciente.data_provavel_alta || null,
    pendencia: paciente.pendencias || null,
    perfil_sala_alta: typeof paciente.perfil_sala_alta === 'boolean' ? paciente.perfil_sala_alta : null,
    status_internacao: 'ativa',
    fonte_criacao: 'migracao_planilha',
    created_by: 'kanban_foto'
  };
}

/**
 * Valida que o payload respeita constraints conhecidos do schema.
 */
function validatePayload(payload) {
  const erros = [];
  if (!payload.id || !payload.id.startsWith('HMAGR_int_')) erros.push('id deve começar com HMAGR_int_');
  if (payload.hospital !== 'HMAGR') erros.push('hospital deve ser HMAGR');
  if (!['manual', 'migracao_planilha'].includes(payload.fonte_criacao)) {
    erros.push('fonte_criacao inválido: ' + payload.fonte_criacao);
  }
  if (payload.status_internacao !== 'ativa') erros.push('status_internacao deve ser ativa');
  // Status visual (verde/amarelo/vermelho) NUNCA deve estar no payload
  const proibido = ['verde', 'amarelo', 'vermelho', 'green', 'yellow', 'red'];
  for (const [k, v] of Object.entries(payload)) {
    if (proibido.includes(String(v).toLowerCase())) {
      erros.push(`campo ${k} contém cor de status proibida: ${v}`);
    }
  }
  return erros;
}

const PACIENTE_COMPLETO = {
  leito: '301',
  nome: 'J.M.S.',
  idade: 67,
  diagnostico: 'IAM',
  data_admissao: '2026-06-10',
  data_provavel_alta: '2026-06-20',
  pendencias: 'ATB',
  perfil_sala_alta: true,
  campos_baixa_confianca: []
};

describe('mapPacienteToInternacao', () => {
  it('campos obrigatórios mapeados corretamente', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CM');
    assert.equal(payload.id, 'HMAGR_int_301');
    assert.equal(payload.hospital, 'HMAGR');
    assert.equal(payload.leito, '301');
    assert.equal(payload.atendimento, '301');
    assert.equal(payload.nome_paciente, 'J.M.S.');
    assert.equal(payload.status_internacao, 'ativa');
    assert.equal(payload.fonte_criacao, 'migracao_planilha');
    assert.equal(payload.created_by, 'kanban_foto');
  });

  it('CA-05.2: status de cor do quadro NÃO mapeado', () => {
    const pacienteComStatus = { ...PACIENTE_COMPLETO, status: 'verde' };
    const payload = mapPacienteToInternacao(pacienteComStatus, 'CM');
    assert.ok(!('status' in payload), 'campo status do quadro não deve estar no payload');
    assert.ok(!Object.values(payload).includes('verde'), 'cor verde não deve aparecer no payload');
  });

  it('CA-02.2: diagnóstico mapeado para cid_principal', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CM');
    assert.equal(payload.cid_principal, 'IAM');
  });

  it('CA-02.2: data admissão mapeada para data_internacao', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CM');
    assert.equal(payload.data_internacao, '2026-06-10');
  });

  it('CA-02.2: data provável alta mapeada para previsao_kanban', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CM');
    assert.equal(payload.previsao_kanban, '2026-06-20');
  });

  it('CA-02.2: perfil sala de alta mapeado para perfil_sala_alta (bool)', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CM');
    assert.equal(payload.perfil_sala_alta, true);
  });

  it('setor mapeado corretamente', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CT');
    assert.equal(payload.setor, 'CT');
  });

  it('campos null quando não preenchidos', () => {
    const parcial = { leito: '302', campos_baixa_confianca: [] };
    const payload = mapPacienteToInternacao(parcial, 'CM');
    assert.equal(payload.nome_paciente, null);
    assert.equal(payload.cid_principal, null);
    assert.equal(payload.data_internacao, null);
    assert.equal(payload.previsao_kanban, null);
  });

  it('lança erro se leito ausente', () => {
    assert.throws(() => mapPacienteToInternacao({ nome: 'J.M.S.' }, 'CM'), /leito é obrigatório/);
  });

  it('id gerado = HMAGR_int_ + leito', () => {
    const payload = mapPacienteToInternacao({ leito: '401', campos_baixa_confianca: [] }, 'CT');
    assert.equal(payload.id, 'HMAGR_int_401');
  });
});

describe('validatePayload', () => {
  it('payload válido → sem erros', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CM');
    const erros = validatePayload(payload);
    assert.deepEqual(erros, []);
  });

  it('fonte_criacao inválida → erro', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CM');
    payload.fonte_criacao = 'ocr'; // não aceito pelo CHECK constraint
    const erros = validatePayload(payload);
    assert.ok(erros.some(e => e.includes('fonte_criacao')));
  });

  it('cor de status no payload → erro', () => {
    const payload = mapPacienteToInternacao(PACIENTE_COMPLETO, 'CM');
    payload.status_cor = 'verde'; // não deveria estar aqui
    const erros = validatePayload(payload);
    assert.ok(erros.some(e => e.includes('verde')));
  });
});
