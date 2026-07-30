# Conectar la memoria colectiva a SharePoint

Documento para pasar a IT / administración de M365. La herramienta **funciona sin
esto**: mientras las variables `SP_*` estén vacías, la memoria vive en el archivo
local del servidor y se puede exportar a mano. Este documento describe cómo pasar
a sincronización automática.

Trabajo estimado: una hora de un administrador, una sola vez.

---

## 1. Crear el sitio y las tres listas

Crear (o reutilizar) un sitio de SharePoint de acceso **restringido** al equipo de
Ventas Remotas y Digitales. No heredar permisos de un sitio amplio: la bitácora
guarda los prompts escritos por las personas y eso no debería ser público.

Dentro del sitio, crear tres listas con estas columnas de texto. Todas admiten
texto simple salvo donde se indica; el conector aplana arreglos a texto separado
por ` | `.

### Lista `Bitacora_Analisis`
Un elemento por ejecución.

| Columna | Tipo | Qué guarda |
|---|---|---|
| `id` | Texto (**indexar**) | Identificador de la ejecución |
| `fecha` | Texto | Fecha y hora ISO |
| `usuario` | Texto | Correo de quien ejecutó |
| `prompt` | Varias líneas | Solicitud literal |
| `prompt_id_origen` | Texto | Prompt de la biblioteca del que partió |
| `reintento_de` | Texto | Ejecución que corrige |
| `archivo` | Texto | Nombre del archivo |
| `archivo_hash` | Texto | Huella del archivo (no su contenido) |
| `columnas` | Varias líneas | Nombres de columna detectados |
| `filas` | Número | Conteo de filas |
| `modelo` | Texto | Modelo usado |
| `version_system_prompt` | Texto | Versión del prompt base |
| `estado` | Texto | ok / error |
| `tipo_error` | Texto | Clase de error |
| `titulo` | Texto | Título del informe generado |
| `resumen` | Varias líneas | Resumen ejecutivo |
| `calificacion` | Texto | util / no_util |
| `etiqueta_falla` | Texto | Qué falló |
| `que_se_corrigio` | Varias líneas | Corrección registrada |
| `decision_tomada` | Varias líneas | Decisión de negocio |
| `exporto_pptx` | Sí/No | Señal implícita de utilidad |
| `tokens_entrada`, `tokens_salida` | Número | Consumo |
| `costo_usd` | Número (4 decimales) | Costo estimado |
| `duracion_ms` | Número | Duración |

**Indexar la columna `id`.** Sin ese índice, actualizar un elemento existente
(por ejemplo cuando alguien califica un análisis) falla en listas grandes y el
conector inserta un duplicado en su lugar.

### Lista `Biblioteca_Prompts`
`id` (indexar), `titulo`, `texto` (varias líneas), `version` (número),
`reemplaza_a`, `caso_de_uso`, `etiquetas`, `requisitos_de_datos`, `notas`,
`errores_frecuentes`, `ejemplo_ejecucion_id`, `propietario`, `revisor`,
`estado`, `creado`, `actualizado`.

Activar el **versionado de elementos** en la configuración de la lista: es la
capa de gobierno sin escribir código.

### Lista `Reglas_Aprendidas`
`id` (indexar), `texto` (varias líneas), `origen_ejecucion`, `propuesta_por`,
`estado`, `aprobada_por`, `creado`, `actualizado`.

---

## 2. Registrar la aplicación en Entra ID

1. Portal de Entra ID → **App registrations** → New registration.
   Nombre sugerido: `WOM Analytics Workbench`. Sin URI de redirección (es un
   servicio, no una app de usuario).
2. Copiar **Application (client) ID** y **Directory (tenant) ID**.
3. **Certificates & secrets** → New client secret. Copiar el valor (solo se ve
   una vez) y anotar la fecha de expiración para renovarlo.
4. **API permissions** → Microsoft Graph → *Application permissions* →
   `Sites.Selected` → Grant admin consent.

`Sites.Selected` es el permiso correcto: da acceso únicamente a los sitios que se
autoricen explícitamente. No usar `Sites.ReadWrite.All`, que abriría todo
SharePoint de la organización a esta aplicación.

## 3. Autorizar la app sobre ese único sitio

Un administrador de SharePoint concede el permiso al sitio (por ejemplo desde
Graph Explorer o PowerShell), con rol `write` para el `SP_CLIENT_ID` de la app.
Es una operación puntual sobre el sitio creado en el paso 1.

## 4. Obtener el `SP_SITE_ID`

Consultar en Graph: `/sites/{dominio}.sharepoint.com:/sites/{nombre-del-sitio}`.
El campo `id` que devuelve es el valor de `SP_SITE_ID`.

## 5. Cargar las variables en el host

En Render (o el host que corresponda), agregar como variables de entorno:

```
SP_TENANT_ID, SP_CLIENT_ID, SP_CLIENT_SECRET, SP_SITE_ID
```

No hace falta redesplegar código: el conector se activa solo cuando detecta las
cuatro. Verificar con:

- `GET /api/health` → el bloque `sharepoint` debe reportar `activo: true`.
- `GET /api/sharepoint/estado` (solo curaduría) → confirma que el sitio y las
  tres listas responden, y nombra la que falle.
- Botón **Sincronizar a SharePoint** en la pestaña Bitácora → envía la cola
  acumulada.

---

## Qué pasa si SharePoint falla

Nada se pierde. Cada escritura entra a una cola local; si Graph responde error, el
registro se queda en la cola y se reintenta cada cinco minutos. La herramienta
sigue funcionando con el archivo local. El estado de la cola y el último error se
muestran en la pestaña Bitácora.

## Plan B si el registro de app no se aprueba

Un flujo de Power Automate con disparador *Cuando se recibe una solicitud HTTP*
que escriba en las listas, y el servidor haciendo POST a esa URL. Evita el
registro de app porque el flujo corre con la conexión de su propietario. La
contra: ese disparador es conector premium, así que hay que verificar la licencia
antes de tomar este camino.

## Nota de privacidad

Esta memoria guarda **metadatos, no datos**: nombre del archivo, huella, nombres
de columna y conteo de filas. Ninguna fila de datos de clientes se escribe en la
bitácora ni viaja a SharePoint. Lo que sí queda literal es el texto que las
personas escriben como solicitud, y ahí sí puede aparecer información sensible si
alguien la teclea. Por eso el sitio debe ser restringido y conviene recordarlo al
equipo.
