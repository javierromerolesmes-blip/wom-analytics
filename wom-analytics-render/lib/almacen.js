/**
 * Almacén de la memoria colectiva.
 * ---------------------------------
 * Diseño: el archivo local es SIEMPRE la base de trabajo (rápido y sin
 * dependencias). Si hay credenciales de SharePoint, cada escritura se encola
 * y un flush periódico la envía. Si SharePoint falla o no está configurado,
 * la herramienta sigue funcionando y nada se pierde: la cola reintenta.
 *
 * Volúmenes esperados: unos miles de registros. Se carga todo en memoria y se
 * persiste el archivo completo en cada cambio. Simple y suficiente.
 */

const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const sharepoint = require('./sharepoint');

const DIR = process.env.DATOS_DIR || path.join(__dirname, '..', 'datos');

const TABLAS = {
  bitacora: 'bitacora.json',
  biblioteca: 'biblioteca.json',
  reglas: 'reglas.json',
  cola: 'cola.json'
};

const db = { bitacora: [], biblioteca: [], reglas: [], cola: [] };

function rutaDe(tabla) {
  return path.join(DIR, TABLAS[tabla]);
}

function cargar() {
  if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
  for (const tabla of Object.keys(TABLAS)) {
    try {
      const txt = fs.readFileSync(rutaDe(tabla), 'utf8');
      const datos = JSON.parse(txt);
      db[tabla] = Array.isArray(datos) ? datos : [];
    } catch {
      db[tabla] = [];
    }
  }
  console.log(
    `  Almacén:          ${DIR} · bitácora ${db.bitacora.length} · ` +
    `biblioteca ${db.biblioteca.length} · reglas ${db.reglas.length}`
  );
}

function persistir(tabla) {
  try {
    fs.writeFileSync(rutaDe(tabla), JSON.stringify(db[tabla], null, 2), 'utf8');
  } catch (err) {
    console.error(`No se pudo persistir ${tabla}:`, err.message);
  }
}

function encolar(tabla, registro) {
  if (!sharepoint.configurado()) return;
  db.cola.push({ tabla, registro, intentos: 0, encolado: new Date().toISOString() });
  persistir('cola');
}

// ---------------------------------------------------------------------------
//  Bitácora — un registro por ejecución
// ---------------------------------------------------------------------------
function nuevaEjecucion(datos) {
  const registro = {
    id: randomUUID(),
    fecha: new Date().toISOString(),
    // Identidad
    usuario: datos.usuario || 'anonimo',
    area: datos.area || null,
    // Qué se pidió
    prompt: datos.prompt,
    prompt_id_origen: datos.prompt_id_origen || null,
    reintento_de: datos.reintento_de || null,
    // Sobre qué fuente (metadatos, NUNCA filas de datos)
    archivo: datos.archivo || null,
    archivo_hash: datos.archivo_hash || null,
    columnas: datos.columnas || [],
    filas: datos.filas || 0,
    // Cómo se ejecutó
    modelo: datos.modelo || null,
    version_system_prompt: datos.version_system_prompt || null,
    prompts_inyectados: datos.prompts_inyectados || [],
    tokens_entrada: datos.tokens_entrada || 0,
    tokens_salida: datos.tokens_salida || 0,
    costo_usd: datos.costo_usd || 0,
    duracion_ms: datos.duracion_ms || 0,
    // Qué resultó
    estado: datos.estado || 'ok',
    tipo_error: datos.tipo_error || null,
    titulo: datos.titulo || null,
    resumen: datos.resumen || null,
    // Qué opinó la gente (se completa con /api/feedback)
    calificacion: null,
    etiqueta_falla: null,
    que_se_corrigio: null,
    decision_tomada: null,
    exporto_pptx: false,
    calificacion_curador: null
  };
  db.bitacora.push(registro);
  persistir('bitacora');
  encolar('bitacora', registro);
  return registro;
}

function actualizarEjecucion(id, parches) {
  const reg = db.bitacora.find((r) => r.id === id);
  if (!reg) return null;
  const permitidos = [
    'calificacion', 'etiqueta_falla', 'que_se_corrigio', 'decision_tomada',
    'exporto_pptx', 'calificacion_curador'
  ];
  for (const clave of permitidos) {
    if (parches[clave] !== undefined) reg[clave] = parches[clave];
  }
  reg.actualizado = new Date().toISOString();
  persistir('bitacora');
  encolar('bitacora', reg);
  return reg;
}

function listarEjecuciones({ usuario, desde, limite = 200 } = {}) {
  let filas = db.bitacora;
  if (usuario) filas = filas.filter((r) => r.usuario === usuario);
  if (desde) filas = filas.filter((r) => r.fecha >= desde);
  return filas.slice(-limite).reverse();
}

