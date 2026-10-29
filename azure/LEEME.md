# Azure SQL · histórico de precios · guía de instalación

Esta guía conecta el histórico horario de precios **desde 2020** de **todos los NodosP (PML) y
Zonas de Carga (PEND)** del catálogo del CENACE con una base de datos **Azure SQL gratuita**. Ahí
quedan **Views SQL** listas para analizar con Excel, Power BI o cualquier herramienta SQL.

**Cómo funciona** (workflow `historico-masivo.yml`, una vez al día):
1. El Robot descarga del CENACE hasta ~4 horas, **sin tocar Azure**, pidiendo 20 NodosP o
   10 zonas por llamada. Primero baja los días nuevos y después el histórico, de lo más
   reciente hacia 2020.
2. Abre la base **una sola vez**: carga todo en bloque y recalcula los resúmenes solo de los
   meses que tocó. La base gratuita gasta cómputo mientras está despierta, por eso se abre una
   vez al día y no en cada consulta.
3. Publica en el bucket privado de Cloudflare R2 un resumen mensual pequeño por NodoP o zona
   (`resumen/`; ver `pml-worker/LEEME.md`), que
   es lo que muestra el portal en **Market Prices → Long-term history**. El portal nunca
   consulta Azure en vivo.

La carga inicial de todo el catálogo desde 2020 tarda **unos 10 días**. Si en algún mes se acaba
el cómputo gratis, la base se pausa (sin cobro) y la carga sigue el mes siguiente.

Se hace una sola vez. Tiempo aproximado: 30 minutos.

---

## 1. Cuenta de Azure

1. Entra a <https://azure.microsoft.com/free> y haz clic en **Comenzar gratis**. Usa una cuenta
   Microsoft de la empresa.
2. Azure pide una tarjeta solo para verificar identidad. La base de esta guía usa la **oferta
   gratuita** y queda configurada para **no cobrar nunca** (paso 2.6).

## 2. Crear la base de datos gratuita

1. En <https://portal.azure.com>, busca **"Azure SQL"** y abre **Create → SQL databases →
   Single database**.
2. Arriba aparece el aviso **"Want to try Azure SQL Database for free?"**: haz clic en
   **Apply offer**. Si no aparece, revisa que la suscripción no tenga ya 10 bases gratuitas.
3. Llena así:

   | Campo | Valor |
   |---|---|
   | Resource group | **Create new** → `sentinels` |
   | Database name | `sentinels-historico` |
   | Server | **Create new**: nombre `sentinels-mem` (si está ocupado, agrega algo, p. ej. `sentinels-mem-01`); región cercana (p. ej. *South Central US* o *Mexico Central* si aparece) |
   | Authentication method | **Use SQL authentication**: usuario administrador (p. ej. `admin_sentinels`) y una contraseña larga. **Guárdala solo tú**, no se la pases a nadie ni la pegues en el repositorio |

4. En **Networking**:
   - *Connectivity method*: **Public endpoint**.
   - *Allow Azure services and resources to access this server*: **No**.
   - *Add current client IP address*: **Yes** (para que tú entres desde tu computadora).
   - *Minimum TLS version*: **1.2**.
5. Deja lo demás como está y haz clic en **Review + create → Create**. Tarda unos minutos.
6. Ya creada, abre la base → **Compute + storage** (o **Free offer**) y confirma que
   *Behavior when free offer limit is reached* diga **Auto-pause the database until next month**.
   Así nunca hay cobro: si se acaba el cómputo gratis del mes, la base se pausa.

## 3. Permitir la conexión de GitHub

Los servidores de GitHub cambian de dirección IP en cada corrida, así que hay que abrir el firewall:

1. Abre el **servidor** `sentinels-mem` → **Networking** → *Firewall rules* → **Add a firewall rule**.
2. Nombre `GitHubActions`, *Start IP* `0.0.0.0`, *End IP* `255.255.255.255` → **Save**.

> La conexión siempre va cifrada (TLS) y exige usuario y contraseña. Por eso el paso 4 crea un
> usuario solo para el Robot, con una contraseña larga y sin permisos de administrador.

## 4. Crear el usuario del Robot

1. Abre la **base** `sentinels-historico` → **Query editor (preview)** y entra con el usuario
   administrador del paso 2.3.
2. Pega esto, cambia la contraseña por una nueva y larga (al menos 20 caracteres, distinta a la
   del administrador) y haz clic en **Run**:

   ```sql
   CREATE USER robot_sentinels WITH PASSWORD = 'Escribe-aqui-una-contraseña-larga-y-nueva-2026!';
   ALTER ROLE db_datareader ADD MEMBER robot_sentinels;
   ALTER ROLE db_datawriter ADD MEMBER robot_sentinels;
   ALTER ROLE db_ddladmin  ADD MEMBER robot_sentinels;
   ```

   Debe decir *Query succeeded*. Este usuario solo existe dentro de esta base: puede crear las
   tablas y Views del histórico y escribir precios, pero no administrar el servidor.

## 5. Guardar la conexión en GitHub (Secrets)

En GitHub, abre el repositorio → **Settings → Secrets and variables → Actions → New repository
secret** y crea estos cuatro:

