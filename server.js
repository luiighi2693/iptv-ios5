'use strict';
// Puente: mantiene el enlace vigente del canal elegido, lo expone por /api/clip, sirve el
// stream al iPad por HTTP plano (/live, o /tv si se transcodifica), el catálogo de canales
// para el menú (/api/channels) y la web app.

try {
  process.loadEnvFile();
} catch {
  // sin .env: se usan las variables del entorno
}

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { createHlsProxy, FORWARD_HEADERS, PLAYLIST_TYPE } = require('./lib/hls-proxy');
const { createTranscoder } = require('./lib/transcoder');
const { createCatalog, createSource, channelFromUrl } = require('./lib/channels');
const { createYouTube } = require('./lib/youtube');
const { readConfig, startRefresher } = require('./scraper');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const CLIP_SECRET = process.env.CLIP_SECRET || '';
const TRANSCODE = process.env.TRANSCODE === '1';
const CHANNELS = process.env.SCRAPER !== '0';
const YOUTUBE = process.env.YOUTUBE !== '0';
const TARGET_URL = process.env.TARGET_URL || '';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CLIP_FILE = path.join(DATA_DIR, 'clip.json');
const CHANNEL_FILE = path.join(DATA_DIR, 'channel.json');
const CATALOG_FILE = path.join(DATA_DIR, 'catalog.json');
const HEALTH_FILE = path.join(DATA_DIR, 'health.json');
const ACCESS_KEY_FILE = path.join(DATA_DIR, 'access-key.txt');
// Todo vive bajo /<clave>/: sin la clave no hay página, ni API, ni video.
const ACCESS_KEY = accessKey();
const BASE = ACCESS_KEY ? `/${ACCESS_KEY}` : '';
const PLAY_PATH = TRANSCODE ? '/tv/index.m3u8' : '/live/index.m3u8';
// Validaciones a mano por minuto: cada una abre conexiones contra la fuente.
const VALIDATE_PER_MINUTE = 20;
// Fuentes del menú: "pluto" (su API) y URLs de listas M3U, separadas por coma.
const PROVIDERS = (process.env.PROVIDERS ?? legacyProviders())
  .split(',')
  .map((p) => p.trim())
  .filter(Boolean);
const M3U_URLS = PROVIDERS.filter((p) => /^https?:\/\//i.test(p));
const M3U_ALLOW = process.env.M3U_ALLOW ? new RegExp(process.env.M3U_ALLOW, 'i') : null;

// Antes de PROVIDERS se configuraban por separado: PLUTO_CATALOG y M3U_URLS.
function legacyProviders() {
  const lists = process.env.M3U_URLS ?? 'https://iptv-org.github.io/iptv/languages/spa.m3u';
  return [process.env.PLUTO_CATALOG === '0' ? '' : 'pluto', lists].filter(Boolean).join(',');
}

// ACCESS_KEY del .env; si no está, la que se generó en el primer arranque (queda en DATA_DIR
// para que el ícono del iPad siga andando). ACCESS_KEY=off la apaga.
function accessKey() {
  const valid = (key) => /^[\w-]{16,}$/.test(key);
  const given = (process.env.ACCESS_KEY || '').trim();
  if (given === 'off') return '';
  if (given) {
    if (!valid(given)) throw new Error('ACCESS_KEY: usá 16 caracteres o más, sólo letras, números, "-" y "_" (o "off")');
    return given;
  }
  const saved = (readText(ACCESS_KEY_FILE) || '').trim();
  if (valid(saved)) return saved;
  const key = crypto.randomBytes(18).toString('base64url');
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(ACCESS_KEY_FILE, key + '\n', { mode: 0o600 });
  return key;
}

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);

// ---- Estado: canal elegido y su último enlace (RAM + copia en disco para sobrevivir reinicios)

let clip = readJson(CLIP_FILE);
// La versión es la clave de las cachés del proxy: tiene que crecer siempre, también al
// cambiar de canal, o el proxy podría servir la master del canal anterior.
let clipVersion = clip ? clip.version : 0;
let channel = null;
let refresher = null;