function obtenerEjecucion(id) {
  return db.bitacora.find((r) => r.id === id) || null;
}

// ---------------------------------------------------------------------------
//  Biblioteca — prompts reutilizables, versionados
// ---------------------------------------------------------------------------
function nuevoPrompt(datos) {
  const registro = {
    id: randomUUID(),
    titulo: datos.titulo,
    texto: datos.texto,
    version: datos.version || 1,
    reemplaza_a: datos.reemplaza_a || null,
    caso_de_uso: datos.caso_de_uso || 'general',
    etiquetas: datos.etiquetas || [],
    requisitos_de_datos: datos.requisitos_de_datos || [],
    notas: datos.notas || null,
    errores_frecuentes: datos.errores_frecuentes || null,
    ejemplo_ejecucion_id: datos.ejemplo_ejecucion_id || null,
    propietario: datos.propietario,
    revisor: null,
    estado: datos.estado || 'propuesto',
    creado: new Date().toISOString(),
    actualizado: new Date().toISOString()
  };
  db.biblioteca.push(registro);
  persistir('biblioteca');
  encolar('biblioteca', registro);
  return registro;
}

function actualizarPrompt(id, parches) {
  const reg = db.biblioteca.find((r) => r.id === id);
  if (!reg) return null;
  Object.assign(reg, parches, { actualizado: new Date().toISOString() });
  persistir('biblioteca');
  encolar('biblioteca', reg);
  return reg;
}

function listarPrompts({ estado } = {}) {
  const filas = estado ? db.biblioteca.filter((p) => p.estado === estado) : db.biblioteca;
  return filas.slice().sort((a, b) => (a.titulo || '').localeCompare(b.titulo || ''));
}

function obtenerPrompt(id) {
  return db.biblioteca.find((p) => p.id === id) || null;
}

// ---------------------------------------------------------------------------
//  Reglas destiladas — lo que la herramienta "aprende" y reinyecta
// ---------------------------------------------------------------------------
function nuevaRegla(datos) {
  const registro = {
    id: randomUUID(),
    texto: datos.texto,
    origen_ejecucion: datos.origen_ejecucion || null,
    propuesta_por: datos.propuesta_por,
    estado: datos.estado || 'propuesta',
    aprobada_por: null,
    creado: new Date().toISOString(),
    actualizado: new Date().toISOString()
  };
  db.reglas.push(registro);
  persistir('reglas');
  encolar('reglas', registro);
  return registro;
}

function actualizarRegla(id, parches) {
  const reg = db.reglas.find((r) => r.id === id);
  if (!reg) return null;
  Object.assign(reg, parches, { actualizado: new Date().toISOString() });
  persistir('reglas');
  encolar('reglas', reg);
  return reg;
}

function listarReglas({ estado } = {}) {
  return estado ? db.reglas.filter((r) => r.estado === estado) : db.reglas.slice();
}

// ---------------------------------------------------------------------------
//  Sincronización con SharePoint
// ---------------------------------------------------------------------------
async function sincronizar() {
  if (!sharepoint.configurado() || db.cola.length === 0) {
    return { enviados: 0, pendientes: db.cola.length, activo: sharepoint.configurado() };
  }
  const pendientes = db.cola.slice(0, 50);
  let enviados = 0;
  for (const item of pendientes) {
    try {
      await sharepoint.guardarElemento(item.tabla, item.registro);
      db.cola.shift();
      enviados++;
    } catch (err) {
      item.intentos++;
      item.ultimo_error = String(err.message || err);
      // Tras 5 intentos se mueve al final para no bloquear la cola.
      if (item.intentos >= 5) {
        db.cola.shift();
        db.cola.push(item);
      }
      break;
    }
  }
  persistir('cola');
  return { enviados, pendientes: db.cola.length, activo: true };
}

function estadoCola() {
  return {
    activo: sharepoint.configurado(),
    pendientes: db.cola.length,
    ultimo_error: db.cola[0]?.ultimo_error || null
  };
}

function exportarTodo() {
  return {
    exportado: new Date().toISOString(),
    bitacora: db.bitacora,
    biblioteca: db.biblioteca,
    reglas: db.reglas
  };
}

module.exports = {
  cargar,
  nuevaEjecucion, actualizarEjecucion, listarEjecuciones, obtenerEjecucion,
  nuevoPrompt, actualizarPrompt, listarPrompts, obtenerPrompt,
  nuevaRegla, actualizarRegla, listarReglas,
  sincronizar, estadoCola, exportarTodo
};
