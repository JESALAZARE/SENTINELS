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
