/**
 * WOM Analytics Workbench — servidor
 * -----------------------------------
 * - Sirve el frontend estático (carpeta /public).
 * - Expone POST /api/analyze como PROXY a la API de Anthropic.
 *   La API key vive SOLO aquí (en el servidor), nunca en el navegador.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_FILAS_IA = parseInt(process.env.MAX_FILAS_IA || '5000', 10);
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
//  Prompt de sistema: define QUÉ hace la IA y el CONTRATO JSON exacto de salida
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `Eres un analista de datos senior del equipo de canales remotos y digitales de WOM Colombia. Tu especialidad es el canal de autoatención por WhatsApp: funnels de conversión, portabilidad, activaciones, OTP/NIP, costos y desempeño comercial.

Recibirás cuatro cosas:
1. La SOLICITUD del usuario en lenguaje natural (qué análisis quiere).
2. El ESQUEMA detectado del archivo (columnas y tipo de dato).
3. Un RESUMEN ESTADÍSTICO calculado sobre el 100% de las filas.
4. Una MUESTRA de datos crudos en formato CSV.

Tu trabajo es interpretar la solicitud, modelar los datos y devolver un análisis accionable.

REGLAS CRÍTICAS:
- Responde ÚNICAMENTE con un objeto JSON válido. Sin markdown, sin explicaciones, sin \`\`\`json, sin texto antes o después.
- Usa EXCLUSIVAMENTE los datos entregados. Nunca inventes cifras. Si un cálculo requiere datos que no están, dilo con honestidad en "resumen_ejecutivo" y en un diagnóstico de nivel "info".
- Si el resumen estadístico y la muestra difieren en tamaño (archivo truncado), basa los agregados en el RESUMEN ESTADÍSTICO, que cubre el 100% de las filas.
- Responde en el MISMO idioma de la solicitud del usuario (si escribe en inglés, responde en inglés).
- Cuando la solicitud implique una comparación (ej. "mayo vs junio", "antes/después"), prioriza gráficas comparativas y KPIs con variación (delta).
- Si los datos incluyen filas de subtotal/total (p. ej. una columna de periodo con valor "Total"), EXCLÚYELAS de todo cálculo y no las trates como un día o categoría más.
- Para un funnel, calcula la conversión paso a paso (cada etapa dividida por la etapa anterior) y compárala entre periodos. La vista más útil suele ser una gráfica de barras agrupadas con la conversión por etapa (periodo A vs B), más una línea con la tendencia diaria de la etapa donde esté el cuello de botella. Señala explícitamente en qué etapa se abre la mayor caída.
- Si un periodo está incompleto (menos días que el otro), NO compares totales absolutos directamente; usa tasas de conversión, promedios diarios o alineación por día del mes, y adviértelo.
- Interpreta bien la semántica de cada métrica: para una tasa de conversión, bajar es NEGATIVO; para un costo o un tiempo de espera, bajar es POSITIVO. Refleja esto en el campo "sentido".
- Redacta como para una audiencia directiva (board): claro, cuantificado, sin relleno.
- Números: usa separador de miles y máximo 1-2 decimales. Porcentajes con el símbolo %.

CONTRATO DE SALIDA — devuelve exactamente esta estructura (los arreglos pueden tener los elementos que consideres, pero respeta los nombres de campo):

{
  "titulo": "string — título corto del informe",
  "subtitulo": "string — una línea de contexto (periodo, alcance)",
  "resumen_ejecutivo": "string — 2 a 4 frases con el mensaje principal y su magnitud",
  "kpis": [
    {
      "etiqueta": "string — nombre de la métrica",
      "valor": "string — valor formateado, ej. '54.1%' o '6,320'",
      "comparacion": "string|null — valor de referencia, ej. 'vs 92.9% en mayo'",
      "delta": "string|null — variación, ej. '-38.7 pp' o '+12.4%'",
      "direccion": "sube|baja|estable",
      "sentido": "positivo|negativo|neutral"
    }
  ],
  "graficas": [
    {
      "tipo": "barras|barras_agrupadas|lineas|pastel|dona",
      "titulo": "string",
      "descripcion": "string|null — qué muestra o cómo leerla",
      "labels": ["string", "..."],
      "series": [ { "nombre": "string", "datos": [numero, "..."] } ],
      "formato_valor": "numero|porcentaje|moneda|null"
    }
  ],
  "diagnosticos": [
    {
      "nivel": "critico|alerta|ok|info",
      "titulo": "string",
      "detalle": "string — qué se observa y por qué importa",
      "recomendacion": "string|null — acción concreta sugerida"
    }
  ],
  "hallazgos": ["string — bullet de hallazgo relevante", "..."],
  "siguientes_pasos": ["string — acción recomendada priorizada", "..."]
}

Reglas del contrato:
- "series[].datos" deben ser números (no strings). "labels" y "datos" de una misma gráfica deben tener la misma longitud.
- Para "barras_agrupadas" y "lineas" comparativas, cada elemento de "series" es una serie (ej. una por mes); todas comparten los mismos "labels".
- Para "pastel"/"dona" usa una sola serie.
- Genera entre 2 y 5 gráficas, las más útiles para la solicitud. Genera entre 2 y 6 KPIs y entre 1 y 5 diagnósticos.
- Si la solicitud es ambigua, elige la interpretación más útil y decláralo en una línea del "resumen_ejecutivo".`;

// ---------------------------------------------------------------------------
//  Utilidad: extraer el JSON del texto devuelto por la IA de forma robusta
// ---------------------------------------------------------------------------
function extraerJSON(texto) {
  let t = (texto || '').trim();
  // Quitar cercas de código si las hubiera
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  // Recortar al primer { y último }
  const ini = t.indexOf('{');
  const fin = t.lastIndexOf('}');
  if (ini !== -1 && fin !== -1 && fin > ini) {
    t = t.slice(ini, fin + 1);
  }
  return JSON.parse(t);
}

// ---------------------------------------------------------------------------
//  Endpoint principal
// ---------------------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'Falta ANTHROPIC_API_KEY en el servidor. Configura el archivo .env.'
    });
  }

  const { request: solicitud, schema, summary, sampleCSV, rowCount, truncated, modelo } =
    req.body || {};

  if (!solicitud || !sampleCSV) {
    return res.status(400).json({ error: 'Faltan datos: se requiere la solicitud y el archivo.' });
  }

  const esquemaTxt = Array.isArray(schema)
    ? schema.map((c) => `- ${c.name}: ${c.type}`).join('\n')
    : 'No especificado';

  const resumenTxt =
    typeof summary === 'string' ? summary : JSON.stringify(summary, null, 2);

  const nota = truncated
    ? `\n\n[NOTA] El archivo tiene ${rowCount} filas; se envía una muestra de las primeras ${MAX_FILAS_IA}. El RESUMEN ESTADÍSTICO abarca el 100% de las filas: úsalo para los agregados globales.`
    : '';

  const userMessage =
    `SOLICITUD DEL USUARIO:\n${solicitud}\n\n` +
    `ESQUEMA DETECTADO (columna: tipo):\n${esquemaTxt}\n\n` +
    `RESUMEN ESTADÍSTICO (100% de las filas, ${rowCount} filas):\n${resumenTxt}\n\n` +
    `MUESTRA DE DATOS (CSV):\n${sampleCSV}${nota}`;

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: modelo || MODEL,
        max_tokens: 8000,
        thinking: { type: 'disabled' },
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userMessage }]
      })
    });

    if (!r.ok) {
      const detalle = await r.text();
      console.error('Error API Anthropic:', r.status, detalle);
      return res.status(502).json({
        error: `La API de Claude respondió ${r.status}. Revisa la API key, el saldo o el nombre del modelo.`,
        detalle
      });
    }

    const data = await r.json();
    const stopReason = data.stop_reason;
    const texto = (data.content || [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim();

    console.log('Anthropic OK -> stop_reason=%s, caracteres=%d, uso=%j', stopReason, texto.length, data.usage);
    if (texto.length === 0) {
      console.error('Respuesta SIN texto. Data cruda:', JSON.stringify(data).slice(0, 1200));
    }

    let analisis;
    try {
      analisis = extraerJSON(texto);
    } catch (e) {
      console.error('No se pudo parsear el JSON de la IA:', e.message, '| stop_reason:', stopReason, '| inicio:', texto.slice(0, 300));
      const pista =
        stopReason === 'max_tokens'
          ? 'La respuesta se truncó por longitud. '
          : texto.length === 0
          ? 'La IA devolvió una respuesta vacía (revisa el modelo o el saldo). '
          : '';
      return res.status(502).json({
        error: pista + 'La IA no devolvió un JSON válido. Intenta reformular la solicitud.',
        stop_reason: stopReason || null,
        caracteres: texto.length,
        crudo: texto.slice(0, 2000)
      });
    }

    res.json({ analisis, modelo: data.model || (modelo || MODEL), uso: data.usage || null });
  } catch (err) {
    console.error('Fallo en /api/analyze:', err);
    res.status(500).json({ error: 'Error interno al contactar la IA.', detalle: String(err) });
  }
});

// Salud del servicio (útil para monitoreo del servidor)
app.get('/api/health', (_req, res) => {
  res.json({ ok: true, modelo: MODEL, apiKeyConfigurada: Boolean(API_KEY), maxFilasIA: MAX_FILAS_IA });
});

// Exponer la config no sensible al frontend
app.get('/api/config', (_req, res) => {
  res.json({ modeloPorDefecto: MODEL, maxFilasIA: MAX_FILAS_IA });
});

app.listen(PORT, () => {
  console.log(`\n  WOM Analytics Workbench`);
  console.log(`  ---------------------------------------------`);
  console.log(`  Servidor en:      http://localhost:${PORT}`);
  console.log(`  Modelo:           ${MODEL}`);
  console.log(`  API key:          ${API_KEY ? 'configurada ✓' : 'FALTA ✗  (revisa .env)'}`);
  console.log(`  Máx. filas a IA:  ${MAX_FILAS_IA}`);
  console.log(`  ---------------------------------------------\n`);
});
