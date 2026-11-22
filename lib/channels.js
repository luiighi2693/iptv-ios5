'use strict';
// Catálogo de canales para el menú del iPad. Junta varias fuentes detrás de una misma forma
// ({ id, name, source }) y convierte cada una en una función capture() que devuelve el enlace
// vigente ({ url, headers, refreshMs? }), igual que el capturador de páginas:
//   pluto → API de Pluto TV (catálogo de la región del servidor)
//   m3u   → listas M3U (iptv-org y similares), validadas canal por canal en segundo plano
//   page  → la página de TARGET_URL, capturada con Chrome

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { parseM3u } = require('./m3u');
const { plutoSlug, createPlutoSource, fetchPlutoCatalog } = require('./pluto');

const REBUILD_MS = 12 * 3600 * 1000;
const STATIC_REFRESH_MS = 6 * 3600 * 1000;
const HEALTH_TIMEOUT_MS = 8000;
const HEALTH_CONCURRENCY = 8;
const ALIVE_RECHECK_MS = 6 * 3600 * 1000;
const DEAD_RETRY_MS = 30 * 60 * 1000; // se duplica con cada falla seguida, hasta MAX_DEAD_RETRY_MS
const MAX_DEAD_RETRY_MS = 24 * 3600 * 1000;
const VALIDATE_BATCH = 40;
const VALIDATE_IDLE_MS = 60 * 1000;
const PROGRESS_LOG_MS = 2 * 60 * 1000;
const PLUTO_ID_IN_URL = /plu-([0-9a-f]{24})/i;
const SPANISH_CATEGORY = /españ|spanish|latin/i;
const MIN_GROUP_SIZE = 3; // categorías más chicas van a "Otros": en el iPad cada fila cuenta

// Las categorías de iptv-org vienen en inglés. Traducirlas además las separa de las de Pluto
// de EE. UU. (en inglés): "Películas" de la lista en español no se mezcla con "Movies".
const M3U_GROUP_NAMES = {
  Animation: 'Animación', Auto: 'Autos', Business: 'Negocios', Classic: 'Clásicos', Comedy: 'Comedia',
  Cooking: 'Cocina', Culture: 'Cultura', Documentary: 'Documentales', Education: 'Educación',
  Entertainment: 'Entretenimiento', Family: 'Familia', General: 'General', Kids: 'Infantil',
  Legislative: 'Legislativo', Lifestyle: 'Estilo de vida', Movies: 'Películas', Music: 'Música',
  News: 'Noticias', Outdoor: 'Aire libre', Religious: 'Religión', Science: 'Ciencia', Series: 'Series',
  Shop: 'Compras', Sports: 'Deportes', Travel: 'Viajes', Weather: 'Clima', Undefined: 'Otros', Otros: 'Otros',
};

// Por canal, sus categorías traducidas sin las chiquitas; el orden, de más canales a menos.
function localizeGroups(channels) {
  const translated = channels.map((c) => c.groups.map((g) => M3U_GROUP_NAMES[g] || g));
  const counts = {};
  for (const names of translated) for (const name of names) counts[name] = (counts[name] || 0) + 1;
  const perChannel = translated.map((names) => {
    const kept = names.filter((name) => name !== 'Otros' && counts[name] >= MIN_GROUP_SIZE);
    return kept.length ? kept : ['Otros'];
  });
  const sizes = {};
  for (const names of perChannel) for (const name of names) sizes[name] = (sizes[name] || 0) + 1;
  const order = Object.keys(sizes).sort((a, b) => (a === 'Otros') - (b === 'Otros') || sizes[b] - sizes[a]);
  return { perChannel, order };
}

function shortHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 10);
}

function channelFromUrl(url) {
  const slug = plutoSlug(url);
  if (slug) return { id: `pluto:${slug}`, name: slug, source: { type: 'pluto', slug } };
  return { id: `page:${shortHash(url)}`, name: `Canal configurado (${new URL(url).host})`, source: { type: 'page', url } };
}

function createSource(channel, log) {
  const { source } = channel;
  if (source.type === 'pluto') return createPlutoSource(source.slug);
  if (source.type === 'm3u') return createStaticSource(source);
  if (source.type === 'page') return require('../scraper').createPageSource(source.url, log);
  throw new Error(`fuente desconocida: ${source.type}`);
}

