const express = require('express');
const { InfluxDB, Point } = require('@influxdata/influxdb-client');
const QRCode = require('qrcode');

const { INFLUX_URL, INFLUX_TOKEN, INFLUX_ORG, INFLUX_BUCKET } = process.env;
const PORT = parseInt(process.env.PORT || '3000', 10);
const SEED_POINTS = parseInt(process.env.SEED_POINTS || '0', 10);
// El final de la soga se calcula al empezar cada ronda según cuánta gente juega:
//   ventaja necesaria = jugadores × WIN_PER_PLAYER  (mínimo WIN_MIN, máximo WIN_MAX)
const WIN_PER_PLAYER = parseFloat(process.env.WIN_PER_PLAYER || '4');
const WIN_MIN = parseInt(process.env.WIN_MIN || '30', 10);
const WIN_MAX = parseInt(process.env.WIN_MAX || '400', 10);
let WIN_DIFF = 100;

const influx = new InfluxDB({ url: INFLUX_URL, token: INFLUX_TOKEN });
const query = influx.getQueryApi(INFLUX_ORG);
const writer = influx.getWriteApi(INFLUX_ORG, INFLUX_BUCKET, 'ns', { flushInterval: 100, batchSize: 200 });

// ---- timestamps unicos en ns (si no, InfluxDB sobreescribe puntos iguales) ----
let lastNs = BigInt(Date.now()) * 1000000n;
const nextNs = () => { const n = BigInt(Date.now()) * 1000000n; lastNs = n > lastNs ? n : lastNs + 1n; return lastNs.toString(); };

// ---- LA TRAMPA ----
// Rojo: TAG   -> measurement=clicks,equipo=rojo value=1     (indexado, busqueda por indice)
// Azul: FIELD -> measurement=clicks equipo_field="azul"     (sin indice, hay que escanear valores)
const sentN = { rojo: 0, azul: 0 };
function writeClick(team) {
  sentN[team]++;
  const p = team === 'rojo'
    ? new Point('clicks').tag('equipo', 'rojo').intField('value', 1)
    : new Point('clicks').stringField('equipo_field', 'azul');
  p.timestamp(nextNs());
  writer.writePoint(p);
}

const RANGE = '-24h';
const qRojo = `from(bucket: "${INFLUX_BUCKET}") |> range(start: ${RANGE})
  |> filter(fn: (r) => r._measurement == "clicks" and r.equipo == "rojo" and r._field == "value")
  |> count()`;
const qAzul = `from(bucket: "${INFLUX_BUCKET}") |> range(start: ${RANGE})
  |> filter(fn: (r) => r._measurement == "clicks" and r._field == "equipo_field" and r._value == "azul")
  |> count()`;

async function runCount(flux) {
  const t0 = Date.now();
  let n = 0;
  await new Promise((resolve, reject) => query.queryRows(flux, {
    next: (row, meta) => { n += Number(meta.toObject(row)._value); },
    error: reject, complete: resolve,
  }));
  return { n, ms: Date.now() - t0 };
}

// ---- ruido historico: otros "grupos" que jugaron antes (aumenta lo que hay que escanear) ----
async function seed() {
  if (!SEED_POINTS) return;
  const check = await runCount(`from(bucket: "${INFLUX_BUCKET}") |> range(start: -30d)
    |> filter(fn: (r) => r._measurement == "clicks" and r.equipo == "gris") |> limit(n: 1) |> count()`).catch(() => ({ n: 0 }));
  if (check.n > 0) { console.log('seed ya existe'); return; }
  console.log(`sembrando ${SEED_POINTS * 2} puntos historicos...`);
  const now = Date.now() * 1000000;
  const span = 20 * 3600 * 1e9; // ultimas 20h
  const BATCH = 5000;
  for (let i = 0; i < SEED_POINTS; i += BATCH) {
    const lines = [];
    for (let j = i; j < Math.min(i + BATCH, SEED_POINTS); j++) {
      const ts = BigInt(Math.floor(now - span + (span * j) / SEED_POINTS - 3600e9)) ;
      lines.push(`clicks,equipo=gris value=1i ${ts}`);
      lines.push(`clicks equipo_field="gris" ${ts + 1n}`);
    }
    const r = await fetch(`${INFLUX_URL}/api/v2/write?org=${INFLUX_ORG}&bucket=${INFLUX_BUCKET}&precision=ns`, {
      method: 'POST', headers: { Authorization: `Token ${INFLUX_TOKEN}` }, body: lines.join('\n'),
    });
    if (!r.ok) { console.error('seed error', await r.text()); return; }
  }
  console.log('seed listo');
}

