// lib/token.js
// Sessao stateless assinada com HMAC-SHA256. Sem dependencias externas (CommonJS).
// O segredo vem de AUTH_SECRET (env). Nunca embarque o segredo no codigo.

const crypto = require('crypto');

const TTL_PADRAO_S = 60 * 60 * 12; // 12h, cobre um turno

function getSecret() {
  const s = process.env.AUTH_SECRET;
  if (!s || s.length < 16) {
    throw new Error('AUTH_SECRET ausente ou curto (minimo 16 chars). Configure no Vercel.');
  }
  return s;
}

function b64url(input) {
  return Buffer.from(input).toString('base64url');
}

// Gera token: base64url(payload).base64url(hmac)
function signToken(payload, ttlSeconds = TTL_PADRAO_S) {
  const secret = getSecret();
  const agora = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: agora, exp: agora + ttlSeconds };
  const data = b64url(JSON.stringify(body));
  const sig = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  return `${data}.${sig}`;
}

// Verifica assinatura e expiracao. Retorna o payload ou null.
function verifyToken(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  let secret;
  try { secret = getSecret(); } catch { return null; }

  const [data, sig] = token.split('.');
  if (!data || !sig) return null;

  const esperado = crypto.createHmac('sha256', secret).update(data).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(esperado);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let body;
  try {
    body = JSON.parse(Buffer.from(data, 'base64url').toString('utf8'));
  } catch {
    return null;
  }

  const agora = Math.floor(Date.now() / 1000);
  if (!body.exp || body.exp < agora) return null;

  return body;
}

// Le o valor de um cookie pelo header bruto.
function lerCookie(headerCookie, nome) {
  if (!headerCookie) return null;
  const partes = headerCookie.split(';');
  for (const p of partes) {
    const [k, ...v] = p.trim().split('=');
    if (k === nome) return decodeURIComponent(v.join('='));
  }
  return null;
}

module.exports = { signToken, verifyToken, lerCookie, SESSAO_TTL_S: TTL_PADRAO_S };
