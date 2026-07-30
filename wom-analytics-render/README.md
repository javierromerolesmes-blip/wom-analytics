# WOM Analytics Workbench

Herramienta interna para el equipo de canal digital: **subes un archivo plano, describes en lenguaje natural el análisis que quieres, y la IA (Claude) devuelve un dashboard comparativo + un PowerPoint con la plantilla de marca.**

La IA interpreta la solicitud, identifica fechas/métricas/dimensiones y modela los datos según lo que pidas — no hay que preconfigurar columnas ni informes.

---

## Novedades v1.2 — memoria colectiva

Además de analizar, la herramienta ahora recuerda. Tres capas:

1. **Bitácora.** Cada ejecución queda registrada: quién, qué prompt, sobre qué
   archivo, qué modelo, qué costó, qué resultó, cómo se calificó, qué se corrigió
   y qué decisión se tomó. Se guardan **metadatos, nunca filas de datos**.
2. **Biblioteca.** Prompts reutilizables con propietario, versión, estado, las
   columnas que necesitan y los errores frecuentes a evitar. Un prompt se vuelve
   candidato automáticamente con 3 usos de al menos 2 personas y 70% de
   calificaciones útiles; la curaduría solo aprueba o descarta.
3. **Reglas aprendidas.** Cuando una corrección se repite, se escribe como regla.
   Las reglas aprobadas entran en el prompt de sistema de todos los análisis
   siguientes. Esto es lo que hace que la herramienta mejore con el uso: el modelo
   no se reentrena, pero sí recibe de vuelta lo que ya funcionó.

Identidad: cada persona se identifica con su correo corporativo (validado contra
`DOMINIO_PERMITIDO`). Está diseñado para reemplazarse por SSO de Entra ID sin
tocar el resto: solo cambia de dónde sale el campo `usuario`.

Gobierno: los correos listados en `CURADORES` son los únicos que pueden aprobar
prompts y reglas. Todo lo demás se propone.

Almacenamiento: archivo local en `DATOS_DIR` como base, con espejo opcional a
SharePoint (ver `docs/SHAREPOINT.md`). Si SharePoint falla, la escritura se encola
y se reintenta; la herramienta nunca se bloquea por eso.

### Corrección crítica incluida en esta versión

En Sonnet 5 y Opus 5 el razonamiento interno viene **activado por defecto**. Para
una tarea que solo debe devolver JSON, el modelo consumía todo `max_tokens`
razonando y devolvía texto vacío, lo que rompía el parseo. La llamada ahora envía
`thinking: { type: 'disabled' }`. Dos cosas relacionadas que hay que respetar en
estos modelos:

- `thinking: { type: 'enabled', budget_tokens: N }` ya **no existe**: devuelve 400.
  Si algún día se quiere razonamiento, la forma válida es `{ type: 'adaptive' }`.
- `temperature`, `top_p` y `top_k` con valores distintos al default devuelven 400.
  Por eso el cuerpo de la petición no los incluye. No agregarlos.

### Endpoints nuevos

| Método y ruta | Para qué |
|---|---|
| `POST /api/feedback` | Calificar una ejecución y registrar corrección o decisión |
| `GET /api/bitacora` | Listar ejecuciones |
| `GET /api/metricas` | Uso por persona, tasa de éxito, costo 30 días, candidatos |
| `GET/POST /api/biblioteca` | Consultar y proponer prompts |
| `POST /api/biblioteca/:id/estado` | Aprobar u obsoletar (curaduría) |
| `GET/POST /api/reglas` | Consultar y proponer reglas |
| `POST /api/reglas/:id/estado` | Aprobar o descartar (curaduría) |
| `GET /api/export?formato=csv\|json` | Descargar la memoria completa |
| `POST /api/sincronizar` | Forzar el envío de la cola a SharePoint (curaduría) |
| `GET /api/sharepoint/estado` | Diagnóstico del conector (curaduría) |

### Advertencia de despliegue

En hosts con disco efímero (como el plan gratuito de Render) la carpeta `datos/`
se borra en cada despliegue. Mientras SharePoint no esté conectado, exporta la
bitácora antes de redesplegar, o mueve `DATOS_DIR` a un disco persistente.

## Cómo funciona (arquitectura)

