/**
 * Unit tests: lógica de dedup (MD5 exact OR dHash Hamming ≤ 5)
 * Roda com: node --test tests/unit/dedup.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { hammingDistance } = require('../../lib/dhash');

/**
 * Simula a lógica de dedup do server (stages A + B).
 * Em produção isso acontece dentro de api/extract.js contra o Supabase.
 * Aqui testamos a lógica isolada com dados em memória.
 */
function isDuplicate(newMd5, newDhash, storedHashes) {
  // Stage A: MD5 exact match
  for (const h of storedHashes) {
    if (h.md5 === newMd5) return { duplicata: true, razao: 'md5', processedAt: h.ts_processamento };
  }
  // Stage B: dHash Hamming ≤ 5
  for (const h of storedHashes) {
    if (h.dhash && hammingDistance(newDhash, h.dhash) <= 5) {
      return { duplicata: true, razao: 'dhash', processedAt: h.ts_processamento };
    }
  }
  return { duplicata: false };
}

describe('dedup lógica', () => {
  const stored = [
    { md5: 'abc123', dhash: '1234567890abcdef', ts_processamento: '2026-06-26T07:00:00Z' }
  ];

  it('CA-04.1: MD5 idêntico bloqueia (Stage A)', () => {
    const result = isDuplicate('abc123', '9999999999999999', stored);
    assert.equal(result.duplicata, true);
    assert.equal(result.razao, 'md5');
  });

  it('CA-04.1: dHash Hamming ≤ 5 bloqueia (Stage B)', () => {
    // dHash com 3 bits diferentes (re-encoding WhatsApp)
    const reencoded = (BigInt('0x' + '1234567890abcdef') ^ 7n).toString(16).padStart(16, '0');
    const result = isDuplicate('diferente_md5', reencoded, stored);
    assert.equal(result.duplicata, true);
    assert.equal(result.razao, 'dhash');
  });

  it('CA-04.1: MD5 E dHash diferentes → não é duplicata', () => {
    const result = isDuplicate('outro_md5', 'fedcba0987654321', stored);
    assert.equal(result.duplicata, false);
  });

  it('OR explícito: MD5 diferente mas dHash ≤ 5 ainda bloqueia', () => {
    // Mesmo cenário com MD5 diferente (WhatsApp reencoda, MD5 muda mas imagem é a mesma)
    const vizinho = (BigInt('0x1234567890abcdef') ^ 3n).toString(16).padStart(16, '0');
    const result = isDuplicate('md5_novo_apos_reencoding', vizinho, stored);
    assert.equal(result.duplicata, true, 'dHash deve capturar re-encoding mesmo com MD5 diferente');
  });

  it('dHash exatamente 5 bits diferentes → bloqueado (threshold inclusivo)', () => {
    const cincobitsDiff = (BigInt('0x1234567890abcdef') ^ 0b11111n).toString(16).padStart(16, '0');
    const result = isDuplicate('md5_x', cincobitsDiff, stored);
    assert.equal(result.duplicata, true);
  });

  it('dHash com 6 bits diferentes → não bloqueado', () => {
    const seisbitsDiff = (BigInt('0x1234567890abcdef') ^ 0b111111n).toString(16).padStart(16, '0');
    const result = isDuplicate('md5_y', seisbitsDiff, stored);
    assert.equal(result.duplicata, false);
  });

  it('base vazia → nunca duplicata', () => {
    const result = isDuplicate('qualquer', '1234567890abcdef', []);
    assert.equal(result.duplicata, false);
  });
});
