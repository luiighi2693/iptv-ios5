'use strict';
// YouTube para el iPad 1. yt-dlp busca y resuelve los videos, y YouTube ya arma un HLS para iOS:
// video H.264 Main en TS y audio AAC empaquetado, en dos playlists con los mismos cortes. Como
// no está claro que el reproductor de iOS 5 soporte el audio en pista aparte (EXT-X-MEDIA), cada
// segmento se arma acá juntando los dos con ffmpeg sin recodificar (-c copy). El iPad recibe un
// HLS VOD común, con avance y retroceso, y la CPU casi no se entera.

const { execFile, spawn } = require('child_process');
const express = require('express');

const ID = /^[\w-]{11}$/;
const SEARCH_RESULTS = 20;
const SEARCH_TTL_MS = 10 * 60 * 1000;
const MAX_QUERY = 100;
const RESOLVE_TIMEOUT_MS = 60000;
const UPSTREAM_TIMEOUT_MS = 20000;
const EXPIRY_MARGIN_MS = 30 * 60 * 1000; // los enlaces de googlevideo duran unas 6 h
const MAX_VIDEOS = 20; // videos resueltos en memoria
const MAX_SEGMENTS = 8; // segmentos ya armados, por si el iPad los vuelve a pedir
const UPDATE_EVERY_MS = 24 * 3600 * 1000; // YouTube cambia seguido y yt-dlp viejo deja de andar
const ID3_TIMESTAMP = Buffer.from('com.apple.streaming.transportStreamTimestamp\0');

