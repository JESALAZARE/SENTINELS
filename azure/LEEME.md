# Azure SQL · histórico de precios · guía de instalación

Esta guía conecta el histórico horario de precios (PML por NodoP y PEND por Zona de Carga)
con una base de datos **Azure SQL gratuita**. Ahí quedan **Views SQL** listas para analizar con
Excel, Power BI o cualquier herramienta SQL.

**Cómo funciona:**
- El Robot de GitHub (`historico.yml`) sigue descargando los precios del CENACE al repositorio.
- Una vez al día, el workflow `azure-sync.yml` copia a Azure **solo las horas nuevas**. No vuelve
  a consultar al CENACE.
- El portal sigue leyendo los archivos del repositorio, así que no despierta la base y responde
  al instante.

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

## 6. Primera sincronización

1. En GitHub abre **Actions → "Azure SQL · histórico" → Run workflow**.
2. La primera vez puede tardar unos minutos, porque crea las tablas y las Views, sube todo el
   histórico que ya hay y despierta la base si estaba pausada.
3. Abre la corrida → paso **"Sincronizar con Azure SQL"**. Debe terminar con
   `Listo: N horas sincronizadas.` y una línea `Azure · …` por cada NodoP o zona.

Desde ahí corre sola todos los días a las 06:20 (hora centro de México).

## 7. Consultar las Views

**En el portal de Azure:** base → **Query editor**:

```sql
SELECT * FROM dbo.v_anual         WHERE clave = '06CDU-400' ORDER BY proceso, anio;
SELECT * FROM dbo.v_mensual       WHERE clave = 'MONTERREY' AND proceso = 'MDA' ORDER BY mes;
SELECT * FROM dbo.v_mda_vs_mtr    WHERE clave = '06CDU-400' ORDER BY fecha DESC;
SELECT * FROM dbo.v_cobertura;    -- qué tan completo está el histórico
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
| `v_precios` | Cada hora con su NodoP o zona (base de las demás) |
| `v_diario` | Promedio, máximo y mínimo por día |
| `v_mensual` | Promedio, máximo y mínimo por mes |
| `v_anual` | Promedio, máximo y mínimo por año |
| `v_perfil_horario` | Precio promedio de cada hora del día, por año |
| `v_extremos_anual` | La hora del precio máximo y mínimo de cada año, con sus componentes |
| `v_mda_vs_mtr` | Diferencia diaria entre MTR y MDA |
| `v_cobertura` | Desde y hasta dónde llega el histórico de cada NodoP o zona |

### Notas
- **Costo:** con la oferta gratuita y *Auto-pause* no hay cargos. La sincronización diaria usa
  unos minutos de cómputo al mes, muy por debajo del límite gratis.
- **Arranque en frío:** si la base estaba pausada, la primera consulta tarda de 30 a 60 segundos
  en responder; después responde rápido. Por eso el portal no consulta Azure en vivo.
- **Qué NodosP y zonas se guardan:** los de `scripts/historico-lista.json`. Al agregar uno, el
  Robot descarga su histórico y la siguiente sincronización lo sube a Azure.
- **Para cambiar la contraseña del Robot:** en el Query editor,
  `ALTER USER robot_sentinels WITH PASSWORD = '…';` y actualiza el secret `AZURE_SQL_PASSWORD`.
