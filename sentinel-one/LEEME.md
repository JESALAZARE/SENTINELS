# Sentinel One · guía de instalación

Sentinel One es el asistente IA del portal de clientes. Usa **Claude Haiku 5.5** a través de un
**Cloudflare Worker** (gratis) que guarda tu llave de Anthropic en secreto, solo deja pasar a
clientes activos y limita el gasto a **$1 USD por cliente al mes**.

Se hace una sola vez. Tiempo aproximado: 20 minutos.

---

## 1. Cuenta de Anthropic y llave de API

1. Entra a <https://console.anthropic.com> y crea tu cuenta.
2. **Settings → Billing**: agrega tu tarjeta y carga un saldo pequeño (por ejemplo $5 USD).
   Recomendado: en **Limits** fija un límite mensual de gasto (por ejemplo $20 USD) como red de seguridad.
3. **API Keys → Create Key**, nómbrala `Sentinel One` y **cópiala** (empieza con `sk-ant-`).
   Solo se muestra una vez; no la pegues en ningún otro lugar que no sea Cloudflare.

## 2. Crear el Worker en Cloudflare

1. Crea una cuenta gratis en <https://dash.cloudflare.com/sign-up>.
2. Menú **Storage & Databases → KV → Create namespace**, nómbralo `sentinel-one`.
3. Menú **Compute (Workers) → Workers & Pages → Create → Create Worker** (plantilla "Hello World").
   Nómbralo `sentinel-one` y haz clic en **Deploy**.
4. Clic en **Edit code**: borra todo, pega el contenido completo de `sentinel-one/worker.js`
   (de este repositorio) y haz clic en **Deploy**.
5. En el Worker: **Settings → Bindings → Add → KV namespace**:
   nombre de variable `S1`, namespace `sentinel-one`. Guarda.
6. **Settings → Variables and Secrets → Add**:

   | Tipo   | Nombre              | Valor                                  |
   |--------|---------------------|----------------------------------------|
   | Secret | `ANTHROPIC_API_KEY` | la llave de Anthropic del paso 1       |
   | Text   | `ALLOWED_ORIGINS`   | `https://sentinels.com.mx`             |
   | Text   | `SITE_URL`          | `https://sentinels.com.mx`             |
   | Text   | `MONTHLY_LIMIT_USD` | `1`                                    |

   (`AI_SECRET` se agrega en el paso 3.)
7. Copia la URL del Worker (algo como `https://sentinel-one.TU-CUENTA.workers.dev`).

## 3. Conectar el panel admin

1. Abre el panel admin → pestaña **Sentinel One**.
2. Pega la URL del Worker y haz clic en **Guardar URL**.
3. Haz clic en **Generar llave**. Cópiala y pégala en Cloudflare como **Secret** llamado
   `AI_SECRET` (Settings → Variables and Secrets → Add). Guarda.
4. Vuelve al panel y haz clic en **Probar conexión**. Debe decir "Conexión correcta ✓".

## 4. Activarlo para un cliente

En **Clientes**, abre al cliente, marca **"Dar acceso al asistente IA en su portal"** y guarda.
En 1–2 minutos le aparece la pestaña **Sentinel One** en su portal.

---

### Notas
- **Costo:** cada pregunta cuesta aproximadamente $0.001 USD. Con el tope, un cliente no puede
  pasar de $1 USD al mes; el contador se reinicia el día 1. Para cambiar el tope, edita
  `MONTHLY_LIMIT_USD` en Cloudflare.
- **Privacidad:** las conversaciones, la memoria y las instrucciones se cifran en el navegador del
  cliente antes de guardarse; el Worker no puede leerlas. Las preguntas sí se envían a Anthropic
  para generar la respuesta.
- **Si generas una llave nueva** en el panel, pégala otra vez en Cloudflare (`AI_SECRET`).
- **Si actualizas `worker.js`** en el repositorio, vuelve a pegarlo en Cloudflare (Edit code → Deploy).
  Las variables, la llave y el almacén se conservan; solo cambia el código.
