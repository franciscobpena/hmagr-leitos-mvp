/**
 * Unit tests: parser da resposta JSON da Anthropic API
 * Valida que o JSON extraído é parseado corretamente e campos esperados existem.
 * Roda com: node --test tests/unit/parser.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Parser da resposta bruta da API (pode vir com markdown wrapper).
 * Extrai o JSON estruturado dos pacientes.
 */
function parseAnthropicResponse(rawText) {
  const cleaned = rawText
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  return JSON.parse(cleaned);
}

/**
 * Valida estrutura mínima do resultado extraído.
 */
function validateExtractResult(result) {
  const erros = [];
  if (!result.setor_sigla) erros.push('setor_sigla ausente');
  if (!result.data_kanban) erros.push('data_kanban ausente');
  if (!Array.isArray(result.pacientes)) erros.push('pacientes deve ser array');
  if (typeof result.confianca_setor !== 'number') erros.push('confianca_setor deve ser number');
  for (const [i, p] of (result.pacientes || []).entries()) {
    if (!p.leito) erros.push(`paciente[${i}].leito ausente`);
    if (!Array.isArray(p.campos_baixa_confianca)) erros.push(`paciente[${i}].campos_baixa_confianca deve ser array`);
  }
  return erros;
}

const VALID_RESPONSE = JSON.stringify({
  setor_sigla: 'CM',
  setor_nome: 'Clínica Médica',
  data_kanban: '2026-06-26',
  confianca_setor: 0.98,
  leitos_inativos: [],
  pacientes: [
    {
      leito: '301',
      nome: 'J.M.S.',
      idade: 67,
      diagnostico: 'IAM',
      data_admissao: '2026-06-10',
      data_provavel_alta: '2026-06-20',
      pendencias: 'ATB',
      perfil_sala_alta: true,
      campos_baixa_confianca: []
    }
  ]
});

describe('parseAnthropicResponse', () => {
  it('parseia JSON limpo', () => {
    const result = parseAnthropicResponse(VALID_RESPONSE);
    assert.equal(result.setor_sigla, 'CM');
    assert.equal(result.pacientes.length, 1);
    assert.equal(result.pacientes[0].leito, '301');
  });

  it('parseia JSON com markdown wrapper ```json', () => {
    const wrapped = '```json\n' + VALID_RESPONSE + '\n```';
    const result = parseAnthropicResponse(wrapped);
    assert.equal(result.setor_sigla, 'CM');
  });

  it('parseia JSON com wrapper ``` simples', () => {
    const wrapped = '```\n' + VALID_RESPONSE + '\n```';
    const result = parseAnthropicResponse(wrapped);
    assert.equal(result.data_kanban, '2026-06-26');
  });

  it('lança SyntaxError em JSON inválido', () => {
    assert.throws(() => parseAnthropicResponse('não é JSON'), SyntaxError);
  });

  it('confianca_setor < 0.80 é preservado (confirmação humana necessária)', () => {
    const lowConf = JSON.parse(VALID_RESPONSE);
    lowConf.confianca_setor = 0.72;
    const result = parseAnthropicResponse(JSON.stringify(lowConf));
    assert.equal(result.confianca_setor, 0.72);
    assert.ok(result.confianca_setor < 0.80, 'baixa confiança deve ser preservada para UI sinalizar');
  });

  it('paciente com campos_baixa_confianca preenchidos é preservado', () => {
    const withBaixaConf = JSON.parse(VALID_RESPONSE);
    withBaixaConf.pacientes[0].campos_baixa_confianca = ['idade', 'data_provavel_alta'];
    const result = parseAnthropicResponse(JSON.stringify(withBaixaConf));
    assert.deepEqual(result.pacientes[0].campos_baixa_confianca, ['idade', 'data_provavel_alta']);
  });

  it('leito inativo é capturado em leitos_inativos, não em pacientes', () => {
    const comLeito = JSON.parse(VALID_RESPONSE);
    comLeito.leitos_inativos = ['401'];
    comLeito.pacientes = [];
    const result = parseAnthropicResponse(JSON.stringify(comLeito));
    assert.deepEqual(result.leitos_inativos, ['401']);
    assert.equal(result.pacientes.length, 0);
  });
});

describe('validateExtractResult', () => {
  it('resultado válido → sem erros', () => {
    const result = JSON.parse(VALID_RESPONSE);
    const erros = validateExtractResult(result);
    assert.deepEqual(erros, []);
  });

  it('setor_sigla ausente → erro', () => {
    const result = JSON.parse(VALID_RESPONSE);
    delete result.setor_sigla;
    const erros = validateExtractResult(result);
    assert.ok(erros.some(e => e.includes('setor_sigla')));
  });

  it('pacientes não-array → erro', () => {
    const result = JSON.parse(VALID_RESPONSE);
    result.pacientes = null;
    const erros = validateExtractResult(result);
    assert.ok(erros.some(e => e.includes('pacientes')));
  });

  it('paciente sem leito → erro', () => {
    const result = JSON.parse(VALID_RESPONSE);
    delete result.pacientes[0].leito;
    const erros = validateExtractResult(result);
    assert.ok(erros.some(e => e.includes('leito')));
  });
});
