/* =========================================================================
   WOM Analytics Workbench — memoria colectiva (cliente)
   Identidad · calificación · biblioteca de prompts · bitácora · métricas
   ========================================================================= */

const LS_USUARIO = 'wom_usuario';
let ES_CURADOR = false;
let DOMINIO = null;

const ETIQUETAS_FALLA = [
  ['cifras', 'Las cifras no cuadran'],
  ['grafica', 'La gráfica no era la adecuada'],
  ['interpretacion', 'Interpretó mal el negocio'],
  ['incompleto', 'No respondió lo que pedí'],
  ['formato', 'Problema de formato o idioma']
];

const CASOS_DE_USO = ['funnel', 'portabilidad', 'activaciones', 'otp', 'costos', 'anomalias', 'general'];

// -------------------------------------------------------------------------
//  Identidad
// -------------------------------------------------------------------------
function usuarioActual() {
  return (localStorage.getItem(LS_USUARIO) || '').trim().toLowerCase() || null;
}

function guardarUsuario(correo) {
  const limpio = (correo || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(limpio)) {
    avisoUsuario('Escribe un correo válido.');
    return false;
  }
  if (DOMINIO && !limpio.endsWith('@' + DOMINIO)) {
    avisoUsuario('Usa tu correo @' + DOMINIO + '.');
    return false;
  }
  localStorage.setItem(LS_USUARIO, limpio);
  avisoUsuario('');
  pintarIdentidad();
  refrescarPermisos();
  return true;
}

function avisoUsuario(texto) {
  const el = $('userAviso');
  if (el) el.textContent = texto || '';
}

function pintarIdentidad() {
  const correo = usuarioActual();
  $('userInput').value = correo || '';
  $('userBadge').style.display = ES_CURADOR ? 'inline-flex' : 'none';
}

function pedirIdentificacion() {
  avisoUsuario('Identifícate con tu correo para que quede registro de quién construye qué.');
  $('userInput').focus();
}

async function refrescarPermisos() {
  if (!usuarioActual()) return;
  try {
    const datos = await api('/api/biblioteca');
    ES_CURADOR = Boolean(datos.curador);
  } catch {
    ES_CURADOR = false;
  }
  pintarIdentidad();
}

// -------------------------------------------------------------------------
//  Cliente HTTP
// -------------------------------------------------------------------------
async function api(ruta, opciones = {}) {
  const res = await fetch(ruta, {
    ...opciones,
    headers: {
      'content-type': 'application/json',
      'x-usuario': usuarioActual() || '',
      ...(opciones.headers || {})
    }
  });
  const datos = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(datos.error || `Error ${res.status}`);
  return datos;
}

/** Huella del archivo: identifica la fuente sin guardar una sola fila. */
async function huella(buffer) {
  try {
    const hash = await crypto.subtle.digest('SHA-256', buffer);
    return [...new Uint8Array(hash)].slice(0, 8)
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return null;
  }
}

// -------------------------------------------------------------------------
//  Pestañas
// -------------------------------------------------------------------------
function irA(vista) {
  ['analisis', 'biblioteca', 'bitacora'].forEach((v) => {
    $('vista-' + v).style.display = v === vista ? 'block' : 'none';
    document.querySelector(`.tab[data-vista="${v}"]`)?.classList.toggle('activa', v === vista);
  });
  if (vista === 'biblioteca') cargarBiblioteca();
  if (vista === 'bitacora') cargarBitacora();
}

// -------------------------------------------------------------------------
//  Calificación (capa 1: bitácora)
// -------------------------------------------------------------------------
function mostrarCalificacion(respuesta) {
  const caja = $('feedback');
  caja.style.display = 'block';
  $('fbDetalle').innerHTML = '';
  $('fbEstado').textContent = '';
  const m = respuesta?.memoria;
  $('fbMeta').textContent = m && (m.reglas_inyectadas || m.prompts_inyectados)
    ? `Este análisis usó ${m.reglas_inyectadas} regla(s) aprendida(s) y ${m.prompts_inyectados} ejemplo(s) de la biblioteca.`
    : 'Aún no hay memoria acumulada: este análisis salió solo del prompt base.';
}

async function enviarFeedback(parches) {
  if (!state.idEjecucion || !usuarioActual()) return;
  try {
    await api('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ id_ejecucion: state.idEjecucion, usuario: usuarioActual(), ...parches })
    });
    return true;
  } catch (err) {
    $('fbEstado').textContent = err.message;
    return false;
  }
}

