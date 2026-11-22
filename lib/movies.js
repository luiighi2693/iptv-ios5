'use strict';
// Películas locales: una carpeta del disco (MOVIES_DIR) con videos en cualquier formato. Cada
// archivo nuevo se convierte UNA vez, en segundo plano, a un HLS que el iPad 1 lee directo
// (H.264 Main hasta 480p + AAC estéreo) y queda en MOVIES_DIR/.ipad/. Mirar es servir archivos:
// arranca al instante, se puede adelantar a cualquier punto y no depende de la CPU del momento.

const { spawn } = require('child_process');
const crypto = require('crypto');
const express = require('express');
const fs = require('fs');
const path = require('path');
const { Transform, pipeline } = require('stream');
const { writeAtomic } = require('./channels');

const VIDEO_FILE = /\.(mp4|m4v|mkv|avi|mov|wmv|mpg|mpeg|ts|m2ts|webm|flv|3gp|vob|divx)$/i;
const OUT_DIR = '.ipad';
const ID = /^[0-9a-f]{12}$/;
const SCAN_MS = 30000;
const MAX_DEPTH = 3;
const SEGMENT_SECONDS = 6;
const SPANISH = /^(spa|es|esp|es-\w+)$/i;
const SUBTITLE_SUFFIXES = ['.es.srt', '.spa.srt', '.esp.srt', '.srt'];
const SUBTITLE_FILE = /\.srt$/i;
// Subidas desde la página de administración: de a pedazos, para poder retomarlas si se cortan.
const UPLOAD_DIR = '.uploads';
const MAX_CHUNK = 64 * 1024 * 1024;
const FREE_MARGIN = 5 * 1024 ** 3; // no llenar el disco: siempre quedan 5 GB libres
const TEXT_SUBTITLES = /^(subrip|srt|ass|ssa|mov_text|webvtt|text)$/;
// Etiquetas de release: el título termina donde empieza la primera.
const RELEASE_TAG = /\b(2160p|1080p|720p|480p|4k|uhd|blu-?ray|[bh]d-?rip|brrip|web-?(dl|rip)?|hdtv|dvd-?rip|dvd|[xh]\.?26[45]|hevc|xvid|divx|remux|latino|castellano|espa[nñ]ol|dual|subs?|multi|proper|repack)\b/i;

