/**
 * E2E Playwright: pipeline foto→OCR HMAGR (CA-E2E)
 * Moca /api/extract → upload fixture → review → Gravar → confirma payload upsert
 *
 * NÃO chama Anthropic real nem escreve no Supabase real.
 * O DB (internacoes_hmsa) também é mockado intencionalmente — a confirmação de
 * persistência via SQL real é smoke manual pré-deploy (roda o Maestro após
 * ANTHROPIC_API_KEY configurada no Vercel e deploy feito).
 *
 * [Fase 2 — reconciliação foto-OCR, 2026-07-01] PENDENTE DE EXECUÇÃO nesta sessão: o
 * auth-guard.js do index.html exige `/api/auth/verify` real (função serverless Vercel) pra
 * exibir a página — sem `vercel dev` rodando (não disponível nesta sessão, ver
 * playwright.config.js "Sem webServer — Maestro sobe o servidor antes dos testes E2E"),
 * nenhum teste deste arquivo roda localmente. Escrito e revisado por leitura, não executado.
 * Rodar via `npx playwright test` numa sessão com o servidor Vercel de pé.
 *
 * Verifica:
 *  - CA-01.1: HEIC rejeitado com mensagem PT-BR
 *  - CA-04.1: re-upload da mesma foto → dedup bloqueia
 *  - CA-08.1/T4: read-before-write — GET internacoes_hmsa antes de qualquer escrita
 *  - CA-12.1/CA-12.2/T13: modo sombra — Gravar NÃO escreve em internacoes_hmsa, loga decisão
 *  - CA-03.4: Gravar desabilitado com campo essencial ❓
 *  - CA-07.1: hit-target ≥ 44px (mobile)
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const mockResponse = require('../fixtures/mock-extract-response.json');

// Fixture local copiada para o repo — não depende de path absoluto externo
const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/kanban-foto-fixture.jpeg');

test.describe('Kanban Foto OCR — HMAGR', () => {
  test.beforeEach(async ({ page }) => {
    // Mock /api/extract para não chamar Anthropic
    await page.route('**/api/extract', async (route) => {
      const body = route.request().postDataJSON() || {};
      // Simula dedup se md5 = 'DEDUP_TEST_MD5'
      if (body.md5 === 'DEDUP_TEST_MD5') {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ status: 'duplicada', processedAt: '2026-06-26T07:00:00Z' })
        });
        return;
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockResponse)
      });
    });

    // Mock internacoes_hmsa: GET (T4 read-before-write) sempre "leito vazio" (sem
    // ocupante ativo) por default; POST/PATCH (aplicação real, gateada por
    // KF_RECONCILE_MODO_REAL=false nesta entrega) confirmam sucesso se ocorrerem.
    await page.route('**/rest/v1/internacoes_hmsa**', async (route) => {
      const method = route.request().method();
      if (method === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return;
      }
      await route.fulfill({
        status: 201,
        contentType: 'application/json',
        body: JSON.stringify([{ id: 'HMAGR_ocr_CC1-01_test' }])
      });
    });

    // Mock kanban_reconcile_pendencias (T10/T13 — fila de pendências, tabela nova ainda
    // não aplicada em prod; mock só evita depender de rede real durante o teste).
    await page.route('**/rest/v1/kanban_reconcile_pendencias**', async (route) => {
      await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    });

    // Mock kanban_snapshots
    await page.route('**/rest/v1/kanban_snapshots**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify([{ id: 'snapshot-uuid-test' }])
        });
        return;
      }
      // GET para dedup semântico — retorna vazio (sem snapshot anterior)
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify([])
      });
    });

    // Mock kanban_image_hashes
    await page.route('**/rest/v1/kanban_image_hashes**', async (route) => {
      if (route.request().method() === 'POST') {
        await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
    });

    await page.goto('/#/kanban/foto');
    await page.waitForSelector('#view-kanban-foto', { state: 'visible', timeout: 10_000 });
  });

  test('CA-01.1 — HEIC rejeitado com microcopy PT-BR', async ({ page }) => {
    // Cria arquivo fake com extensão .heic
    const heicFile = {
      name: 'foto.heic',
      mimeType: 'image/heic',
      buffer: Buffer.from('fake heic data')
    };

    const input = page.locator('#kf-upload-input');
    await input.setInputFiles({
      name: heicFile.name,
      mimeType: heicFile.mimeType,
      buffer: heicFile.buffer
    });

    // Mensagem de erro deve aparecer com texto PT-BR coloquial (sem "HEIC format not supported")
    await expect(page.locator('#kf-error')).toBeVisible({ timeout: 3_000 });
    const errorText = await page.locator('#kf-error').textContent();
    expect(errorText).toMatch(/câmera|câmera padrão|JPG|converte/i);
    expect(errorText).not.toMatch(/HEIC format not supported/i);
  });

  test('CA-08.1/T4 — read-before-write: GET internacoes_hmsa antes de Gravar escrever', async ({ page }) => {
    let getCalls = [];
    let writeCalls = [];
    await page.route('**/rest/v1/internacoes_hmsa**', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        getCalls.push(req.url());
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return;
      }
      writeCalls.push({ method: req.method(), body: req.postDataJSON() });
      await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    });

    const input = page.locator('#kf-upload-input');
    await input.setInputFiles(FIXTURE_PATH);
    await expect(page.locator('#kf-review-section')).toBeVisible({ timeout: 15_000 });

    const btnGravar = page.locator('#kf-btn-gravar');
    await expect(btnGravar).toBeEnabled({ timeout: 5_000 });
    await btnGravar.click();
    await expect(page.locator('#kf-success-msg')).toBeVisible({ timeout: 10_000 });

    // CA-08.1: GET aconteceu, filtrado por leito+hospital+status_internacao=ativa
    expect(getCalls.length).toBeGreaterThan(0);
    expect(getCalls[0]).toMatch(/hospital=eq\.HMAGR/);
    expect(getCalls[0]).toMatch(/status_internacao=eq\.ativa/);
  });

  test('CA-12.1/CA-12.2/T13 — modo sombra: Gravar NÃO escreve em internacoes_hmsa', async ({ page }) => {
    let writeCalls = [];
    let consoleLogs = [];
    page.on('console', (msg) => { if (msg.text().includes('kf-reconcile')) consoleLogs.push(msg.text()); });
    await page.route('**/rest/v1/internacoes_hmsa**', async (route) => {
      const req = route.request();
      if (req.method() === 'GET') {
        await route.fulfill({ status: 200, contentType: 'application/json', body: '[]' });
        return;
      }
      writeCalls.push({ method: req.method(), body: req.postDataJSON() });
      await route.fulfill({ status: 201, contentType: 'application/json', body: '[]' });
    });

    const input = page.locator('#kf-upload-input');
    await input.setInputFiles(FIXTURE_PATH);
    await expect(page.locator('#kf-review-section')).toBeVisible({ timeout: 15_000 });

    const btnGravar = page.locator('#kf-btn-gravar');
    await expect(btnGravar).toBeEnabled({ timeout: 5_000 });
    await btnGravar.click();
    await expect(page.locator('#kf-success-msg')).toBeVisible({ timeout: 10_000 });

    // CA-12.1: nenhuma escrita real em internacoes_hmsa (KF_RECONCILE_MODO_REAL=false default)
    expect(writeCalls.length).toBe(0);
    // CA-12.2: log estruturado com contagem de inseridos/atualizados/sugestões/giros/revisões
    expect(consoleLogs.length).toBeGreaterThan(0);
    expect(consoleLogs[0]).toMatch(/"modo":"sombra"/);
    // UX: mensagem de sucesso reflete modo sombra (não afirma "gravado" quando não gravou)
    const msg = await page.locator('#kf-success-msg').textContent();
    expect(msg).toMatch(/modo sombra/i);
  });

  test('CA-04.1 — re-upload detectado como duplicata (dedup UI)', async ({ page }) => {
    // Simula: a API retorna 'duplicada' para qualquer upload
    await page.route('**/api/extract', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ status: 'duplicada', processedAt: '2026-06-26T07:00:00Z' })
      });
    });

    const input = page.locator('#kf-upload-input');
    await input.setInputFiles(FIXTURE_PATH);

    // Mensagem de dedup deve aparecer
    await expect(page.locator('#kf-dedup-msg')).toBeVisible({ timeout: 10_000 });
    const msg = await page.locator('#kf-dedup-msg').textContent();
    expect(msg).toMatch(/já processada|07:00|Nada a fazer/i);

    // Tela de revisão NÃO deve aparecer
    await expect(page.locator('#kf-review-section')).not.toBeVisible();
  });

  test('CA-03.4 — Gravar desabilitado com campo essencial ❓', async ({ page }) => {
    // Mock com leito = null (campo essencial ausente)
    const mockComLeitoNull = {
      ...mockResponse,
      pacientes: [
        {
          ...mockResponse.pacientes[0],
          leito: null,
          campos_baixa_confianca: ['leito']
        }
      ]
    };

    await page.route('**/api/extract', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(mockComLeitoNull)
      });
    });

    const input = page.locator('#kf-upload-input');
    await input.setInputFiles(FIXTURE_PATH);

    await expect(page.locator('#kf-review-section')).toBeVisible({ timeout: 10_000 });

    // CA-03.4: botão Gravar deve estar desabilitado enquanto há ❓ em campo essencial
    const btnGravar = page.locator('#kf-btn-gravar');
    await expect(btnGravar).toBeDisabled({ timeout: 5_000 });
  });

  test('CA-07.1 — mobile-first: hit-target ≥ 44px', async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 }); // iPhone SE

    // Upload input wrapper deve ter área clicável adequada
    const uploadBtn = page.locator('#kf-upload-btn');
    const box = await uploadBtn.boundingBox();
    if (box) {
      expect(box.height).toBeGreaterThanOrEqual(44);
    }
  });

  // ── T5/T11 — pendentes de verdade, não escritos como teste real ──
  // Motivo: (a) dependem de kanban_reconcile_pendencias/campos_travados/leito_status,
  // colunas/tabela ainda não aplicadas (docs/migrations/2026-07-01-reconciliacao-ocr-hmagr.sql);
  // (b) "resolver giro via chip" depende do chip de UI (T16/T17), fora de escopo desta entrega
  // (T4/T5/T10/T11/T13/T14). kfResolverGiroPendencia/kfConfirmarGiro (index.html) existem e são
  // chamáveis diretamente, mas não há gatilho de UI ainda pra um teste de clique real fazer sentido.
  test.skip('T5 — giro confirmado invalida overrides do idEpisodio anterior (CA-08.3)', async ({ page }) => {
    // TODO (próxima chamada, após T0 aplicado): mockar kanban_reconcile_pendencias com 1 linha
    // tipo='giro', chamar kfResolverGiroPendencia(id) via page.evaluate, confirmar motivo no
    // modal, assert KaizenAPI.resetLeitoOverride foi chamado com o id_episodio antigo.
  });

  test.skip('T11 — resolver giro via chip exige giro_motivo antes de admitir novo paciente (CA-09.3/CA-13.4)', async ({ page }) => {
    // TODO (chamada do chip, T16/T17): clicar no chip "Dar baixa" do bed-card, confirmar que o
    // modal reusado (#acao-modal) exige seleção de giro_motivo antes de habilitar a confirmação.
  });
});