// Enlace fijo de una lista. Las redirecciones (jmp2.uk y similares) se resuelven una vez por
// captura: el proxy relee la master seguido y no tiene sentido pegarle al redirector cada vez.
function createStaticSource({ url, headers = {} }) {
  return async function capture() {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!res.ok || !text.includes('#EXTM3U')) throw new Error(`el canal respondió ${res.status} sin playlist`);
    return { url: res.url, headers, refreshMs: STATIC_REFRESH_MS };
  };
}

// Vivo = baja un segmento de verdad. Pedir sólo la playlist no alcanza: hay CDNs (Rakuten TV
// desde fuera de Europa) que entregan la playlist y rechazan los segmentos por región.
async function segmentReachable({ url, headers }) {
  const get = (u, extra) => fetch(u, { headers: { ...headers, ...extra }, signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) });
  let res = await get(url);
  let text = await res.text();
  if (!res.ok || !text.includes('#EXTM3U')) return false;
  if (text.includes('#EXT-X-STREAM-INF')) {
    const variant = uriLines(text)[0];
    if (!variant) return false;
    res = await get(new URL(variant, res.url).href);
    text = await res.text();
    if (!res.ok || !text.includes('#EXTM3U')) return false;
  }
  const segment = uriLines(text).pop();
  if (!segment) return false;
  const seg = await get(new URL(segment, res.url).href, { range: 'bytes=0-1023' });
  if (seg.body) seg.body.cancel().catch(() => {});
  return seg.ok;
}

function uriLines(playlist) {
  return playlist.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
}


// Vivo: pasó el chequeo alguna vez y no falló dos veces seguidas desde entonces (una sola falla
// puede ser un corte de red: se reintenta pronto antes de darlo por caído).
function isAlive(h) {
  return Boolean(h && h.okAt && h.fails < 2);
}

// Los vivos se re-chequean cada tanto; los muertos, cada vez más espaciado (muchos canales de
// estas listas no son 24/7 y vuelven más tarde).
function isDue(h, now, aliveRecheckMs, deadRetryMs) {
  if (!h) return true;
  const wait = h.ok ? aliveRecheckMs : Math.min(MAX_DEAD_RETRY_MS, deadRetryMs * 2 ** (h.fails - 1));
  return now - h.at >= wait;
}

const STATUS_ORDER = { ok: 0, pending: 1, dead: 2 };

