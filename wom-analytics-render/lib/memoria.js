/**
 * Memoria colectiva: convierte la bitácora en métricas, candidatos y contexto
 * reinyectable al modelo.
 *
 * Nota importante: el modelo no se reentrena con esto. Lo que hacemos es
 * recuperar lo que ya funcionó y volverlo a poner en el prompt de sistema.
 * Eso es lo que hace que la herramienta mejore con el uso.
 */

const fs = require('fs');
const path = require('path');

// Precios referenciales por millón de tokens (entrada / salida), USD.
// Ajustables sin tocar código con PRECIOS_JSON.
const PRECIOS = {
  'claude-opus-5': { entrada: 5, salida: 25 },
  'claude-sonnet-5': { entrada: 2, salida: 10 },
  'claude-haiku-4-5-20251001': { entrada: 1, salida: 5 },
  'claude-haiku-4-5': { entrada: 1, salida: 5 }
};

try {
  if (process.env.PRECIOS_JSON) Object.assign(PRECIOS, JSON.parse(process.env.PRECIOS_JSON));
} catch {
  console.warn('PRECIOS_JSON no es JSON válido; se usan los precios por defecto.');
}

function costoEstimado(modelo, tokensEntrada, tokensSalida) {
  const p = PRECIOS[modelo] || PRECIOS['claude-sonnet-5'];
  return Number(((tokensEntrada / 1e6) * p.entrada + (tokensSalida / 1e6) * p.salida).toFixed(5));
}