// ---- estado del juego ----
const ADMIN_KEY = process.env.ADMIN_KEY || 'profe';
const TUNNEL_METRICS = process.env.TUNNEL_METRICS;
let publicUrl = null;

let base = { rojo: 0, azul: 0 }, raw = { rojo: 0, azul: 0 }, lat = { rojo: 0, azul: 0 };
const sentBase = { rojo: 0, azul: 0 };
let phase = 'lobby';            // lobby -> countdown -> playing -> finished -> lobby
let countdownEnd = 0, winner = null, reveal = false, ver = 0;
const COUNTDOWN_MS = 3500;

const EMOJIS = ['🦊','🐼','🐯','🦁','🐸','🐙','🦄','🐵','🐧','🦉','🐲','🐳','🦋','🐢','🦖','🐝','🐨','🐰','🦈','🦩','🐺','🦜','🐞','🦔','🐮','🐷','🐹','🦀','🐬','🦅'];
const players = new Map();      // id -> { team, emoji, t }
const conns = new Map();        // id -> conexiones SSE abiertas

const count = t => [...players.values()].filter(p => p.team === t).length;
const bump = () => { ver++; };

function rebalance() {
  for (;;) {
    const r = count('rojo'), a = count('azul');
    if (Math.abs(r - a) <= 1) return;
    const big = r > a ? 'rojo' : 'azul', small = big === 'rojo' ? 'azul' : 'rojo';
    const last = [...players.entries()].filter(([, p]) => p.team === big).sort((x, y) => y[1].t - x[1].t)[0];
    last[1].team = small;
  }
}

function state() {
  const rojo = Math.max(0, raw.rojo - base.rojo);
  const azul = Math.max(0, raw.azul - base.azul);
  const roster = { rojo: [], azul: [] };
  for (const p of players.values()) if (roster[p.team].length < 60) roster[p.team].push(p.emoji);
  const spectators = [...conns.keys()].filter(id => !players.has(id)).length;
  return { phase, cd: phase === 'countdown' ? Math.max(0, countdownEnd - Date.now()) : 0,
           rojo, azul, sentRound: { rojo: sentN.rojo - sentBase.rojo, azul: sentN.azul - sentBase.azul }, diff: rojo - azul, win: WIN_DIFF, winner, lat, reveal, ver,
           sim: { on: sim.on, bots: sim.bots, cps: sim.cps, auto: sim.auto },
           players: { rojo: count('rojo'), azul: count('azul'), spectators }, roster, url: publicUrl };
}

const clients = new Set();
function broadcast() {
  const s = `data: ${JSON.stringify(state())}\n\n`;
  for (const c of clients) c.write(s);
}
setInterval(broadcast, 250);

function toLobby() {
  clearTimeout(cdTimer);
  for (const id of [...players.keys()]) if (!conns.has(id)) players.delete(id);
  rebalance(); bump();
  phase = 'lobby'; winner = null; sim.restartAt = 0;
  base = { rojo: raw.rojo, azul: raw.azul };
  broadcast();
}
let cdTimer;
function startRound() {
  if (phase !== 'lobby' && phase !== 'finished') return;
  // en simulación no hay celulares: se asume ~5 toques/s por jugador virtual (rate = clicks/s de UN equipo)
  const n = sim.on ? sim.bots : players.size;
  WIN_DIFF = Math.max(WIN_MIN, Math.min(WIN_MAX, Math.round(n * WIN_PER_PLAYER)));
  console.log(`ronda: ${n} jugadores${sim.on ? ' (simulados)' : ''} -> la soga termina con ${WIN_DIFF} de ventaja`);
  base = { rojo: raw.rojo, azul: raw.azul }; sentBase.rojo = sentN.rojo; sentBase.azul = sentN.azul; winner = null; sim.restartAt = 0;
  phase = 'countdown'; countdownEnd = Date.now() + COUNTDOWN_MS; bump();
  cdTimer = setTimeout(() => { phase = 'playing'; broadcast(); }, COUNTDOWN_MS);
  broadcast();
}

