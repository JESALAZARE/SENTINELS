# Worker de precios (PML) · guía de instalación

Este Worker es la **única puerta** a los datos de mercado del portal:

- **Datos guardados:** precios de 60 días, histórico desde 2020, catálogo de NodosP, tipo de
  cambio y demanda del SEN. Viven en un **bucket privado de Cloudflare R2**, que llenan los
  robots de GitHub Actions. Nada de esto está en el repositorio ni en el sitio.
- **Consultas al CENACE en el momento:** cualquier NodoP del catálogo (SW-PML) y cualquier Zona
  de Carga o Nodo Distribuido (SW-PEND). Guarda las respuestas en la caché de Cloudflare para no
  repetir llamadas.

Seguridad:

- Solo responde a un **cliente con sesión iniciada** que presenta su **pase de datos de
  mercado**. El panel de admin crea un pase por cliente y lo guarda cifrado dentro de su
  bóveda.
- Revisa que el cliente exista y no esté pausado.
- Cada cliente tiene un **límite de consultas**:
  - 400 por hora;
  - 2,000 por día;
  - 150 archivos del histórico por día.
  Así nadie puede descargar todo con un pase. El límite se cuenta en cada centro de datos de
  Cloudflare, así que es aproximado.
- Solo acepta consultas que vengan de `https://sentinels.com.mx`.
- Cada consulta al CENACE abarca máximo **31 días** y **20 NodosP** o **10 Zonas de Carga**.

Todo es gratis dentro de los planes gratuitos de Cloudflare: Workers da 100,000 consultas al
día y R2 da 10 GB.

---

## 1. Crear el Worker (si aún no existe)

1. Entra a <https://dash.cloudflare.com> con la misma cuenta del Worker de Sentinel One.
2. Menú **Compute (Workers) → Workers & Pages → Create → Create Worker**, con la plantilla
   "Hello World". Nómbralo `sentinels-pml` y haz clic en **Deploy**.
3. Copia la URL del Worker. Es algo como `https://sentinels-pml.TU-CUENTA.workers.dev`.

## 2. Bucket privado y llaves de los robots

1. **R2 Object Storage → Create bucket**. Nómbralo `sentinels-mercado` y deja todo lo demás
   igual.
   - **No** actives "Public access", ni "R2.dev subdomain", ni un dominio propio.
2. **R2 Object Storage → Manage API tokens → Create API token**:
   - Permisos: **Object Read & Write**.
   - Buckets: **Apply to specific buckets only** → `sentinels-mercado`.
   - Al crearlo, Cloudflare muestra un **Access Key ID** y un **Secret Access Key**. Solo los
     muestra una vez.
3. En GitHub, en el repositorio, ve a **Settings → Secrets and variables → Actions → New
   repository secret** y crea estos:

   | Nombre                         | Valor                                                       |
   |--------------------------------|-------------------------------------------------------------|
   | `R2_ACCOUNT_ID`                | El Account ID de Cloudflare (aparece en la página de R2). Es el mismo para toda la cuenta: si ya existe, no lo vuelvas a crear |
   | `R2_MERCADO_ACCESS_KEY_ID`     | El Access Key ID del paso 2                                 |
   | `R2_MERCADO_SECRET_ACCESS_KEY` | El Secret Access Key del paso 2                             |
   | `R2_MERCADO_BUCKET`            | `sentinels-mercado`                                         |

   Llevan `MERCADO` en el nombre para no mezclarse con los secrets `R2_ACCESS_KEY_ID`,
   `R2_SECRET_ACCESS_KEY` y `R2_BUCKET` de otro robot del mismo repositorio.

Las llaves solo viven en Cloudflare y en los secrets de GitHub. No las pegues en ningún otro
lugar.

## 3. Configurar el Worker

1. En el Worker: **Edit code**. Borra todo, pega el contenido completo de
   `pml-worker/worker.js` (de este repositorio) y haz clic en **Deploy**.
2. **Settings → Bindings → Add → R2 bucket**:
   - Variable name: `DATOS`.
   - Bucket: `sentinels-mercado`.

   Y otro más, para la pestaña **MEM Insights**:
   - Variable name: `OFERTAS`.
   - Bucket: `sentinels-ofertas` (el bucket privado del Robot de ofertas).
3. **Settings → Variables and Secrets → Add**:

   | Tipo   | Nombre            | Valor                                                |
   |--------|-------------------|------------------------------------------------------|
   | Text   | `ALLOWED_ORIGINS` | `https://sentinels.com.mx`                           |
   | Text   | `SITE_URL`        | `https://sentinels.com.mx`                           |
   | Secret | `DATA_SECRET`     | La llave que genera el panel de admin (paso 4)       |

   Guarda con **Deploy**.