function createMovies({ dir, dataDir, ffmpegPath = 'ffmpeg', maxHeight = 480, log = console.log }) {
  dir = path.resolve(dir); // absoluta: el borrado verifica que el archivo quede adentro
  const outRoot = path.join(dir, OUT_DIR);
  const uploadRoot = path.join(dir, UPLOAD_DIR);
  const uploading = new Set(); // nombres con un pedazo en camino
  const positionsFile = path.join(dataDir, 'movie-positions.json');
  const items = new Map(); // id → { id, rel, title, size, mtimeMs, status, progress, duration, error }
  const positions = readJson(positionsFile) || {}; // id → segundos
  let queue = [];
  let current = null; // { item, child }
  let scanTimer = null;
  let stopped = false;
  let warnedMissing = false;

  function scan() {
    let files;
    try {
      files = listVideos(dir);
    } catch (err) {
      // Carpeta inexistente o disco sin montar: no se toca nada, se reintenta en el próximo.
      if (!warnedMissing) log(`[películas] no puedo leer ${dir}: ${err.code || err.message}`);
      warnedMissing = true;
      return;
    }
    warnedMissing = false;
    const seen = new Set();
    for (const file of files) {
      const id = idOf(file.rel);
      seen.add(id);
      let item = items.get(id);
      if (!item) {
        item = { id, rel: file.rel, title: titleOf(file.rel), size: -1, mtimeMs: -1, status: 'copying', progress: 0 };
        items.set(id, item);
      }
      const changed = item.size !== file.size || item.mtimeMs !== file.mtimeMs;
      if (changed && item.status !== 'copying') {
        // Lo están reemplazando: se corta lo que haya y se espera a que termine de copiarse.
        if (current && current.item === item && current.child) current.child.kill('SIGKILL');
        queue = queue.filter((q) => q !== item);
        Object.assign(item, { status: 'copying', progress: 0 });
      }
      Object.assign(item, { size: file.size, mtimeMs: file.mtimeMs });
      if (item.status !== 'copying') continue;

      const meta = readJson(path.join(outRoot, id, 'meta.json'));
      if (meta && meta.size === file.size && meta.mtimeMs === file.mtimeMs) {
        Object.assign(item, { status: 'ready', duration: meta.duration });
      } else if (!changed) {
        // Mismo tamaño y fecha que en la pasada anterior: terminó de copiarse.
        item.status = 'queued';
        queue.push(item);
      }
    }
    for (const [id, item] of items) {
      if (seen.has(id)) continue;
      items.delete(id);
      queue = queue.filter((q) => q !== item);
      if (current && current.item === item) current.child.kill('SIGKILL');
    }
    removeOrphans(seen);
    next();
  }

  // Conversiones de archivos que ya no están (borrados o renombrados).
  function removeOrphans(seen) {
    let names = [];
    try {
      names = fs.readdirSync(outRoot);
    } catch {
      return;
    }
    for (const name of names) {
      const id = name.replace(/\.tmp$/, '');
      if (!ID.test(id) || seen.has(id) || (current && current.item.id === id)) continue;
      fs.rmSync(path.join(outRoot, name), { recursive: true, force: true });
      log(`[películas] borré la conversión de un archivo que ya no está (${id})`);
    }
  }

  // De a una, con prioridad baja: los canales en vivo y YouTube van primero.
  async function next() {
    if (current || stopped || !queue.length) return;
    const item = queue.shift();
    current = { item, child: null };
    item.status = 'converting';
    const started = Date.now();
    try {
      await convert(item, (child) => (current.child = child));
      item.status = 'ready';
      log(`[películas] lista: ${item.title} (${Math.round((Date.now() - started) / 60000)} min de conversión)`);
    } catch (err) {
      // Cortada a propósito (borrada, reemplazada o apagando): no es un error del archivo.
      if (items.get(item.id) === item && !stopped && item.status === 'converting') {
        Object.assign(item, { status: 'error', error: err.message });
        log(`[películas] no pude convertir ${item.rel}: ${err.message}`);
      }
    } finally {
      current = null;
      next();
    }
  }

  async function convert(item, onChild) {
    const src = path.join(dir, item.rel);
    const info = await probe(ffmpegPath, src);
    if (!info.video) throw new Error('no encontré video: ¿archivo dañado o incompleto?');
    const tmp = path.join(outRoot, `${item.id}.tmp`);
    const final = path.join(outRoot, item.id);
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });

    const plan = planFor(info, subtitleFile(src), maxHeight);
    if (plan.subtitles) prepareSubtitles(plan.subtitles, path.join(tmp, 'subs.srt'));
    if (plan.subtitles && plan.subtitles.stream !== undefined) await extractSubtitles(ffmpegPath, src, plan.subtitles.stream, tmp);
    item.duration = info.duration;
    log(`[películas] convirtiendo ${item.title}: ${plan.summary}`);

    await run(nice(ffmpegPath, ffmpegArgs(src, plan)), tmp, (seconds) => {
      item.progress = info.duration ? Math.min(99, Math.floor((seconds / info.duration) * 100)) : 0;
    }, onChild);
    // Un cuadro al 10 % de la película: la portada para la lista.
    await run([ffmpegPath, '-hide_banner', '-nostdin', '-y', '-ss', String(Math.floor((info.duration || 60) * 0.1)), '-i', src,
      '-frames:v', '1', '-vf', 'scale=160:90:force_original_aspect_ratio=decrease,pad=160:90:(ow-iw)/2:(oh-ih)/2', 'poster.jpg'], tmp, null, onChild)
      .catch(() => {});
    fs.rmSync(path.join(tmp, 'subs.srt'), { force: true });
    fs.writeFileSync(path.join(tmp, 'meta.json'), JSON.stringify({ rel: item.rel, size: item.size, mtimeMs: item.mtimeMs, duration: info.duration, plan: plan.summary }));
    fs.rmSync(final, { recursive: true, force: true });
    fs.renameSync(tmp, final);
  }

  // Un archivo que terminó de subirse está completo: no hace falta esperar a ver que dejó de crecer.
  function added(rel) {
    if (SUBTITLE_FILE.test(rel)) return subtitlesChanged(rel);
    scan();
    const item = items.get(idOf(rel));
    if (item && item.status === 'copying') {
      item.status = 'queued';
      queue.push(item);
      next();
    }
  }

  // Subtítulos nuevos o borrados: la película se convierte de nuevo para grabarlos (o sacarlos).
  function subtitlesChanged(rel) {
    const base = rel.replace(/(\.(es|spa|esp))?\.srt$/i, '');
    for (const item of items.values()) {
      if (item.rel.replace(/\.[^.]+$/, '') !== base || item.status === 'copying') continue;
      if (current && current.item === item && current.child) current.child.kill('SIGKILL');
      queue = queue.filter((q) => q !== item);
      Object.assign(item, { status: 'queued', progress: 0 });
      queue.push(item);
    }
    next();
  }

  function savePosition(id, seconds) {
    if (seconds > 0) positions[id] = Math.round(seconds);
    else delete positions[id];
    writeAtomic(positionsFile, positions, (err) => log('[películas] no pude guardar por dónde iba:', err.message));
  }

  function list() {
    const rank = { ready: 0, converting: 1, queued: 2, copying: 2, error: 3 };
    return [...items.values()]
      .sort((a, b) => rank[a.status] - rank[b.status] || a.title.localeCompare(b.title, 'es', { sensitivity: 'base' }))
      .map((m) => [m.id, m.title, Math.round(m.duration || 0), m.status, m.progress || 0, positions[m.id] || 0]);
  }

  const router = express.Router();

  router.get('/list', (req, res) => res.set('Cache-Control', 'no-store').json({ items: list() }));

  router.post('/:id/position', express.text({ limit: '1kb' }), (req, res) => {
    const item = items.get(req.params.id);
    const seconds = Number(String(req.body || '').trim());
    if (!item || !Number.isFinite(seconds) || seconds < 0) return res.sendStatus(404);
    // Casi al final (créditos) cuenta como vista: la próxima vez arranca de cero.
    savePosition(item.id, item.duration && seconds > item.duration - Math.min(120, item.duration * 0.05) ? 0 : seconds);
    res.sendStatus(204);
  });

  // ---- Administración (public/admin.html): listar, subir y borrar. Va antes de /:id/:file.

  router.get('/admin/files', (req, res) => {
    const videos = [...items.values()].sort((a, b) => a.rel.localeCompare(b.rel, 'es'));
    const withVideo = new Set();
    const movies = videos.map((m) => {
      const subtitles = SUBTITLE_SUFFIXES.map((s) => m.rel.replace(/\.[^.]+$/, '') + s).filter((s) => fs.existsSync(path.join(dir, s)));
      subtitles.forEach((s) => withVideo.add(s));
      return { rel: m.rel, title: m.title, size: m.size, status: m.status, progress: m.progress || 0, error: m.error || null, subtitles };
    });
    let loose = [];
    try {
      loose = listFiles(dir, SUBTITLE_FILE).filter((s) => !withVideo.has(s));
    } catch {
      // carpeta sin montar: ya lo avisa el scan
    }
    const uploads = listFiles(uploadRoot, /\.part$/).map((p) => ({ name: p.replace(/\.part$/, ''), received: sizeOf(path.join(uploadRoot, p)) }));
    res.set('Cache-Control', 'no-store').json({ dir, free: freeBytes(dir), movies, loose, uploads });
  });

  // Cuánto de un archivo ya llegó (para retomar una subida cortada).
  router.get('/admin/upload', (req, res) => {
    const name = uploadName(req.query.name);
    if (!name) return res.status(400).json({ error: 'nombre de archivo no permitido' });
    if (fs.existsSync(path.join(dir, name))) return res.json({ exists: true, received: 0 });
    res.json({ exists: false, received: sizeOf(path.join(uploadRoot, `${name}.part`)) });
  });

  // PUT ?name=&offset=&total= con un pedazo en el cuerpo, en crudo. El pedazo se agrega sólo si
  // offset coincide con lo ya recibido; si no, 409 con lo que hay, y el navegador sigue desde ahí.
  router.put('/admin/upload', (req, res) => {
    const name = uploadName(req.query.name);
    const offset = Number(req.query.offset);
    const total = Number(req.query.total);
    if (!name) return res.status(400).json({ error: 'nombre de archivo no permitido (sólo videos y .srt)' });
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(total) || offset < 0 || total <= 0 || offset > total) {
      return res.status(400).json({ error: 'offset o total inválidos' });
    }
    const target = path.join(dir, name);
    const part = path.join(uploadRoot, `${name}.part`);
    if (fs.existsSync(target)) return res.status(409).json({ error: 'ya hay un archivo con ese nombre', exists: true });
    if (uploading.has(name)) return res.status(409).json({ error: 'ese archivo ya se está subiendo', received: sizeOf(part) });
    const received = sizeOf(part);
    if (offset !== received) return res.status(409).json({ received });
    if (offset === 0 && total > freeBytes(dir) - FREE_MARGIN) return res.status(507).json({ error: 'no hay espacio en el disco' });

    uploading.add(name);
    fs.mkdirSync(uploadRoot, { recursive: true });
    let bytes = 0;
    const guard = new Transform({
      transform(chunk, encoding, done) {
        bytes += chunk.length;
        if (bytes > MAX_CHUNK || offset + bytes > total) return done(new Error('pedazo más grande de lo anunciado'));
        done(null, chunk);
      },
    });
    pipeline(req, guard, fs.createWriteStream(part, { flags: 'a' }), (err) => {
      uploading.delete(name);
      const now = sizeOf(part);
      // Cortado a mitad de pedazo: lo que llegó queda, y el navegador retoma desde ahí.
      if (err) return res.headersSent || res.destroyed ? undefined : res.status(400).json({ error: err.message, received: now });
      if (now < total) return res.json({ received: now });
      fs.renameSync(part, target);
      log(`[películas] subida completa: ${name} (${(total / 1024 ** 3).toFixed(2)} GB)`);
      added(name);
      res.json({ received: now, done: true });
    });
  });

  // Descarta una subida a medias.
  router.delete('/admin/upload', (req, res) => {
    const name = uploadName(req.query.name);
    if (!name || uploading.has(name)) return res.sendStatus(409);
    fs.rmSync(path.join(uploadRoot, `${name}.part`), { force: true });
    res.sendStatus(204);
  });

  // Borra un video (con sus subtítulos; la conversión la limpia el scan) o un .srt suelto.
  router.delete('/admin/files', (req, res) => {
    const rel = String(req.query.path || '');
    const file = path.resolve(dir, rel);
    const inside = file.startsWith(dir + path.sep) && !rel.split(/[/\\]/).some((p) => p.startsWith('.'));
    if (!inside || !(VIDEO_FILE.test(file) || SUBTITLE_FILE.test(file)) || !fs.existsSync(file)) return res.sendStatus(404);
    fs.rmSync(file);
    const removed = [rel];
    if (VIDEO_FILE.test(file)) {
      for (const suffix of SUBTITLE_SUFFIXES) {
        const sub = file.replace(/\.[^.]+$/, '') + suffix;
        if (fs.existsSync(sub)) {
          fs.rmSync(sub);
          removed.push(path.relative(dir, sub));
        }
      }
      savePosition(idOf(rel), 0);
      scan();
    } else {
      subtitlesChanged(rel);
    }
    log(`[películas] borrado desde la administración: ${removed.join(', ')}`);
    res.sendStatus(204);
  });

  const TYPES = { m3u8: 'application/vnd.apple.mpegurl', ts: 'video/mp2t', jpg: 'image/jpeg' };
  router.get('/:id/:file', (req, res) => {
    const { id, file } = req.params;
    const item = items.get(id);
    if (!item || item.status !== 'ready' || !/^(index\.m3u8|seg_\d{5}\.ts|poster\.jpg)$/.test(file)) return res.sendStatus(404);
    const ext = file.split('.').pop();
    res.set({ 'Content-Type': TYPES[ext], 'Cache-Control': ext === 'm3u8' ? 'no-cache' : 'max-age=86400' });
    res.sendFile(path.join(outRoot, id, file), (err) => err && !res.headersSent && res.sendStatus(404));
  });

  return {
    router,
    start() {
      try {
        fs.mkdirSync(outRoot, { recursive: true });
      } catch {
        // se avisa en el scan
      }
      scan();
      scanTimer = setInterval(scan, SCAN_MS);
    },
    stop() {
      stopped = true;
      clearInterval(scanTimer);
      if (current && current.child) current.child.kill('SIGKILL');
    },
  };
}

