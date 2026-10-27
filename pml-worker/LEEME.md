# Worker de precios (PML) · guía de instalación

Este Worker permite que la pestaña **Market Prices** del portal consulte los precios de
**cualquier NodoP del catálogo del CENACE** (servicio SW-PML) y de **cualquier Zona de Carga o
Nodo Distribuido** (servicio SW-PEND), no solo los que se guardan cada día en el repositorio.
Recibe la consulta del portal, la hace al servicio público del CENACE y guarda las respuestas
en la caché de Cloudflare para no repetir llamadas.

- No necesita llaves ni almacenamiento: los precios del CENACE son públicos.
- Solo acepta consultas que vengan de `https://sentinels.com.mx`.
- Cada consulta abarca máximo **31 días** y **20 NodosP** o **10 Zonas de Carga**.
- Es gratis dentro del plan gratuito de Cloudflare (100,000 consultas al día).

Se hace una sola vez. Tiempo aproximado: 10 minutos.

---

## 1. Crear el Worker

1. Entra a <https://dash.cloudflare.com> con la misma cuenta del Worker de Sentinel One.
2. Menú **Compute (Workers) → Workers & Pages → Create → Create Worker** (plantilla "Hello World").
   Nómbralo `sentinels-pml` y haz clic en **Deploy**.
3. Clic en **Edit code**: borra todo, pega el contenido completo de `pml-worker/worker.js`
   (de este repositorio) y haz clic en **Deploy**.
4. En el Worker: **Settings → Variables and Secrets → Add**:

   | Tipo | Nombre            | Valor                      |
   |------|-------------------|----------------------------|
   | Text | `ALLOWED_ORIGINS` | `https://sentinels.com.mx` |

   Guarda (**Deploy**).
5. Copia la URL del Worker (algo como `https://sentinels-pml.TU-CUENTA.workers.dev`).

## 2. Comprobar que llega al CENACE

Abre en el navegador la URL del Worker seguida de `/health?cenace=1`, por ejemplo:

```
https://sentinels-pml.TU-CUENTA.workers.dev/health?cenace=1
```

- Si responde `"cenace": "reachable"` con `"hours": 24`, el Worker sí llega al CENACE.
- Si responde `"cenace": "unreachable"`, Cloudflare no pudo conectarse al servicio del CENACE.
  En ese caso no actives el paso 3 y avisa para buscar otra opción.

## 3. Conectar el portal

En `client-portal/prices.js`, escribe la URL del Worker en la constante `PML_API`
(sin `/` al final) y publica el cambio:

```js
const PML_API = 'https://sentinels-pml.TU-CUENTA.workers.dev';
```

Mientras `PML_API` esté vacía, la pestaña funciona como antes: solo muestra los NodosP que
se guardan en `data/pml`.

---

### Demanda del SEN (widget del Dashboard)
El mismo Worker atiende `/demanda?gerencia=10`: la demanda, generación y pronóstico de hoy,
hora por hora, que el CENACE publica en su página "Operación del SEN" (10 = SIN, 1 = Baja
California, 2 = Baja California Sur, 3 a 9 = regiones del SIN). Guarda cada respuesta 1 minuto
en la caché, así que el CENACE recibe como máximo una consulta por minuto y región. CENACE alterna entre dos
juegos de valores para las horas ya publicadas; el Worker entrega siempre lo que CENACE responde.
El botón ⟳ del widget pide `&fresh=1`: si la copia guardada tiene más de 15 segundos, el Worker
vuelve a consultar al CENACE (como máximo una consulta cada 15 segundos por región).
El widget "SEN demand" del portal usa esta ruta; después de actualizar `worker.js`, vuelve a
pegarlo en Cloudflare. Para comprobarlo, abre la URL del Worker seguida de
`/demanda?gerencia=10` desde la consola del portal (el Worker rechaza otros orígenes).

### Notas
- **Velocidad:** el CENACE tarda de 2 a 15 segundos en contestar una consulta nueva; mientras
  tanto el portal muestra "Loading … prices from CENACE…". Las consultas repetidas salen de la
  caché de Cloudflare al instante (los días ya publicados se guardan una semana; los recientes,
  30 minutos).
- **NodosP guardados:** si el NodoP y las fechas están dentro de los 60 días que se guardan en
  `data/pml`, el portal los toma de ahí y no llama al Worker.
- **Si actualizas `worker.js`** en el repositorio, vuelve a pegarlo en Cloudflare
  (Edit code → Deploy). La variable `ALLOWED_ORIGINS` se conserva.
- **Probar en otra dirección** (por ejemplo una copia del sitio): agrega su origen a
  `ALLOWED_ORIGINS`, separado por coma.