## 4. Llave y pases en el panel de admin

1. Abre el panel de admin → pestaña **Datos de mercado**.
2. Confirma la URL del Worker y haz clic en **Generar llave**.
   - El panel crea el pase de **todos** los clientes y publica el cambio.
   - Te muestra la llave **una sola vez**: pégala en Cloudflare como el secreto `DATA_SECRET`
     del paso 3.
3. Cuando agregues o edites un cliente, el panel le da su pase automáticamente.

## 5. Llenar el bucket y comprobar

1. Llena el bucket: en GitHub, **Actions → "PML CENACE" → Run workflow**.
   - La primera corrida sube al bucket todo lo que aún está en `data/` del repositorio: precios,
     tipo de cambio, catálogo e histórico.
   - A partir de ahí, los robots leen y escriben solo en el bucket.
2. Comprueba en el panel: **Datos de mercado → Probar conexión** debe decir "Conexión correcta
   ✓".
3. Comprueba que no quedó nada abierto. Cualquiera de estas direcciones debe responder 401 o
   403:

   ```
   https://sentinels-pml.TU-CUENTA.workers.dev/datos/nodos/catalogo.json
   https://sentinels-pml.TU-CUENTA.workers.dev/pml?sistema=SIN&proceso=MDA&nodos=06CDU-400&desde=2026-10-01&hasta=2026-10-02
   ```

La carpeta `data/` ya no existe en el repositorio (está en `.gitignore`): el bucket es la única
copia. Si algún día se pierde el bucket, el Robot masivo no arranca (no hay avance) y hay que
volver a cargar el histórico.

---

### Rutas
- `GET /datos/<ruta>.json`: un archivo del bucket. Solo se permiten estas carpetas:
  - `pml/…`: precios de 60 días;
  - `resumen/…`: histórico mensual y avance del Robot;
  - `nodos/catalogo.json`: catálogo de NodosP;
  - `fx/usd-mxn.json`: tipo de cambio;
  - `demanda/…`: demanda del SEN por día.
- `GET /ofertas/<ruta>.json`: un resumen de la pestaña MEM Insights, del bucket `OFERTAS`
  (`resumen/<ruta>.json.gz`, descomprimido por el Worker). Solo resúmenes, nunca las ofertas
  crudas: `curva/…`, `desvio/…`, `costos/…`, `hidro/…`, `compras/…`, `reservas/…`, `ajuste/…`.
- `GET /pml?…` y `GET /pend?…`: consultas al CENACE (SW-PML, SW-PEND).
- `GET /demanda?gerencia=10`: la demanda, generación y pronóstico de hoy, hora por hora, de la
  página "Operación del SEN" del CENACE.
  - Gerencias: 10 = SIN, 1 = Baja California, 2 = Baja California Sur, 3 a 9 = regiones del SIN.
  - Guarda cada respuesta 1 minuto en la caché. El botón ⟳ del widget pide `&fresh=1`, que acepta
    como máximo 15 segundos.
  - CENACE alterna entre dos juegos de valores para las horas ya publicadas; el Worker entrega
    siempre lo que CENACE responde.
- `GET /health`: es pública. Muestra `"configured": true` cuando el Worker ya tiene `DATA_SECRET`
  y el bucket `DATOS`. Con `?cenace=1`, además revisa que el CENACE conteste.
- `GET /admin/check`: solo para el panel de admin, con la llave `DATA_SECRET`.

### Notas
- **Velocidad:** el CENACE tarda de 2 a 15 segundos en contestar una consulta nueva.
  - Las consultas repetidas salen de la caché de Cloudflare al instante.
  - Los días ya publicados se guardan una semana; los recientes, 30 minutos.
  - El navegador del cliente guarda su copia 5 minutos, solo para él.
- **Si actualizas `worker.js`** en el repositorio, vuelve a pegarlo en Cloudflare (Edit code →
  Deploy). Las variables, el secreto y el bucket se conservan.
- **Si se filtra la llave** o quieres cortar todos los pases: en el panel, **Generar nueva** y
  pégala en Cloudflare.
- **Para cortar el acceso de un solo cliente:** pausa al cliente en el panel. El Worker lo
  rechaza en un minuto.
- **Probar en otra dirección** (por ejemplo una copia del sitio): agrega su origen a
  `ALLOWED_ORIGINS`, separado por coma.
