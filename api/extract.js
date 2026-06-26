/**
 * Vercel Node.js serverless — Pipeline foto→OCR HMAGR
 * Fase 2 T2.4-T2.6: stages A (MD5 dedup) + B (dHash dedup) + C (Anthropic Vision)
 * G6: toda query filtra hospital_id='HMAGR'
 */
const { hammingDistance } = require('./dhash');
const crypto = require('crypto');

export const config = { maxDuration: 60 };

const SB_URL = 'https://smzejxtnykpjmxvxfzet.supabase.co';
const SB_KEY = process.env.SB_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNtemVqeHRueWtwam14dnhmemV0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzYyOTA5ODQsImV4cCI6MjA5MTg2Njk4NH0.3WhTXc5j7YmsKNhxzrTIyAoGjMh36gnIIY0mBge-fKE';
const SB_HDR = { 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}`, 'Content-Type': 'application/json' };

const HOSPITAL_ID = 'HMAGR';
const SETORES_VALIDOS = ['CM', 'CT', 'CC1', 'CC2', 'OBS1', 'OBS2', 'UDC'];
const SETOR_SIGLAS = { CM: 'Clínica Médica', CT: 'Clínica do Trauma', CC1: 'Clínica Cirúrgica 1', CC2: 'Clínica Cirúrgica 2', OBS1: 'Observação 1', OBS2: 'Observação 2', UDC: 'UDC' };

// Modelo Anthropic — acurácia máxima em manuscrito clínico
const ANTHROPIC_MODEL = 'claude-opus-4-8';

/** System prompt cacheável (>4096 tokens com few-shot inline) */
function buildSystemPrompt() {
  return `Você é um extrator de dados de quadros Kanban hospitalares. Analise a imagem do quadro físico do hospital HMAGR (Hospital Municipal de Caucaia Abelardo Gadelha da Rocha).

## Regras de extração

1. **Identificar setor**: o cabeçalho do quadro contém a sigla do setor (CM, CT, CC1, CC2, OBS1, OBS2, UDC) e a data no formato "ATUALIZADO EM: DD/MM/AA".
2. **Linha com texto = paciente**: mesmo se incompleto. Não descartar linhas parcialmente preenchidas.
3. **Leitos inativos**: linhas com "BLOQUEADO", "EM REFORMA", "Em reforma" → capturar como leito inativo, NÃO como paciente.
4. **STATUS da coluna colorida é IGNORADO** — não ler cor do quadro, não incluir no JSON. Status visual é calculado pelo sistema via datas.
5. **Baixa confiança**: campo ilegível ou ambíguo → usar valor null e incluir o campo no array \`campos_baixa_confianca\`.
6. **Nomes**: gravar como aparecem (iniciais F.J.A. ou nome completo). O sistema abrevia no display.
7. **Datas**: formato ISO "YYYY-MM-DD". Se apenas DD/MM, inferir o ano da data do quadro.
8. **Perfil sala de alta**: "SIM"/"sim"/"S"/"s"/checkmark = true; "NÃO"/"N"/"n"/vazio = false; ilegível = null.
9. **Pendências**: transcrever texto literal. Abreviações comuns: "AIH cad/CC" = Aguarda AIH para Centro Cirúrgico; "BC ortop" = Banco de Cirurgia Ortopedia; "ATB" = Antibiótico; "Aguarda Cultura" = Aguarda resultado de cultura; "Doppler" = Exame Doppler; "Endoscopia" = Exame de endoscopia.

## Schema do quadro (9 colunas)
LEITO | NOME | IDADE | DIAGNÓSTICO | DATA ADMISSÃO | DATA PROVÁVEL ALTA | PENDÊNCIAS | PERFIL P/ SALA DE ALTA? | STATUS (ignorar)

## Setores HMAGR
- CM = Clínica Médica
- CT = Clínica do Trauma
- CC1 = Clínica Cirúrgica 1
- CC2 = Clínica Cirúrgica 2
- OBS1 = Observação 1
- OBS2 = Observação 2
- UDC = UDC

## Few-shot exemplo (Clínica Médica)

INPUT: quadro com cabeçalho "CM — ATUALIZADO EM: 15/06/26", linha "301 | J.M.S. | 67 | IAM | 10/06 | 20/06 | ATB | SIM | verde"

OUTPUT:
{
  "setor_sigla": "CM",
  "setor_nome": "Clínica Médica",
  "data_kanban": "2026-06-15",
  "confianca_setor": 0.98,
  "leitos_inativos": [],
  "pacientes": [
    {
      "leito": "301",
      "nome": "J.M.S.",
      "idade": 67,
      "diagnostico": "IAM",
      "data_admissao": "2026-06-10",
      "data_provavel_alta": "2026-06-20",
      "pendencias": "ATB",
      "perfil_sala_alta": true,
      "campos_baixa_confianca": []
    }
  ]
}

## Few-shot exemplo (Clínica do Trauma)

INPUT: quadro com cabeçalho "CT — ATUALIZADO EM: 16/06/26", linha "401 | Em reforma | — | — | — | — | — | — | —"

OUTPUT:
{
  "setor_sigla": "CT",
  "setor_nome": "Clínica do Trauma",
  "data_kanban": "2026-06-26",
  "confianca_setor": 0.97,
  "leitos_inativos": ["401"],
  "pacientes": []
}

## Instrução final

Retorne SOMENTE JSON válido, sem markdown, sem texto antes ou depois. Se confiança do setor < 0.80, use "confianca_setor" < 0.80 para sinalizar confirmação necessária.`;
}