function createYouTube({ ytdlpPath = 'yt-dlp', ffmpegPath = 'ffmpeg', maxHeight = 480, log = console.log }) {
  const searches = new Map(); // texto → { at, items }
  const videos = new Map(); // id → { promise, expiresAt }
  const segments = new Map(); // "id/n" → TS ya armado
  let missing = false;

  function ytdlp(args, timeout) {
    return new Promise((resolve, reject) => {
      // Node resuelve los desafíos JS de YouTube; sin runtime, yt-dlp no consigue los formatos.
      const all = ['--js-runtimes', `node:${process.execPath}`, '--no-warnings', ...args];
      execFile(ytdlpPath, all, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err && err.code === 'ENOENT') {
          if (!missing) log(`[youtube] no encontré "${ytdlpPath}": instalalo o definí YTDLP_PATH`);
          missing = true;
          return reject(new Error('falta yt-dlp en el servidor'));
        }
        if (err) return reject(new Error(lastLine(stderr) || err.message));
        resolve(stdout);
      });
    });
  }

  async function search(text) {
    const cached = searches.get(text);
    if (cached && Date.now() - cached.at < SEARCH_TTL_MS) return cached.items;
    const found = JSON.parse(await ytdlp(['--flat-playlist', '-J', '--', `ytsearch${SEARCH_RESULTS}:${text}`], RESOLVE_TIMEOUT_MS));
    // Sin duración son transmisiones en vivo: su playlist cambia todo el tiempo y acá no van.
    const items = (found.entries || [])
      .filter((e) => ID.test(e.id || '') && e.duration > 0)
      .map((e) => [e.id, e.title || '', e.channel || e.uploader || '', Math.round(e.duration)]);
    searches.set(text, { at: Date.now(), items });
    if (searches.size > 50) searches.delete(searches.keys().next().value);
    return items;
  }

  async function resolve(id) {
    const info = JSON.parse(await ytdlp(['-j', '--no-playlist', '--', `https://www.youtube.com/watch?v=${id}`], RESOLVE_TIMEOUT_MS));
    const hls = (info.formats || []).filter((f) => String(f.protocol).startsWith('m3u8'));
    const video = pickVideo(hls, maxHeight);
    const audio = pickAudio(hls);
    if (!video || !audio) throw new Error('YouTube no ofrece este video en un formato que el iPad lea');

    const headers = { 'user-agent': (video.http_headers || {})['User-Agent'] || 'Mozilla/5.0' };
    const [v, a] = await Promise.all([fetchPlaylist(video.url, headers), fetchPlaylist(audio.url, headers)]);
    if (v.urls.length !== a.urls.length) throw new Error('el video y el audio vienen cortados distinto');
    log(`[youtube] ${info.title} · ${video.height}p (${video.format_id}) + audio ${audio.format_id} · ${v.urls.length} segmentos`);
    const expire = Number((/expire[/=](\d+)/.exec(video.url) || [])[1]) * 1000;
    return { title: info.title, v, a, headers, expiresAt: (expire || Date.now() + 6 * 3600000) - EXPIRY_MARGIN_MS };
  }

  // Un solo yt-dlp por video aunque el iPad pida la playlist y varios segmentos a la vez. Con
  // fresh (enlaces vencidos) también: si otro pedido ya lo renovó hace un rato, sirve ese.
  function getVideo(id, fresh = false) {
    const cached = videos.get(id);
    const usable = cached && (fresh ? Date.now() - cached.createdAt < 60000 : Date.now() < cached.expiresAt);
    if (usable) return cached.promise;
    const entry = { promise: resolve(id), expiresAt: Infinity, createdAt: Date.now() };
    entry.promise.then(
      (video) => (entry.expiresAt = video.expiresAt),
      () => videos.get(id) === entry && videos.delete(id)
    );
    videos.delete(id);
    videos.set(id, entry);
    if (videos.size > MAX_VIDEOS) videos.delete(videos.keys().next().value);
    return entry.promise;
  }

  // Promesas en el mapa: el segmento que se adelantó y el pedido del iPad comparten el trabajo.
  function segment(id, n) {
    const key = `${id}/${n}`;
    if (!segments.has(key)) {
      const promise = build(id, n);
      promise.catch(() => segments.get(key) === promise && segments.delete(key));
      segments.set(key, promise);
      if (segments.size > MAX_SEGMENTS) segments.delete(segments.keys().next().value);
    }
    return segments.get(key);
  }

  async function build(id, n) {
    let video = await getVideo(id);
    if (n >= video.v.urls.length) return null;
    let parts;
    try {
      parts = await Promise.all([fetchBuffer(video.v.urls[n], video.headers), fetchBuffer(video.a.urls[n], video.headers)]);
    } catch (err) {
      if (!err.expired) throw err;
      // Enlaces vencidos o revocados: se resuelve de nuevo (los cortes son los mismos).
      log(`[youtube] ${id}: googlevideo respondió ${err.status}, renuevo los enlaces`);
      video = await getVideo(id, true);
      parts = await Promise.all([fetchBuffer(video.v.urls[n], video.headers), fetchBuffer(video.a.urls[n], video.headers)]);
    }
    const ts = await mux(ffmpegPath, parts[0], parts[1]);
    // Si el anterior está (se mira de corrido), los contadores siguen los suyos. Si no, es un
    // salto: el reproductor descarta todo lo previo y da igual dónde arranquen.
    const previous = n > 0 && segments.get(`${id}/${n - 1}`);
    const before = previous ? await previous.catch(() => null) : null;
    return { ts, counters: continueCounters(ts, before && before.counters) };
  }

  function update() {
    execFile(ytdlpPath, ['-U'], { timeout: 120000 }, (err, stdout, stderr) => {
      if (err && err.code === 'ENOENT') return;
      log(`[youtube] yt-dlp: ${lastLine(stdout) || lastLine(stderr) || (err && err.message)}`);
    });
  }
  setTimeout(update, 10000).unref();
  setInterval(update, UPDATE_EVERY_MS).unref();

  const router = express.Router();
  const fail = (res, err) => !res.headersSent && res.status(502).type('text').send(err.message);

  router.get('/search', async (req, res) => {
    const text = String(req.query.q || '').trim().slice(0, MAX_QUERY);
    if (!text) return res.status(400).type('text').send('falta qué buscar');
    try {
      res.set('Cache-Control', 'no-store').json({ items: await search(text) });
    } catch (err) {
      log(`[youtube] búsqueda "${text}": ${err.message}`);
      fail(res, err);
    }
  });

  // Las miniaturas vienen por HTTPS moderno, que el Safari de iOS 5 no siempre negocia.
  router.get('/thumb/:file', async (req, res) => {
    const id = req.params.file.replace(/\.jpg$/, '');
    if (!ID.test(id)) return res.sendStatus(404);
    try {
      const jpg = await fetchBuffer(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, {});
      res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=86400' }).end(jpg);
    } catch {
      res.sendStatus(404);
    }
  });

  router.get('/:id/index.m3u8', async (req, res) => {
    const { id } = req.params;
    if (!ID.test(id)) return res.sendStatus(404);
    try {
      const video = await getVideo(id);
      let n = 0;
      // Las líneas de la playlist de video, con cada segmento apuntando al armado local.
      const lines = video.v.lines.map((line) => (line && !line.startsWith('#') ? `s/${n++}.ts` : line));
      res.set({ 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' }).send(lines.join('\n') + '\n');
    } catch (err) {
      log(`[youtube] ${id}: ${err.message}`);
      fail(res, err);
    }
  });

  router.get('/:id/s/:file', async (req, res) => {
    const { id } = req.params;
    const n = Number(req.params.file.replace(/\.ts$/, ''));
    if (!ID.test(id) || !Number.isInteger(n) || n < 0) return res.sendStatus(404);
    try {
      const built = await segment(id, n);
      if (!built) return res.sendStatus(404);
      const { ts } = built;
      res.set({ 'Content-Type': 'video/mp2t', 'Content-Length': ts.length, 'Cache-Control': 'max-age=3600' }).end(ts);
      segment(id, n + 1).catch(() => {}); // el próximo, mientras el iPad mira este
    } catch (err) {
      log(`[youtube] ${id} segmento ${n}: ${err.message}`);
      fail(res, err);
    }
  });

  return { router };
}

// El de mayor resolución que el iPad 1 decodifica: H.264 Baseline o Main (High no), hasta maxHeight.
function pickVideo(formats, maxHeight) {
  return formats
    .filter((f) => /^avc1\.(42|4d)/i.test(f.vcodec || '') && (!f.acodec || f.acodec === 'none') && f.height <= maxHeight)
    .sort((a, b) => b.height - a.height)[0];
}

// AAC-LC (234) antes que HE-AAC (233). Si hay doblajes automáticos, el audio original.
function pickAudio(formats) {
  const rank = (f) => (/original/i.test(f.format_note || '') ? 0 : /default/i.test(f.format_note || '') ? 1 : 2) * 2 + (f.format_id.startsWith('234') ? 0 : 1);
  return formats.filter((f) => f.vcodec === 'none' && /^23[34](-\d+)?$/.test(f.format_id)).sort((a, b) => rank(a) - rank(b))[0];
}

async function fetchPlaylist(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`la playlist respondió ${res.status}`);
  const lines = (await res.text()).split(/\r?\n/).map((l) => l.trim());
  const urls = lines.filter((l) => l && !l.startsWith('#'));
  if (!urls.length || !lines.includes('#EXT-X-ENDLIST')) throw new Error('la playlist no es de un video completo');
  return { lines, urls };
}

