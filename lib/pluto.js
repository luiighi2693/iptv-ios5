'use strict';
// Pluto TV: en Chrome su web reproduce DASH (main.mpd), nunca HLS, así que el capturador por
// navegador no encuentra nada. Para sus canales pedimos la sesión a la misma API de arranque
// que usan sus apps y armamos la URL HLS del stitcher (H.264 + AAC en TS, con el cifrado
// AES-128 estándar de HLS que el iPad descifra solo).

const crypto = require('crypto');

const PAGE = /^https?:\/\/(?:www\.)?pluto\.tv\/(?:[a-z]{2,5}\/)?live-tv\/([\w-]+)/i;
const BOOT_URL = 'https://boot.pluto.tv/v4/start';
const GUIDE_URL = 'https://service-channels.clusters.pluto.tv/v2/guide';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// "https://pluto.tv/us/live-tv/cine-en-espanol" → "cine-en-espanol"; null si no es Pluto.
function plutoSlug(url) {
  const m = PAGE.exec(url || '');
  return m ? m[1] : null;
}

async function getJson(url, headers) {
  const res = await fetch(url, { headers: { 'user-agent': USER_AGENT, ...headers }, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`Pluto TV respondió ${res.status} (${new URL(url).pathname})`);
  return res.json();
}

function bootSession(clientID, extra = {}) {
  const params = new URLSearchParams({
    appName: 'web',
    appVersion: '9.0.0',
    deviceVersion: '120.0.0',
    deviceModel: 'web',
    deviceMake: 'chrome',
    deviceType: 'web',
    clientID,
    clientModelNumber: '1.0.0',
    serverSideAds: 'false',
    ...extra,
  });
  return getJson(`${BOOT_URL}?${params}`);
}

function createPlutoSource(slug) {
  const clientID = crypto.randomUUID();

  return async function capture() {
    const boot = await bootSession(clientID, { channelSlug: slug });
    const channel = (boot.EPG || []).find((c) => c.slug === slug || c.id === slug);
    const region = boot.session ? boot.session.activeRegion : '?';
    if (!channel) throw new Error(`Pluto TV no tiene el canal "${slug}" en la región ${region}`);

    return {
      url: `${boot.servers.stitcher}/v2/stitch/hls/channel/${channel.id}/master.m3u8?${boot.stitcherParams}&jwt=${boot.sessionToken}&masterJWTPassthrough=true`,
      headers: { 'user-agent': USER_AGENT },
      // Cada sesión nueva reinicia la numeración de segmentos y el reproductor lo nota:
      // renovamos cuando Pluto lo pide (~8 h; el JWT dura 24 h), no cada pocos minutos.
      refreshMs: (boot.refreshInSec || 28800) * 1000,
    };
  };
}

// Catálogo completo de la región del servidor, agrupado por las categorías de Pluto.
async function fetchPlutoCatalog() {
  const boot = await bootSession(crypto.randomUUID());
  const auth = { authorization: `Bearer ${boot.sessionToken}` };
  const [channels, categories] = await Promise.all([
    getJson(`${GUIDE_URL}/channels?channelIds=&offset=0&limit=1000&sort=number%3Aasc`, auth),
    getJson(`${GUIDE_URL}/categories`, auth),
  ]);
  const byId = new Map((channels.data || []).map((c) => [c.id, c]));
  return {
    region: boot.session ? boot.session.activeRegion : '?',
    categories: (categories.data || []).map((cat) => ({
      name: cat.name,
      channels: (cat.channelIDs || [])
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((c) => ({ plutoId: c.id, slug: c.slug, name: c.name })),
    })),
  };
}

module.exports = { plutoSlug, createPlutoSource, fetchPlutoCatalog };
