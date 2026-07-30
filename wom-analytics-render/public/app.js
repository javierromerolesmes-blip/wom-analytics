/* =========================================================================
   WOM Analytics Workbench — lógica de cliente
   ========================================================================= */

// ---- Paleta de marca para gráficas ----
const PALETTE = ['#FEF012', '#2ECC8F', '#E8744A', '#6BA4C9', '#C9A0DC', '#F2C14E', '#8FD3B6'];
const CREAM = '#EDE8DF';
const DIMLINE = 'rgba(237,232,223,0.10)';

// ---- Estado global ----
const state = {
  fileName: '',
  buffer: null,      // ArrayBuffer del archivo (para re-decodificar)
  encoding: 'utf-8',
  rows: [],          // filas parseadas (array de objetos)
  fields: [],        // nombres de columnas en orden
  schema: [],        // [{ name, type }]
  charts: [],        // instancias Chart.js activas
  lastAnalysis: null, // último JSON de análisis (para exportar)
  // ---- Trazabilidad para la bitácora ----
  fileHash: null,      // huella SHA-256 del archivo (nunca su contenido)
  idEjecucion: null,   // id del registro de la ejecución en curso
  promptIdOrigen: null, // si la solicitud vino de la biblioteca
  reintentoDe: null    // id de la ejecución que se está corrigiendo
};

let MAX_FILAS_IA = 5000;

// ---- Refs DOM ----
const $ = (id) => document.getElementById(id);
const dropzone = $('dropzone');
const fileInput = $('fileInput');
const analyzeBtn = $('analyzeBtn');

// ---- Config del servidor ----
fetch('/api/config').then(r => r.json()).then(cfg => {
  MAX_FILAS_IA = cfg.maxFilasIA || 5000;
  if (cfg.modeloPorDefecto) $('model').value = cfg.modeloPorDefecto;
}).catch(() => {});

// ---- Chips de ejemplo ----
const EJEMPLOS = [
  'Informe comparativo del comportamiento del funnel en mayo vs junio.',
  'Diagnóstico de la caída en la conversión de OTP/NIP.',
  'Top 10 motivos de caída y su peso porcentual.',
  'Tendencia diaria de activaciones y detección de anomalías.'
];
(function renderChips() {
  const c = $('chips');
  EJEMPLOS.forEach(t => {
    const el = document.createElement('div');
    el.className = 'chip';
    el.textContent = t;
    el.onclick = () => { $('req').value = t; toggleAnalyze(); };
    c.appendChild(el);
  });
})();

// =========================================================================
//  Carga de archivo
// =========================================================================
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('dragover', e => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', e => {
  e.preventDefault(); dropzone.classList.remove('drag');
  if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
});
fileInput.addEventListener('change', e => { if (e.target.files.length) handleFile(e.target.files[0]); });
$('encoding').addEventListener('change', e => { state.encoding = e.target.value; reparse(); });

function handleFile(file) {
  state.fileName = file.name;
  state.ext = (file.name.split('.').pop() || '').toLowerCase();
  const reader = new FileReader();
  reader.onload = async () => {
    state.buffer = reader.result;
    state.fileHash = await huella(reader.result);
    reparse();
  };
  reader.readAsArrayBuffer(file);
  $('fileName').textContent = file.name;
  $('fileRow').style.display = 'flex';
}

function reparse() {
  if (!state.buffer) return;
  let text;
  if (state.ext === 'xlsx' || state.ext === 'xls') {
    // Excel: tomar la primera hoja y convertirla a CSV para reusar el mismo flujo
    const wb = XLSX.read(state.buffer, { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    text = XLSX.utils.sheet_to_csv(ws);
  } else {
    try {
      text = new TextDecoder(state.encoding).decode(state.buffer);
    } catch (e) {
      text = new TextDecoder('utf-8').decode(state.buffer);
    }
  }
  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true, dynamicTyping: false });
  let rows = parsed.data.filter(r => Object.values(r).some(v => v !== null && v !== ''));
  // Excluir subtotales/totales y filas basura (footers/notas de exportación)
  const antes = rows.length;
  rows = rows.filter(r => !esSubtotal(r) && !esFilaBasura(r));
  state.subtotalesExcluidos = antes - rows.length;
  state.rows = rows;
  state.fields = parsed.meta.fields || [];
  // Inferir tipos
  state.schema = state.fields.map(name => ({
    name,
    type: inferType(state.rows.map(r => r[name]))
  }));
  renderSchema();
  toggleAnalyze();
}

