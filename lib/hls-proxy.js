'use strict';
// Proxy HLS para el iPad 1. El iPad sólo habla HTTP plano con la PC (/live/*); la PC
// habla HTTPS con el CDN, reenvía los headers que autorizan el token (Referer, Cookie,
// User-Agent) y reescribe las playlists. Como las URLs que ve el iPad son estables, la
// rotación de tokens le resulta invisible: en el próximo refresco de la playlist ya
// recibe segmentos firmados con el token nuevo.

const express = require('express');
const path = require('path');

const FORWARD_HEADERS = ['user-agent', 'referer', 'origin', 'cookie'];
const AUTH_ERRORS = new Set([401, 403, 410]);
const PLAYLIST_TYPE = 'application/vnd.apple.mpegurl';
const SEGMENT_TYPES = {
  ts: 'video/mp2t',
  aac: 'audio/aac',
  mp3: 'audio/mpeg',
  m4s: 'video/mp4',
  mp4: 'video/mp4',
  m4a: 'audio/mp4',
  vtt: 'text/vtt',
  key: 'application/octet-stream',
};
const VIDEO_CODECS = /avc1|avc3|hvc1|hev1|dvh1|dvhe|av01|vp09/;
// iPad 1: H.264 hasta Main Profile 3.1 (720p30) + AAC-LC. Todo esto lo deja afuera.
const UNSUPPORTED_CODECS = /hvc1|hev1|dvh1|dvhe|av01|vp09|ec-3|ac-3|avc[13]\.(64|6e|7a|f4)/;
const MASTER_TTL_MS = 30000;
const UPSTREAM_TIMEOUT_MS = 15000;
const MAX_SEGMENT_IDS = 3000;

class UpstreamError extends Error {
  constructor(status, message, expired = AUTH_ERRORS.has(status)) {
    super(message);
    this.status = status;
    this.expired = expired;
  }
}

