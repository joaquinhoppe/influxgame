# 🪢 Tira y Afloja desigual — InfluxDB Tag vs Field

Juego competitivo para el aula (~30 personas, celulares + proyector) que demuestra, **jugándolo**, la diferencia
de indexación entre **Tags** y **Fields** en InfluxDB.

## La idea

Se divide la clase en Equipo 🔴 Rojo y Equipo 🔵 Azul. Cada persona tira de la soga tocando un botón en su celular;
el proyector muestra la soga moviéndose. Pero el juego está arreglado:

| Equipo | Cómo se guarda cada click | Cómo lo busca InfluxDB |
|--------|---------------------------|------------------------|
| 🔴 Rojo | **Tag**: `clicks,equipo=rojo value=1` | índice de tags (rápido) |
| 🔵 Azul | **Field**: `clicks equipo_field="azul"` | escaneo de valores (lento) |

El proyector consulta ambos conteos con Flux. Los dos equipos tocan igual de rápido, pero el conteo azul llega tarde
(~1 s con millones de puntos), así que **el Rojo gana casi siempre**. Al final se revela la trampa:
diseñar mal qué dato es Tag y cuál es Field arruina el rendimiento en bases de series temporales.

## Cómo se juega

1. `docker compose up` — el log imprime las URLs públicas (cloudflared) y un QR.
2. El proyector (`/`) muestra un **QR** en el lobby; la gente entra desde `/play` y se asigna equipo y emoji equitativamente.
3. Admin (`/admin`) o teclas en el proyector: **S** iniciar · **N** volver al lobby · **R** revelar la trampa (muestra los ms de cada consulta).
4. Quien entre con la ronda en curso es **espectador**. El final de la soga se adapta al número de jugadores.
5. El panel admin tiene una **simulación** con bots (cantidad y clicks/s configurables) para ensayar o repetir la demo.

## Puesta en marcha

```bash
cp .env.example .env     # ajusta ADMIN_KEY, puertos, etc.
docker compose up        # app + InfluxDB 2.7 + tunnel de cloudflared
```

La primera vez siembra ~4M de puntos históricos (`SEED_POINTS`) para que el escaneo del field pese de verdad
(tarda un par de minutos). La URL pública cambia cada vez que se recrea el contenedor `tunnel`.

### Configuración (`.env`)

| Variable | Descripción |
|----------|-------------|
| `ADMIN_KEY` | clave del panel admin y de las teclas del proyector |
| `PORT` / `INFLUX_PORT` | puertos del host para el juego y para InfluxDB |
| `INFLUX_*` | usuario, contraseña, token, organización y bucket |
| `SEED_POINTS` | puntos históricos por tipo (más = azul más lento) |
| `WIN_PER_PLAYER`, `WIN_MIN`, `WIN_MAX` | ventaja para ganar = jugadores × `WIN_PER_PLAYER` |

## Estructura

- `docker-compose.yml` — InfluxDB, app Node y tunnel cloudflared
- `app/server.js` — juego, fases de la ronda, escritura/consultas Flux, simulación
- `app/public/` — `index.html` (proyector), `play.html` (celular), `admin.html`
