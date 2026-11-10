# 🎬 Guión de la experiencia práctica — "Tira y Afloja desigual"

**Duración estimada:** 25–30 min · **Audiencia:** ~30 personas · **Formato:** competitivo, celulares + proyector

---

## 1. Objetivo

Que la audiencia **viva en carne propia** que, en una base de datos de series temporales, decidir mal qué dato es
*Tag* y cuál es *Field* degrada el rendimiento. No se explica primero: se juega, se siente la injusticia y recién
después se revela el porqué.

Al terminar, cada participante debería poder:

- Explicar qué es un **Tag** y qué es un **Field** en InfluxDB.
- Decir por qué filtrar por Tag es rápido y filtrar por Field es lento.
- Reconocer que el modelo de datos (qué va en Tag y qué en Field) es una decisión de diseño con impacto real.

## 2. Concepto que demuestra

**La diferencia de indexación entre Tags y Fields en InfluxDB.**

| | Tag | Field |
|---|---|---|
| Indexado | **Sí** (índice de series, en memoria) | **No** |
| Búsqueda | Salta directo a las series que coinciden | Hay que leer y comparar los valores guardados |
| Uso recomendado | Metadatos con pocos valores distintos que se usan para filtrar o agrupar | Los valores medidos |

**La trampa del juego.** Cada click se guarda distinto según el equipo:

```
🔴 Rojo → Tag:    clicks,equipo=rojo value=1          (filtro: r.equipo == "rojo")
🔵 Azul → Field:  clicks equipo_field="azul"          (filtro: r._value == "azul")
```

El proyector consulta ambos conteos con Flux para mover la soga:

```flux
// Rojo — filtra por tag (índice)
from(bucket: "tirayafloja") |> range(start: -24h)
  |> filter(fn: (r) => r._measurement == "clicks" and r.equipo == "rojo" and r._field == "value")
  |> count()

// Azul — filtra por field (escaneo de valores)
from(bucket: "tirayafloja") |> range(start: -24h)
  |> filter(fn: (r) => r._measurement == "clicks" and r._field == "equipo_field" and r._value == "azul")
  |> count()
```

Ambos equipos tocan igual de rápido, pero el conteo azul llega con retraso. Con los ~4M de puntos históricos
sembrados, la consulta del tag tarda **~5–20 ms** y la del field **~0,3–1,2 s** (medido en el ensayo).
**El retraso es real: el código no mete ningún delay artificial.**

> **Nota de rigor.** La explicación "Tag = RAM / Field = disco" es una simplificación didáctica. Más exacto:
> los tags están en un índice de series; los fields no se indexan y se leen de los bloques de datos al filtrar.
> Y en SQL sí se puede indexar cualquier columna, pero hay que **decidirlo y crear el índice**: en InfluxDB la
> decisión se toma al modelar los datos y no se puede cambiar después.

## 3. Materiales

**Del presentador**
- Laptop con **Docker + Docker Compose** y acceso a internet (el tunnel de cloudflared necesita salida a internet).
- Proyector o pantalla grande, con el navegador en pantalla completa (F11).
- Este repositorio clonado, con el `.env` creado (`cp .env.example .env`).

**De la audiencia**
- Un celular por persona con navegador y datos o wifi. No hay que instalar nada.

**Opcional**
- Un segundo dispositivo (el celular del presentador) abierto en `/admin` para controlar sin tocar el teclado.

## 4. Preparación (antes de la clase)

1. `cp .env.example .env` y cambia `ADMIN_KEY`.
2. `docker compose up` — **la primera vez tarda unos minutos** porque siembra ~4M de puntos históricos.
3. Espera el banner en la terminal con las URLs (Proyector, Celulares, Admin) y el QR.
4. Abre el **proyector** (`/`) en pantalla completa y el **admin** (`/admin`) en el celular o en otra pestaña.
5. **Ensayo con simulación:** en el admin, activa *Simular partida* (30 bots a 5 clicks/s), pulsa **R** para
   revelar y comprueba que el rojo gana y que el azul muestra una latencia mucho mayor. Luego detén la simulación
   y vuelve al lobby (**N**).
6. Si el efecto es poco visible, sube `SEED_POINTS`; si las rondas duran demasiado, baja `WIN_PER_PLAYER`.

> ⚠️ La URL de cloudflared cambia cada vez que se recrea el contenedor `tunnel`. Si reinicias, el QR del
> proyector se actualiza solo, pero la URL vieja deja de funcionar.

## 5. Secuencia de pasos

