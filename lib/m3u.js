'use strict';
// Listas M3U de IPTV (el formato de iptv-org y de casi todas las de GitHub): cada canal es una
// línea #EXTINF con atributos y nombre, opcionalmente #EXTVLCOPT con el referer o el
// user-agent que exige el CDN, y después la URL.

function parseM3u(text) {
  const channels = [];
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) {
      current = { name: extinfName(line), groups: splitGroups(attr(line, 'group-title')), headers: {} };
    } else if (current && line.startsWith('#EXTVLCOPT:')) {
      const [key, ...rest] = line.slice('#EXTVLCOPT:'.length).split('=');
      if (key === 'http-referrer') current.headers.referer = rest.join('=');
      if (key === 'http-user-agent') current.headers['user-agent'] = rest.join('=');
    } else if (current && /^https?:\/\//i.test(line)) {
      channels.push({ ...current, url: line });
      current = null;
    }
  }
  return channels;
}

// El nombre va después de la primera coma que no está dentro de un atributo entre comillas.
function extinfName(line) {
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"') quoted = !quoted;
    else if (line[i] === ',' && !quoted) return line.slice(i + 1).trim();
  }
  return '';
}

function attr(line, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(line);
  return m ? m[1] : '';
}

// iptv-org separa varias categorías con ";" (ej. "Movies;Series").
function splitGroups(value) {
  const groups = value.split(';').map((g) => g.trim()).filter(Boolean);
  return groups.length ? groups : ['Otros'];
}

module.exports = { parseM3u };
