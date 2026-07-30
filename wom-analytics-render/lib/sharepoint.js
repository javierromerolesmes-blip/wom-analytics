/**
 * Conector a SharePoint vía Microsoft Graph (flujo app-only).
 * ----------------------------------------------------------
 * No usa SDK: solo fetch. Se activa cuando existen las cuatro variables de
 * entorno. Mientras no existan, `configurado()` devuelve false y la
 * herramienta trabaja solo con el archivo local (ver lib/almacen.js).
 *
 * Variables:
 *   SP_TENANT_ID      Directorio (tenant) de Entra ID
 *   SP_CLIENT_ID      Id de la aplicación registrada
 *   SP_CLIENT_SECRET  Secreto de cliente
 *   SP_SITE_ID        Id del sitio de SharePoint (ver docs/SHAREPOINT.md)
 *   SP_LISTA_BITACORA / SP_LISTA_BIBLIOTECA / SP_LISTA_REGLAS
 *                     Nombres o ids de las listas destino
 *
 * Permiso recomendado: Sites.Selected, concedido sobre UN solo sitio.
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';

const cfg = () => ({
  tenant: process.env.SP_TENANT_ID,
  clientId: process.env.SP_CLIENT_ID,
  secret: process.env.SP_CLIENT_SECRET,
  siteId: process.env.SP_SITE_ID,
  listas: {
    bitacora: process.env.SP_LISTA_BITACORA || 'Bitacora_Analisis',
    biblioteca: process.env.SP_LISTA_BIBLIOTECA || 'Biblioteca_Prompts',
    reglas: process.env.SP_LISTA_REGLAS || 'Reglas_Aprendidas'
  }
});

function configurado() {
  const c = cfg();
  return Boolean(c.tenant && c.clientId && c.secret && c.siteId);
}

let tokenCache = { valor: null, expira: 0 };

async function token() {
  if (tokenCache.valor && Date.now() < tokenCache.expira - 60000) return tokenCache.valor;
  const c = cfg();
  const cuerpo = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.secret,
    scope: 'https://graph.microsoft.com/.default',
    grant_type: 'client_credentials'
  });
  const r = await fetch(`https://login.microsoftonline.com/${c.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: cuerpo
  });
  if (!r.ok) throw new Error(`Token de Graph falló (${r.status}): ${await r.text()}`);
  const datos = await r.json();
  tokenCache = { valor: datos.access_token, expira: Date.now() + datos.expires_in * 1000 };
  return tokenCache.valor;
}

/**
 * Aplana un registro a columnas de lista de SharePoint.
 * Los arreglos se serializan como texto separado por " | " y los objetos como
 * JSON, porque una columna de lista es un valor plano.
 */
function aColumnas(registro) {
  const campos = {};
  for (const [clave, valor] of Object.entries(registro)) {
    if (valor === null || valor === undefined) continue;
    if (Array.isArray(valor)) campos[clave] = valor.map(String).join(' | ').slice(0, 8000);
    else if (typeof valor === 'object') campos[clave] = JSON.stringify(valor).slice(0, 8000);
    else if (typeof valor === 'string') campos[clave] = valor.slice(0, 8000);
    else campos[clave] = valor;
  }
  // SharePoint reserva "Title": lo usamos como etiqueta legible del elemento.
  campos.Title = String(registro.titulo || registro.prompt || registro.texto || registro.id).slice(0, 250);
  return campos;
}

async function llamar(ruta, opciones = {}) {
  const t = await token();
  const r = await fetch(`${GRAPH}${ruta}`, {
    ...opciones,
    headers: {
      authorization: `Bearer ${t}`,
      'content-type': 'application/json',
      ...(opciones.headers || {})
    }
  });
  if (!r.ok) throw new Error(`Graph ${opciones.method || 'GET'} ${ruta} → ${r.status}: ${await r.text()}`);
  return r.status === 204 ? null : r.json();
}

/**
 * Escribe (o actualiza) un elemento. Busca por la columna `id` para no
 * duplicar cuando el mismo registro se reenvía tras una calificación.
 */
async function guardarElemento(tabla, registro) {
  const c = cfg();
  const lista = c.listas[tabla];
  if (!lista) throw new Error(`Tabla sin lista configurada: ${tabla}`);
  const base = `/sites/${c.siteId}/lists/${encodeURIComponent(lista)}`;
  const campos = aColumnas(registro);

  let existente = null;
  try {
    const filtro = `${base}/items?$expand=fields($select=id)&$filter=fields/id eq '${registro.id}'&$top=1`;
    const res = await llamar(filtro, { headers: { prefer: 'HonorNonIndexedQueriesWarningMayFailRandomly' } });
    existente = res?.value?.[0] || null;
  } catch {
    // Si el filtro falla (columna sin indexar), se inserta como nuevo.
    existente = null;
  }

  if (existente) {
    return llamar(`${base}/items/${existente.id}/fields`, {
      method: 'PATCH',
      body: JSON.stringify(campos)
    });
  }
  return llamar(`${base}/items`, {
    method: 'POST',
    body: JSON.stringify({ fields: campos })
  });
}

/** Diagnóstico: confirma que el sitio y las listas son alcanzables. */
async function probar() {
  if (!configurado()) return { ok: false, motivo: 'Faltan variables de entorno SP_*' };
  const c = cfg();
  try {
    const sitio = await llamar(`/sites/${c.siteId}?$select=displayName,webUrl`);
    const listas = {};
    for (const [tabla, nombre] of Object.entries(c.listas)) {
      try {
        await llamar(`/sites/${c.siteId}/lists/${encodeURIComponent(nombre)}?$select=displayName`);
        listas[tabla] = 'ok';
      } catch (err) {
        listas[tabla] = String(err.message).slice(0, 200);
      }
    }
    return { ok: true, sitio: sitio.displayName, url: sitio.webUrl, listas };
  } catch (err) {
    return { ok: false, motivo: String(err.message).slice(0, 300) };
  }
}

module.exports = { configurado, guardarElemento, probar };