- **Lectura de recibos PDF con IA** (panel admin → Plantas y recibos): usa el mismo Worker y tu
  llave. Cuesta menos de un centavo de dólar por recibo y aparece en la tabla de uso como
  "Panel admin · lectura de recibos" (no cuenta contra el tope de los clientes).
- **Plan gratuito de Cloudflare KV:** 1,000 escrituras al día (cada pregunta usa ~1–2). Si creces
  mucho, el plan de pago de Workers cuesta $5 USD al mes.

---

## 5. Mapa de red CFE (página "Grid Map" del portal)

El portal muestra las líneas de media tensión de CFE y la capacidad disponible para generación
distribuida de cada circuito alrededor de las coordenadas que el usuario escribe. La red nacional
**no está en el repositorio** (es público): vive en un bucket privado de Cloudflare R2 y solo la
entrega este mismo Worker a clientes con pase válido, en pedazos de ~10 km alrededor del punto
(radio máximo 15 km).

Los archivos se generan en la carpeta local de la red (`Downloads\CFE_Red_MT_Nacional`) con
`node a_celdas.js` → carpeta `celdas\`: `indice.json` (~0.4 MB) y `red_00.bin` (~77 MB).

1. Cloudflare → **Storage & Databases → R2** → activa R2 (plan gratis: 10 GB) → **Create bucket**,
   nómbralo `sentinels-red`. Déjalo **privado** (no actives "Public access").
2. En el bucket, **Upload** → crea la carpeta `red` y sube ahí `indice.json` y `red_00.bin`
   (quedan como `red/indice.json` y `red/red_00.bin`). Si `a_celdas.js` generó más paquetes
   (`red_01.bin`…), súbelos también.
3. En el Worker `sentinel-one`: **Settings → Bindings → Add → R2 bucket**: nombre de variable
   `RED`, bucket `sentinels-red`. Guarda.
4. Vuelve a pegar `sentinel-one/worker.js` (Edit code → Deploy).
5. Prueba: abre `https://sentinel-one.TU-CUENTA.workers.dev/health`; debe decir `"grid":true`.

La pestaña **Grid Map** aparece a los clientes *Supply*, *Comercializador* e *Invitado* que tienen activado
Sentinel One (usa el mismo pase). Para actualizar la red, vuelve a generar las celdas y reemplaza
los archivos en R2 y vuelve a hacer **Deploy** del Worker (el índice se guarda en memoria hasta una hora).

### Buscador de direcciones (Esri)

En Grid Map el usuario puede escribir una dirección, colonia, parque industrial o empresa en lugar
de coordenadas. La búsqueda usa el **World Geocoding Service de Esri** a través de este Worker
(la llave queda oculta aquí). Plan gratis: 20,000 búsquedas al mes.

1. Crea una cuenta gratis de **ArcGIS Location Platform** en <https://location.arcgis.com/sign-up/>.
2. En el portal de desarrollador: **Content → New item → Developer credentials → API key credentials**.
   Nómbrala `Sentinels Grid`. En **Privileges** marca solo **Location services → Geocoding**
   (no marques "stored" / almacenamiento). Fecha de expiración: la más lejana que permita
   (anota cuándo vence para renovarla).
3. Genera y **copia** la llave (empieza con `AAPT`).
4. En el Worker `sentinel-one`: **Settings → Variables and Secrets → Add** → tipo **Secret**,
   nombre `ESRI_KEY`, valor la llave. Guarda.
5. Vuelve a pegar `sentinel-one/worker.js` (Edit code → Deploy).
6. Prueba: `/health` debe decir `"geocode":true`.

Sin la llave, Grid Map sigue funcionando con coordenadas y enlaces de Google Maps; solo la
búsqueda por dirección muestra "Address search is not enabled yet".
