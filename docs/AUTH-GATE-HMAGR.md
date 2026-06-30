# Gate de login HMAGR — handoff (port do mecanismo HMSA)

Status: **construído + testado (57/57) + revisado (88/100, passa) — NÃO deployado.** Em branch `feat/auth-gate`. Prod (`hmagr-leitos.vercel.app`) segue **aberto** até o merge na `main`.

## Por que existe
O app exibe dado de paciente com acesso aberto. Este gate exige e-mail institucional + senha compartilhada + aceite de termo de confidencialidade antes de liberar o painel. Espelha o login do HMSA (22/jun). Spec base: `00-Inbox/files/SPEC-AUTH-HMSA.md` no vault.

## Limite de segurança (declarado)
Protege a **INTERFACE**, não o **DADO**. A anon key segue no client (`index.html`) e as leituras Supabase continuam abertas a quem inspeciona a rede (S1). Proteção real = RLS exigindo sessão (backlog "Isolamento real de tenant via RLS").

## Decisões (Maestro, 29/jun)
- Acesso por **domínio institucional** (env `AUTH_EMAIL_DOMAIN`) + senha **`lean`**.
- Trilha de aceite na tabela Supabase `acesso_aceite_log` (RLS insert-only pro anon; sem service key).
- Backdoor master (`bahiapenafrancisco@gmail.com` + `MASTER_PASSWORD`) mantido.
- Login como página `/login.html` separada; contato de solicitação = `bahiapenafrancisco@gmail.com` (Gmail compose).

## Peças (CommonJS — o repo não usa type:module)
`lib/token.js` (HMAC 12h) · `api/auth/{login,verify,accept}.js` · `auth-guard.js` (1º script do `index.html`) · `login.html` · trilha em `acesso_aceite_log`. Cookies `hmagr_session` / `hmagr_accept`. Testes: `tests/unit/{token,auth-login}.test.js`.

## PRA IR PRO AR (ordem)
1. **Definir o domínio institucional** do HMAGR (sufixo do e-mail do staff).
2. Setar env no Vercel (projeto `hmagr-leitos-mvp`, prod): `AUTH_SECRET` (≥16 chars aleatório), `LEAN_SHARED_PASSWORD=lean`, `MASTER_PASSWORD=lean`, `AUTH_EMAIL_DOMAIN=@<dominio>`.
3. **Merge `feat/auth-gate` → `main`** (push main = deploy auto prod = **gateia o app live**).
4. Smoke prod: `curl /api/auth/login` (200 domínio+lean · 401 fora/senha errada · cookie HttpOnly+Secure+SameSite=Strict+Max-Age=43200); abrir o app sem sessão → cai em `/login.html`; aceite grava linha em `acesso_aceite_log`.

Sem `AUTH_EMAIL_DOMAIN` setado: login institucional fica fail-closed (só o master entra) — seguro, mas staff não acessa até configurar.

## Achado lateral (separado, não tratado)
Advisor Supabase: 16 tabelas com RLS desabilitado (incl. backups com dado de paciente) expostas via anon key. Da família do S1; decidir em separado.