```
Navegador (frontend)                    Servidor propio (Node)              Anthropic
────────────────────                    ──────────────────────              ─────────
1. Carga CSV/TSV/TXT
2. Detecta separador, tipos,
   fechas y decimales
3. Calcula un resumen (100% filas)
4. Envía solicitud + resumen + muestra ─▶  /api/analyze  ─────────────────▶  Claude API
                                           (guarda la API key aquí)          (hace el análisis)
6. Renderiza dashboard              ◀───  JSON estructurado         ◀──────  JSON
7. Exporta a PowerPoint (marca)
```

La **API key nunca llega al navegador**: vive solo en el servidor. El frontend habla con `/api/analyze`, y el servidor es quien llama a Anthropic.

---

## Requisitos

- **Node.js 18 o superior** (usa `fetch` nativo).
- Una **API key de Anthropic** con saldo: https://console.anthropic.com

---

## Instalación y ejecución

```bash
# 1. Entrar a la carpeta
cd wom-analytics

# 2. Instalar dependencias
npm install

# 3. Configurar la API key
cp .env.example .env
#    ...y edita .env para poner tu ANTHROPIC_API_KEY

# 4. Arrancar
npm start
```

Abre **http://localhost:3000**. Prueba cargando `ejemplos/funnel_mayo_junio_2026.csv` y escribiendo:

> *"Informe comparativo del comportamiento del funnel en mayo vs junio."*

---

## Configuración (.env)

| Variable | Por defecto | Qué hace |
|---|---|---|
| `ANTHROPIC_API_KEY` | — | **Obligatoria.** Tu key de Anthropic. |
| `ANTHROPIC_MODEL` | `claude-sonnet-5` | Modelo. `claude-sonnet-5` (rápido, 1M contexto) o `claude-opus-4-8` (análisis más profundo). |
| `PORT` | `3000` | Puerto del servidor. |
| `MAX_FILAS_IA` | `5000` | Máximo de filas de la muestra cruda enviada a la IA (control de costo). El resumen estadístico **siempre** cubre el 100% de las filas. |

---

## Despliegue en tu servidor

Es un servidor Node estándar. Opciones típicas:

- **PM2:** `pm2 start server.js --name wom-analytics`
- **systemd:** crea un service que ejecute `node server.js` con las variables de entorno.
- Ponlo detrás de **nginx** con HTTPS si va a ser accesible por el equipo.

Las librerías del frontend (PapaParse, Chart.js, PptxGenJS, SheetJS) se sirven **localmente** desde `public/vendor/` — no dependen de ninguna CDN externa, así funciona detrás de un firewall corporativo.

## Publicar para el equipo sin servidor propio (nube)

Si no tienes servidor, despliega en un host de Node. **Render** tiene plan gratuito suficiente para una herramienta interna (arranca solo, HTTPS automático; en el plan gratis la app "duerme" tras inactividad y tarda ~30–60 s en despertar la primera vez).

1. Sube el proyecto a un repositorio de GitHub (o GitLab).
2. En Render: **New → Web Service** y conecta el repo. Render detecta Node y corre `npm install` y `npm start` solo.
3. En **Environment**, agrega la variable `ANTHROPIC_API_KEY` (y opcional `ANTHROPIC_MODEL`). **No** subas el `.env` al repo.
4. Deploy. Render te da una URL `https://…onrender.com` que compartes con el equipo.

Cada persona entra por esa URL desde su navegador y sube sus propios archivos. **No necesitan cuenta de Claude ni API key**: la key vive solo en el servidor y todas las consultas pasan por tu backend — un único punto de costo que tú controlas.

Nota de arquitectura: el navegador solo habla con `/api/analyze` (mismo origen), así que **no hay problemas de CORS**. El servidor es quien llama a la API de Anthropic (servidor a servidor).

## Publicar en IIS (Windows Server)

IIS no ejecuta Node por sí solo: hay que instalar el módulo **HttpPlatformHandler**, que hace que IIS arranque y administre el proceso de Node. El módulo viejo `iisnode` ya no se usa (sin mantenimiento).