function readText(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(readText(file));
  } catch {
    return null;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFile(file, JSON.stringify(value, null, 2), (err) => err && log('[store] no pude guardar:', err.message));
}

function setClip(input, channelId = null) {
  const url = String(input.url || '').trim();
  if (!/^https?:\/\//i.test(url)) throw new Error('url inválida: tiene que empezar con http:// o https://');

  const given = Object.fromEntries(Object.entries(input.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const headers = {};
  for (const name of FORWARD_HEADERS) if (given[name]) headers[name] = String(given[name]);

  clip = { url, headers, channelId, updatedAt: Date.now(), version: ++clipVersion };
  writeJson(CLIP_FILE, clip);
  log(`[store] enlace actualizado (v${clip.version}) → ${new URL(url).host}`);
  if (transcoder) transcoder.kick();
}

function clipAgeSeconds() {
  return Math.round((Date.now() - clip.updatedAt) / 1000);
}

function selectChannel(next, reason) {
  if (refresher) refresher.stop();
  channel = next;
  writeJson(CHANNEL_FILE, { channel, targetUrl: TARGET_URL || null });
  log(`[canal] ${channel.name} (${reason})`);

  // Sin señal hasta que llegue el enlace del canal nuevo: el proxy responde 503 y /tv espera.
  if (clip && clip.channelId !== channel.id) {
    clip = null;
    if (transcoder) transcoder.reset();
  }

  const config = readConfig();
  refresher = startRefresher({
    capture: createSource(next, log),
    onClip: (found) => channel === next && setClip(found, next.id),
    log,
    refreshMs: config.refreshMs,
    retryMs: config.retryMs,
    minForcedGapMs: config.minForcedGapMs,
  });
}

// Si cambiaste TARGET_URL en el .env, manda el .env; si no, sigue el último canal elegido.
function initialChannel() {
  const target = TARGET_URL ? channelFromUrl(TARGET_URL) : null;
  const saved = readJson(CHANNEL_FILE);
  if (target && (!saved || saved.targetUrl !== TARGET_URL)) return target;
  return (saved && saved.channel) || target;
}

// ---- Servicios

const transcoder = TRANSCODE
  ? createTranscoder({
      // Primero sólo la playlist de la variante: en casi todos los canales trae el audio muxeado,
      // y con dos playlists ffmpeg se desincroniza en los cortes y pierde la ventana en vivo
      // (25 s). La master, con la pista de audio aparte, sólo si la variante viene sin audio.
      input: `http://127.0.0.1:${PORT}${BASE}/live/media.m3u8`,
      audioInput: `http://127.0.0.1:${PORT}${BASE}/live/index.m3u8`,
      outDir: path.join(os.tmpdir(), 'iptv-ipad-hls'),
      height: Number(process.env.TRANSCODE_HEIGHT) || 480,
      videoKbps: Number(process.env.TRANSCODE_KBPS) || 1200,
      ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
      hasInput: () => Boolean(clip),
      log,
    })
  : null;

const catalog = CHANNELS
  ? createCatalog({
      file: CATALOG_FILE,
      healthFile: HEALTH_FILE,
      targetUrl: TARGET_URL,
      m3uUrls: M3U_URLS,
      m3uAllow: M3U_ALLOW,
      pluto: PROVIDERS.includes('pluto'),
      plutoCategories: process.env.PLUTO_CATEGORIES ? new RegExp(process.env.PLUTO_CATEGORIES, 'i') : null,
      log,
      onBuilt() {
        const fresh = channel && catalog.get(channel.id);
        if (fresh && fresh.name !== channel.name) {
          channel.name = fresh.name; // el de TARGET_URL arranca con el slug como nombre
          writeJson(CHANNEL_FILE, { channel, targetUrl: TARGET_URL || null });
        }
        if (!channel && catalog.first()) selectChannel(catalog.first(), 'primer canal del catálogo');
      },
    })
  : null;

const app = express();
app.disable('x-powered-by');

// Registro de accesos remotos: cada dispositivo nuevo y cada pedido fallido. Los pedidos
// locales (ffmpeg) y los exitosos (segmentos, sondeos) no se registran para no inundar el log.
const seenClients = new Set();
app.use((req, res, next) => {
  // Se lee al entrar: en 'finish' el socket puede estar ya desconectado y remoteAddress vacío.
  const ip = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (ip === '127.0.0.1' || ip === '::1') return next();
  res.on('finish', () => {
    if (!seenClients.has(ip)) {
      seenClients.add(ip);
      log(`[acceso] dispositivo nuevo ${ip} · ${req.get('user-agent') || 'sin user-agent'}`);
    }
    if (res.statusCode >= 400) log(`[acceso] ${ip} ${req.method} ${req.originalUrl.slice(0, 80)} → ${res.statusCode}`);
  });
  next();
});

// Sin la clave, 404 a todo (no 401: que no se note que acá hay algo). Con la clave, el resto
// de las rutas la ven ya recortada, y la página usa rutas relativas.
if (BASE) {
  app.use((req, res, next) => {
    if (req.path === BASE) return res.redirect(`${BASE}/`);
    if (!req.path.startsWith(`${BASE}/`)) return res.sendStatus(404);
    req.url = req.url.slice(BASE.length);
    next();
  });
}

function playUrl(req) {
  return `http://${req.get('host') || `localhost:${PORT}`}${BASE}${PLAY_PATH}`;
}

const validations = [];

function validateAllowed() {
  const now = Date.now();
  while (validations.length && now - validations[0] > 60000) validations.shift();
  if (validations.length >= VALIDATE_PER_MINUTE) return false;
  validations.push(now);
  return true;
}

app.post('/api/clip', express.json({ limit: '64kb' }), express.text({ limit: '64kb' }), (req, res) => {
  if (CLIP_SECRET && req.get('x-clip-secret') !== CLIP_SECRET) return res.sendStatus(401);
  const body = typeof req.body === 'string' ? { url: req.body } : req.body || {};
  try {
    setClip(body);
    res.sendStatus(204);
  } catch (err) {
    res.status(400).type('text').send(err.message);
  }
});

// Devuelve el enlace que el iPad tiene que abrir. Es siempre el mismo (el proxy local);
// X-Clip-Age dice hace cuántos segundos se renovó el token detrás y X-Channel, qué canal es
// (URI-encoded: los headers no admiten acentos).
app.get('/api/clip', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (channel) res.set('X-Channel', encodeURIComponent(channel.name));
  if (!clip) return res.sendStatus(204);
  res.set('X-Clip-Age', String(clipAgeSeconds()));
  res.type('text').send(playUrl(req));
});

app.get('/api/channels', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    active: channel ? channel.id : null,
    play: playUrl(req),
    groups: catalog ? catalog.groups() : [],
  });
});

