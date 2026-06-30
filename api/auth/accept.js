// api/auth/accept.js  (CommonJS)
// POST. Registra o aceite do termo de confidencialidade e marca a sessao como liberada.
// Trilha: console.log (Vercel) SEMPRE + INSERT na tabela Supabase acesso_aceite_log.
// A tabela tem RLS com policy de INSERT pro anon (append-only, nao legivel) — por isso
// a anon key publica basta aqui; nao precisa de service key.

const { verifyToken, lerCookie, SESSAO_TTL_S } = require('../../lib/token');

const VERSAO_TERMO = 'AVISO_CONFIDENCIALIDADE_LGPD_v1';
const HOSPITAL_ID = 'HMAGR';

// Mesma URL + anon key publica do app (api/extract.js). Anon key e' publica por design.
const SB_URL = 'https://smzejxtnykpjmxvxfzet.supabase.co';
const SB_KEY = process.env.SB_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtemVqeHRueWtwam14dnhmemV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyOTA5ODQsImV4cCI6MjA5MTg2Njk4NH0.3WhTXc5j7YmsKNhxzrTIyAoGjMh36gnIIY0mBge-fKE';

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Metodo nao permitido' });
  }

  const token = lerCookie(req.headers.cookie, 'hmagr_session');
  const sessao = token ? verifyToken(token) : null;
  if (!sessao) {
    return res.status(401).json({ ok: false, error: 'Sessao invalida ou expirada' });
  }

  const registro = {
    email: sessao.email,
    aceite_em: new Date().toISOString(),
    ip: req.headers['x-forwarded-for'] || (req.socket && req.socket.remoteAddress) || 'desconhecido',
    user_agent: req.headers['user-agent'] || 'desconhecido',
    termo: VERSAO_TERMO,
    hospital: HOSPITAL_ID
  };

  // Trilha minima (consultavel nos logs do Vercel).
  console.log('[ACEITE_TERMO]', JSON.stringify(registro));

  // Trilha duravel na tabela acesso_aceite_log (nao bloqueia o acesso se falhar).
  try {
    const r = await fetch(`${SB_URL}/rest/v1/acesso_aceite_log`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SB_KEY,
        'Authorization': `Bearer ${SB_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(registro)
    });
    // Falha de INSERT (schema/RLS) nao bloqueia o acesso, mas deixa rastro detectavel.
    if (!r.ok) {
      const corpo = await r.text().catch(() => '');
      console.error('[ACEITE_TERMO] Supabase status:', r.status, corpo);
    }
  } catch (e) {
    console.error('[ACEITE_TERMO] falha ao persistir no Supabase:', e && e.message);
  }

  // Marca o aceite para esta sessao.
  res.setHeader('Set-Cookie', [
    `hmagr_accept=1; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${SESSAO_TTL_S}`
  ]);

  return res.status(200).json({ ok: true });
};