// transcoding: el que lee /live es ffmpeg, no el iPad. Cualquier códec sirve (ffmpeg lo
// recodifica), así que conviene la mejor variante hasta maxHeight, no la "compatible".
function createHlsProxy({ getClip, onAuthError = () => {}, maxHeight = 720, maxBandwidth = 4000000, transcoding = false, log = console.log }) {
  const router = express.Router();
  const segments = createSegmentRegistry(MAX_SEGMENT_IDS);
  const logged = new Set();
  let masterCache = null;

  function logOnce(clip, key, message) {
    const id = clip.version + ':' + key;
    if (logged.has(id)) return;
    logged.add(id);
    log('[proxy] ' + message);
  }

  function fetchUpstream(url, clip, { range, signal } = {}) {
    const headers = { accept: '*/*', 'accept-encoding': 'identity' };
    for (const name of FORWARD_HEADERS) if (clip.headers[name]) headers[name] = clip.headers[name];
    if (range) headers.range = range;
    return fetch(url, { headers, redirect: 'follow', signal });
  }

  async function fetchPlaylist(url, clip) {
    let res;
    try {
      res = await fetchUpstream(url, clip, { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) });
    } catch (err) {
      throw new UpstreamError(504, 'upstream inaccesible: ' + err.message);
    }
    const text = await res.text();
    if (!res.ok) throw new UpstreamError(res.status, `upstream respondió ${res.status}`);
    // Muchos CDNs devuelven 200 con una página HTML cuando el token venció.
    if (!text.trimStart().startsWith('#EXTM3U')) throw new UpstreamError(502, 'upstream no devolvió una playlist (¿token vencido?)', true);
    return { text, finalUrl: res.url };
  }

  // Playlist de entrada (la del clip). Las master se cachean por versión de clip; las
  // media no, porque en un live cambian en cada refresco.
  async function loadSource(clip) {
    if (masterCache && masterCache.version === clip.version && Date.now() - masterCache.at < MASTER_TTL_MS) return masterCache;
    const { text, finalUrl } = await fetchPlaylist(clip.url, clip);
    if (!text.includes('#EXT-X-STREAM-INF')) return { kind: 'media', text, finalUrl };
    masterCache = { kind: 'master', version: clip.version, at: Date.now(), ...parseMaster(text, finalUrl) };
    return masterCache;
  }

  function chooseVariant(src, clip) {
    if (!src.variants.length) throw new UpstreamError(502, 'la playlist master no tiene variantes');
    const { variant, compatible } = pickVariant(src.variants, { maxHeight, maxBandwidth, anyCodec: transcoding });
    logOnce(clip, 'variant', `variante elegida: ${describe(variant)}`);
    if (!compatible) {
      logOnce(
        clip,
        'incompatible',
        transcoding
          ? `ninguna variante entra en ${maxHeight}p y ${maxBandwidth / 1e6} Mbps; uso la más liviana`
          : `AVISO: ninguna variante cumple H.264 Main ≤${maxHeight}p; uso la más liviana. Si el iPad no la reproduce, activá TRANSCODE=1.`
      );
    }
    return variant;
  }

  function rewriteMedia(text, baseUrl, clip) {
    if (text.includes('#EXT-X-MAP:')) logOnce(clip, 'fmp4', 'AVISO: el stream usa fMP4 (EXT-X-MAP) y iOS 5 no lo soporta: activá TRANSCODE=1.');
    if (/URI="skd:|com\.apple\.streamingkeydelivery/i.test(text)) logOnce(clip, 'drm', 'AVISO: el stream tiene DRM (FairPlay): no se puede reproducir por este medio.');

    return text
      .split(/\r?\n/)
      .map((raw) => {
        const line = raw.trim();
        if (!line) return line;
        if (line.startsWith('#')) {
          const ext = line.startsWith('#EXT-X-KEY') ? 'key' : null;
          return line.replace(/URI="([^"]+)"/g, (whole, uri) => {
            const abs = resolve(uri, baseUrl);
            return isHttp(abs) ? `URI="${segments.mint(abs, ext)}"` : whole;
          });
        }
        const abs = resolve(line, baseUrl);
        return isHttp(abs) ? segments.mint(abs) : line;
      })
      .join('\n');
  }

  function handle(fn) {
    return async (req, res) => {
      const clip = getClip();
      if (!clip) return res.status(503).type('text').send('Sin señal: todavía no hay un enlace capturado');
      try {
        await fn(req, res, clip);
      } catch (err) {
        if (err.expired) {
          masterCache = null;
          onAuthError(err.message);
        }
        logOnce(clip, 'error:' + err.message, `${req.path}: ${err.message}`);
        if (!res.headersSent) res.status(502).type('text').send(err.message);
      }
    };
  }

  router.get(
    '/index.m3u8',
    handle(async (req, res, clip) => {
      const src = await loadSource(clip);
      if (src.kind === 'media') return sendPlaylist(res, rewriteMedia(src.text, src.finalUrl, clip));
      sendPlaylist(res, buildMaster(src, chooseVariant(src, clip)));
    })
  );

  // La variante se vuelve a resolver contra la master vigente en cada pedido: si el
  // token rotó, este pedido ya usa la URL nueva sin que el reproductor se entere.
  router.get(
    '/media.m3u8',
    handle(async (req, res, clip) => {
      const src = await loadSource(clip);
      if (src.kind === 'media') return sendPlaylist(res, rewriteMedia(src.text, src.finalUrl, clip));
      const target = req.query.group
        ? src.renditions.find((r) => r.attrs['GROUP-ID'] === req.query.group && (r.attrs.NAME || '') === (req.query.name || ''))
        : chooseVariant(src, clip);
      if (!target || !target.uri) throw new UpstreamError(404, 'rendición no encontrada en la master');
      const { text, finalUrl } = await fetchPlaylist(target.uri, clip);
      sendPlaylist(res, rewriteMedia(text, finalUrl, clip));
    })
  );

  router.get('/s/:file', async (req, res) => {
    const [id, ext] = req.params.file.split('.');
    const url = segments.lookup(id);
    const clip = getClip();
    if (!url || !clip) return res.sendStatus(404);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), UPSTREAM_TIMEOUT_MS);
    res.on('close', () => controller.abort());

    // El segmento se baja entero antes de mandarlo. En streaming, si el consumidor (ffmpeg) va
    // lento y el origen cierra con "Connection: close" (servidores Astra), el fetch de Node 22
    // (undici 6) falla un assert interno (Parser.finish: !this.paused) y tumba el proceso.
    let up, data;
    try {
      up = await fetchUpstream(url, clip, { range: req.headers.range, signal: controller.signal });
      if (up.ok) data = Buffer.from(await up.arrayBuffer());
    } catch {
      if (!res.headersSent && !res.socket?.destroyed) res.sendStatus(504);
      return;
    } finally {
      clearTimeout(timer);
    }

    if (!up.ok) {
      if (up.body) up.body.cancel().catch(() => {});
      logOnce(clip, 'segment:' + up.status, `${new URL(url).host} rechazó un segmento (${up.status})`);
      if (AUTH_ERRORS.has(up.status)) {
        masterCache = null;
        onAuthError(`segmento rechazado (${up.status})`);
      }
      return res.sendStatus(502);
    }

    // Tipo propio según extensión: algunos CDNs disfrazan los .ts como imágenes y iOS los rechaza.
    res.status(up.status).setHeader('Content-Type', SEGMENT_TYPES[ext] || 'application/octet-stream');
    res.setHeader('Content-Length', data.length); // ya descomprimido si venía con gzip
    copyHeader(up, res, 'content-range');
    copyHeader(up, res, 'accept-ranges');
    res.end(data);
  });

  return router;
}