// Bots: ambos equipos con el MISMO promedio de clicks/s, pero cada uno con rachas aleatorias propias
// bots: jugadores simulados en total (mitad por equipo); cps: toques por segundo de cada bot
const sim = { on: false, bots: 30, cps: 5, auto: true, timer: null, acc: { rojo: 0, azul: 0 }, restartAt: 0, f: { rojo: 1, azul: 1 } };
const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
const teamRate = () => (sim.bots / 2) * sim.cps;   // clicks/s de UN equipo
function simTick() {
  if (phase === 'finished' && sim.auto) {
    if (!sim.restartAt) sim.restartAt = Date.now() + 5000;
    else if (Date.now() > sim.restartAt) startRound();
    return;
  }
  if (phase !== 'playing') return;
  // Rachas aleatorias por equipo + un control que las compensa: la diferencia acumulada de clicks ENVIADOS
  // se mantiene cerca de 0, así el mismo promedio es real y la única ventaja es la de InfluxDB.
  const sentR = sentN.rojo - sentBase.rojo, sentA = sentN.azul - sentBase.azul;
  for (const t of ['rojo', 'azul']) {
    sim.f[t] += 0.2 * (1 - sim.f[t]) + 0.18 * gauss();
    sim.f[t] = Math.max(0.3, Math.min(1.8, sim.f[t]));
    const ahead = t === 'rojo' ? sentR - sentA : sentA - sentR;           // cuántos clicks lleva de más
    const corr = Math.max(0.2, Math.min(1.8, 1 - ahead / Math.max(12, teamRate() * 0.6)));
    sim.acc[t] += (teamRate() / 10) * sim.f[t] * corr * (0.85 + 0.3 * Math.random());
    while (sim.acc[t] >= 1) { sim.acc[t]--; writeClick(t); }
  }
}
function setSim(on) {
  sim.on = on; clearInterval(sim.timer); sim.timer = null; sim.restartAt = 0;
  if (on) { sim.timer = setInterval(simTick, 100); startRound(); }
}

// Cada equipo se consulta en su propio bucle: lo que ve el proyector depende de lo que devuelva InfluxDB.
async function loop(team, flux) {
  for (;;) {
    try {
      const r = await runCount(flux);
      raw[team] = r.n; lat[team] = r.ms;
      if (phase === 'playing') {
        const s = state();
        if (Math.abs(s.diff) >= WIN_DIFF) { winner = s.diff > 0 ? 'rojo' : 'azul'; phase = 'finished'; }
      }
      broadcast();
    } catch (e) { console.error(team, e.message); await new Promise(r => setTimeout(r, 1000)); }
    await new Promise(r => setTimeout(r, 100));
  }
}

const app = express();
app.use(express.json());
app.use(express.static('public'));
const page = f => (q, r) => r.sendFile(`${__dirname}/public/${f}`);
app.get('/play', page('play.html'));
app.get('/admin', page('admin.html'));

const auth = (req, res, next) =>
  (req.get('x-key') || '').trim().toLowerCase() === ADMIN_KEY.trim().toLowerCase() ? next() : res.sendStatus(401);

// Un jugador entra SOLO en el lobby; fuera del lobby es espectador.
app.post('/join', (req, res) => {
  const { id } = req.body || {};
  if (!id) return res.sendStatus(400);
  let p = players.get(id);
  if (!p && phase === 'lobby') {
    const team = count('rojo') <= count('azul') ? 'rojo' : 'azul';
    const used = new Set([...players.values()].map(x => x.emoji));
    const free = EMOJIS.filter(e => !used.has(e));
    const emoji = (free.length ? free : EMOJIS)[Math.floor(Math.random() * (free.length || EMOJIS.length))];
    p = { team, emoji, t: Date.now() }; players.set(id, p); bump(); broadcast();
  }
  res.json(p ? { role: 'player', team: p.team, emoji: p.emoji } : { role: 'spectator' });
});