// =========================================================================
//  Inferencia de tipos y parsing numérico/fechas
// =========================================================================
function esSubtotal(row) {
  const flags = ['total', 'subtotal', 'grand total', 'total general', 'totales', 'suma total'];
  return Object.values(row).some(v => flags.includes(String(v).trim().toLowerCase()));
}

// Filas basura: footers/notas de exportación (ej. "Filtros aplicados: ...") que
// vienen casi vacías o con un bloque de texto largo en una fila sin datos tabulares.
function esFilaBasura(row) {
  const vals = Object.values(row).map(v => (v == null ? '' : String(v).trim()));
  const llenas = vals.filter(v => v !== '').length;
  if (llenas <= 1) return true;
  if (llenas <= 2 && vals.some(v => v.length > 60)) return true;
  return false;
}

function parseNumber(raw) {
  if (raw == null) return null;
  let s = String(raw).trim();
  if (s === '') return null;
  s = s.replace(/\s|\u00A0/g, '').replace(/[$%]/g, '').replace(/[A-Za-z]/g, '');
  if (s === '' || s === '-') return null;
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasDot) {
    const parts = s.split('.');
    // Varios puntos (1.234.567) o un punto con 3 decimales (5.000, 12.000) => miles en es-CO.
    // Un punto con 1, 2 o 4+ dígitos (12,5 · 3.14159) => decimal, se respeta.
    if (parts.length > 2 || (parts[1] && parts[1].length === 3)) s = s.replace(/\./g, '');
  }
  const n = parseFloat(s);
  return isNaN(n) ? null : n;
}

function parseDate(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (s === '') return null;
  let m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})/);           // yyyy-mm-dd
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})/);              // dd/mm/yyyy (asume día primero)
  if (m) { let y = +m[3]; if (y < 100) y += 2000; return new Date(y, +m[2] - 1, +m[1]); }
  return null;
}

function inferType(vals) {
  const s = vals.filter(v => v != null && String(v).trim() !== '').slice(0, 200);
  if (s.length === 0) return 'texto';
  let d = 0, n = 0;
  for (const v of s) {
    if (parseDate(v)) d++;
    else if (parseNumber(v) != null) n++;
  }
  if (d / s.length >= 0.8) return 'fecha';
  if (n / s.length >= 0.8) return 'numero';
  return 'texto';
}

// =========================================================================
//  Render del esquema editable
// =========================================================================
function renderSchema() {
  const body = $('schemaBody');
  body.innerHTML = '';
  state.schema.forEach((col, i) => {
    const sample = (state.rows.find(r => r[col.name] != null && r[col.name] !== '') || {})[col.name] || '—';
    const tr = document.createElement('tr');
    tr.innerHTML =
      `<td class="col-name">${escapeHtml(col.name)}</td>` +
      `<td><span class="type-badge t-${col.type}" id="badge-${i}">${col.type}</span></td>` +
      `<td class="sample">${escapeHtml(String(sample).slice(0, 40))}</td>` +
      `<td>
         <select class="type-select" data-i="${i}">
           <option value="texto"  ${col.type === 'texto' ? 'selected' : ''}>texto</option>
           <option value="numero" ${col.type === 'numero' ? 'selected' : ''}>número</option>
           <option value="fecha"  ${col.type === 'fecha' ? 'selected' : ''}>fecha</option>
         </select>
       </td>`;
    body.appendChild(tr);
  });
  body.querySelectorAll('.type-select').forEach(sel => {
    sel.addEventListener('change', e => {
      const i = +e.target.dataset.i;
      state.schema[i].type = e.target.value;
      const badge = $('badge-' + i);
      badge.className = 'type-badge t-' + e.target.value;
      badge.textContent = e.target.value;
    });
  });
  $('schemaWrap').style.display = 'block';
  $('rowCount').textContent =
    `${state.rows.length.toLocaleString('es-CO')} filas · ${state.fields.length} columnas` +
    (state.subtotalesExcluidos ? ` · ${state.subtotalesExcluidos} fila(s) de subtotal/nota excluida(s)` : '') +
    (state.rows.length > MAX_FILAS_IA
      ? ` · se enviará una muestra de ${MAX_FILAS_IA.toLocaleString('es-CO')} filas a la IA (el resumen cubre el 100%).`
      : '');
}

