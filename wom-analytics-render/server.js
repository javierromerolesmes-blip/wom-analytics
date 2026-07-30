/**
 * WOM Analytics Workbench — servidor
 * -----------------------------------
 * - Sirve el frontend estático (carpeta /public).
 * - Expone POST /api/analyze como PROXY a la API de Anthropic.
 *   La API key vive SOLO aquí (en el servidor), nunca en el navegador.
 * - Registra cada ejecución en la bitácora, mantiene la biblioteca de prompts
 *   y reinyecta al modelo lo que ya funcionó (ver lib/memoria.js).
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const almacen = require('./lib/almacen');
const memoria = require('./lib/memoria');
const sharepoint = require('./lib/sharepoint');

const app = express();

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.ANTHROPIC_API_KEY;
const MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-5';
const MAX_FILAS_IA = parseInt(process.env.MAX_FILAS_IA || '5000', 10);
const MAX_TOKENS = parseInt(process.env.MAX_TOKENS || '16000', 10);
const USAR_CACHE_PROMPT = process.env.USAR_CACHE_PROMPT === '1';
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';

// Identidad y gobierno
const DOMINIO_PERMITIDO = (process.env.DOMINIO_PERMITIDO || '').trim().toLowerCase();
const CURADORES = (process.env.CURADORES || '')
  .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
const MINUTOS_SINCRONIZACION = parseInt(process.env.MINUTOS_SINCRONIZACION || '5', 10);

app.use(express.json({ limit: '25mb' }));
app.use(express.static(path.join(__dirname, 'public')));

almacen.cargar();
memoria.cargarPlantilla();

// ---------------------------------------------------------------------------
//  Identidad
// ---------------------------------------------------------------------------
function usuarioDe(req) {
  const crudo = (req.body?.usuario || req.get('x-usuario') || req.query?.usuario || '')
    .trim().toLowerCase();
  if (!crudo) return { ok: false, motivo: 'Falta identificarse con el correo corporativo.' };
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(crudo)) {
    return { ok: false, motivo: 'El correo no tiene un formato válido.' };
  }
  if (DOMINIO_PERMITIDO && !crudo.endsWith(`@${DOMINIO_PERMITIDO}`)) {
    return { ok: false, motivo: `Usa tu correo @${DOMINIO_PERMITIDO}.` };
  }
  return { ok: true, usuario: crudo, curador: CURADORES.includes(crudo) };
}

function exigirUsuario(req, res) {
  const id = usuarioDe(req);
  if (!id.ok) {
    res.status(401).json({ error: id.motivo });
    return null;
  }
  return id;
}

function exigirCurador(req, res) {
  const id = exigirUsuario(req, res);
  if (!id) return null;
  if (!id.curador) {
    res.status(403).json({ error: 'Esta acción es de la curaduría. Pide a un curador que la apruebe.' });
    return null;
  }
  return id;
}

// ---------------------------------------------------------------------------
//  Utilidad: extraer el JSON del texto devuelto por la IA de forma robusta
// ---------------------------------------------------------------------------
function extraerJSON(texto) {
  let t = (texto || '').trim();
  t = t.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
  const ini = t.indexOf('{');
  const fin = t.lastIndexOf('}');
  if (ini !== -1 && fin !== -1 && fin > ini) t = t.slice(ini, fin + 1);
  return JSON.parse(t);
}

// ---------------------------------------------------------------------------
//  Análisis
// ---------------------------------------------------------------------------
app.post('/api/analyze', async (req, res) => {
  if (!API_KEY) {
    return res.status(500).json({
      error: 'Falta ANTHROPIC_API_KEY en el servidor. Configura el archivo .env.'
    });
  }

  const id = exigirUsuario(req, res);
  if (!id) return;

  const {
    request: solicitud, schema, summary, sampleCSV, rowCount, truncated, modelo,
    archivo, archivo_hash, prompt_id_origen, reintento_de, area
  } = req.body || {};

  if (!solicitud || !sampleCSV) {
    return res.status(400).json({ error: 'Faltan datos: se requiere la solicitud y el archivo.' });
  }

  const columnas = Array.isArray(schema) ? schema.map((c) => c.name) : [];
  const esquemaTxt = Array.isArray(schema)
    ? schema.map((c) => `- ${c.name}: ${c.type}`).join('\n')
    : 'No especificado';
  const resumenTxt = typeof summary === 'string' ? summary : JSON.stringify(summary, null, 2);

  const nota = truncated
    ? `\n\n[NOTA] El archivo tiene ${rowCount} filas; se envía una muestra de las primeras ${MAX_FILAS_IA}. El RESUMEN ESTADÍSTICO abarca el 100% de las filas: úsalo para los agregados globales.`
    : '';

  const userMessage =
    `SOLICITUD DEL USUARIO:\n${solicitud}\n\n` +
    `ESQUEMA DETECTADO (columna: tipo):\n${esquemaTxt}\n\n` +
    `RESUMEN ESTADÍSTICO (100% de las filas, ${rowCount} filas):\n${resumenTxt}\n\n` +
    `MUESTRA DE DATOS (CSV):\n${sampleCSV}${nota}`;

  // Aquí entra la memoria: reglas aprobadas + ejemplos de la biblioteca.
  const sistema = memoria.construirSystemPrompt({
    solicitud,
    columnas,
    biblioteca: almacen.listarPrompts(),
    reglas: almacen.listarReglas(),
    bitacora: almacen.listarEjecuciones({ limite: 5000 })
  });

  const modeloUsado = modelo || MODEL;
  const arranque = Date.now();

  // Base del registro de bitácora: se completa según el desenlace.
  const base = {
    usuario: id.usuario,
    area: area || null,
    prompt: solicitud,
    prompt_id_origen: prompt_id_origen || null,
    reintento_de: reintento_de || null,
    archivo: archivo || null,
    archivo_hash: archivo_hash || null,
    columnas,
    filas: rowCount || 0,
    modelo: modeloUsado,
    version_system_prompt: sistema.version,
    prompts_inyectados: sistema.prompts_inyectados
  };

  try {
    const cuerpo = {
      model: modeloUsado,
      max_tokens: MAX_TOKENS,
      // CRÍTICO: en Sonnet 5 / Opus 5 el razonamiento viene activado por
      // defecto y consumiría todo max_tokens, devolviendo texto vacío.
      // Para una tarea que solo debe emitir JSON, se apaga.
      thinking: { type: 'disabled' },
      system: USAR_CACHE_PROMPT
        ? [{ type: 'text', text: sistema.texto, cache_control: { type: 'ephemeral' } }]
        : sistema.texto,
      messages: [{ role: 'user', content: userMessage }]
    };

    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(cuerpo)
    });

    if (!r.ok) {
      const detalle = await r.text();
      console.error('Error API Anthropic:', r.status, detalle);
      almacen.nuevaEjecucion({
        ...base, estado: 'error', tipo_error: `api_${r.status}`,
        duracion_ms: Date.now() - arranque
      });
      return res.status(502).json({
        error: `La API de Claude respondió ${r.status}. Revisa la API key, el saldo o el nombre del modelo.`,
        detalle
      });
    }

    const data = await r.json();
    const texto = (data.content || [])
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
      .trim();

    const entrada = data.usage?.input_tokens || 0;
    const salida = data.usage?.output_tokens || 0;
    const costo = memoria.costoEstimado(modeloUsado, entrada, salida);

    let analisis;
    try {
      analisis = extraerJSON(texto);
    } catch (e) {
      console.error('No se pudo parsear el JSON de la IA:', e.message,
        '· stop_reason:', data.stop_reason, '· caracteres:', texto.length);
      almacen.nuevaEjecucion({
        ...base, estado: 'error', tipo_error: `json_invalido_${data.stop_reason || 'sin_razon'}`,
        tokens_entrada: entrada, tokens_salida: salida, costo_usd: costo,
        duracion_ms: Date.now() - arranque
      });
      return res.status(502).json({
        error: 'La IA no devolvió un JSON válido. Intenta reformular la solicitud.',
        crudo: texto.slice(0, 2000),
        stop_reason: data.stop_reason
      });
    }

    const registro = almacen.nuevaEjecucion({
      ...base,
      estado: 'ok',
      titulo: analisis.titulo || null,
      resumen: analisis.resumen_ejecutivo || null,
      tokens_entrada: entrada,
      tokens_salida: salida,
      costo_usd: costo,
      duracion_ms: Date.now() - arranque
    });

    res.json({
      analisis,
      id_ejecucion: registro.id,
      modelo: data.model || modeloUsado,
      uso: data.usage || null,
      costo_usd: costo,
      memoria: {
        reglas_inyectadas: sistema.reglas_inyectadas,
        prompts_inyectados: sistema.prompts_inyectados.length
      }
    });
  } catch (err) {
    console.error('Fallo en /api/analyze:', err);
    almacen.nuevaEjecucion({
      ...base, estado: 'error', tipo_error: 'excepcion_servidor',
      duracion_ms: Date.now() - arranque
    });
    res.status(500).json({ error: 'Error interno al contactar la IA.', detalle: String(err) });
  }
});

// ---------------------------------------------------------------------------
//  Bitácora: calificación y cierre del ciclo
// ---------------------------------------------------------------------------
app.post('/api/feedback', (req, res) => {
  const id = exigirUsuario(req, res);
  if (!id) return;

  const { id_ejecucion, calificacion, etiqueta_falla, que_se_corrigio,
    decision_tomada, exporto_pptx } = req.body || {};
  if (!id_ejecucion) return res.status(400).json({ error: 'Falta id_ejecucion.' });

  const ejecucion = almacen.obtenerEjecucion(id_ejecucion);
  if (!ejecucion) return res.status(404).json({ error: 'No existe esa ejecución en la bitácora.' });

  if (calificacion && !['util', 'no_util'].includes(calificacion)) {
    return res.status(400).json({ error: 'La calificación debe ser "util" o "no_util".' });
  }
  if (calificacion === 'no_util' && !etiqueta_falla) {
    return res.status(400).json({ error: 'Indica qué falló para que el registro sirva de algo.' });
  }

  const parches = {};
  if (calificacion !== undefined) parches.calificacion = calificacion;
  if (etiqueta_falla !== undefined) parches.etiqueta_falla = etiqueta_falla;
  if (que_se_corrigio !== undefined) parches.que_se_corrigio = que_se_corrigio;
  if (decision_tomada !== undefined) parches.decision_tomada = decision_tomada;
  if (exporto_pptx !== undefined) parches.exporto_pptx = Boolean(exporto_pptx);

  res.json({ ok: true, registro: almacen.actualizarEjecucion(id_ejecucion, parches) });
});

app.get('/api/bitacora', (req, res) => {
  const id = exigirUsuario(req, res);
  if (!id) return;
  const soloMias = req.query.mias === '1';
  res.json({
    registros: almacen.listarEjecuciones({
      usuario: soloMias ? id.usuario : undefined,
      limite: parseInt(req.query.limite || '200', 10)
    }),
    curador: id.curador
  });
});

app.get('/api/metricas', (req, res) => {
  const id = exigirUsuario(req, res);
  if (!id) return;
  const bitacora = almacen.listarEjecuciones({ limite: 5000 });
  const biblioteca = almacen.listarPrompts();
  res.json({
    ...memoria.metricas(bitacora, biblioteca),
    candidatos: memoria.candidatos(bitacora, biblioteca).slice(0, 10),
    cola_sharepoint: almacen.estadoCola(),
    curador: id.curador
  });
});

// ---------------------------------------------------------------------------
//  Biblioteca de prompts
// ---------------------------------------------------------------------------
app.get('/api/biblioteca', (req, res) => {
  const id = exigirUsuario(req, res);
  if (!id) return;
  const bitacora = almacen.listarEjecuciones({ limite: 5000 });
  const ranking = memoria.rankear(bitacora);
  const usoPorId = new Map();
  for (const reg of bitacora) {
    if (!reg.prompt_id_origen) continue;
    const u = usoPorId.get(reg.prompt_id_origen) || { usos: 0, utiles: 0, calificadas: 0 };
    u.usos++;
    if (reg.calificacion) u.calificadas++;
    if (reg.calificacion === 'util') u.utiles++;
    usoPorId.set(reg.prompt_id_origen, u);
  }
  const prompts = almacen.listarPrompts().map((p) => {
    const u = usoPorId.get(p.id) || { usos: 0, utiles: 0, calificadas: 0 };
    const enRanking = ranking.find((f) => f.prompt_id_origen === p.id);
    return {
      ...p,
      usos: u.usos,
      calificacion_media: u.calificadas ? Number((u.utiles / u.calificadas).toFixed(2)) : null,
      puntaje: enRanking?.puntaje ?? null
    };
  });
  res.json({ prompts, curador: id.curador, min_usos: memoria.MIN_USOS_PARA_RANKEAR });
});

app.post('/api/biblioteca', (req, res) => {
  const id = exigirUsuario(req, res);
  if (!id) return;
  const { titulo, texto, caso_de_uso, etiquetas, requisitos_de_datos, notas,
    errores_frecuentes, ejemplo_ejecucion_id, reemplaza_a } = req.body || {};
  if (!titulo || !texto) return res.status(400).json({ error: 'El prompt necesita título y texto.' });

  let version = 1;
  if (reemplaza_a) {
    const anterior = almacen.obtenerPrompt(reemplaza_a);
    if (anterior) {
      version = (anterior.version || 1) + 1;
      almacen.actualizarPrompt(reemplaza_a, { estado: 'obsoleto' });
    }
  }

  const prompt = almacen.nuevoPrompt({
    titulo, texto, caso_de_uso, etiquetas, requisitos_de_datos, notas,
    errores_frecuentes, ejemplo_ejecucion_id, reemplaza_a, version,
    propietario: id.usuario,
    // Un curador puede publicar directo; el resto propone.
    estado: id.curador && req.body.aprobar ? 'aprobado' : 'propuesto'
  });
  res.json({ ok: true, prompt });
});

app.post('/api/biblioteca/:id/estado', (req, res) => {
  const id = exigirCurador(req, res);
  if (!id) return;
  const { estado } = req.body || {};
  if (!['propuesto', 'aprobado', 'obsoleto', 'rechazado'].includes(estado)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  const prompt = almacen.actualizarPrompt(req.params.id, { estado, revisor: id.usuario });
  if (!prompt) return res.status(404).json({ error: 'No existe ese prompt.' });
  res.json({ ok: true, prompt });
});

// ---------------------------------------------------------------------------
//  Reglas aprendidas: lo que se reinyecta al modelo
// ---------------------------------------------------------------------------
app.get('/api/reglas', (req, res) => {
  const id = exigirUsuario(req, res);
  if (!id) return;
  res.json({ reglas: almacen.listarReglas(), curador: id.curador });
});

app.post('/api/reglas', (req, res) => {
  const id = exigirUsuario(req, res);
  if (!id) return;
  const { texto, origen_ejecucion } = req.body || {};
  if (!texto || texto.trim().length < 10) {
    return res.status(400).json({ error: 'Escribe la regla en una frase clara.' });
  }
  const regla = almacen.nuevaRegla({
    texto: texto.trim(),
    origen_ejecucion: origen_ejecucion || null,
    propuesta_por: id.usuario,
    estado: id.curador && req.body.aprobar ? 'aprobada' : 'propuesta'
  });
  res.json({ ok: true, regla });
});

app.post('/api/reglas/:id/estado', (req, res) => {
  const id = exigirCurador(req, res);
  if (!id) return;
  const { estado } = req.body || {};
  if (!['propuesta', 'aprobada', 'descartada'].includes(estado)) {
    return res.status(400).json({ error: 'Estado no válido.' });
  }
  const regla = almacen.actualizarRegla(req.params.id, { estado, aprobada_por: id.usuario });
  if (!regla) return res.status(404).json({ error: 'No existe esa regla.' });
  res.json({ ok: true, regla });
});

// ---------------------------------------------------------------------------
//  Export y sincronización
// ---------------------------------------------------------------------------
app.get('/api/export', (req, res) => {
  const id = exigirUsuario(req, res);
  if (!id) return;
  const todo = almacen.exportarTodo();

  if (req.query.formato === 'csv') {
    const columnas = [
      'id', 'fecha', 'usuario', 'prompt', 'prompt_id_origen', 'reintento_de',
      'archivo', 'filas', 'modelo', 'version_system_prompt', 'estado', 'tipo_error',
      'titulo', 'calificacion', 'etiqueta_falla', 'que_se_corrigio', 'decision_tomada',
      'exporto_pptx', 'tokens_entrada', 'tokens_salida', 'costo_usd', 'duracion_ms'
    ];
    const escapar = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const csv = [
      columnas.join(','),
      ...todo.bitacora.map((r) => columnas.map((c) => escapar(r[c])).join(','))
    ].join('\n');
    res.setHeader('content-type', 'text/csv; charset=utf-8');
    res.setHeader('content-disposition', 'attachment; filename="bitacora-wom-analytics.csv"');
    return res.send('\uFEFF' + csv);
  }

  res.setHeader('content-disposition', 'attachment; filename="memoria-wom-analytics.json"');
  res.json(todo);
});

app.post('/api/sincronizar', async (req, res) => {
  const id = exigirCurador(req, res);
  if (!id) return;
  res.json(await almacen.sincronizar());
});

app.get('/api/sharepoint/estado', async (req, res) => {
  const id = exigirCurador(req, res);
  if (!id) return;
  res.json({ ...(await sharepoint.probar()), cola: almacen.estadoCola() });
});

// ---------------------------------------------------------------------------
//  Salud y configuración
// ---------------------------------------------------------------------------
app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    modelo: MODEL,
    apiKeyConfigurada: Boolean(API_KEY),
    maxFilasIA: MAX_FILAS_IA,
    maxTokens: MAX_TOKENS,
    thinking: 'disabled',
    versionSystemPrompt: memoria.cargarPlantilla(),
    sharepoint: almacen.estadoCola()
  });
});

app.get('/api/config', (_req, res) => {
  res.json({
    modeloPorDefecto: MODEL,
    maxFilasIA: MAX_FILAS_IA,
    dominioPermitido: DOMINIO_PERMITIDO || null,
    sharepointActivo: sharepoint.configurado()
  });
});

// Sincronización periódica en segundo plano (si SharePoint está configurado).
if (sharepoint.configurado() && MINUTOS_SINCRONIZACION > 0) {
  setInterval(() => {
    almacen.sincronizar().catch((e) => console.error('Sincronización:', e.message));
  }, MINUTOS_SINCRONIZACION * 60000);
}

app.listen(PORT, () => {
  console.log(`\n  WOM Analytics Workbench`);
  console.log(`  ---------------------------------------------`);
  console.log(`  Servidor en:      http://localhost:${PORT}`);
  console.log(`  Modelo:           ${MODEL}`);
  console.log(`  API key:          ${API_KEY ? 'configurada ✓' : 'FALTA ✗  (revisa .env)'}`);
  console.log(`  Máx. filas a IA:  ${MAX_FILAS_IA}`);
  console.log(`  Thinking:         disabled (obligatorio para salida JSON)`);
  console.log(`  Curadores:        ${CURADORES.length || 'ninguno configurado ✗'}`);
  console.log(`  SharePoint:       ${sharepoint.configurado() ? 'configurado ✓' : 'inactivo (solo archivo local)'}`);
  console.log(`  ---------------------------------------------\n`);
});