// Las listas entran sin filtrar (salvo m3uAllow) y un validador en segundo plano prueba sus
// canales de a tandas. El menú muestra todo con su estado (ok / pending / dead), calculado en
// cada pedido, y el historial de cada canal (health) se guarda para no empezar de cero.
function createCatalog({
  file, healthFile, targetUrl, m3uUrls, m3uAllow = null, pluto, plutoCategories = null, log, onBuilt,
  aliveRecheckMs = ALIVE_RECHECK_MS, deadRetryMs = DEAD_RETRY_MS, idleMs = VALIDATE_IDLE_MS,
}) {
  let state = readState(file);
  const health = readJson(healthFile) || seedHealth(state); // id del canal → último chequeo
  const listCache = new Map(); // url de la lista → sus canales, por si la próxima lectura falla
  const probing = new Map(); // id → chequeo manual en curso
  let listed = []; // canales de las listas, los que valida el validador
  let plutoGroups = [];
  let timer = null;
  let building = null;
  let running = false;
  let lastProgressLog = 0;

  async function build() {
    let plutoCatalog = null;
    if (pluto) {
      try {
        plutoCatalog = await fetchPlutoCatalog();
      } catch (err) {
        log(`[catálogo] Pluto TV: ${err.message}`);
      }
    }
    const plutoIds = new Set(plutoCatalog ? plutoCatalog.categories.flatMap((cat) => cat.channels.map((c) => c.plutoId)) : []);
    if (plutoCatalog) {
      plutoGroups = plutoCatalog.categories
        .filter((cat) => !plutoCategories || plutoCategories.test(cat.name))
        // Las categorías en español primero; el resto, en el orden que les da Pluto.
        .sort((a, b) => SPANISH_CATEGORY.test(b.name) - SPANISH_CATEGORY.test(a.name));
    }

    // Las listas van antes que Pluto: son las que eligió el usuario (por idioma, por país).
    const entries = [];
    const seen = new Set();
    for (const url of m3uUrls) {
      let channels = listCache.get(url);
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const all = parseM3u(await res.text());
        channels = m3uAllow ? all.filter((c) => m3uAllow.test(`${c.name} ${c.url}`)) : all;
        listCache.set(url, channels);
        log(`[catálogo] ${new URL(url).pathname}: ${all.length} canales${m3uAllow ? ` · ${channels.length} pasan M3U_ALLOW` : ''}`);
      } catch (err) {
        log(`[catálogo] no pude leer ${url}: ${err.message}${channels ? ' (sigo con la lectura anterior)' : ''}`);
      }
      for (const c of channels || []) {
        // Los de Pluto que ya están en su catálogo van directo por la API, sin redirector.
        const m = PLUTO_ID_IN_URL.exec(c.url);
        if (seen.has(c.url) || (m && plutoIds.has(m[1]))) continue;
        seen.add(c.url);
        entries.push(c);
      }
    }

    const groups = new Map(); // nombre → [ids], en orden de aparición
    const channels = {};
    const add = (channel, groupNames) => {
      if (!channels[channel.id]) channels[channel.id] = channel;
      for (const name of groupNames) {
        if (!groups.has(name)) groups.set(name, []);
        if (!groups.get(name).includes(channel.id)) groups.get(name).push(channel.id);
      }
    };
    const configured = targetUrl ? channelFromUrl(targetUrl) : null;
    if (configured && configured.source.type === 'page') add(configured, ['Configurado']);
    const { perChannel, order } = localizeGroups(entries);
    for (const name of order) if (!groups.has(name)) groups.set(name, []);
    listed = entries.map((c) => ({ id: `m3u:${shortHash(c.url)}`, name: c.name, source: { type: 'm3u', url: c.url, headers: c.headers } }));
    listed.forEach((c, i) => add(c, perChannel[i]));
    for (const cat of plutoGroups) {
      for (const c of cat.channels) add({ id: `pluto:${c.slug}`, name: c.name, source: { type: 'pluto', slug: c.slug } }, [cat.name]);
    }

    if (!Object.keys(channels).length) {
      log('[catálogo] no conseguí ningún canal; sigo con el catálogo anterior');
      return;
    }
    state = { updatedAt: Date.now(), groups: [...groups].map(([name, ids]) => ({ name, ids })), channels };
    writeAtomic(file, state, (err) => log('[catálogo] no pude guardar:', err.message));
    // Canales que ya no están en ninguna fuente: su historial no sirve más.
    for (const id of Object.keys(health)) if (!channels[id]) delete health[id];
    saveHealth();
    const counts = countListed();
    log(`[catálogo] ${Object.keys(channels).length} canales en ${state.groups.length} categorías · listas: ${listed.length} (${counts.ok} vivos, ${counts.pending} por validar)${plutoCatalog ? ` · Pluto TV (${plutoCatalog.region}): ${plutoIds.size}` : ''}`);
    if (onBuilt) onBuilt();
  }

  function statusOf(id) {
    const h = health[id];
    if (h) return isAlive(h) ? 'ok' : 'dead';
    // Sin chequeo: los de las listas esperan al validador; Pluto y el configurado vienen de
    // fuentes que sólo publican canales en vivo.
    const channel = state.channels[id];
    return channel && channel.source.type === 'm3u' ? 'pending' : 'ok';
  }

  function countListed() {
    const counts = { ok: 0, pending: 0, dead: 0 };
    for (const c of listed) counts[statusOf(c.id)]++;
    return counts;
  }

  function saveHealth() {
    writeAtomic(healthFile, health, (err) => log('[catálogo] no pude guardar la salud:', err.message));
  }

  // A mano manda el resultado: una falla ya lo da por caído (el validador espera dos).
  function record(id, ok, manual = false) {
    const prev = health[id];
    const now = Date.now();
    const fails = (prev ? prev.fails : 0) + 1;
    health[id] = ok
      ? { ok: true, at: now, okAt: now, fails: 0 }
      : { ok: false, at: now, okAt: prev ? prev.okAt : 0, fails: manual ? Math.max(fails, 2) : fails };
  }

  async function probe(channel) {
    try {
      if (channel.source.type === 'pluto') return await segmentReachable(await createPlutoSource(channel.source.slug)());
      return await segmentReachable(channel.source);
    } catch {
      return false; // caído, lento o con certificado roto
    }
  }

  async function check(batch) {
    const queue = [...batch];
    async function worker() {
      while (queue.length) {
        const c = queue.shift();
        record(c.id, await probe(c));
      }
    }
    await Promise.all(Array.from({ length: HEALTH_CONCURRENCY }, worker));
  }

  async function validateLoop() {
    while (running) {
      const now = Date.now();
      const at = (c) => (health[c.id] ? health[c.id].at : 0); // los nunca probados primero
      const due = listed.filter((c) => isDue(health[c.id], now, aliveRecheckMs, deadRetryMs));
      if (!due.length) {
        await new Promise((r) => setTimeout(r, idleMs).unref());
        continue;
      }
      await check(due.sort((a, b) => at(a) - at(b)).slice(0, VALIDATE_BATCH));
      saveHealth();
      // Si todavía no había ninguno en verde, recién ahora hay con qué arrancar.
      if (onBuilt) onBuilt();
      const counts = countListed();
      if (Date.now() - lastProgressLog >= PROGRESS_LOG_MS || (counts.pending === 0 && due.some((c) => !at(c)))) {
        lastProgressLog = Date.now();
        log(`[catálogo] validando listas: ${counts.ok} vivos · ${counts.dead} caídos · ${counts.pending} por validar`);
      }
    }
  }

  // Chequeo pedido desde el menú. Dos pedidos juntos del mismo canal comparten el chequeo.
  async function validateNow(id) {
    const channel = state.channels[id];
    if (!channel || channel.source.type === 'page') return null; // la página la captura Chrome
    if (!probing.has(id)) {
      probing.set(id, probe(channel).then((ok) => {
        record(id, ok, true);
        saveHealth();
        probing.delete(id);
      }));
    }
    await probing.get(id);
    return statusOf(id);
  }

  function rebuild() {
    if (!building) building = build().finally(() => (building = null));
    return building;
  }

  return {
    start() {
      running = true;
      rebuild()
        .catch((err) => log('[catálogo] ' + err.message))
        .then(validateLoop);
      timer = setInterval(rebuild, REBUILD_MS);
    },
    stop() {
      running = false;
      clearInterval(timer);
    },
    get(id) {
      return state.channels[id] || null;
    },
    validate: validateNow,
    // El primero que anda, para arrancar cuando no hay canal elegido.
    first() {
      for (const g of state.groups) for (const id of g.ids) if (statusOf(id) === 'ok') return state.channels[id];
      return null;
    },
    // Forma compacta para el iPad: [id, nombre, estado] por canal, los que andan primero.
    groups() {
      return state.groups.map((g) => ({
        name: g.name,
        channels: g.ids
          .map((id, i) => ({ row: [id, state.channels[id].name, statusOf(id)], i }))
          .sort((a, b) => STATUS_ORDER[a.row[2]] - STATUS_ORDER[b.row[2]] || a.i - b.i)
          .map((x) => x.row),
      }));
    },
    get size() {
      return Object.keys(state.channels).length;
    },
    get updatedAt() {
      return state.updatedAt || null;
    },
    // Canales de las listas que todavía no se probaron nunca.
    get pending() {
      return listed.length ? countListed().pending : null;
    },
  };
}

function readState(file) {
  const saved = readJson(file);
  if (saved && Array.isArray(saved.groups) && saved.channels) return saved;
  return { updatedAt: 0, groups: [], channels: {} };
}

// Se escriben seguido (cada tanda del validador): a un temporal y después rename, que es
// atómico. Con writeFile directo, un corte o dos escrituras pisándose dejan el JSON a medias.
let tmpSeq = 0;
function writeAtomic(file, value, onError) {
  const tmp = `${file}.${process.pid}.${++tmpSeq}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFile(tmp, JSON.stringify(value), (err) => {
    if (err) return onError(err);
    fs.rename(tmp, file, (renameErr) => renameErr && onError(renameErr));
  });
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null; // primera vez
  }
}

// Sin historial todavía (primer arranque con validación progresiva): los canales de las listas
// que ya estaban en el menú pasaron el chequeo de entonces, así que arrancan en verde.
function seedHealth(state) {
  const health = {};
  for (const c of Object.values(state.channels)) {
    if (c.source.type === 'm3u') health[c.id] = { ok: true, at: state.updatedAt, okAt: state.updatedAt, fails: 0 };
  }
  return health;
}

module.exports = { createCatalog, createSource, channelFromUrl, writeAtomic };
