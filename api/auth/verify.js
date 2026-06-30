// api/auth/verify.js  (CommonJS)
// GET. Le o cookie de sessao e diz se esta autenticado + se aceitou o termo.
// Usado pelo auth-guard.js no carregamento de cada pagina protegida.

const { verifyToken, lerCookie } = require('../../lib/token');

module.exports = function handler(req, res) {
  const token = lerCookie(req.headers.cookie, 'hmagr_session');
  const sessao = token ? verifyToken(token) : null;

  if (!sessao) {
    return res.status(401).json({ authenticated: false });
  }

  const aceite = lerCookie(req.headers.cookie, 'hmagr_accept') === '1';
  return res.status(200).json({ authenticated: true, email: sessao.email, aceite });
};