**Requisitos en el servidor (los instala un administrador):**
- **Node.js LTS** (deja `node.exe` normalmente en `C:\Program Files\nodejs\`).
- **IIS** con el módulo **HttpPlatformHandler** (descarga oficial de Microsoft/IIS.net).

**Pasos:**
1. Copia esta carpeta completa al servidor, por ejemplo a `C:\inetpub\wom-analytics\` (incluye `server.js`, `public/`, `node_modules/` y `web.config`).
2. Abre `web.config` y:
   - Reemplaza `PON_AQUI_TU_API_KEY` por tu API key real (o borra esa línea y pon un archivo `.env` con `ANTHROPIC_API_KEY=...`).
   - Verifica que `processPath` apunte al `node.exe` real del servidor.
3. En el **Administrador de IIS**: clic derecho en *Sitios* → **Agregar sitio web**.
   - *Ruta de acceso física:* la carpeta del paso 1.
   - *Enlace:* el puerto/host que uses (ej. 80 y un nombre de host interno).
4. Selecciona el **grupo de aplicaciones** del sitio → *Configuración básica* → **.NET CLR = "Sin código administrado"** (la app no es .NET).
5. Da permiso de **lectura/ejecución** a la identidad del grupo de aplicaciones (`IIS AppPool\<tu-sitio>`) sobre la carpeta, y de **escritura** sobre la subcarpeta `logs\`.
6. Reinicia el sitio y prueba en el navegador:
   - `http://<tu-servidor>/` → debe cargar la interfaz.
   - `http://<tu-servidor>/api/health` → debe responder `{"ok":true,"apiKeyConfigurada":true,...}`.

**Si `/api/health` da 502.5 (falló el arranque de Node):** mira `logs\node.log` — ahí queda el error exacto (ruta de node mal, falta `node_modules`, o key sin configurar).

**Salida a internet:** el servidor debe poder alcanzar `https://api.anthropic.com`. Si la red corporativa filtra la salida por un proxy, hay que habilitar ese dominio; si el proxy exige autenticación, se configura con la variable `HTTPS_PROXY` (pídelo a quien administra la red).

---

## Privacidad de los datos — importante

Elegiste que **la IA haga todo el análisis**. Eso implica que, en cada solicitud, se envían a la API de Anthropic:

- El **resumen estadístico** (agregados por columna).
- Una **muestra de las filas** del archivo (hasta `MAX_FILAS_IA`), en texto.

Consideraciones:

- Anthropic no entrena con los datos enviados por la API.
- Aun así, **no cargues archivos con datos personales de clientes** (cédulas, teléfonos, nombres) salvo que exista aval del área correspondiente. Si necesitas analizar ese tipo de datos, anonimiza o agrega antes de subir.
- Para limitar cuánto se envía, baja `MAX_FILAS_IA`. El diagnóstico global sigue siendo válido porque el resumen abarca el 100% de las filas.

---

## Formatos que entiende

- **Archivos:** `.xlsx` / `.xls` (lee la primera hoja), además de `.csv`, `.tsv` y `.txt`.
- **Separador:** detecta automáticamente `,` `;` o tabulación.
- **Números:** formato colombiano (`1.234.567,89`, `$ 5.000`) e inglés (`1,234,567.89`).
- **Fechas:** `AAAA-MM-DD` y `DD/MM/AAAA` (asume día primero, como en Colombia).
- **Subtotales/notas:** excluye automáticamente filas de subtotal/total (tablas dinámicas) y filas-nota de exportación (ej. "Filtros aplicados: …"). El conteo de filas excluidas se muestra bajo la tabla de esquema.
- **Codificación:** UTF-8 por defecto; si ves caracteres raros, cambia a Windows-1252 o Latin-1 en el selector (solo aplica a CSV/TXT).

Si una columna se detecta con el tipo equivocado, ajústala en la tabla de esquema antes de analizar.

---

## Estructura del proyecto

```
wom-analytics/
├── server.js              Servidor + proxy a la API (aquí vive la key y el prompt de sistema)
├── package.json
├── .env.example           Plantilla de configuración
├── public/
│   ├── index.html         Interfaz
│   ├── styles.css         Sistema de diseño de marca
│   └── app.js             Carga, detección de tipos, render y exportación PPTX
└── ejemplos/
    └── funnel_mayo_junio_2026.csv
```

## Ajustes rápidos

- **Cambiar el rol/enfoque de la IA:** edita `SYSTEM_PROMPT` en `server.js`.
- **Cambiar colores de marca:** variables CSS al inicio de `public/styles.css` y las constantes de color en `exportPPTX()` de `app.js`.
- **Cambiar ejemplos de la interfaz:** arreglo `EJEMPLOS` en `app.js`.