app.post('/api/channel', express.json({ limit: '4kb' }), express.text({ limit: '4kb' }), (req, res) => {
  if (!catalog) return res.status(404).type('text').send('el menú de canales está apagado (SCRAPER=0)');
  const id = String((typeof req.body === 'string' ? req.body : (req.body || {}).id) || '').trim();
  const next = catalog.get(id) || (channel && channel.id === id ? channel : null);
  if (!next) return res.status(404).type('text').send('canal desconocido');
  if (!channel || channel.id !== next.id) selectChannel(next, 'elegido en el menú');
  res.sendStatus(204);
});

// Valida un canal en el momento (botón del menú): { id, status: 'ok' | 'dead' }.
app.post('/api/validate', express.json({ limit: '4kb' }), express.text({ limit: '4kb' }), async (req, res) => {
  if (!catalog) return res.status(404).type('text').send('el menú de canales está apagado (SCRAPER=0)');
  if (!validateAllowed()) return res.status(429).type('text').send(`más de ${VALIDATE_PER_MINUTE} validaciones por minuto: esperá un poco`);
  const id = String((typeof req.body === 'string' ? req.body : (req.body || {}).id) || '').trim();
  const status = await catalog.validate(id);
  if (!status) return res.status(404).type('text').send('canal desconocido o que no se puede validar');
  res.set('Cache-Control', 'no-store').json({ id, status });
});