function calificar(valor) {
  const detalle = $('fbDetalle');
  if (valor === 'util') {
    enviarFeedback({ calificacion: 'util' });
    detalle.innerHTML = `
      <label class="fb-label" for="fbDecision">¿Qué decisión tomaste con este análisis? (opcional, pero es lo que le da valor al registro)</label>
      <textarea id="fbDecision" class="fb-texto" rows="2" placeholder="Ej.: se escaló el problema de OTP a la mesa técnica con la evidencia del día 14."></textarea>
      <div class="fb-acciones">
        <button class="btn btn-ghost" onclick="guardarDecision()">Guardar en la bitácora</button>
        <button class="btn btn-primary" onclick="abrirFormPrompt()">Proponer este prompt a la biblioteca</button>
      </div>`;
  } else {
    const opciones = ETIQUETAS_FALLA.map(([v, t]) => `<option value="${v}">${t}</option>`).join('');
    detalle.innerHTML = `
      <label class="fb-label" for="fbFalla">¿Qué falló?</label>
      <select id="fbFalla" class="fb-select">${opciones}</select>
      <label class="fb-label" for="fbCorreccion">¿Qué le cambiarías al prompt?</label>
      <textarea id="fbCorreccion" class="fb-texto" rows="2" placeholder="Ej.: había que pedirle que excluyera la fila Total y comparara por tasa, no por volumen."></textarea>
      <div class="fb-acciones">
        <button class="btn btn-ghost" onclick="guardarFalla(false)">Guardar</button>
        <button class="btn btn-primary" onclick="guardarFalla(true)">Guardar y corregir el prompt</button>
      </div>
      <div class="fb-nota">Si corriges, la nueva ejecución queda encadenada a esta. Ese par —lo que falló y lo que funcionó— es lo que enseña.</div>`;
  }
}

async function guardarDecision() {
  const ok = await enviarFeedback({ decision_tomada: $('fbDecision').value.trim() });
  if (ok) $('fbEstado').textContent = 'Registrado en la bitácora.';
}

