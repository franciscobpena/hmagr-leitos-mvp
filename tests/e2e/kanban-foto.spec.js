/**
 * E2E Playwright: pipeline foto→OCR HMAGR (CA-E2E)
 * Moca /api/extract → upload fixture → review → Gravar → confirma payload upsert
 *
 * NÃO chama Anthropic real nem escreve no Supabase real.
 * Verifica:
 *  - CA-01.1: HEIC rejeitado com mensagem PT-BR
 *  - CA-04.1: re-upload da mesma foto → dedup bloqueia
 *  - CA-E2E: upload → review → gravar → payload correto capturado
 */
const { test, expect } = require('@playwright/test');
const path = require('path');
const mockResponse = require('../fixtures/mock-extract-response.json');

// Fixture: Kaban clinica cirurgica 1.jpeg (arquivo real disponível)
const FIXTURE_PATH = path.resolve(
  __dirname,
  '../../../../Francisco Projetos/second_brain_md_package/00-Inbox/hmagr/Kaban clinica cirurgica 1.jpeg'
);

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

    // Mock upsert Supabase (internacoes_hmsa)
    await page.route('**/rest/v1/internacoes_hmsa**', async (route) => {
      if (route.request().method() === 'POST') {
        // Captura payload e retorna sucesso
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify([{ id: 'HMAGR_int_CC1-01' }])
        });
        return;
      }
      await route.continue();
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

  test('CA-E2E — upload fixture → review → Gravar → payload capturado', async ({ page }) => {
    let capturedPayloads = [];

    // Intercepta o POST em internacoes_hmsa para capturar o payload
    await page.route('**/rest/v1/internacoes_hmsa**', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        if (Array.isArray(body)) capturedPayloads = body;
        else capturedPayloads = [body];
        await route.fulfill({
          status: 201,
          contentType: 'application/json',
          body: JSON.stringify(capturedPayloads.map((_, i) => ({ id: `HMAGR_int_test_${i}` })))
        });
        return;
      }
      await route.continue();
    });

    // Upload da foto fixture real
    const input = page.locator('#kf-upload-input');
    await input.setInputFiles(FIXTURE_PATH);

    // Aguarda tela de revisão aparecer
    await expect(page.locator('#kf-review-section')).toBeVisible({ timeout: 15_000 });

    // CA-03.4: botão Gravar habilitado (nenhum campo essencial com ❓)
    const btnGravar = page.locator('#kf-btn-gravar');
    await expect(btnGravar).toBeEnabled({ timeout: 5_000 });

    // Clicar Gravar SEM editar nada
    await btnGravar.click();

    // Aguarda confirmação de sucesso
    await expect(page.locator('#kf-success-msg')).toBeVisible({ timeout: 10_000 });

    // Verifica payload capturado
    expect(capturedPayloads.length).toBeGreaterThan(0);
    const firstPayload = capturedPayloads[0];
    expect(firstPayload.hospital).toBe('HMAGR');
    expect(firstPayload.fonte_criacao).toBe('migracao_planilha');
    expect(firstPayload.status_internacao).toBe('ativa');
    expect(firstPayload.id).toMatch(/^HMAGR_int_/);
    // CA-05.2: status de cor NÃO deve estar no payload
    expect(firstPayload).not.toHaveProperty('status', 'verde');
    expect(firstPayload).not.toHaveProperty('status', 'amarelo');
    expect(firstPayload).not.toHaveProperty('status', 'vermelho');
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
});
