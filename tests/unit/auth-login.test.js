// tests/unit/auth-login.test.js — regras de login (CA-01..04 da SPEC-AUTH-HMAGR).
// Env setado ANTES do require (login.js le AUTH_EMAIL_DOMAIN/MASTER no load).
const { test } = require('node:test');
const assert = require('node:assert');

process.env.AUTH_SECRET = 'test-secret-min-16-chars-xxxxxx';
process.env.LEAN_SHARED_PASSWORD = 'lean';
process.env.AUTH_EMAIL_DOMAIN = '@hospital.test';
const login = require('../../api/auth/login');

function fakeRes() {
  return {
    _status: 0, _json: null, _headers: {},
    status(c) { this._status = c; return this; },
    json(o) { this._json = o; return this; },
    setHeader(k, v) { this._headers[k] = v; return this; }
  };
}
async function call(body, method = 'POST') {
  const res = fakeRes();
  await login({ method, body }, res);
  return res;
}

test('CA-01 dominio institucional + senha lean -> 200 + cookie httpOnly/Secure/Strict', async () => {
  const res = await call({ email: 'joao@hospital.test', password: 'lean' });
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.ok, true);
  const cookie = String(res._headers['Set-Cookie']);
  assert.match(cookie, /hmagr_session=/);
  assert.match(cookie, /HttpOnly; Secure; SameSite=Strict; Path=\/; Max-Age=43200/);
});

test('normaliza espacos e maiusculas no e-mail', async () => {
  const res = await call({ email: '  JOAO@Hospital.TEST  ', password: 'lean' });
  assert.strictEqual(res._status, 200);
});

test('CA-02 fora do dominio -> 401 (independe da senha)', async () => {
  const res = await call({ email: 'joao@gmail.com', password: 'lean' });
  assert.strictEqual(res._status, 401);
});

test('CA-03 senha errada -> 401 (independe do e-mail)', async () => {
  const res = await call({ email: 'joao@hospital.test', password: 'leao' });
  assert.strictEqual(res._status, 401);
});

test('CA-04 mensagem de erro unica (nao revela campo)', async () => {
  const r1 = await call({ email: 'joao@gmail.com', password: 'lean' });       // dominio errado
  const r2 = await call({ email: 'joao@hospital.test', password: 'errada' }); // senha errada
  assert.strictEqual(r1._json.error, r2._json.error);
});

test('master (Francisco) bypassa dominio institucional', async () => {
  const res = await call({ email: 'bahiapenafrancisco@gmail.com', password: 'lean' });
  assert.strictEqual(res._status, 200);
  assert.strictEqual(res._json.master, true);
});

test('metodo != POST -> 405', async () => {
  const res = await call({}, 'GET');
  assert.strictEqual(res._status, 405);
});