function listVideos(root) {
  const found = [];
  (function walk(rel, depth) {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue; // .ipad, ._ de macOS, ocultos
      const child = path.join(rel, entry.name);
      if (entry.isDirectory() && depth < MAX_DEPTH) walk(child, depth + 1);
      else if (entry.isFile() && VIDEO_FILE.test(entry.name)) {
        const stat = fs.statSync(path.join(root, child));
        found.push({ rel: child, size: stat.size, mtimeMs: Math.round(stat.mtimeMs) });
      }
    }
  })('', 0);
  return found;
}

// Archivos de una carpeta (sin ocultos), recorriendo subcarpetas como listVideos.
function listFiles(root, pattern) {
  const found = [];
  if (!fs.existsSync(root)) return found;
  (function walk(rel, depth) {
    for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const child = path.join(rel, entry.name);
      if (entry.isDirectory() && depth < MAX_DEPTH) walk(child, depth + 1);
      else if (entry.isFile() && pattern.test(entry.name)) found.push(child);
    }
  })('', 0);
  return found;
}

// Sólo un nombre de archivo (nada de carpetas ni ocultos), y sólo videos o .srt.
function uploadName(value) {
  const name = String(value || '').normalize('NFC').trim();
  if (!name || name.length > 200 || name !== path.basename(name) || name.startsWith('.')) return null;
  if (/[\x00-\x1f\\/:]/.test(name) || !(VIDEO_FILE.test(name) || SUBTITLE_FILE.test(name))) return null;
  return name;
}