// Mapa id corto <-> URL upstream. El iPad (y ffmpeg) sólo pueden pedir IDs que el
// propio proxy emitió, así que no es un proxy abierto hacia cualquier URL.
function createSegmentRegistry(max) {
  const idByUrl = new Map();
  const urlById = new Map();
  let seq = 0;
  return {
    mint(url, forcedExt) {
      let id = idByUrl.get(url);
      if (!id) {
        id = (++seq).toString(36);
        idByUrl.set(url, id);
        urlById.set(id, url);
        if (urlById.size > max) {
          const [oldId, oldUrl] = urlById.entries().next().value;
          urlById.delete(oldId);
          idByUrl.delete(oldUrl);
        }
      }
      return `s/${id}.${forcedExt || segmentExt(url)}`;
    },
    lookup(id) {
      return urlById.get(id);
    },
  };
}

function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  const renditions = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      let j = i + 1;
      while (j < lines.length && (!lines[j] || lines[j].startsWith('#'))) j++;
      if (j < lines.length) variants.push({ attrs: parseAttrs(line), uri: resolve(lines[j], baseUrl) });
      i = j;
    } else if (line.startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttrs(line);
      renditions.push({ tag: line, attrs, uri: attrs.URI ? resolve(attrs.URI, baseUrl) : null });
    }
  }
  return { variants, renditions };
}

// La variante más alta que entra en el techo del iPad; si ninguna entra, la más
// liviana, que es la que más chances tiene de reproducirse.
function pickVariant(variants, { maxHeight, maxBandwidth, anyCodec = false }) {
  const info = variants.map((v) => {
    const codecs = (v.attrs.CODECS || '').toLowerCase();
    return {
      v,
      height: Number((v.attrs.RESOLUTION || '').split('x')[1]) || 0,
      bandwidth: Number(v.attrs['AVERAGE-BANDWIDTH'] || v.attrs.BANDWIDTH) || 0,
      audioOnly: codecs !== '' && !VIDEO_CODECS.test(codecs),
      unsupported: !anyCodec && UNSUPPORTED_CODECS.test(codecs),
    };
  });
  const withVideo = info.filter((x) => !x.audioOnly);
  const pool = withVideo.length ? withVideo : info;
  const fits = pool.filter((x) => !x.unsupported && x.height <= maxHeight && x.bandwidth <= maxBandwidth);
  if (fits.length) return { variant: fits.sort((a, b) => b.bandwidth - a.bandwidth)[0].v, compatible: true };
  return { variant: pool.sort((a, b) => a.bandwidth - b.bandwidth)[0].v, compatible: false };
}

// Master mínima con una sola variante: el iPad no puede saltar a una que no soporta.
function buildMaster(src, variant) {
  const lines = ['#EXTM3U'];
  const audioGroup = variant.attrs.AUDIO;
  if (audioGroup) {
    const group = src.renditions.filter((r) => r.attrs.TYPE === 'AUDIO' && r.attrs['GROUP-ID'] === audioGroup);
    for (const r of group) {
      const proxied = `media.m3u8?group=${encodeURIComponent(audioGroup)}&name=${encodeURIComponent(r.attrs.NAME || '')}`;
      lines.push(r.uri ? r.tag.replace(/URI="[^"]*"/, () => `URI="${proxied}"`) : r.tag);
    }
  }
  const attrs = ['BANDWIDTH=' + (variant.attrs.BANDWIDTH || 1000000)];
  if (variant.attrs.RESOLUTION) attrs.push('RESOLUTION=' + variant.attrs.RESOLUTION);
  if (variant.attrs.CODECS) attrs.push(`CODECS="${variant.attrs.CODECS}"`);
  if (audioGroup) attrs.push(`AUDIO="${audioGroup}"`);
  lines.push('#EXT-X-STREAM-INF:' + attrs.join(','), 'media.m3u8', '');
  return lines.join('\n');
}

function parseAttrs(line) {
  const attrs = {};
  const body = line.slice(line.indexOf(':') + 1);
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(body))) attrs[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  return attrs;
}

function describe(variant) {
  const a = variant.attrs;
  return [a.RESOLUTION || 'resolución ?', a.BANDWIDTH ? Math.round(a.BANDWIDTH / 1000) + ' kbps' : null, a.CODECS].filter(Boolean).join(' · ');
}

function segmentExt(url) {
  const ext = path.posix.extname(new URL(url).pathname).slice(1).toLowerCase();
  return SEGMENT_TYPES[ext] && ext !== 'key' ? ext : 'ts';
}

function resolve(uri, base) {
  try {
    return new URL(uri, base).href;
  } catch {
    return uri;
  }
}

function isHttp(url) {
  return /^https?:\/\//i.test(url);
}

function sendPlaylist(res, body) {
  // Buffer para que Express no agregue "; charset=utf-8" al Content-Type.
  res.set({ 'Content-Type': PLAYLIST_TYPE, 'Cache-Control': 'no-cache, no-store' }).send(Buffer.from(body, 'utf8'));
}

function copyHeader(from, res, name) {
  const value = from.headers.get(name);
  if (value) res.setHeader(name, value);
}

module.exports = { createHlsProxy, FORWARD_HEADERS, PLAYLIST_TYPE };
