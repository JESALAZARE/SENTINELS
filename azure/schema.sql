/* ── Sentinels · Azure SQL · histórico de precios del MEM ───────────────
   Almacén del histórico horario de PML (NodosP, SW-PML) y PEND (Zonas de Carga,
   SW-PEND). Solo se guarda una tabla de hechos (precios_hora); todo el análisis
   son VIEWS. Lo aplica scripts/sync-azure.mjs en cada corrida (es idempotente:
   crea lo que falta y actualiza las views), así que no hay que ejecutarlo a mano.
   Los bloques se separan con GO. */

IF OBJECT_ID('dbo.entidades') IS NULL
CREATE TABLE dbo.entidades (
  id      smallint IDENTITY(1,1) NOT NULL CONSTRAINT pk_entidades PRIMARY KEY,
  tipo    varchar(4)  NOT NULL,   -- 'nodo' (NodoP) | 'zona' (Zona de Carga / Nodo Distribuido)
  sistema char(3)     NOT NULL,   -- SIN | BCA | BCS
  clave   varchar(40) NOT NULL,   -- clave del NodoP o nombre de la Zona de Carga
  CONSTRAINT uq_entidades UNIQUE (tipo, sistema, clave)
);
GO

-- Una fila por entidad, mercado, día y hora. Compresión PAGE: el histórico completo
-- de un NodoP desde 2016 (~180,000 filas) ocupa unos pocos MB.
IF OBJECT_ID('dbo.precios_hora') IS NULL
CREATE TABLE dbo.precios_hora (
  entidad_id smallint      NOT NULL CONSTRAINT fk_precios_entidad REFERENCES dbo.entidades(id),
  proceso    char(3)       NOT NULL,   -- MDA | MTR
  fecha      date          NOT NULL,   -- día de operación
  hora       tinyint       NOT NULL,   -- 1..24 (hora que termina)
  precio     decimal(12,2) NOT NULL,   -- PML o PEND ($/MWh) = energía + pérdidas + congestión
  energia    decimal(12,2) NULL,
  perdidas   decimal(12,2) NULL,
  congestion decimal(12,2) NULL,
  CONSTRAINT pk_precios_hora PRIMARY KEY (entidad_id, proceso, fecha, hora) WITH (DATA_COMPRESSION = PAGE)
);
GO

IF OBJECT_ID('dbo.sync_log') IS NULL
CREATE TABLE dbo.sync_log (
  id         int IDENTITY(1,1) NOT NULL CONSTRAINT pk_sync_log PRIMARY KEY,
  ejecutado  datetime2(0)  NOT NULL CONSTRAINT df_sync_log DEFAULT SYSUTCDATETIME(),
  filas      int           NOT NULL,
  detalle    nvarchar(4000) NULL
);
GO

/* ── Views ─────────────────────────────────────────────────────────── */

-- Base legible: precios con la entidad
CREATE OR ALTER VIEW dbo.v_precios AS
SELECT e.tipo, e.sistema, e.clave, p.proceso, p.fecha, p.hora, p.precio, p.energia, p.perdidas, p.congestion
FROM dbo.precios_hora p JOIN dbo.entidades e ON e.id = p.entidad_id;
GO

CREATE OR ALTER VIEW dbo.v_diario AS
SELECT tipo, sistema, clave, proceso, fecha,
       AVG(precio) AS precio_prom, AVG(energia) AS energia_prom, AVG(perdidas) AS perdidas_prom, AVG(congestion) AS congestion_prom,
       MAX(precio) AS precio_max, MIN(precio) AS precio_min, COUNT(*) AS horas
FROM dbo.v_precios
GROUP BY tipo, sistema, clave, proceso, fecha;
GO

CREATE OR ALTER VIEW dbo.v_mensual AS
SELECT tipo, sistema, clave, proceso, DATEFROMPARTS(YEAR(fecha), MONTH(fecha), 1) AS mes,
       AVG(precio) AS precio_prom, AVG(energia) AS energia_prom, AVG(perdidas) AS perdidas_prom, AVG(congestion) AS congestion_prom,
       MAX(precio) AS precio_max, MIN(precio) AS precio_min, COUNT(*) AS horas
FROM dbo.v_precios
GROUP BY tipo, sistema, clave, proceso, DATEFROMPARTS(YEAR(fecha), MONTH(fecha), 1);
GO

CREATE OR ALTER VIEW dbo.v_anual AS
SELECT tipo, sistema, clave, proceso, YEAR(fecha) AS anio,
       AVG(precio) AS precio_prom, AVG(energia) AS energia_prom, AVG(perdidas) AS perdidas_prom, AVG(congestion) AS congestion_prom,
       MAX(precio) AS precio_max, MIN(precio) AS precio_min, COUNT(*) AS horas
FROM dbo.v_precios
GROUP BY tipo, sistema, clave, proceso, YEAR(fecha);
GO

-- Perfil horario: precio promedio de cada hora del día, por año
CREATE OR ALTER VIEW dbo.v_perfil_horario AS
SELECT tipo, sistema, clave, proceso, YEAR(fecha) AS anio, hora, AVG(precio) AS precio_prom, COUNT(*) AS dias
FROM dbo.v_precios
GROUP BY tipo, sistema, clave, proceso, YEAR(fecha), hora;
GO

-- Hora del precio máximo y mínimo de cada año, con sus componentes
CREATE OR ALTER VIEW dbo.v_extremos_anual AS
SELECT tipo, sistema, clave, proceso, anio, CASE WHEN rn_max = 1 THEN 'max' ELSE 'min' END AS extremo,
       fecha, hora, precio, energia, perdidas, congestion
FROM (
  SELECT *, YEAR(fecha) AS anio,
         ROW_NUMBER() OVER (PARTITION BY tipo, sistema, clave, proceso, YEAR(fecha) ORDER BY precio DESC, fecha, hora) AS rn_max,
         ROW_NUMBER() OVER (PARTITION BY tipo, sistema, clave, proceso, YEAR(fecha) ORDER BY precio ASC, fecha, hora) AS rn_min
  FROM dbo.v_precios
) x
WHERE rn_max = 1 OR rn_min = 1;
GO

-- MDA contra MTR por día (diferencia de precio promedio)
CREATE OR ALTER VIEW dbo.v_mda_vs_mtr AS
SELECT a.tipo, a.sistema, a.clave, a.fecha,
       a.precio_prom AS mda_prom, b.precio_prom AS mtr_prom, b.precio_prom - a.precio_prom AS diferencia
FROM dbo.v_diario a
JOIN dbo.v_diario b ON b.tipo = a.tipo AND b.sistema = a.sistema AND b.clave = a.clave AND b.fecha = a.fecha AND b.proceso = 'MTR'
WHERE a.proceso = 'MDA';
GO

-- Avance del histórico por entidad y mercado
CREATE OR ALTER VIEW dbo.v_cobertura AS
SELECT tipo, sistema, clave, proceso, MIN(fecha) AS desde, MAX(fecha) AS hasta, COUNT(*) AS horas
FROM dbo.v_precios
GROUP BY tipo, sistema, clave, proceso;
GO