function sizeOf(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function freeBytes(dir) {
  try {
    const stats = fs.statfsSync(dir);
    return stats.bavail * stats.bsize;
  } catch {
    return 0;
  }
}

function idOf(rel) {
  return crypto.createHash('sha1').update(rel).digest('hex').slice(0, 12);
}

// "The.Matrix.1999.1080p.BluRay.x264.mkv" → "The Matrix (1999)"
function titleOf(rel) {
  const name = path.basename(rel).replace(/\.[^.]+$/, '');
  let title = name.replace(/[._]+/g, ' ');
  const tag = title.search(RELEASE_TAG);
  if (tag > 0) title = title.slice(0, tag);
  title = title.replace(/[\s([{-]+$/, '');
  const year = /[\s([]((?:19|20)\d{2})[)\]]?$/.exec(title);
  if (year) title = `${title.slice(0, year.index).replace(/[\s(-]+$/, '')} (${year[1]})`;
  return title.replace(/\s+/g, ' ').trim() || name;
}

// ffmpeg -i (no hay ffprobe en el ffmpeg de evermeet): duración y pistas.
function probe(ffmpegPath, file) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file], { stdio: ['ignore', 'ignore', 'pipe'] });
    let text = '';
    child.stderr.on('data', (chunk) => (text += chunk));
    child.on('error', reject);
    child.on('close', () => resolve(parseProbe(text)));
  });
}

