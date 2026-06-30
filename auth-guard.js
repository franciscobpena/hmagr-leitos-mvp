// auth-guard.js
// PRIMEIRO script no <head> do index.html:
//   <script src="/auth-guard.js"></script>
//
// LIMITE: este guard protege a INTERFACE, nao o DADO. O painel le o Supabase direto do
// browser com a anon key (S1). Protecao real do dado = RLS no Supabase exigindo sessao,
// ou proxy via /api. Ver SPEC-AUTH-HMAGR (limite de seguranca).

(function () {
  // Esconde a pagina ate confirmar a sessao, para nao piscar conteudo.
  var raiz = document.documentElement;
  raiz.style.visibility = 'hidden';

  function irParaLogin() {
    window.location.replace('/login.html');
  }

  fetch('/api/auth/verify', { credentials: 'same-origin' })
    .then(function (r) { return r.ok ? r.json() : { authenticated: false }; })
    .then(function (d) {
      if (d && d.authenticated && d.aceite) {
        raiz.style.visibility = '';
      } else {
        // Sem sessao, ou sessao sem aceite do termo: volta para o login.
        irParaLogin();
      }
    })
    .catch(irParaLogin);
})();