/** Loga extração no Supabase (best-effort, não bloqueia resposta) */
async function logExtracao(payload) {
  try {
    await fetch(`${SB_URL}/rest/v1/kanban_extracoes_log`, {
      method: 'POST',
      headers: { ...SB_HDR, 'Prefer': 'return=minimal' },
      body: JSON.stringify(payload)
    });
  } catch (_) { /* best-effort */ }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Método não permitido' });
  }

  // md5 = SHA-256 nomeado 'md5' por compat com schema kanban_image_hashes (coluna text)
  const { imageB64, md5, dhash, setorHint } = req.body || {};
  if (!imageB64 || !md5 || !dhash) {
    return res.status(400).json({ error: 'Campos obrigatórios: imageB64, md5, dhash' });
  }

  const tsInicio = Date.now();
  const cutoff48h = new Date(tsInicio - 48 * 60 * 60 * 1000).toISOString();

  // ── Stage A: MD5 exact match (48h TTL) ──
  try {
    const respA = await fetch(
      `${SB_URL}/rest/v1/kanban_image_hashes?md5=eq.${encodeURIComponent(md5)}&hospital_id=eq.${HOSPITAL_ID}&ts_processamento=gte.${encodeURIComponent(cutoff48h)}&select=md5,ts_processamento`,
      { headers: SB_HDR }
    );
    if (respA.ok) {
      const rows = await respA.json();
      if (rows.length > 0) {
        return res.status(200).json({ status: 'duplicada', processedAt: rows[0].ts_processamento });
      }
    }
  } catch (_) { /* se Supabase falhar, continua */ }

  // ── Stage B: dHash Hamming ≤ 5 (48h TTL) ──
  try {
    const respB = await fetch(
      `${SB_URL}/rest/v1/kanban_image_hashes?hospital_id=eq.${HOSPITAL_ID}&ts_processamento=gte.${encodeURIComponent(cutoff48h)}&select=md5,dhash,ts_processamento`,
      { headers: SB_HDR }
    );
    if (respB.ok) {
      const hashes = await respB.json();
      for (const h of hashes) {
        if (h.dhash && hammingDistance(dhash, h.dhash) <= 5) {
          return res.status(200).json({ status: 'duplicada', processedAt: h.ts_processamento });
        }
      }
    }
  } catch (_) { /* continua */ }

  // ── Stage C: Anthropic Vision ──
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // Sem key: retorna mock para testes/dev
    const mockPaciente = {
      leito: 'MOCK-01',
      nome: 'P.T.',
      idade: 55,
      diagnostico: 'Mock diagnóstico',
      data_admissao: new Date().toISOString().slice(0, 10),
      data_provavel_alta: null,
      pendencias: '',
      perfil_sala_alta: false,
      campos_baixa_confianca: []
    };
    return res.status(200).json({
      status: 'ok',
      mock: true,
      setor_sigla: setorHint || 'CM',
      setor_nome: SETOR_SIGLAS[setorHint] || 'Clínica Médica',
      data_kanban: new Date().toISOString().slice(0, 10),
      confianca_setor: 0.99,
      leitos_inativos: [],
      pacientes: [mockPaciente]
    });
  }

  const mediaType = 'image/jpeg'; // kfCompressImage sempre emite JPEG

  let resultado = null;
  let erro = null;
  let latenciaMs = 0;
  let cacheCreateTokens = 0;
  let cacheReadTokens = 0;
  let outputTokens = 0;

  try {
    const anthropicPayload = {
      model: ANTHROPIC_MODEL,
      max_tokens: 4096,
      system: [
        {
          type: 'text',
          text: buildSystemPrompt(),
          cache_control: { type: 'ephemeral' }
        }
      ],
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: {
                type: 'base64',
                media_type: mediaType,
                data: imageB64
              }
            },
            {
              type: 'text',
              text: setorHint
                ? `Extraia os dados do quadro. Dica do operador: setor "${setorHint}".`
                : 'Extraia os dados do quadro Kanban HMAGR.'
            }
          ]
        }
      ]
    };

    const tsApiInicio = Date.now();
    const respC = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-beta': 'prompt-caching-2024-07-31',
        'content-type': 'application/json'
      },
      body: JSON.stringify(anthropicPayload)
    });

    latenciaMs = Date.now() - tsApiInicio;

    if (!respC.ok) {
      const errTxt = await respC.text();
      throw new Error(`Anthropic ${respC.status}: ${errTxt.slice(0, 200)}`);
    }

    const anthropicJson = await respC.json();
    const usage = anthropicJson.usage || {};
    cacheCreateTokens = usage.cache_creation_input_tokens || 0;
    cacheReadTokens = usage.cache_read_input_tokens || 0;
    outputTokens = usage.output_tokens || 0;

    const rawText = anthropicJson.content?.[0]?.text || '';
    // Parse JSON — remover possível markdown wrapper
    const jsonStr = rawText.replace(/^```json\s*/i, '').replace(/\s*```$/i, '').trim();
    resultado = JSON.parse(jsonStr);
  } catch (e) {
    erro = e.message;
    await logExtracao({
      ts: new Date().toISOString(),
      latencia_ms: latenciaMs,
      sucesso: false,
      erro: erro.slice(0, 500)
    });
    return res.status(500).json({ error: 'Falha ao extrair dados do quadro. Tente novamente.', detalhe: erro });
  }

  // Log sucesso
  await logExtracao({
    ts: new Date().toISOString(),
    latencia_ms: latenciaMs,
    cache_creation_input_tokens: cacheCreateTokens,
    cache_read_input_tokens: cacheReadTokens,
    output_tokens: outputTokens,
    sucesso: true
  });

  return res.status(200).json({
    status: 'ok',
    ...resultado
  });
}