// =========================================================================
//  Resumen estadístico (100% de las filas)
// =========================================================================
function computeSummary() {
  const out = {};
  state.schema.forEach(col => {
    const vals = state.rows.map(r => r[col.name]);
    const noNulos = vals.filter(v => v != null && String(v).trim() !== '');
    const nulos = vals.length - noNulos.length;
    if (col.type === 'numero') {
      const nums = noNulos.map(parseNumber).filter(v => v != null);
      const suma = nums.reduce((a, b) => a + b, 0);
      out[col.name] = {
        tipo: 'numero', nulos,
        min: nums.length ? Math.min(...nums) : null,
        max: nums.length ? Math.max(...nums) : null,
        promedio: nums.length ? +(suma / nums.length).toFixed(2) : null,
        suma: +suma.toFixed(2)
      };
    } else if (col.type === 'fecha') {
      const ds = noNulos.map(parseDate).filter(Boolean).map(d => d.getTime());
      out[col.name] = {
        tipo: 'fecha', nulos,
        desde: ds.length ? new Date(Math.min(...ds)).toISOString().slice(0, 10) : null,
        hasta: ds.length ? new Date(Math.max(...ds)).toISOString().slice(0, 10) : null,
        distintos: new Set(noNulos.map(String)).size
      };
    } else {
      const counts = new Map();
      noNulos.forEach(v => { const k = String(v); counts.set(k, (counts.get(k) || 0) + 1); });
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
        .map(([valor, conteo]) => ({ valor, conteo }));
      out[col.name] = { tipo: 'texto', nulos, distintos: counts.size, top };
    }
  });
  return out;
}

// =========================================================================
//  Analizar
// =========================================================================
function toggleAnalyze() {
  analyzeBtn.disabled = !(state.rows.length && $('req').value.trim());
}
$('req').addEventListener('input', toggleAnalyze);

analyzeBtn.addEventListener('click', analyze);
$('resetBtn').addEventListener('click', () => location.reload());

async function analyze() {
  if (!usuarioActual()) { pedirIdentificacion(); return; }
  hideError();
  $('results').classList.remove('show');
  setLoading(true);

  const sample = state.rows.slice(0, MAX_FILAS_IA);
  const sampleCSV = Papa.unparse({ fields: state.fields, data: sample });
  const payload = {
    request: $('req').value.trim(),
    schema: state.schema,
    summary: computeSummary(),
    sampleCSV,
    rowCount: state.rows.length,
    truncated: state.rows.length > MAX_FILAS_IA,
    modelo: $('model').value,
    // Identidad y trazabilidad (sin datos crudos)
    usuario: usuarioActual(),
    archivo: state.fileName,
    archivo_hash: state.fileHash,
    prompt_id_origen: state.promptIdOrigen,
    reintento_de: state.reintentoDe
  };

  try {
    const res = await fetch('/api/analyze', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) { showError(data.error || 'Error del servidor.', data.detalle || data.crudo); return; }
    state.lastAnalysis = data.analisis;
    state.idEjecucion = data.id_ejecucion || null;
    state.reintentoDe = null;
    renderResults(data.analisis);
    mostrarCalificacion(data);
  } catch (err) {
    showError('No se pudo contactar el servidor.', String(err));
  } finally {
    setLoading(false);
  }
}