| Name | Value |
|---|---|
| `AZURE_SQL_SERVER` | el nombre completo del servidor, p. ej. `sentinels-mem.database.windows.net` (aparece en *Overview* de la base como *Server name*) |
| `AZURE_SQL_DATABASE` | `sentinels-historico` |
| `AZURE_SQL_USER` | `robot_sentinels` |
| `AZURE_SQL_PASSWORD` | la contraseña del paso 4 |

GitHub guarda los Secrets cifrados. Nadie puede volver a verlos, ni siquiera tú: solo se usan
dentro de los workflows.

## 6. Ajustar el cómputo de la base (recomendado)

En la base `sentinels-historico` → **Settings → Compute + storage**:

- **Max vCores: 1.** Con más vCores la carga va más rápido, pero gasta el cómputo gratis más
  rápido.
- **Auto-pause delay:** el mínimo que permita (por ejemplo 15 minutos o 1 hora). Es el tiempo
  que la base sigue despierta, gastando, después de la carga diaria.
- Confirma otra vez que *Behavior when free limit is reached* sea **Auto-pause … until next
  month**.

## 7. Primera corrida del Robot

1. En GitHub abre **Actions → "Histórico masivo (Azure SQL)" → Run workflow**.
2. Tarda hasta ~5 horas: unas 4 horas de descarga del CENACE y luego la carga en Azure.
3. Abre la corrida → paso **"Descargar, cargar en Azure y resumir"**. Al final debe decir
   `Azure: … horas nuevas`, `Portal: … resúmenes actualizados` y `Avance: …%`.

Desde ahí corre sola todos los días a las 02:10 (hora centro de México). En unos 10 días termina
la carga desde 2020; después cada corrida solo agrega los días nuevos.

## 8. Consultar las Views

**En el portal de Azure:** base → **Query editor**:

```sql
-- Rápidas (sobre los resúmenes), para todo el catálogo:
SELECT * FROM dbo.v_resumen_anual   WHERE clave = '06CDU-400' ORDER BY proceso, anio;
SELECT * FROM dbo.v_resumen_mensual WHERE clave = 'MONTERREY' AND proceso = 'MDA' ORDER BY mes;
SELECT * FROM dbo.v_cobertura;      -- qué tan completo está el histórico
-- Detalle horario o diario (filtra siempre por clave y fechas: son cientos de millones de horas):
SELECT * FROM dbo.v_mda_vs_mtr WHERE clave = '06CDU-400' AND fecha >= '2025-01-01' ORDER BY fecha;
```

**En Excel:** *Datos → Obtener datos → Desde Azure → Desde Azure SQL Database*. Servidor
`sentinels-mem.database.windows.net`, base `sentinels-historico`, *Base de datos* → tu usuario.
Elige una View y **Cargar** (o **Transformar** para filtrar).

**En Power BI:** *Obtener datos → Azure SQL Database* con los mismos datos.

> Para análisis conviene un usuario solo de lectura (no el administrador):
> `CREATE USER analista WITH PASSWORD = '…'; ALTER ROLE db_datareader ADD MEMBER analista;`

---

### Views disponibles

| View | Qué contiene |
|---|---|
| `v_resumen_mensual` | **Rápida.** Promedio, componentes, máximo y mínimo (con fecha y hora) por mes |
| `v_resumen_anual` | **Rápida.** Promedio, máximo y mínimo por año |
| `v_resumen_perfil` | **Rápida.** Precio promedio de cada hora del día, por año |
| `v_precios` | Cada hora con su NodoP o zona (base de las demás) |
| `v_diario` | Promedio, máximo y mínimo por día |
| `v_mensual` | Promedio, máximo y mínimo por mes |
| `v_anual` | Promedio, máximo y mínimo por año |
| `v_perfil_horario` | Precio promedio de cada hora del día, por año |
| `v_extremos_anual` | La hora del precio máximo y mínimo de cada año, con sus componentes |
| `v_mda_vs_mtr` | Diferencia diaria entre MTR y MDA |
| `v_cobertura` | **Rápida.** Desde y hasta qué mes llega el histórico de cada NodoP o zona |

Las Views sin "rápida" leen la tabla horaria completa: filtra siempre por `clave` y por fechas.

### Notas
- **Costo:** con la oferta gratuita y *Auto-pause* no hay cargos. Si en un mes se acaba el
  cómputo gratis, la base se pausa hasta el mes siguiente y el Robot continúa entonces.
- **Arranque en frío:** si la base estaba pausada, la primera consulta tarda de 30 a 60 segundos
  en responder; después responde rápido. Por eso el portal no consulta Azure en vivo.
- **Qué se guarda:** todos los NodosP y Zonas de Carga del catálogo vigente (`data/nodos`),
  desde el 1 de enero de 2020. Si el CENACE agrega un NodoP, el Robot carga su histórico en las
  siguientes corridas.
- **Resúmenes del portal:** solo meses cerrados (el MTR de un mes está completo 7 días después
  de que termina). Se reescriben al cerrar cada mes o al llegar historia nueva, para que el
  repositorio crezca poco.
- **Para cambiar la contraseña del Robot:** en el Query editor,
  `ALTER USER robot_sentinels WITH PASSWORD = '…';` y actualiza el secret `AZURE_SQL_PASSWORD`.
