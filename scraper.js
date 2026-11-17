'use strict';
// Capturador de tokens. Dos piezas:
//   - createPageSource: abre la página del canal en un Chrome controlado, espera a que el
//     reproductor pida su .m3u8 y se queda con esa URL más los headers que la autorizan.
//   - startRefresher: repite cualquier capture() (página, Pluto, lista M3U) cuando toca o
//     cuando el CDN rechaza el token.
// Se usa desde server.js (un refresher por canal elegido) o suelto (npm run scraper), posteando
// al puente el enlace de TARGET_URL.

const puppeteer = require('puppeteer');
const { plutoSlug, createPlutoSource } = require('./lib/pluto');

const PLAYLIST_CONTENT_TYPE = /mpegurl/i;

function readConfig() {
  return {
    targetUrl: process.env.TARGET_URL,
    playSelector: process.env.PLAY_SELECTOR || '',
    pattern: new RegExp(process.env.M3U8_PATTERN || '\\.m3u8(\\?|$)', 'i'),
    refreshMs: (Number(process.env.REFRESH_MINUTES) || 10) * 60000,
    retryMs: 60000,
    minForcedGapMs: 60000,
    captureTimeoutMs: (Number(process.env.CAPTURE_TIMEOUT_SECONDS) || 45) * 1000,
    headless: process.env.HEADLESS !== '0',
    profileDir: process.env.CHROME_PROFILE_DIR || undefined,
    executablePath: process.env.CHROME_PATH || undefined,
  };
}

// Un Chrome por captura: entre capturas pasan minutos y así no acumula memoria ni procesos
// zombis. Con CHROME_PROFILE_DIR la sesión del sitio persiste igual en disco.
function createPageSource(targetUrl, log = console.log) {
  const config = readConfig();
  let browser = null;

  async function capture() {
    browser = await puppeteer.launch({
      headless: config.headless,
      userDataDir: config.profileDir,
      executablePath: config.executablePath,
      defaultViewport: { width: 1280, height: 720 },
      timeout: 90000, // el primer arranque de Chrome en frío puede pasar los 30 s por defecto
      args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio', '--no-first-run'],
    });
    try {
      const page = await browser.newPage();
      page.on('popup', (popup) => popup && popup.close().catch(() => {}));
      await page.setUserAgent({ userAgent: (await browser.userAgent()).replace('HeadlessChrome', 'Chrome') });

      const hit = waitForPlaylistRequest(page, config);
      let captured = false;
      hit.then(() => (captured = true), () => {});

      // Sin await: hay sitios que nunca terminan de cargar (publicidad) pero el
      // reproductor pide la playlist igual. El límite real lo pone `hit`.
      page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: config.captureTimeoutMs }).catch((err) => {
        if (!captured) log('[scraper] navegación: ' + err.message);
      });
      if (config.playSelector) clickPlay(page, config.playSelector, () => captured).catch(() => {});

      const req = await hit;
      const sent = req.headers();
      return {
        url: req.url(),
        headers: {
          'user-agent': sent['user-agent'],
          referer: sent.referer,
          origin: sent.origin,
          cookie: await cookieHeader(page, req.url()),
        },
      };
    } finally {
      const b = browser;
      browser = null;
      if (b) await b.close().catch(() => {});
    }
  }

  capture.close = async () => {
    if (browser) await browser.close().catch(() => {});
  };
  return capture;
}