// ---- Loading con mensajes rotativos ----
let loadingTimer = null;
function setLoading(on) {
  const box = $('loading');
  if (on) {
    box.classList.add('show');
    const msgs = [
      'Interpretando la solicitud y modelando los datos…',
      'Identificando fechas, métricas y dimensiones…',
      'Calculando comparativas y variaciones…',
      'Redactando diagnóstico y recomendaciones…'
    ];
    let i = 0; $('loadingMsg').textContent = msgs[0];
    loadingTimer = setInterval(() => { i = (i + 1) % msgs.length; $('loadingMsg').textContent = msgs[i]; }, 2500);
  } else {
    box.classList.remove('show');
    clearInterval(loadingTimer);
  }
}

function showError(msg, detail) {
  $('errMsg').textContent = msg;
  $('errDetail').textContent = detail ? String(detail).slice(0, 1500) : '';
  $('errbox').classList.add('show');
}
function hideError() { $('errbox').classList.remove('show'); }

// =========================================================================
//  Render de resultados
// =========================================================================
function renderResults(a) {
  $('rTitulo').textContent = a.titulo || 'Análisis';
  $('rSubtitulo').textContent = a.subtitulo || '';
  $('rResumen').textContent = a.resumen_ejecutivo || '';

  renderKPIs(a.kpis || []);
  renderCharts(a.graficas || []);
  renderDiagnostics(a.diagnosticos || []);
  renderLists(a.hallazgos || [], a.siguientes_pasos || []);

  $('results').classList.add('show');
  $('resetBtn').style.display = 'inline-flex';
  $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderKPIs(kpis) {
  const grid = $('kpiGrid'); grid.innerHTML = '';
  $('kpiTitle').style.display = kpis.length ? 'flex' : 'none';
  kpis.forEach(k => {
    const cls = k.sentido === 'positivo' ? 'd-pos' : k.sentido === 'negativo' ? 'd-neg' : 'd-neu';
    const arrow = k.direccion === 'sube' ? '▲' : k.direccion === 'baja' ? '▼' : '▬';
    const el = document.createElement('div');
    el.className = 'kpi';
    el.innerHTML =
      `<div class="k-label">${escapeHtml(k.etiqueta || '')}</div>` +
      `<div class="k-value">${escapeHtml(k.valor || '')}</div>` +
      (k.comparacion ? `<div class="k-cmp">${escapeHtml(k.comparacion)}</div>` : '') +
      (k.delta ? `<div class="k-delta ${cls}">${arrow} ${escapeHtml(k.delta)}</div>` : '');
    grid.appendChild(el);
  });
}

function renderCharts(graficas) {
  state.charts.forEach(c => c.destroy());
  state.charts = [];
  const grid = $('chartsGrid'); grid.innerHTML = '';
  $('chartTitle').style.display = graficas.length ? 'flex' : 'none';

  graficas.forEach((g, idx) => {
    const card = document.createElement('div');
    card.className = 'chart-card';
    card.innerHTML =
      `<h3>${escapeHtml(g.titulo || '')}</h3>` +
      (g.descripcion ? `<p class="c-desc">${escapeHtml(g.descripcion)}</p>` : '') +
      `<div class="chart-holder"><canvas id="chart-${idx}"></canvas></div>`;
    grid.appendChild(card);
    const ctx = $('chart-' + idx).getContext('2d');
    state.charts.push(buildChart(ctx, g));
  });
}

function buildChart(ctx, g) {
  const tipoMap = { barras: 'bar', barras_agrupadas: 'bar', lineas: 'line', pastel: 'pie', dona: 'doughnut' };
  const type = tipoMap[g.tipo] || 'bar';
  const labels = g.labels || [];
  const series = g.series || [];
  const esCircular = type === 'pie' || type === 'doughnut';
  const fmt = fmtFor(g.formato_valor);

  let datasets;
  if (esCircular) {
    datasets = [{
      data: (series[0] && series[0].datos) || [],
      backgroundColor: labels.map((_, i) => PALETTE[i % PALETTE.length]),
      borderColor: '#0E1117', borderWidth: 2
    }];
  } else {
    datasets = series.map((s, i) => {
      const color = PALETTE[i % PALETTE.length];
      const single = series.length === 1 && type === 'bar';
      return {
        label: s.nombre || '',
        data: s.datos || [],
        backgroundColor: single ? labels.map((_, j) => PALETTE[j % PALETTE.length])
          : (type === 'line' ? hexA(color, 0.12) : color),
        borderColor: color,
        borderWidth: type === 'line' ? 2.5 : 0,
        tension: 0.3,
        fill: type === 'line' ? false : true,
        pointRadius: type === 'line' ? 3 : 0,
        pointBackgroundColor: color,
        borderRadius: type === 'bar' ? 6 : 0
      };
    });
  }

  return new Chart(ctx, {
    type,
    data: { labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      color: CREAM,
      plugins: {
        legend: {
          display: esCircular || series.length > 1,
          labels: { color: CREAM, font: { family: 'Jost' }, boxWidth: 12, padding: 12 }
        },
        tooltip: {
          callbacks: { label: (c) => ` ${c.dataset.label ? c.dataset.label + ': ' : ''}${fmt(c.parsed.y ?? c.parsed)}` }
        }
      },
      scales: esCircular ? {} : {
        x: { ticks: { color: CREAM, font: { family: 'Jost' } }, grid: { color: DIMLINE } },
        y: { ticks: { color: CREAM, font: { family: 'Jost' }, callback: v => fmt(v) }, grid: { color: DIMLINE }, beginAtZero: true }
      }
    }
  });
}

function fmtFor(formato) {
  return (v) => {
    if (v == null || isNaN(v)) return v;
    if (formato === 'porcentaje') return (+v).toLocaleString('es-CO', { maximumFractionDigits: 1 }) + '%';
    if (formato === 'moneda') return '$' + (+v).toLocaleString('es-CO', { maximumFractionDigits: 0 });
    return (+v).toLocaleString('es-CO', { maximumFractionDigits: 2 });
  };
}

function renderDiagnostics(diags) {
  const grid = $('diagGrid'); grid.innerHTML = '';
  $('diagTitle').style.display = diags.length ? 'flex' : 'none';
  diags.forEach(d => {
    const nivel = ['critico', 'alerta', 'ok', 'info'].includes(d.nivel) ? d.nivel : 'info';
    const el = document.createElement('div');
    el.className = 'diag ' + nivel;
    el.innerHTML =
      `<div class="d-head"><span class="d-tag">${nivel}</span>${escapeHtml(d.titulo || '')}</div>` +
      `<div class="d-detail">${escapeHtml(d.detalle || '')}</div>` +
      (d.recomendacion ? `<div class="d-rec"><b>Acción:</b> ${escapeHtml(d.recomendacion)}</div>` : '');
    grid.appendChild(el);
  });
}

function renderLists(hallazgos, pasos) {
  const wrap = $('listWrap'); wrap.innerHTML = '';
  const any = hallazgos.length || pasos.length;
  $('listTitle').style.display = any ? 'flex' : 'none';
  if (hallazgos.length) {
    const c = document.createElement('div');
    c.className = 'list-card';
    c.innerHTML = `<h3>Hallazgos</h3><ul>${hallazgos.map(h => `<li>${escapeHtml(h)}</li>`).join('')}</ul>`;
    wrap.appendChild(c);
  }
  if (pasos.length) {
    const c = document.createElement('div');
    c.className = 'list-card steps';
    c.innerHTML = `<h3>Próximos pasos</h3><ul>${pasos.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>`;
    wrap.appendChild(c);
  }
}

// =========================================================================
//  Exportar a PowerPoint (plantilla de marca)
// =========================================================================
$('exportBtn').addEventListener('click', exportPPTX);

function exportPPTX() {
  const a = state.lastAnalysis;
  if (!a) return;

  const NAVY = '0E1117', PANEL = '171E27', BORDER = '2A313B', CREAM = 'EDE8DF',
        DIM = '9A958C', YELLOW = 'FEF012', MINT = '2ECC8F', RED = 'ED5A48', BLUE = '6BA4C9';
  const FONT = 'Century Gothic';

  const pptx = new PptxGenJS();
  pptx.layout = 'LAYOUT_WIDE'; // 13.333 x 7.5"
  const W = 13.333;

  const eyebrow = (s, txt) =>
    s.addText(txt.toUpperCase(), { x: 0.6, y: 0.45, w: 12, h: 0.35, fontFace: FONT, fontSize: 11, color: YELLOW, charSpacing: 2, bold: true });
  const footer = (s) =>
    s.addText('WOM · Analytics', { x: 0.6, y: 7.0, w: 6, h: 0.3, fontFace: FONT, fontSize: 9, color: DIM });

  // ---- Portada ----
  let s = pptx.addSlide(); s.background = { color: NAVY };
  s.addShape(pptx.ShapeType.rect, { x: 0.62, y: 2.55, w: 0.42, h: 0.42, fill: { color: YELLOW } });
  s.addText(a.titulo || 'Análisis de datos',
    { x: 0.6, y: 3.05, w: 12, h: 1.4, fontFace: FONT, fontSize: 40, bold: true, color: CREAM });
  if (a.subtitulo)
    s.addText(a.subtitulo, { x: 0.6, y: 4.35, w: 12, h: 0.6, fontFace: FONT, fontSize: 18, color: YELLOW });
  s.addText('WOM Colombia · Canal digital', { x: 0.6, y: 6.9, w: 8, h: 0.35, fontFace: FONT, fontSize: 11, color: DIM });

  // ---- Resumen + KPIs ----
  s = pptx.addSlide(); s.background = { color: NAVY }; eyebrow(s, 'Resumen ejecutivo'); footer(s);
  s.addText(a.resumen_ejecutivo || '', { x: 0.6, y: 1.05, w: 12.1, h: 1.6, fontFace: FONT, fontSize: 16, color: CREAM, lineSpacingMultiple: 1.15, valign: 'top' });
  const kpis = (a.kpis || []).slice(0, 6);
  if (kpis.length) {
    const perRow = Math.min(kpis.length, 3);
    const gap = 0.25, usable = 12.13;
    const bw = (usable - gap * (perRow - 1)) / perRow, bh = 1.5;
    kpis.forEach((k, i) => {
      const row = Math.floor(i / perRow), col = i % perRow;
      const x = 0.6 + col * (bw + gap), y = 3.15 + row * (bh + 0.25);
      const dc = k.sentido === 'positivo' ? MINT : k.sentido === 'negativo' ? RED : DIM;
      s.addShape(pptx.ShapeType.roundRect, { x, y, w: bw, h: bh, fill: { color: PANEL }, line: { color: BORDER, width: 0.75 }, rectRadius: 0.08 });
      s.addText((k.etiqueta || '').toUpperCase(), { x: x + 0.2, y: y + 0.15, w: bw - 0.4, h: 0.35, fontFace: FONT, fontSize: 9.5, color: DIM, charSpacing: 1 });
      s.addText(k.valor || '', { x: x + 0.2, y: y + 0.5, w: bw - 0.4, h: 0.55, fontFace: FONT, fontSize: 26, bold: true, color: CREAM });
      const linea = [k.comparacion, k.delta].filter(Boolean).join('   ·   ');
      if (linea) s.addText(linea, { x: x + 0.2, y: y + 1.08, w: bw - 0.4, h: 0.3, fontFace: FONT, fontSize: 10, color: dc });
    });
  }

  // ---- Una lámina por gráfica ----
  (a.graficas || []).forEach((g, idx) => {
    const chart = state.charts[idx];
    if (!chart) return;
    const img = chart.toBase64Image('image/png', 1.0);
    const sl = pptx.addSlide(); sl.background = { color: NAVY }; eyebrow(sl, 'Visualización'); footer(sl);
    sl.addText(g.titulo || '', { x: 0.6, y: 0.95, w: 12.1, h: 0.5, fontFace: FONT, fontSize: 22, bold: true, color: CREAM });
    if (g.descripcion) sl.addText(g.descripcion, { x: 0.6, y: 1.5, w: 12.1, h: 0.5, fontFace: FONT, fontSize: 12, color: DIM });
    sl.addImage({ data: img, x: 1.4, y: 2.05, w: 10.5, h: 4.6, sizing: { type: 'contain', w: 10.5, h: 4.6 } });
  });

  // ---- Diagnóstico ----
  const diags = a.diagnosticos || [];
  if (diags.length) {
    s = pptx.addSlide(); s.background = { color: NAVY }; eyebrow(s, 'Diagnóstico y evaluación'); footer(s);
    let y = 1.1;
    diags.slice(0, 5).forEach(d => {
      const nivel = ['critico', 'alerta', 'ok', 'info'].includes(d.nivel) ? d.nivel : 'info';
      const bc = nivel === 'critico' ? RED : nivel === 'alerta' ? YELLOW : nivel === 'ok' ? MINT : BLUE;
      const h = d.recomendacion ? 1.15 : 0.85;
      s.addShape(pptx.ShapeType.rect, { x: 0.6, y, w: 0.06, h, fill: { color: bc } });
      s.addText([
        { text: (nivel + '  ').toUpperCase(), options: { color: bc, bold: true, fontSize: 10 } },
        { text: d.titulo || '', options: { color: CREAM, bold: true, fontSize: 14 } }
      ], { x: 0.8, y: y, w: 12, h: 0.35, fontFace: FONT });
      s.addText(d.detalle || '', { x: 0.8, y: y + 0.35, w: 12, h: 0.4, fontFace: FONT, fontSize: 11.5, color: 'CFCABF' });
      if (d.recomendacion)
        s.addText([{ text: 'Acción: ', options: { color: YELLOW, bold: true } }, { text: d.recomendacion, options: { color: CREAM } }],
          { x: 0.8, y: y + 0.72, w: 12, h: 0.35, fontFace: FONT, fontSize: 11 });
      y += h + 0.2;
    });
  }

  // ---- Hallazgos + próximos pasos ----
  const hall = a.hallazgos || [], pasos = a.siguientes_pasos || [];
  if (hall.length || pasos.length) {
    s = pptx.addSlide(); s.background = { color: NAVY }; eyebrow(s, 'Hallazgos y próximos pasos'); footer(s);
    if (hall.length) {
      s.addText('Hallazgos', { x: 0.6, y: 1.1, w: 5.9, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: YELLOW });
      s.addText(hall.map(t => ({ text: t, options: { bullet: { code: '25AA' }, color: CREAM } })),
        { x: 0.6, y: 1.6, w: 5.9, h: 4.8, fontFace: FONT, fontSize: 12.5, lineSpacingMultiple: 1.3, valign: 'top' });
    }
    if (pasos.length) {
      s.addText('Próximos pasos', { x: 6.9, y: 1.1, w: 5.9, h: 0.4, fontFace: FONT, fontSize: 16, bold: true, color: MINT });
      s.addText(pasos.map(t => ({ text: t, options: { bullet: { code: '25AA' }, color: CREAM } })),
        { x: 6.9, y: 1.6, w: 5.9, h: 4.8, fontFace: FONT, fontSize: 12.5, lineSpacingMultiple: 1.3, valign: 'top' });
    }
  }

  const nombre = (a.titulo || 'Analisis_WOM').replace(/[^a-z0-9]+/gi, '_').slice(0, 50);
  pptx.writeFile({ fileName: `${nombre}.pptx` });
  // Señal implícita: exportar es el voto positivo más fuerte que existe.
  enviarFeedback({ exporto_pptx: true });
}

// =========================================================================
//  Utilidades
// =========================================================================
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