app.get('/api/status', (req, res) => {
  res.set('Cache-Control', 'no-store').json({
    mode: TRANSCODE ? 'transcode' : 'proxy',
    channel: channel ? { id: channel.id, name: channel.name } : null,
    catalog: catalog ? { channels: catalog.size, updatedAt: catalog.updatedAt, pending: catalog.pending } : null,
    hasClip: Boolean(clip),
    version: clip ? clip.version : 0,
    ageSeconds: clip ? clipAgeSeconds() : null,
    upstreamHost: clip ? new URL(clip.url).host : null,
    transcoding: transcoder ? transcoder.running : false,
    youtube: YOUTUBE,
  });
});

app.use(
  '/live',
  createHlsProxy({
    getClip: () => clip,
    onAuthError: (reason) => refresher && refresher.refreshNow(reason),
    maxHeight: Number(process.env.MAX_HEIGHT) || 720,
    maxBandwidth: Number(process.env.MAX_BANDWIDTH) || 4000000,
    transcoding: TRANSCODE,
    log,
  })
);

if (YOUTUBE) {
  const youtube = createYouTube({
    ytdlpPath: process.env.YTDLP_PATH || 'yt-dlp',
    ffmpegPath: process.env.FFMPEG_PATH || 'ffmpeg',
    maxHeight: Number(process.env.YT_MAX_HEIGHT) || 480,
    lang: process.env.YT_LANG ?? 'es',
    log,
  });
  app.use('/yt', youtube.router);
}

if (transcoder) {
  app.get('/tv/:file', async (req, res) => {
    const { file } = req.params;
    if (!/^[\w-]+\.(m3u8|ts)$/.test(file)) return res.sendStatus(404);

    // Tras un cambio de canal, waitReady también espera a que llegue el enlace nuevo.
    transcoder.touch();
    const isPlaylist = file.endsWith('.m3u8');
    if (isPlaylist && !(await transcoder.waitReady())) {
      return res.status(503).type('text').send(clip ? 'El transcodificador no arrancó a tiempo' : 'Sin señal');
    }
    res.set({
      'Content-Type': isPlaylist ? PLAYLIST_TYPE : 'video/mp2t',
      'Cache-Control': isPlaylist ? 'no-cache, no-store' : 'max-age=60',
    });
    res.sendFile(file, { root: transcoder.outDir }, (err) => err && !res.headersSent && res.sendStatus(404));
  });
}

app.use(
  express.static(path.join(__dirname, 'public'), {
    setHeaders: (res, file) => file.endsWith('.html') && res.setHeader('Cache-Control', 'no-cache'),
  })
);

app.listen(PORT, HOST, () => {
  log(`Puente escuchando en ${HOST}:${PORT} (modo ${TRANSCODE ? 'transcodificación' : 'proxy'})`);
  for (const ip of lanAddresses()) log(`  → En el iPad abrí: http://${ip}:${PORT}${BASE}/`);
  if (!BASE) log('AVISO: ACCESS_KEY=off: cualquiera que llegue a este puerto ve y maneja todo.');
  else if (!process.env.ACCESS_KEY) log(`  (clave generada y guardada en ${ACCESS_KEY_FILE}; para elegir otra, ACCESS_KEY en el .env)`);

  if (!catalog) return log('Capturador apagado (SCRAPER=0): mandá enlaces a POST /api/clip');
  const unknown = PROVIDERS.filter((p) => p !== 'pluto' && !M3U_URLS.includes(p));
  log(`[catálogo] proveedores: ${PROVIDERS.filter((p) => !unknown.includes(p)).join(', ') || 'ninguno'} · filtro M3U_ALLOW: ${M3U_ALLOW ? M3U_ALLOW.source : 'ninguno'}`);
  if (unknown.length) log(`[catálogo] ignoro proveedores que no entiendo: ${unknown.join(', ')} (usá "pluto" o la URL de una lista M3U)`);
  const first = initialChannel();
  if (first) selectChannel(first, 'inicio');
  catalog.start();
});

function lanAddresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((a) => a && a.family === 'IPv4' && !a.internal)
    .map((a) => a.address);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    log('Cerrando…');
    const transcoding = transcoder ? transcoder.stop() : null;
    if (catalog) catalog.stop();
    if (refresher) await refresher.stop();
    await transcoding;
    process.exit(0);
  });
}