// capture() puede devolver refreshMs para pedir otro ritmo (Pluto: cada ~8 h).
function startRefresher({ capture, onClip, log = console.log, refreshMs, retryMs = 60000, minForcedGapMs = 60000 }) {
  let running = null;
  let lastRunAt = 0;
  let timer = null;
  let stopped = false;

  function schedule(ms) {
    clearTimeout(timer);
    if (!stopped) timer = setTimeout(() => run('programado'), ms);
  }

  function run(reason) {
    if (running || stopped) return running;
    lastRunAt = Date.now();
    log(`[scraper] capturando (${reason})…`);
    running = capture()
      .then(async ({ refreshMs: next = refreshMs, ...found }) => {
        if (stopped) return; // cambiaron de canal mientras capturábamos: este enlace ya no sirve
        await onClip(found);
        log(`[scraper] token fresco de ${new URL(found.url).host}; próximo en ${Math.round(next / 60000)} min`);
        schedule(next);
      })
      .catch((err) => {
        if (stopped) return;
        log(`[scraper] falló: ${err.message}; reintento en ${retryMs / 1000} s`);
        schedule(retryMs);
      })
      .finally(() => {
        running = null;
      });
    return running;
  }

  // Lo llama el proxy cuando el CDN rechaza el token. Con freno para no lanzar una captura
  // por cada segmento rechazado.
  function refreshNow(reason) {
    if (running || Date.now() - lastRunAt < minForcedGapMs) return;
    run(`token rechazado: ${reason}`);
  }

  async function stop() {
    stopped = true;
    clearTimeout(timer);
    if (capture.close) await capture.close();
  }

  run('inicio');
  return { refreshNow, stop };
}

// Dos detectores: por URL (rápido) y por Content-Type de la respuesta, porque muchos
// sitios esconden la extensión (ej. /playlist/123/a/x?token=…) pero el servidor igual
// responde application/vnd.apple.mpegurl.
function waitForPlaylistRequest(page, config) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`ninguna playlist HLS (${config.pattern} o Content-Type mpegurl) en ${config.captureTimeoutMs / 1000} s`)),
      config.captureTimeoutMs
    );
    const found = (req) => {
      clearTimeout(timer);
      resolve(req);
    };
    page.on('request', (req) => config.pattern.test(req.url()) && found(req));
    page.on('response', (res) => PLAYLIST_CONTENT_TYPE.test(res.headers()['content-type'] || '') && found(res.request()));
  });
}

// Muchos reproductores no piden la playlist hasta que alguien toca "play", y suelen vivir
// dentro de iframes: buscamos el selector en todos los frames y reintentamos el clic
// (el primero muchas veces se lo come una capa de publicidad).
async function clickPlay(page, selector, isDone, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (!isDone() && !page.isClosed() && Date.now() < deadline) {
    for (const frame of page.frames()) {
      const el = await frame.$(selector).catch(() => null);
      if (el) {
        await el.click().catch(() => {});
        break;
      }
    }
    await new Promise((r) => setTimeout(r, 2000));
  }
}

async function cookieHeader(page, url) {
  const cdp = await page.createCDPSession();
  try {
    const { cookies } = await cdp.send('Network.getCookies', { urls: [url] });
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  } finally {
    await cdp.detach().catch(() => {});
  }
}

module.exports = { readConfig, createPageSource, startRefresher };

// Modo suelto: corre en esta u otra máquina y manda cada enlace de TARGET_URL al puente.
if (require.main === module) {
  try {
    process.loadEnvFile();
  } catch {
    // sin .env
  }
  const config = readConfig();
  if (!config.targetUrl) throw new Error('Falta TARGET_URL');
  const bridge = (process.env.BRIDGE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
  const secret = process.env.CLIP_SECRET || '';
  const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
  const slug = plutoSlug(config.targetUrl);

  const refresher = startRefresher({
    capture: slug ? createPlutoSource(slug) : createPageSource(config.targetUrl, log),
    refreshMs: config.refreshMs,
    log,
    onClip: async (clip) => {
      const headers = { 'content-type': 'application/json' };
      if (secret) headers['x-clip-secret'] = secret;
      const res = await fetch(`${bridge}/api/clip`, { method: 'POST', headers, body: JSON.stringify(clip) });
      if (!res.ok) throw new Error(`el puente respondió ${res.status}`);
    },
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => refresher.stop().then(() => process.exit(0)));
}