// ---------------------------------------------------------------------------
//  Normalización de prompts: agrupa "el mismo prompt" escrito con variaciones
// ---------------------------------------------------------------------------
function normalizar(texto) {
  return (texto || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const VACIAS = new Set([
  'de', 'la', 'el', 'los', 'las', 'un', 'una', 'y', 'o', 'en', 'del', 'al', 'por',
  'para', 'con', 'que', 'se', 'su', 'sus', 'me', 'mi', 'lo', 'a', 'es', 'como',
  'quiero', 'dame', 'hazme', 'necesito', 'muestrame', 'analiza', 'analisis'
]);

function terminos(texto) {
  return new Set(normalizar(texto).split(' ').filter((t) => t.length > 2 && !VACIAS.has(t)));
}

function similitud(a, b) {
  const A = terminos(a);
  const B = terminos(b);
  if (!A.size || !B.size) return 0;
  let comunes = 0;
  for (const t of A) if (B.has(t)) comunes++;
  return comunes / Math.min(A.size, B.size);
}

// ---------------------------------------------------------------------------
//  Métricas
// ---------------------------------------------------------------------------
const MIN_USOS_PARA_RANKEAR = 3;
const PESO_PRIOR = 3; // suaviza el promedio hacia la media global

function utilidadDe(reg) {
  if (reg.calificacion === 'util') return 1;
  if (reg.calificacion === 'no_util') return 0;
  // Señal implícita: exportar a PowerPoint es un voto positivo fuerte.
  if (reg.exporto_pptx) return 1;
  return null;
}

/**
 * Agrupa la bitácora por prompt normalizado y calcula las métricas que
 * deciden qué se promueve y qué se reinyecta.
 */
function agruparPorPrompt(bitacora) {
  const grupos = new Map();
  for (const reg of bitacora) {
    const clave = normalizar(reg.prompt).slice(0, 300);
    if (!clave) continue;
    if (!grupos.has(clave)) {
      grupos.set(clave, {
        clave,
        prompt_ejemplo: reg.prompt,
        prompt_id_origen: reg.prompt_id_origen || null,
        usos: 0,
        usuarios: new Set(),
        votos: [],
        errores: 0,
        exportaciones: 0,
        columnas: new Set(),
        ultimo_uso: reg.fecha,
        ejemplo_ejecucion_id: null,
        correcciones: []
      });
    }
    const g = grupos.get(clave);
    g.usos++;
    g.usuarios.add(reg.usuario);
    if (reg.estado !== 'ok') g.errores++;
    if (reg.exporto_pptx) g.exportaciones++;
    (reg.columnas || []).forEach((c) => g.columnas.add(c));
    if (reg.fecha > g.ultimo_uso) g.ultimo_uso = reg.fecha;
    const u = utilidadDe(reg);
    if (u !== null) {
      g.votos.push(u);
      if (u === 1 && !g.ejemplo_ejecucion_id) g.ejemplo_ejecucion_id = reg.id;
    }
    if (reg.que_se_corrigio) g.correcciones.push(reg.que_se_corrigio);
    if (reg.prompt_id_origen && !g.prompt_id_origen) g.prompt_id_origen = reg.prompt_id_origen;
  }
  return grupos;
}

function mediaGlobal(grupos) {
  let suma = 0;
  let n = 0;
  for (const g of grupos.values()) {
    for (const v of g.votos) { suma += v; n++; }
  }
  return n ? suma / n : 0.5;
}

/**
 * Ranking con promedio ponderado: un prompt con un solo voto positivo no le
 * gana a uno con quince votos buenos.
 */
function rankear(bitacora) {
  const grupos = agruparPorPrompt(bitacora);
  const global = mediaGlobal(grupos);
  const filas = [];
  for (const g of grupos.values()) {
    const n = g.votos.length;
    const promedio = n ? g.votos.reduce((a, b) => a + b, 0) / n : null;
    const puntaje = (n * (promedio ?? global) + PESO_PRIOR * global) / (n + PESO_PRIOR);
    filas.push({
      clave: g.clave,
      prompt: g.prompt_ejemplo,
      prompt_id_origen: g.prompt_id_origen,
      usos: g.usos,
      usuarios_distintos: g.usuarios.size,
      votos: n,
      promedio_utilidad: promedio,
      puntaje: Number(puntaje.toFixed(3)),
      tasa_exito: g.usos ? Number(((g.usos - g.errores) / g.usos).toFixed(2)) : null,
      exportaciones: g.exportaciones,
      columnas: [...g.columnas],
      correcciones: g.correcciones.slice(-3),
      ejemplo_ejecucion_id: g.ejemplo_ejecucion_id,
      ultimo_uso: g.ultimo_uso,
      rankeable: g.usos >= MIN_USOS_PARA_RANKEAR
    });
  }
  return filas.sort((a, b) => b.puntaje - a.puntaje || b.usos - a.usos);
}

/**
 * Candidatos a la biblioteca: criterio numérico explícito, para que la
 * curaduría sea aprobar o descartar en un clic, no llenar fichas.
 */
function candidatos(bitacora, biblioteca) {
  const yaEnBiblioteca = new Set(biblioteca.map((p) => normalizar(p.texto).slice(0, 300)));
  return rankear(bitacora).filter(
    (f) =>
      f.usos >= MIN_USOS_PARA_RANKEAR &&
      f.usuarios_distintos >= 2 &&
      (f.promedio_utilidad ?? 0) >= 0.7 &&
      !yaEnBiblioteca.has(f.clave)
  );
}

function metricas(bitacora, biblioteca) {
  const porUsuario = new Map();
  let costo = 0;
  let ok = 0;
  const desde = new Date(Date.now() - 30 * 864e5).toISOString();
  const mes = bitacora.filter((r) => r.fecha >= desde);

  for (const reg of bitacora) {
    const u = porUsuario.get(reg.usuario) || { usuario: reg.usuario, ejecuciones: 0, calificadas: 0, utiles: 0 };
    u.ejecuciones++;
    if (reg.calificacion) u.calificadas++;
    if (reg.calificacion === 'util') u.utiles++;
    porUsuario.set(reg.usuario, u);
    if (reg.estado === 'ok') ok++;
  }
  for (const reg of mes) costo += reg.costo_usd || 0;

  const ranking = rankear(bitacora);
  return {
    ejecuciones: bitacora.length,
    ejecuciones_30d: mes.length,
    tasa_exito: bitacora.length ? Number((ok / bitacora.length).toFixed(2)) : null,
    costo_30d_usd: Number(costo.toFixed(2)),
    usuarios: [...porUsuario.values()].sort((a, b) => b.ejecuciones - a.ejecuciones),
    cobertura_calificacion: bitacora.length
      ? Number((bitacora.filter((r) => r.calificacion).length / bitacora.length).toFixed(2))
      : null,
    prompts_en_biblioteca: biblioteca.filter((p) => p.estado === 'aprobado').length,
    reuso: bitacora.length
      ? Number((bitacora.filter((r) => r.prompt_id_origen).length / bitacora.length).toFixed(2))
      : null,
    top_prompts: ranking.filter((f) => f.rankeable).slice(0, 10)
  };
}

// ---------------------------------------------------------------------------
//  Construcción del prompt de sistema con la memoria dentro
// ---------------------------------------------------------------------------
const RUTA_PROMPT = process.env.RUTA_SYSTEM_PROMPT ||
  path.join(__dirname, '..', 'prompts', 'sistema.v3.md');

let plantilla = null;
let versionPrompt = null;

function cargarPlantilla() {
  plantilla = fs.readFileSync(RUTA_PROMPT, 'utf8');
  versionPrompt = path.basename(RUTA_PROMPT);
  return versionPrompt;
}

/**
 * Elige hasta 3 prompts aprobados relevantes: por similitud de texto y por
 * coincidencia entre las columnas que el prompt exige y las del archivo.
 */
function elegirEjemplos(solicitud, columnas, biblioteca, ranking) {
  const cols = new Set((columnas || []).map((c) => normalizar(c)));
  const puntajePorId = new Map(
    ranking.filter((f) => f.prompt_id_origen).map((f) => [f.prompt_id_origen, f.puntaje])
  );

  return biblioteca
    .filter((p) => p.estado === 'aprobado')
    .map((p) => {
      const sim = similitud(solicitud, `${p.titulo} ${p.texto} ${(p.etiquetas || []).join(' ')}`);
      const req = (p.requisitos_de_datos || []).map(normalizar);
      const cubre = req.length ? req.filter((r) => cols.has(r)).length / req.length : 0.5;
      const calidad = puntajePorId.get(p.id) ?? 0.5;
      return { p, puntaje: sim * 0.55 + cubre * 0.3 + calidad * 0.15, sim, cubre };
    })
    .filter((x) => x.sim > 0.15 || x.cubre >= 0.8)
    .sort((a, b) => b.puntaje - a.puntaje)
    .slice(0, 3)
    .map((x) => x.p);
}

function construirSystemPrompt({ solicitud, columnas, biblioteca, reglas, bitacora }) {
  if (!plantilla) cargarPlantilla();
  const ranking = rankear(bitacora);

  const aprobadas = reglas.filter((r) => r.estado === 'aprobada');
  const bloqueReglas = aprobadas.length
    ? 'REGLAS APRENDIDAS POR EL EQUIPO (correcciones ya validadas; respétalas como si fueran reglas críticas):\n' +
      aprobadas.map((r) => `- ${r.texto}`).join('\n')
    : '';

  const ejemplos = elegirEjemplos(solicitud, columnas, biblioteca, ranking);
  const bloqueEjemplos = ejemplos.length
    ? 'ANÁLISIS SIMILARES QUE YA FUNCIONARON BIEN (úsalos como referencia de enfoque y nivel de detalle, no los copies literalmente):\n' +
      ejemplos
        .map((p, i) => {
          const notas = p.notas ? `\n  Nota del equipo: ${p.notas}` : '';
          const errores = p.errores_frecuentes ? `\n  Evita: ${p.errores_frecuentes}` : '';
          return `${i + 1}. [${p.caso_de_uso}] ${p.titulo}\n  Solicitud: ${p.texto}${notas}${errores}`;
        })
        .join('\n')
    : '';

  const texto = plantilla
    .replace('{{REGLAS_APRENDIDAS}}', bloqueReglas)
    .replace('{{EJEMPLOS_BIBLIOTECA}}', bloqueEjemplos)
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return {
    texto,
    version: versionPrompt,
    reglas_inyectadas: aprobadas.length,
    prompts_inyectados: ejemplos.map((p) => p.id)
  };
}

module.exports = {
  cargarPlantilla, construirSystemPrompt, costoEstimado,
  rankear, candidatos, metricas, normalizar, similitud, MIN_USOS_PARA_RANKEAR
};