| # | Tiempo | Qué pasa | Quién actúa | Acción en el sistema |
|---|--------|----------|-------------|----------------------|
| 1 | 2 min | **Presentación del juego.** "Vamos a competir: Rojo contra Azul, tiren de la soga tocando el botón. Gana quien saque ventaja." **No mencionar la trampa.** | Presentador | Proyector en lobby, **trampa oculta** |
| 2 | 3 min | **Entrada.** La audiencia escanea el QR y entra. El sistema asigna equipo y emoji de forma equilibrada (diferencia máxima de 1). Se ven los emojis aparecer en cada lado. | Audiencia | — |
| 3 | 1 min | **Reglas.** Quien llegue tarde será espectador. Verificar que haya ~15 por equipo. | Presentador | Opcional: mostrar a un espectador tardío |
| 4 | 1 min | **Cuenta atrás** 3-2-1-¡YA! y la ronda arranca. | Presentador | Pulsar **S** (o *Iniciar ronda* en `/admin`) |
| 5 | 2–3 min | **Ronda 1.** Todos tocan lo más rápido posible. El Rojo va ganando casi siempre. El presentador comenta con neutralidad. El final de la soga se ajusta al número de jugadores. | Audiencia | — |
| 6 | 2 min | **Reacción.** Gana Rojo. Preguntar al equipo azul: *"¿Qué sintieron? ¿Tocaron igual de rápido?"* Dejar que digan "había lag", "no respondía", "estaba arreglado". | Audiencia / presentador | — |
| 7 | 5 min | **Revelación.** Pulsar **R**: aparecen en pantalla TAG·RAM y FIELD·DISCO con los **ms de cada consulta**. Explicar cómo se guardó cada equipo y mostrar las dos consultas Flux. | Presentador | Pulsar **R** (revelar) |
| 8 | 5 min | **Repetición en vivo con bots.** Con la trampa ya visible, volver al lobby (**N**) y activar la *simulación* con los mismos clicks para ambos. Ver en tiempo real cómo el azul va a la zaga aunque tocan lo mismo. Subir `Clicks/bot` o `Bots` para exagerar el efecto. | Presentador | `/admin` → *Simular partida*, ajustar bots y clicks/s |
| 9 | 5 min | **Cierre y discusión.** Ver sección 7. | Todos | — |

**Teclas del proyector:** `S` iniciar ronda · `N` volver al lobby · `R` revelar/ocultar la trampa
(piden la clave de admin la primera vez).

## 6. Rol de la audiencia

- **Jugadores (Rojo / Azul).** Todos los que escaneen el QR **antes** de que empiece la ronda entran como
  jugadores. Cada uno recibe equipo y emoji automáticamente, y su única tarea es tocar el botón lo más rápido
  posible. Son el "cobaya" de la demostración: sienten la diferencia antes de entenderla.
- **Espectadores.** Quien entre con la ronda en curso no puede tocar ni se le asigna equipo. Ve el marcador en su
  celular y entra solo como jugador cuando vuelva el lobby con el QR. Sirve para mostrar que el sistema no acepta
  entradas a mitad de partida.
- **Equipo Azul como testigo clave.** Son quienes sufren el retraso. Sus comentarios espontáneos ("no
  respondía", "estaba arreglado") son el gancho de la explicación final.
- **Equipo Rojo.** Gana sin saber por qué. La pregunta *"¿ganaron por ser mejores?"* abre la discusión sobre
  sesgos del sistema de medición.

El presentador es quien opera el juego (admin) y guía la reflexión.

## 7. Explicación final y cierre

> *"El juego estaba arreglado. A InfluxDB le pedíamos que contara los clicks de ambos equipos. Pero al Equipo
> Rojo lo indexamos por TAG (búsqueda instantánea mediante índice), y al Azul por FIELD (búsqueda lenta,
> escaneando los valores guardados). Esto demuestra que, en bases de series temporales, diseñar mal qué dato es
> Tag y qué dato es Field arruina el rendimiento."*

**Ideas para cerrar**
- Los **tags** son para metadatos con pocos valores distintos por los que filtrás o agrupás (host, región, equipo).
- Los **fields** son los valores medidos (temperatura, cantidad de clicks) y no se indexan.
- No hay vuelta atrás fácil: elegir mal exige **reescribir los datos**.
- Comparación con SQL: allí cualquier columna puede indexarse con `CREATE INDEX`; en InfluxDB la decisión se toma
  al modelar la escritura.
- Contrapunto: poner **todo** como tag con valores casi únicos tampoco sirve (explota la cardinalidad de series).
  Hay que elegir bien, no solo "todo a tag".

**Preguntas para la discusión**
1. ¿Qué habrían medido si solo hubieran mirado el marcador sin ver la latencia?
2. ¿Cómo detectarían en producción que un campo debería ser un tag?
3. ¿Qué pasa si convertimos en tag algo con millones de valores distintos?

## 8. Plan B y problemas frecuentes

| Problema | Solución |
|----------|----------|
| El tunnel no da URL | `docker compose logs tunnel`; usar `http://IP-local:PORT/play` si todos están en la misma red wifi |
| El rojo gana demasiado rápido o el azul casi no se atrasa | Ajustar `SEED_POINTS` (más = azul más lento) o `WIN_PER_PLAYER` y reiniciar con `docker compose up -d` |
| Mucha gente se queda de espectadora | Volver al lobby (**N**) y esperar a que escaneen el QR antes de iniciar |
| Falla internet del aula | Ensayar con la simulación y mostrar el efecto en el proyector sin celulares (`/admin` → *Simular partida*) |
| Clave de admin incorrecta | Se admite en cualquier combinación de mayúsculas y minúsculas; revisar `ADMIN_KEY` en `.env` |

> **Pendiente de validar en vivo:** la medición se hizo con conexiones y bots simulados, no con 30 celulares
> reales. Conviene un ensayo previo para calibrar `WIN_PER_PLAYER` según cuántos toques por segundo den las personas.
