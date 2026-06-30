// api/auth/login.js  (CommonJS — o repo nao usa type:module)
// POST { email, password }
// Regra: email com sufixo do dominio institucional (AUTH_EMAIL_DOMAIN) E senha == LEAN_SHARED_PASSWORD.
// Sucesso: grava cookie de sessao httpOnly assinado. Falha: 401 (mensagem unica).

const { signToken, SESSAO_TTL_S } = require('../../lib/token');

// Dominio institucional do HMAGR via env (ex: AUTH_EMAIL_DOMAIN='@isgh.org.br').
// Sem env configurado o login institucional fica FAIL-CLOSED (so o master entra) —
// proposital pra nao liberar acesso amplo antes do dominio ser definido.
const DOMINIO_AUTORIZADO = (process.env.AUTH_EMAIL_DOMAIN || '').trim().toLowerCase();

// Convidados externos (fora do dominio), liberados caso a caso. Vazio no piloto HMAGR.
const EMAILS_CONVIDADOS = [];

// Usuario master (Francisco): bypassa dominio + senha compartilhada. Senha de MASTER_PASSWORD
// (env), fallback fixo 'lean' por decisao do dono pra o piloto funcionar sem config.
const MASTER_EMAIL = 'bahiapenafrancisco@gmail.com';
const MASTER_PASSWORD = process.env.MASTER_PASSWORD || 'lean';

// Le o corpo JSON de forma defensiva (cobre runtimes que nao pre-parseiam).
async function lerJson(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch { return {}; }
  }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const raw = Buffer.concat(chunks).toString('utf8');
  try { return JSON.parse(raw); } catch { return {}; }
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Metodo nao permitido' });
  }

  const { email, password } = await lerJson(req);

  const emailNorm = typeof email === 'string' ? email.trim().toLowerCase() : '';
  const senhaStr = typeof password === 'string' ? password : '';

  // Regra master: avaliada antes do fluxo institucional.
  const ehMaster = emailNorm === MASTER_EMAIL && senhaStr === MASTER_PASSWORD;

  if (!ehMaster) {
    const senhaCompartilhada = process.env.LEAN_SHARED_PASSWORD;
    if (!senhaCompartilhada) {
      // Sem fallback hardcoded da senha compartilhada por seguranca.
      return res.status(500).json({ ok: false, error: 'Configuracao de acesso ausente no servidor' });
    }
    const dominioOk =
      (DOMINIO_AUTORIZADO && emailNorm.endsWith(DOMINIO_AUTORIZADO)) ||
      EMAILS_CONVIDADOS.includes(emailNorm);
    const senhaOk = senhaStr === senhaCompartilhada;
    if (!dominioOk || !senhaOk) {
      // Mensagem unica para nao revelar qual campo falhou.
      return res.status(401).json({ ok: false, error: 'E-mail institucional ou senha invalidos' });
    }
  }

  const token = signToken({ email: emailNorm, master: ehMaster });
  res.setHeader('Set-Cookie', [
    `hmagr_session=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSAO_TTL_S}`
  ]);

  return res.status(200).json({ ok: true, email: emailNorm, master: ehMaster });
};