function parseProbe(text) {
  const duration = /Duration: (\d+):(\d+):(\d+(?:\.\d+)?)/.exec(text);
  const info = { duration: duration ? +duration[1] * 3600 + +duration[2] * 60 + +duration[3] : 0, video: null, audio: [], subtitles: [] };
  const stream = /Stream #0:(\d+)(?:\[[^\]]*\])?(?:\(([^)]*)\))?: (Video|Audio|Subtitle): (.*)/g;
  let m, video = 0, audio = 0, subtitle = 0;
  while ((m = stream.exec(text))) {
    const [, index, lang = '', kind, rest] = m;
    const codec = rest.split(/[\s,]/)[0];
    const base = { index: +index, lang, codec, isDefault: /\(default\)/.test(rest) };
    if (kind === 'Video') {
      // Las portadas de los MKV/MP4 vienen como un "video" de un cuadro: no cuentan.
      if (!info.video && !/attached pic/.test(rest)) {
        const size = /\b(\d{2,5})x(\d{2,5})\b/.exec(rest) || [];
        const fps = /([\d.]+) fps/.exec(rest);
        info.video = { ...base, order: video, profile: (/^\w+ \(([^)]+)\)/.exec(rest) || [])[1] || '', width: +size[1] || 0, height: +size[2] || 0, fps: fps ? +fps[1] : 0 };
      }
      video++;
    } else if (kind === 'Audio') info.audio.push({ ...base, order: audio++ });
    else info.subtitles.push({ ...base, order: subtitle++ });
  }
  return info;
}