app.post('/click', (req, res) => {
  const p = players.get((req.body || {}).id);
  if (!p) return res.sendStatus(403);
  if (phase !== 'playing') return res.json({ ok: false, phase });
  writeClick(p.team);
  res.json({ ok: true });
});

app.post('/reset', auth, (q, r) => { toLobby(); r.json({ ok: true }); });
app.post('/admin/start', auth, (q, r) => { startRound(); r.json({ ok: true }); });
app.post('/admin/sim', auth, (req, res) => {
  const { on, bots, cps, auto } = req.body || {};
  if (typeof bots === 'number') sim.bots = Math.max(2, Math.min(100, Math.round(bots / 2) * 2));
  if (typeof cps === 'number') sim.cps = Math.max(0.5, Math.min(15, Math.round(cps * 2) / 2));
  if (typeof auto === 'boolean') sim.auto = auto;
  if (typeof on === 'boolean') setSim(on);
  broadcast(); res.json({ ok: true });
});
app.post('/admin/reveal', auth, (req, res) => { reveal = !!(req.body || {}).on; broadcast(); res.json({ ok: true }); });

app.get('/qr.svg', async (req, res) => {
  const base = publicUrl || `${req.protocol}://${req.get('host')}`;
  res.type('image/svg+xml').send(await QRCode.toString(`${base}/play`, { type: 'svg', margin: 1, color: { dark: '#0f1220', light: '#ffffff' } }));
});

app.get('/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  clients.add(res);
  const pid = req.query.pid;
  if (pid) conns.set(pid, (conns.get(pid) || 0) + 1);
  res.write(`data: ${JSON.stringify(state())}\n\n`);
  req.on('close', () => {
    clients.delete(res);
    if (!pid) return;
    const n = (conns.get(pid) || 1) - 1;
    if (n > 0) return void conns.set(pid, n);
    conns.delete(pid);
    if (phase === 'lobby' && players.delete(pid)) { rebalance(); bump(); broadcast(); }
  });
});

async function announceUrl() {
  if (!TUNNEL_METRICS) return;
  for (let i = 0; i < 90; i++) {
    try {
      const j = await (await fetch(`${TUNNEL_METRICS}/quicktunnel`)).json();
      if (j.hostname) { publicUrl = `https://${j.hostname}`; break; }
    } catch {}
    await new Promise(r => setTimeout(r, 1000));
  }
  const line = '='.repeat(64);
  if (!publicUrl) return console.log('\n(no se pudo obtener la URL del tunnel: docker compose logs tunnel)\n');
  const qr = await QRCode.toString(`${publicUrl}/play`, { type: 'terminal', small: true });
  console.log(`\n${line}\n  🪢  TIRA Y AFLOJA  —  LISTO PARA JUGAR\n${line}`);
  console.log(`  📽  Proyector : ${publicUrl}/`);
  console.log(`  📱  Celulares : ${publicUrl}/play`);
  console.log(`  🔧  Admin     : ${publicUrl}/admin   (clave: ADMIN_KEY del .env)`);
  console.log(`  💻  Local     : http://localhost:${PORT}/`);
  console.log(`${line}\n${qr}${line}\n`);
}

(async () => {
  for (let i = 0; i < 30; i++) {
    try { await runCount(qRojo); break; } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  await seed();
  const [r, a] = await Promise.all([runCount(qRojo).catch(() => ({ n: 0 })), runCount(qAzul).catch(() => ({ n: 0 }))]);
  base = { rojo: r.n, azul: a.n }; raw = { ...base };
  loop('rojo', qRojo);
  loop('azul', qAzul);
  app.listen(PORT, () => { console.log(`servidor listo en :${PORT}`); announceUrl(); });
})();
