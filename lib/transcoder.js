'use strict';
// Transcodificación opcional (TRANSCODE=1) para canales que el iPad 1 no decodifica
// (1080p, 60 fps, High Profile, HEVC, fMP4). ffmpeg lee del propio proxy local, así que
// hereda gratis los headers y la rotación de tokens. Arranca cuando alguien mira y se
// apaga solo después de idleMs sin pedidos: no quema CPU ni ancho de banda de gusto.

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const MAX_SILENT_STARTS = 10; // ~40 s de reintentos: más que cualquier cortina o publicidad muda
const STALL_MS = 20000; // 5 segmentos sin novedades con ffmpeg vivo: está trabado
const START_TIMEOUT_MS = 45000;
const WATCHDOG_MS = 5000;
const KEEP_SEGMENTS_MS = 120000;
const FRESH_MS = 15000; // ffmpeg reescribe la playlist con cada segmento (4 s)

function createTranscoder({ input, audioInput = null, outDir, height = 480, videoKbps = 1200, idleMs = 60000, ffmpegPath = 'ffmpeg', hasInput = () => true, log = console.log, stallMs = STALL_MS, startTimeoutMs = START_TIMEOUT_MS, watchdogMs = WATCHDOG_MS, freshMs = FRESH_MS }) {
  const playlist = path.join(outDir, 'index.m3u8');
  let proc = null;
  let dying = null; // el ffmpeg del canal anterior, mientras termina de cerrar
  let missing = false;
  let lastTouch = 0;
  let idleTimer = null;
  let restartTimer = null;
  let keepOutput = false; // el próximo arranque es un reinicio del mismo canal

  // ffmpeg decide qué pistas hay en los primeros segundos: si arranca en un clip mudo, toda la
  // sesión sale muda aunque el audio vuelva. Por eso el audio es obligatorio (si falta, ffmpeg
  // falla y reintentamos en unos segundos, cuando el clip mudo ya pasó). Después de
  // MAX_SILENT_STARTS intentos así asumimos que el canal no tiene audio y seguimos sin él.
  let silentStarts = 0;

  // Hay canales (FOX Sports en Pluto) cuya variante trae sólo video: el audio va en una pista
  // aparte que lista la master. Si la variante sale sin audio, se prueba con audioInput (la
  // master) y se sigue con ella hasta el próximo cambio de canal.
  let separateAudio = false;

  // Tras un cambio de pistas se arranca en el último segmento: el live normal arranca 3 antes
  // del borde, todavía con la pista vieja, y volvería a ver el cambio en un loop de reinicios.
  let fromLiveEdge = false;

  function args() {
    return ffmpegArgs({
      input: separateAudio ? audioInput : input,
      outDir, height, videoKbps,
      requireAudio: silentStarts < MAX_SILENT_STARTS,
      liveStartIndex: fromLiveEdge ? -1 : null,
    });
  }

  function wanted() {
    return Date.now() - lastTouch < idleMs;
  }

  function lastSegment() {
    try {
      return fs.readFileSync(playlist, 'utf8').trim().split('\n').pop();
    } catch {
      return null;
    }
  }

  // En un reinicio del mismo canal se conservan los segmentos recientes: el iPad sigue con la
  // playlist anterior hasta que la corrida nueva escriba la suya (numeración por epoch más
  // discont_start: le llega un salto hacia adelante, no una playlist que desaparece).
  function prepareOutput(keep) {
    if (!keep) fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(outDir, { recursive: true });
    if (!keep) return;
    const cutoff = Date.now() - KEEP_SEGMENTS_MS;
    for (const name of fs.readdirSync(outDir)) {
      const file = path.join(outDir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
      } catch {
        // ya no está
      }
    }
  }

  function terminate(child) {
    child.kill('SIGTERM');
    setTimeout(() => child.exitCode === null && child.signalCode === null && child.kill('SIGKILL'), 5000).unref();
  }

  function start() {
    if (proc || dying || missing || !hasInput()) return;
    clearTimeout(restartTimer);
    prepareOutput(keepOutput);
    keepOutput = false;
    log('[ffmpeg] arrancando transcodificación');

    const child = spawn(ffmpegPath, args(), { stdio: ['ignore', 'ignore', 'pipe'] });
    proc = child;
    fromLiveEdge = false;
    let noAudio = false;
    let restartDelay = 3000; // tras una caída: no martillar una fuente rota

    // Reinicio buscado (trabado, pistas nuevas): sin esperar, el iPad ya está sin video.
    // Llega una vez por pista nueva (video y audio), pero se reinicia una sola vez.
    function restartNow(reason) {
      if (proc !== child || restartDelay === 0) return;
      clearInterval(watchdog);
      restartDelay = 0;
      log(`[ffmpeg] ${reason}: lo reinicio`);
      terminate(child);
    }

    // ffmpeg puede quedar vivo sin producir nada (se atrasó y perdió la ventana en vivo, o el
    // stream cambió de pista en un corte): sin esto el iPad repite el último tramo para siempre.
    const startedWith = lastSegment();
    let progress = { segment: startedWith, at: Date.now() };
    const watchdog = setInterval(() => {
      if (proc !== child) return;
      const segment = lastSegment();
      if (segment !== progress.segment) return void (progress = { segment, at: Date.now() });
      const producing = segment !== startedWith;
      const limit = producing ? stallMs : startTimeoutMs;
      if (Date.now() - progress.at < limit) return;
      restartNow(`está trabado (${Math.round(limit / 1000)} s sin ${producing ? 'segmentos nuevos' : 'producir video'})`);
    }, watchdogMs);
    const stderr = repeatCollapser((line) => {
      // El error de "sin audio" son varias líneas crípticas: lo resumimos al salir.
      if (/matches no streams/.test(line)) noAudio = true;
      // En los cambios de programa Pluto manda el video (o el audio) en una pista nueva. ffmpeg
      // no toma pistas que aparecen después de arrancar: la mapeada deja de recibir datos y la
      // salida se congela para siempre. Un ffmpeg nuevo arranca ya con las pistas actuales.
      if (/New (video|audio) stream with index/.test(line) && proc === child) {
        fromLiveEdge = true;
        restartNow('la fuente cambió de pistas (cambio de programa)');
      }
      // El del canal anterior, mientras cierra, ya lee la fuente nueva y se queja: ruido.
      if (!noAudio && child !== dying) log('[ffmpeg] ' + line);
    });
    child.stderr.on('data', (chunk) => stderr.write(chunk.toString()));
    child.on('close', () => {
      stderr.end();
      if (!noAudio || child === dying) return;
      if (audioInput && !separateAudio) {
        separateAudio = true;
        return log('[ffmpeg] la variante viene sin audio: pruebo con la pista de audio aparte de la master');
      }
      silentStarts++;
      log(
        silentStarts < MAX_SILENT_STARTS
          ? `[ffmpeg] la fuente está sin audio ahora (cortina o publicidad muda): reintento (${silentStarts}/${MAX_SILENT_STARTS})`
          : '[ffmpeg] la fuente sigue sin audio: arranco igual, sin audio'
      );
    });
    child.on('error', (err) => {
      clearInterval(watchdog);
      if (proc === child) proc = null;
      if (err.code === 'ENOENT') {
        missing = true;
        log(`[ffmpeg] no encontré "${ffmpegPath}": instalalo o definí FFMPEG_PATH`);
      } else {
        log('[ffmpeg] ' + err.message);
      }
    });
    child.on('exit', (code, signal) => {
      clearInterval(watchdog);
      if (child === dying) {
        dying = null;
        if (wanted()) start();
        return;
      }
      if (proc === child) proc = null;
      if (lastSegment() !== startedWith) silentStarts = 0; // esta corrida llegó a producir video
      log(`[ffmpeg] terminó (${signal || code})`);
      if (wanted()) {
        keepOutput = true;
        restartTimer = setTimeout(start, restartDelay);
      }
    });
  }

  // Cambio de canal: el ffmpeg actual está leyendo la fuente vieja. Al recibir SIGTERM escribe
  // su playlist final, así que no se borra nada acá: lo borra start() antes de lanzar el nuevo,
  // y mientras tanto waitReady no lee (proc es null). Nadie recibe segmentos del canal anterior.
  function reset() {
    clearTimeout(restartTimer);
    silentStarts = 0;
    separateAudio = false;
    keepOutput = false;
    if (!proc) return;
    dying = proc;
    proc = null;
    terminate(dying);
  }

  // Llegó el enlace de una fuente nueva: si alguien está mirando, arrancar ya.
  function kick() {
    if (wanted()) start();
  }

  // Se resuelve cuando ffmpeg terminó: uno trabado ignora el SIGTERM y, si el servidor sale
  // antes del SIGKILL, queda huérfano leyendo del puente que arranque después.
  function stop() {
    lastTouch = 0;
    clearTimeout(idleTimer);
    clearTimeout(restartTimer);
    const victim = proc;
    if (!victim) return Promise.resolve();
    return new Promise((resolve) => {
      victim.once('exit', resolve);
      terminate(victim);
    });
  }

  function touch() {
    lastTouch = Date.now();
    start();
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      log('[ffmpeg] nadie mirando, apago');
      stop();
    }, idleMs);
  }

  // El reproductor de iOS necesita varios segmentos para arrancar un live: retenemos el
  // primer pedido hasta que ffmpeg haya escrito al menos dos, en vez de devolver 404.
  // Una playlist que no se reescribe hace rato es de un ffmpeg trabado (o del anterior a un
  // reinicio): tampoco se sirve. Si no, la página, al reconectar por imagen congelada,
  // vuelve a reproducir los mismos tramos una y otra vez.
  async function waitReady(timeoutMs = 25000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !missing) {
      try {
        if (proc) {
          const [text, stat] = await Promise.all([fs.promises.readFile(playlist, 'utf8'), fs.promises.stat(playlist)]);
          if (Date.now() - stat.mtimeMs < freshMs && (text.match(/#EXTINF/g) || []).length >= 2) return true;
        }
      } catch {
        // todavía no existe
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  return {
    outDir,
    touch,
    stop,
    reset,
    kick,
    waitReady,
    get running() {
      return proc !== null;
    },
  };
}

// En un corte de publicidad ffmpeg repite los mismos avisos por cada paquete (miles de líneas
// en segundos, a veces alternando dos). Cada tipo se muestra una vez por minuto, con cuántas
// veces se repitió desde la anterior. El "tipo" ignora números, direcciones y el prefijo
// [aist#…]/[vist#…], que alterna entre pistas.
function repeatCollapser(emit, windowMs = 60000) {
  let pending = '';
  const seen = new Map(); // tipo → { at, repeats }

  function line(text) {
    const trimmed = text.trim();
    if (!trimmed || /^\[[^\]]*\]$/.test(trimmed)) return; // prefijo suelto partido en otro chunk
    const kind = trimmed.replace(/^\[[^\]]*\]\s*/, '').replace(/0x[0-9a-f]+|-?\d+/gi, '#');
    if (kind === 'Last message repeated # times') return; // el resumen de ffmpeg: ya contamos nosotros
    const now = Date.now();
    const prev = seen.get(kind);
    if (prev && now - prev.at < windowMs) return void prev.repeats++;
    emit(prev && prev.repeats ? `${trimmed} (y ${prev.repeats} veces más en el último minuto)` : trimmed);
    seen.set(kind, { at: now, repeats: 0 });
    if (seen.size > 200) for (const [k, v] of seen) if (now - v.at >= windowMs) seen.delete(k);
  }

  return {
    write(chunk) {
      const lines = (pending + chunk).split('\n');
      pending = lines.pop();
      lines.forEach(line);
    },
    end() {
      if (pending) line(pending);
      pending = '';
      const repeats = [...seen.values()].reduce((sum, v) => sum + v.repeats, 0);
      if (repeats) emit(`(${repeats} avisos repetidos sin mostrar)`);
      seen.clear();
    },
  };
}

// Aparte de createTranscoder para poder probarlos contra streams de prueba.
function ffmpegArgs({ input, outDir, height = 480, videoKbps = 1200, requireAudio = false, liveStartIndex = null, extra = [] }) {
  return [
    '-hide_banner', '-loglevel', 'warning',
    ...(liveStartIndex === null ? [] : ['-live_start_index', String(liveStartIndex)]),
    '-i', input,
    '-map', '0:v:0', '-map', requireAudio ? '0:a:0' : '0:a:0?',
    // Baseline 3.1 + yuv420p: lo único que el decodificador del A4 acepta sin dudar.
    '-c:v', 'libx264', '-preset', 'veryfast', '-profile:v', 'baseline', '-level', '3.1', '-pix_fmt', 'yuv420p',
    '-vf', `scale=-2:'min(${height},ih)'`, '-fpsmax', '30',
    '-b:v', `${videoKbps}k`, '-maxrate', `${Math.round(videoKbps * 1.2)}k`, '-bufsize', `${videoKbps * 2}k`,
    '-g', '60', '-keyint_min', '60', '-sc_threshold', '0',
    // async=1 rellena con silencio los clips mudos que meten en el medio (cortinas, publicidad):
    // sin eso queda un hueco de audio que desincroniza o traba al reproductor.
    '-af', 'aresample=async=1',
    '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '44100',
    ...extra,
    '-f', 'hls', '-hls_time', '4', '-hls_list_size', '6',
    // epoch + discont_start: si ffmpeg se reinicia, la numeración sigue creciendo y el
    // iPad recibe una discontinuidad en vez de una playlist que "vuelve atrás".
    '-hls_flags', 'delete_segments+omit_endlist+discont_start+temp_file',
    '-hls_start_number_source', 'epoch',
    '-hls_segment_filename', path.join(outDir, 'seg_%d.ts'),
    path.join(outDir, 'index.m3u8'),
  ];
}

module.exports = { createTranscoder, ffmpegArgs };