// Entero, no en streaming: ver el comentario de /s/:file en hls-proxy.js (undici + Connection: close).
async function fetchBuffer(url, headers) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
  if (!res.ok) {
    if (res.body) res.body.cancel().catch(() => {});
    throw Object.assign(new Error(`googlevideo respondió ${res.status}`), { status: res.status, expired: res.status === 403 || res.status === 410 });
  }
  return Buffer.from(await res.arrayBuffer());
}

// El audio empaquetado arranca en 0 para ffmpeg; su tiempo real está en un ID3 PRIV de Apple
// (PTS de 33 bits a 90 kHz). Con eso y -copyts, video y audio quedan alineados entre segmentos.
function id3Seconds(aac) {
  const at = aac.indexOf(ID3_TIMESTAMP);
  if (at < 0 || aac.length < at + ID3_TIMESTAMP.length + 8) return 0;
  const pts = aac.subarray(at + ID3_TIMESTAMP.length, at + ID3_TIMESTAMP.length + 8);
  return ((pts[3] & 1) * 2 ** 32 + pts.readUInt32BE(4)) / 90000;
}

function mux(ffmpegPath, videoTs, audioAac) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-copyts',
      '-f', 'mpegts', '-i', 'pipe:0',
      '-itsoffset', String(id3Seconds(audioAac)), '-f', 'aac', '-i', 'pipe:3',
      '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy',
      '-muxdelay', '0', '-muxpreload', '0', '-f', 'mpegts', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe', 'pipe'] });
    const out = [];
    let errors = '';
    child.stdout.on('data', (chunk) => out.push(chunk));
    child.stderr.on('data', (chunk) => (errors += chunk));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(Buffer.concat(out)) : reject(new Error(`ffmpeg no pudo juntar el segmento: ${lastLine(errors) || code}`))));
    // Si ffmpeg termina antes de leer todo, la escritura falla con EPIPE: lo informa 'close'.
    child.stdin.on('error', () => {});
    child.stdio[3].on('error', () => {});
    child.stdin.end(videoTs);
    child.stdio[3].end(audioAac);
  });
}

// Cada segmento sale de un ffmpeg nuevo, con los contadores de continuidad del TS desde cero: en
// cada corte el reproductor vería un salto y podría descartar paquetes. Se renumeran (en el lugar)
// para seguir los del segmento anterior; devuelve en qué quedó cada PID.
function continueCounters(ts, from) {
  const counters = { ...from };
  for (let at = 0; at + 188 <= ts.length; at += 188) {
    if (ts[at] !== 0x47) continue;
    const pid = ((ts[at + 1] & 0x1f) << 8) | ts[at + 2];
    if (pid === 0x1fff) continue; // relleno: no lleva contador
    const last = counters[pid];
    const hasPayload = (ts[at + 3] & 0x10) !== 0; // sólo los paquetes con datos avanzan el contador
    const cc = last === undefined ? ts[at + 3] & 0x0f : hasPayload ? (last + 1) & 0x0f : last;
    ts[at + 3] = (ts[at + 3] & 0xf0) | cc;
    counters[pid] = cc;
  }
  return counters;
}

function lastLine(text) {
  return String(text || '').trim().split('\n').pop().replace(/^ERROR:\s*/, '');
}

module.exports = { createYouTube, pickVideo, pickAudio, id3Seconds, continueCounters };