// Qué hacer con cada pista. El video se copia tal cual sólo si el iPad ya lo lee y no hay que
// grabarle subtítulos; el audio siempre se pasa a AAC estéreo (barato, y evita AC3/DTS/5.1).
function planFor(info, sidecar, maxHeight) {
  const audio = info.audio.find((a) => SPANISH.test(a.lang)) || info.audio.find((a) => a.isDefault) || info.audio[0] || null;
  const spanishAudio = Boolean(audio && SPANISH.test(audio.lang));
  let subtitles = null;
  if (sidecar) subtitles = { file: sidecar };
  else if (!spanishAudio) {
    const embedded = info.subtitles.find((s) => SPANISH.test(s.lang) && TEXT_SUBTITLES.test(s.codec));
    if (embedded) subtitles = { stream: embedded.index };
  }
  const v = info.video;
  const copy = !subtitles && v.codec === 'h264' && /baseline|main/i.test(v.profile) && v.height <= maxHeight && v.fps <= 31;
  const summary = [
    copy ? `video copiado (${v.codec} ${v.height}p)` : `video ${v.codec} ${v.height}p → H.264 ${Math.min(v.height, maxHeight)}p`,
    audio ? `audio ${audio.codec}${audio.lang ? ` (${audio.lang})` : ''} → AAC estéreo` : 'sin audio',
    subtitles ? `subtítulos ${subtitles.file ? path.basename(subtitles.file) : 'en español del archivo'} grabados` : '',
  ].filter(Boolean).join(' · ');
  return { video: v, audio, copy, subtitles, maxHeight, summary };
}

function ffmpegArgs(src, plan) {
  const filters = [`scale='min(854,iw)':'min(${plan.maxHeight},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`];
  if (plan.video.fps > 31) filters.push('fps=30');
  if (plan.subtitles) filters.push("subtitles=subs.srt:force_style='Fontsize=22'");
  return [
    '-hide_banner', '-nostdin', '-y', '-nostats', '-progress', 'pipe:1', '-i', src,
    '-map', `0:${plan.video.index}`, ...(plan.audio ? ['-map', `0:${plan.audio.index}`] : []),
    ...(plan.copy
      ? ['-c:v', 'copy']
      : ['-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'main', '-level', '3.1',
          '-crf', '22', '-maxrate', '1500k', '-bufsize', '3000k', '-pix_fmt', 'yuv420p',
          '-force_key_frames', `expr:gte(t,n_forced*${SEGMENT_SECONDS})`]),
    ...(plan.audio ? ['-c:a', 'aac', '-b:a', '128k', '-ac', '2', '-ar', '44100'] : []),
    '-f', 'hls', '-hls_time', String(SEGMENT_SECONDS), '-hls_playlist_type', 'vod', '-hls_segment_filename', 'seg_%05d.ts', 'index.m3u8',
  ];
}

// Un .srt al lado del video, con el mismo nombre (pelicula.srt, pelicula.es.srt…).
function subtitleFile(src) {
  const base = src.replace(/\.[^.]+$/, '');
  for (const suffix of SUBTITLE_SUFFIXES) if (fs.existsSync(base + suffix)) return base + suffix;
  return null;
}

// libass quiere UTF-8 y muchos .srt en español vienen en Windows-1252.
function prepareSubtitles(subtitles, target) {
  if (!subtitles.file) return;
  const raw = fs.readFileSync(subtitles.file);
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    text = new TextDecoder('windows-1252').decode(raw);
  }
  fs.writeFileSync(target, text.replace(/^﻿/, ''));
}

function extractSubtitles(ffmpegPath, src, index, cwd) {
  return run([ffmpegPath, '-hide_banner', '-nostdin', '-y', '-i', src, '-map', `0:${index}`, '-c:s', 'srt', 'subs.srt'], cwd, null, () => {});
}

function nice(ffmpegPath, args) {
  return ['/usr/bin/nice', '-n', '15', ffmpegPath, ...args];
}

// Corre un comando en cwd; con onSeconds, lee el -progress de ffmpeg por stdout.
function run(command, cwd, onSeconds, onChild) {
  return new Promise((resolve, reject) => {
    const child = spawn(command[0], command.slice(1), { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    if (onChild) onChild(child);
    let errors = '';
    child.stdout.on('data', (chunk) => {
      const us = /out_time_us=(\d+)/.exec(String(chunk));
      if (us && onSeconds) onSeconds(Number(us[1]) / 1e6);
    });
    child.stderr.on('data', (chunk) => (errors = (errors + chunk).slice(-2000)));
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(signal ? `cortado (${signal})` : errors.trim().split('\n').pop() || `ffmpeg salió con ${code}`));
    });
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

module.exports = { createMovies, titleOf, parseProbe, planFor, ffmpegArgs };
