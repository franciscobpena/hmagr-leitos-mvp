/**
 * Unit tests: dHash determinístico + Hamming distance
 * Roda com: node --test tests/unit/dhash.test.js
 */
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { dhashFromPixels, hammingDistance } = require('../../api/dhash');

describe('dHash', () => {
  it('retorna 16-char hex para pixels válidos', () => {
    // 9×8 = 72 pixels, RGBA = 288 bytes, tudo preto
    const buf = Buffer.alloc(9 * 8 * 4, 0);
    const h = dhashFromPixels(buf);
    assert.match(h, /^[0-9a-f]{16}$/, 'deve ser hex de 16 chars');
  });

  it('é determinístico — mesma entrada, mesmo hash', () => {
    const buf = Buffer.alloc(9 * 8 * 4);
    // Gradiente simples: pixel brighter para a direita em cada linha
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        const i = (row * 9 + col) * 4;
        const v = col * 28; // 0..224
        buf[i] = v; buf[i+1] = v; buf[i+2] = v; buf[i+3] = 255;
      }
    }
    const h1 = dhashFromPixels(buf);
    const h2 = dhashFromPixels(buf);
    assert.equal(h1, h2);
  });

  it('imagem toda preta → hash 0000000000000000', () => {
    // Todos os pixels iguais → nenhuma diferença → todos bits 0
    const buf = Buffer.alloc(9 * 8 * 4, 0);
    // Pixel preto: R=0 G=0 B=0, compare com vizinho à direita (igual) → 0
    assert.equal(dhashFromPixels(buf), '0000000000000000');
  });

  it('imagem toda branca → hash 0000000000000000', () => {
    // Todos os pixels iguais (branco) → nenhuma diferença
    const buf = Buffer.alloc(9 * 8 * 4, 255);
    assert.equal(dhashFromPixels(buf), '0000000000000000');
  });

  it('gradiente da esquerda pra direita → todos bits 1 (ffffffffffffffff)', () => {
    // Cada pixel é mais brilhante que o vizinho à direita significa bit=0 (esq > dir = 1)
    // Se esq MAIS BRILHANTE que dir → bit=1. Gradiente decrescente (esq=255, dir=0) → todos 1s.
    const buf = Buffer.alloc(9 * 8 * 4, 0);
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 9; col++) {
        const i = (row * 9 + col) * 4;
        const v = 255 - col * 28; // 255 → 27 (decrescente)
        buf[i] = v; buf[i+1] = v; buf[i+2] = v; buf[i+3] = 255;
      }
    }
    assert.equal(dhashFromPixels(buf), 'ffffffffffffffff');
  });

  it('gera 64 bits (16 hex chars)', () => {
    const buf = Buffer.alloc(9 * 8 * 4, 128);
    const h = dhashFromPixels(buf);
    assert.equal(h.length, 16);
  });
});

describe('hammingDistance', () => {
  it('hash igual → distância 0', () => {
    assert.equal(hammingDistance('abcdef0123456789', 'abcdef0123456789'), 0);
  });

  it('hash totalmente diferente → distância 64', () => {
    assert.equal(hammingDistance('0000000000000000', 'ffffffffffffffff'), 64);
  });

  it('1 bit diferente → distância 1', () => {
    // 0x0000000000000001 vs 0x0000000000000000 → 1 bit
    assert.equal(hammingDistance('0000000000000001', '0000000000000000'), 1);
  });

  it('Hamming ≤ 5 detecta variação WhatsApp (recorte leve)', () => {
    // Simula re-encoding: 3 bits diferentes
    const original = '1234567890abcdef';
    // XOR com valor que muda 3 bits: 0x0000000000000007 = 3 bits
    const reencoded = (BigInt('0x' + original) ^ 7n).toString(16).padStart(16, '0');
    const dist = hammingDistance(original, reencoded);
    assert.equal(dist, 3);
    assert.ok(dist <= 5, 'deve passar no threshold de dedup');
  });

  it('Hamming > 5 rejeita cena diferente', () => {
    // 8 bits diferentes → cena diferente, não dedup
    const a = '0000000000000000';
    const b = '00000000000000ff'; // 8 bits diferentes
    assert.equal(hammingDistance(a, b), 8);
    assert.ok(hammingDistance(a, b) > 5, 'deve rejeitar como cena diferente');
  });
});
