// tests/unit/token.test.js — token HMAC stateless (CA-13 + base do gate de login).
const { test } = require('node:test');
const assert = require('node:assert');

process.env.AUTH_SECRET = 'test-secret-min-16-chars-xxxxxx';
const { signToken, verifyToken, lerCookie, SESSAO_TTL_S } = require('../../lib/token');

test('round-trip: token assinado verifica e devolve o payload', () => {
  const t = signToken({ email: 'a@b.com', master: false });
  const p = verifyToken(t);
  assert.ok(p);
  assert.strictEqual(p.email, 'a@b.com');
  assert.strictEqual(p.master, false);
  assert.ok(p.exp > p.iat);
});

test('assinatura adulterada e rejeitada', () => {
  const t = signToken({ email: 'a@b.com' });
  const [data] = t.split('.');
  assert.strictEqual(verifyToken(data + '.' + 'x'.repeat(43)), null);
});

test('payload trocado mantendo a assinatura e rejeitado', () => {
  const t = signToken({ email: 'a@b.com' });
  const sig = t.split('.')[1];
  const outroData = Buffer.from(JSON.stringify({ email: 'hacker@x', exp: 9999999999 })).toString('base64url');
  assert.strictEqual(verifyToken(outroData + '.' + sig), null);
});

test('token expirado e rejeitado', () => {
  const t = signToken({ email: 'a@b.com' }, -10);
  assert.strictEqual(verifyToken(t), null);
});

test('token malformado e rejeitado', () => {
  assert.strictEqual(verifyToken(''), null);
  assert.strictEqual(verifyToken('semponto'), null);
  assert.strictEqual(verifyToken(null), null);
});

test('secret curto: sign lanca, verify devolve null', () => {
  const orig = process.env.AUTH_SECRET;
  process.env.AUTH_SECRET = 'curto';
  try {
    assert.throws(() => signToken({ email: 'a' }));
    assert.strictEqual(verifyToken('a.b'), null);
  } finally {
    process.env.AUTH_SECRET = orig;
  }
});

test('lerCookie extrai pelo nome', () => {
  const h = 'hmagr_session=abc.def; hmagr_accept=1';
  assert.strictEqual(lerCookie(h, 'hmagr_session'), 'abc.def');
  assert.strictEqual(lerCookie(h, 'hmagr_accept'), '1');
  assert.strictEqual(lerCookie(h, 'inexistente'), null);
  assert.strictEqual(lerCookie('', 'x'), null);
});

test('TTL padrao = 12h', () => {
  assert.strictEqual(SESSAO_TTL_S, 60 * 60 * 12);
});