async function guardarFalla(corregir) {
  const ok = await enviarFeedback({
    calificacion: 'no_util',
    etiqueta_falla: $('fbFalla').value,
    que_se_corrigio: $('fbCorreccion').value.trim()
  });
  if (!ok) return;
  $('fbEstado').textContent = 'Registrado. Gracias: esto es lo que hace que la próxima salga mejor.';
  if (corregir) {
    state.reintentoDe = state.idEjecucion;
    irA('analisis');
    $('req').focus();
    $('req').scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

// -------------------------------------------------------------------------
//  Biblioteca (capa 2)
// -------------------------------------------------------------------------
let BIBLIOTECA = [];

async function cargarBiblioteca() {
  if (!usuarioActual()) { pedirIdentificacion(); return; }
  const lista = $('bibliotecaLista');
  lista.innerHTML = '<div class="vacio">Cargando…</div>';
  try {
    const datos = await api('/api/biblioteca');
    ES_CURADOR = Boolean(datos.curador);
    pintarIdentidad();
    BIBLIOTECA = datos.prompts;
    pintarBiblioteca();
    cargarReglas();
  } catch (err) {
    lista.innerHTML = `<div class="vacio">${escapeHtml(err.message)}</div>`;
  }
}

function pintarBiblioteca() {
  const q = ($('bibBuscar').value || '').toLowerCase().trim();
  const filtro = $('bibFiltro').value;
  const filas = BIBLIOTECA.filter((p) => {
    if (filtro !== 'todos' && p.estado !== filtro) return false;
    if (!q) return true;
    return `${p.titulo} ${p.texto} ${p.caso_de_uso} ${(p.etiquetas || []).join(' ')}`.toLowerCase().includes(q);
  });

  const lista = $('bibliotecaLista');
  if (!filas.length) {
    lista.innerHTML = `<div class="vacio">Todavía no hay prompts guardados. Cuando un análisis salga bien, califícalo y propónlo desde ahí.</div>`;
    return;
  }

  lista.innerHTML = filas.map((p) => {
    const req = (p.requisitos_de_datos || []).length
      ? `<div class="pr-req">Requiere columnas: ${p.requisitos_de_datos.map(escapeHtml).join(', ')}</div>` : '';
    const metricas = [
      `${p.usos} uso${p.usos === 1 ? '' : 's'}`,
      p.calificacion_media !== null ? `${Math.round(p.calificacion_media * 100)}% útil` : 'sin calificar',
      `v${p.version}`
    ].join(' · ');
    const acciones = [
      `<button class="btn btn-ghost btn-sm" onclick="usarPrompt('${p.id}')">Usar</button>`,
      ES_CURADOR && p.estado !== 'aprobado'
        ? `<button class="btn btn-primary btn-sm" onclick="cambiarEstadoPrompt('${p.id}','aprobado')">Aprobar</button>` : '',
      ES_CURADOR && p.estado === 'aprobado'
        ? `<button class="btn btn-ghost btn-sm" onclick="cambiarEstadoPrompt('${p.id}','obsoleto')">Marcar obsoleto</button>` : ''
    ].join('');

    return `<div class="prompt-card">
      <div class="pr-head">
        <div>
          <div class="pr-titulo">${escapeHtml(p.titulo)}</div>
          <div class="pr-meta">${escapeHtml(p.caso_de_uso)} · ${metricas} · ${escapeHtml(p.propietario || '')}</div>
        </div>
        <span class="estado e-${p.estado}">${p.estado}</span>
      </div>
      <div class="pr-texto">${escapeHtml(p.texto)}</div>
      ${req}
      ${p.notas ? `<div class="pr-nota">Nota: ${escapeHtml(p.notas)}</div>` : ''}
      ${p.errores_frecuentes ? `<div class="pr-nota pr-alerta">Ojo: ${escapeHtml(p.errores_frecuentes)}</div>` : ''}
      <div class="pr-acciones">${acciones}</div>
    </div>`;
  }).join('');
}

function usarPrompt(id) {
  const p = BIBLIOTECA.find((x) => x.id === id);
  if (!p) return;
  $('req').value = p.texto;
  state.promptIdOrigen = p.id;
  irA('analisis');
  toggleAnalyze();

  // Aviso temprano: el fracaso más común al reutilizar es que falten columnas.
  const faltan = (p.requisitos_de_datos || []).filter(
    (r) => !state.schema.some((c) => c.name.toLowerCase().trim() === r.toLowerCase().trim())
  );
  const aviso = $('promptAviso');
  if (state.rows.length && faltan.length) {
    aviso.style.display = 'block';
    aviso.textContent = `Este prompt espera las columnas ${faltan.join(', ')} y tu archivo no las trae. Ajusta el archivo o el prompt antes de gastar una consulta.`;
  } else {
    aviso.style.display = 'none';
  }
  $('req').scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function cambiarEstadoPrompt(id, estado) {
  try {
    await api(`/api/biblioteca/${id}/estado`, {
      method: 'POST',
      body: JSON.stringify({ estado, usuario: usuarioActual() })
    });
    cargarBiblioteca();
  } catch (err) {
    alert(err.message);
  }
}

function abrirFormPrompt(textoPrevio) {
  irA('biblioteca');
  const form = $('formPrompt');
  form.style.display = 'block';
  $('fpTexto').value = textoPrevio ?? ($('req').value || '');
  $('fpTitulo').value = '';
  $('fpRequisitos').value = state.schema.map((c) => c.name).join(', ');
  $('fpCaso').innerHTML = CASOS_DE_USO.map((c) => `<option value="${c}">${c}</option>`).join('');
  $('fpEstado').textContent = '';
  form.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

async function guardarPrompt() {
  try {
    await api('/api/biblioteca', {
      method: 'POST',
      body: JSON.stringify({
        usuario: usuarioActual(),
        titulo: $('fpTitulo').value.trim(),
        texto: $('fpTexto').value.trim(),
        caso_de_uso: $('fpCaso').value,
        requisitos_de_datos: $('fpRequisitos').value.split(',').map((s) => s.trim()).filter(Boolean),
        notas: $('fpNotas').value.trim() || null,
        errores_frecuentes: $('fpErrores').value.trim() || null,
        ejemplo_ejecucion_id: state.idEjecucion,
        aprobar: ES_CURADOR
      })
    });
    $('formPrompt').style.display = 'none';
    cargarBiblioteca();
  } catch (err) {
    $('fpEstado').textContent = err.message;
  }
}

// -------------------------------------------------------------------------
//  Reglas aprendidas: lo que se reinyecta al modelo
// -------------------------------------------------------------------------
async function cargarReglas() {
  try {
    const datos = await api('/api/reglas');
    const reglas = datos.reglas;
    const cont = $('reglasLista');
    if (!reglas.length) {
      cont.innerHTML = '<div class="vacio">Sin reglas todavía. Cuando una corrección se repita, escríbela acá: entra al prompt de sistema de todos.</div>';
      return;
    }
    cont.innerHTML = reglas.map((r) => `
      <div class="regla r-${r.estado}">
        <div class="rg-texto">${escapeHtml(r.texto)}</div>
        <div class="rg-meta">
          <span class="estado e-${r.estado === 'aprobada' ? 'aprobado' : 'propuesto'}">${r.estado}</span>
          ${escapeHtml(r.propuesta_por)}
          ${ES_CURADOR && r.estado === 'propuesta'
            ? `<button class="btn btn-primary btn-sm" onclick="cambiarEstadoRegla('${r.id}','aprobada')">Aprobar</button>
               <button class="btn btn-ghost btn-sm" onclick="cambiarEstadoRegla('${r.id}','descartada')">Descartar</button>` : ''}
        </div>
      </div>`).join('');
  } catch {
    $('reglasLista').innerHTML = '';
  }
}

async function proponerRegla() {
  const texto = $('reglaTexto').value.trim();
  if (texto.length < 10) { $('reglaEstado').textContent = 'Escríbela en una frase clara.'; return; }
  try {
    await api('/api/reglas', {
      method: 'POST',
      body: JSON.stringify({ texto, usuario: usuarioActual(), origen_ejecucion: state.idEjecucion, aprobar: ES_CURADOR })
    });
    $('reglaTexto').value = '';
    $('reglaEstado').textContent = ES_CURADOR ? 'Regla aprobada y activa.' : 'Propuesta enviada a la curaduría.';
    cargarReglas();
  } catch (err) {
    $('reglaEstado').textContent = err.message;
  }
}

async function cambiarEstadoRegla(id, estado) {
  try {
    await api(`/api/reglas/${id}/estado`, {
      method: 'POST',
      body: JSON.stringify({ estado, usuario: usuarioActual() })
    });
    cargarReglas();
  } catch (err) {
    alert(err.message);
  }
}

// -------------------------------------------------------------------------
//  Bitácora y métricas (capa 3: lo que ve el gobierno)
// -------------------------------------------------------------------------
async function cargarBitacora() {
  if (!usuarioActual()) { pedirIdentificacion(); return; }
  try {
    const [m, b] = await Promise.all([api('/api/metricas'), api('/api/bitacora?limite=200')]);
    ES_CURADOR = Boolean(m.curador);
    pintarIdentidad();
    pintarMetricas(m);
    pintarCandidatos(m.candidatos || []);
    pintarRegistros(b.registros || []);
  } catch (err) {
    $('bitacoraTabla').innerHTML = `<div class="vacio">${escapeHtml(err.message)}</div>`;
  }
}

function pintarMetricas(m) {
  const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)}%`);
  const tarjetas = [
    ['Ejecuciones (30 d)', m.ejecuciones_30d, `${m.ejecuciones} en total`],
    ['Tasa de éxito', pct(m.tasa_exito), 'ejecuciones sin error'],
    ['Costo (30 d)', `US$ ${m.costo_30d_usd.toFixed(2)}`, 'estimado por tokens'],
    ['Prompts calificados', pct(m.cobertura_calificacion), 'cobertura de la bitácora'],
    ['Reuso', pct(m.reuso), 'análisis que partieron de la biblioteca'],
    ['Biblioteca', m.prompts_en_biblioteca, 'prompts aprobados']
  ];
  $('metricasStrip').innerHTML = tarjetas.map(([t, v, s]) => `
    <div class="met">
      <div class="met-label">${t}</div>
      <div class="met-valor">${v}</div>
      <div class="met-sub">${s}</div>
    </div>`).join('');

  const cola = m.cola_sharepoint || {};
  $('estadoSync').innerHTML = cola.activo
    ? `SharePoint conectado · ${cola.pendientes} registro(s) en cola${cola.ultimo_error ? ` · último error: ${escapeHtml(cola.ultimo_error)}` : ''}`
    : 'SharePoint no está conectado todavía: la memoria vive en el servidor. Usa Exportar para llevarla al sitio mientras se habilita.';

  const usuarios = m.usuarios || [];
  $('usuariosLista').innerHTML = usuarios.length
    ? usuarios.map((u) => `<div class="us"><span>${escapeHtml(u.usuario)}</span><span>${u.ejecuciones} ejec. · ${u.calificadas} calificadas</span></div>`).join('')
    : '<div class="vacio">Sin uso registrado.</div>';
}

function pintarCandidatos(candidatos) {
  const cont = $('candidatosLista');
  if (!candidatos.length) {
    cont.innerHTML = `<div class="vacio">Nada por revisar. Un prompt se vuelve candidato con ${3} usos de al menos 2 personas y 70% de calificaciones útiles.</div>`;
    return;
  }
  cont.innerHTML = candidatos.map((c) => `
    <div class="cand">
      <div class="cand-texto">${escapeHtml(c.prompt)}</div>
      <div class="cand-meta">${c.usos} usos · ${c.usuarios_distintos} personas · ${Math.round((c.promedio_utilidad || 0) * 100)}% útil · puntaje ${c.puntaje}</div>
      ${c.correcciones.length ? `<div class="cand-corr">Correcciones registradas: ${c.correcciones.map(escapeHtml).join(' / ')}</div>` : ''}
      <button class="btn btn-primary btn-sm" onclick="abrirFormPrompt(${JSON.stringify(c.prompt).replace(/"/g, '&quot;')})">Publicar en la biblioteca</button>
    </div>`).join('');
}

function pintarRegistros(registros) {
  if (!registros.length) {
    $('bitacoraTabla').innerHTML = '<div class="vacio">Sin ejecuciones registradas.</div>';
    return;
  }
  const fila = (r) => {
    const cal = r.calificacion === 'util' ? '<span class="cal ok">útil</span>'
      : r.calificacion === 'no_util' ? `<span class="cal mal">${escapeHtml(r.etiqueta_falla || 'falló')}</span>`
      : r.exporto_pptx ? '<span class="cal ok">exportado</span>' : '<span class="cal sin">sin calificar</span>';
    return `<tr>
      <td>${new Date(r.fecha).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' })}</td>
      <td>${escapeHtml(r.usuario)}</td>
      <td class="td-prompt" title="${escapeHtml(r.prompt)}">${escapeHtml(r.prompt.slice(0, 90))}${r.prompt.length > 90 ? '…' : ''}</td>
      <td>${escapeHtml(r.archivo || '—')}</td>
      <td>${r.estado === 'ok' ? 'ok' : `<span class="cal mal">${escapeHtml(r.tipo_error || 'error')}</span>`}</td>
      <td>${cal}</td>
      <td>${r.reintento_de ? 'corrección' : (r.prompt_id_origen ? 'biblioteca' : 'nuevo')}</td>
      <td>US$ ${(r.costo_usd || 0).toFixed(4)}</td>
    </tr>`;
  };
  $('bitacoraTabla').innerHTML = `<table class="tabla">
    <thead><tr><th>Fecha</th><th>Quién</th><th>Prompt</th><th>Archivo</th><th>Resultado</th><th>Calificación</th><th>Origen</th><th>Costo</th></tr></thead>
    <tbody>${registros.map(fila).join('')}</tbody></table>`;
}

async function sincronizarAhora() {
  try {
    const r = await api('/api/sincronizar', { method: 'POST', body: JSON.stringify({ usuario: usuarioActual() }) });
    $('estadoSync').textContent = `Enviados ${r.enviados} · pendientes ${r.pendientes}`;
  } catch (err) {
    $('estadoSync').textContent = err.message;
  }
}

function exportar(formato) {
  const correo = usuarioActual();
  if (!correo) { pedirIdentificacion(); return; }
  // La descarga va por navegación directa: se pasa el usuario por query.
  window.location = `/api/export?formato=${formato}&usuario=${encodeURIComponent(correo)}`;
}

// -------------------------------------------------------------------------
//  Arranque
// -------------------------------------------------------------------------
(async function iniciar() {
  try {
    const cfg = await (await fetch('/api/config')).json();
    DOMINIO = cfg.dominioPermitido || null;
    if (DOMINIO) $('userInput').placeholder = `tu.correo@${DOMINIO}`;
  } catch { /* sin config, se sigue igual */ }

  pintarIdentidad();
  refrescarPermisos();

  $('userInput').addEventListener('change', (e) => guardarUsuario(e.target.value));
  $('userInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') guardarUsuario(e.target.value); });
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => irA(t.dataset.vista)));
  $('bibBuscar').addEventListener('input', pintarBiblioteca);
  $('bibFiltro').addEventListener('change', pintarBiblioteca);
  $('fbUtil').addEventListener('click', () => calificar('util'));
  $('fbNoUtil').addEventListener('click', () => calificar('no_util'));
})();
