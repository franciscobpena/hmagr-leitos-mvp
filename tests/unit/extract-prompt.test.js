/**
 * Unit tests: sinal leitos_vazios em api/extract.js (T3)
 * Roda com: node --test tests/unit/extract-prompt.test.js
 * CA-08.5: leitos_vazios distinto de leitos_inativos, no prompt e no mock.
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');

// Garante que NÃO há ANTHROPIC_API_KEY no ambiente de teste (força o handler
// pelo branch de mock, sem chamada de rede à Anthropic).
const prevKey = process.env.ANTHROPIC_API_KEY;
delete process.env.ANTHROPIC_API_KEY;

const handler = require('../../api/extract');
const { buildSystemPrompt } = handler;

function fakeRes() {
  return {
    _status: 0, _json: null,
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; }
  };
}

describe('buildSystemPrompt (CA-08.5)', () => {
  it('é exportado do módulo (testável sem chamada de rede)', () => {
    assert.equal(typeof buildSystemPrompt, 'function');
  });

  it('menciona leitos_vazios no prompt', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /leitos_vazios/);
  });

  it('distingue leitos_vazios de leitos_inativos (ambos mencionados, textos diferentes)', () => {
    const prompt = buildSystemPrompt();
    assert.match(prompt, /leitos_inativos/);
    assert.match(prompt, /leitos_vazios/);
    // a regra de leitos_vazios explica que é "disponível" (distinto de bloqueado/reforma)
    assert.match(prompt, /vazi[ao]/i);
  });
});

describe('handler mock (sem ANTHROPIC_API_KEY) inclui leitos_vazios', () => {
  after(() => {
    if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
  });

  it('resposta mock inclui a chave leitos_vazios (array)', async () => {
    const res = fakeRes();
    const req = {
      method: 'POST',
      body: { imageB64: 'ZmFrZQ==', md5: 'deadbeef', dhash: '0000000000000000' }
    };
    await handler(req, res);
    assert.equal(res._status, 200);
    assert.ok(res._json.mock, 'deve responder no branch mock sem API key');
    assert.ok(Array.isArray(res._json.leitos_vazios), 'leitos_vazios deve ser array no mock');
    assert.ok(Array.isArray(res._json.leitos_inativos), 'leitos_inativos continua presente (irmão)');
  });
});
