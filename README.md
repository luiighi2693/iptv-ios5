# IPTV → iPad 1 (iOS 5.1.1)

Consigue el enlace `.m3u8` vigente de un canal (con su token efímero) y lo sirve por **HTTP plano** a un iPad 1. Tocás un botón y mirás. El token se renueva solo, sin que el iPad se entere, y desde el menú **CANALES** elegís entre cientos de canales gratis.

```
Fuentes del canal elegido                                 PC: server.js
 ├─ Pluto TV (API, sin navegador) ─────┐                   ├─ /live  proxy HLS (por defecto)
 ├─ listas M3U de GitHub (iptv-org) ───┼─ enlace + headers ─┤                          HTTP plano
 └─ TARGET_URL (Chrome caza el .m3u8) ─┘                   ├─ /tv    ffmpeg → Baseline + AAC ──▶ iPad 1
                                                           └─ /api/channels  menú de canales
```

## Por qué un proxy y no el enlace directo

Abrir la URL capturada directamente en el iPad falla casi siempre, por tres razones:

1. **HTTPS**: los CDN de hoy usan certificados que iOS 5 no reconoce. La PC habla HTTPS y el iPad recibe HTTP.
2. **Headers**: el token suele exigir el `Referer`, la `Cookie` o el `User-Agent` del navegador. QuickTime no los manda, el proxy sí.
3. **Rotación**: si el iPad tiene la URL con el token adentro, se corta cuando el token vence. Con el proxy, el iPad siempre pide la misma URL (`/live/index.m3u8`) y la PC la resuelve contra el token vigente.

El proxy además elige la variante que el iPad 1 puede decodificar (H.264 Main ≤ 720p + AAC) y se la sirve sola, para que el reproductor no pueda saltar a una de 1080p.

## Requisitos

- Node.js **22 o más nuevo** en la PC.
- La PC y el iPad en la **misma red Wi-Fi**.
- `ffmpeg` sólo si usás `TRANSCODE=1` (`brew install ffmpeg` · `winget install ffmpeg` · `sudo apt install ffmpeg`).

## Instalación y ejecución

```bash
npm install   # también descarga un Chrome para Puppeteer (~170 MB)
# creá un archivo .env (ver "Configuración"): como mínimo, TARGET_URL
npm start
```

### Configuración (`.env`)

Todas las variables son opcionales. Sin `TARGET_URL`, arranca en el primer canal del catálogo. También se pueden pasar como variables de entorno.

```ini
PORT=3000                    # el iPad entra por http://IP-DE-LA-PC:3000/<clave>/

# Menú de canales (ver "Menú de canales")
PROVIDERS=pluto,https://iptv-org.github.io/iptv/languages/spa.m3u   # fuentes separadas por coma: "pluto" o URLs de listas M3U
M3U_ALLOW=                               # regex opcional sobre "nombre url": si está, sólo entran los canales que coinciden
PLUTO_CATEGORIES=                        # regex para quedarte con algunas categorías de Pluto (ej. "españ|movies")
DATA_DIR=./data                          # estado: canal elegido, último enlace, catálogo, salud de los canales

# Capturador
TARGET_URL=https://sitio.ejemplo/canal   # canal inicial (opcional): página a capturar o link de Pluto TV
PLAY_SELECTOR=                           # CSS del botón play si no arranca solo (busca en iframes)
M3U8_PATTERN=                            # regex de la playlist; por defecto, cualquier .m3u8 (además detecta por Content-Type)
REFRESH_MINUTES=10                       # renovación programada (además se renueva si el CDN rechaza)
CAPTURE_TIMEOUT_SECONDS=45
HEADLESS=1                               # 0 = ver el Chrome (depurar / loguearse)
CHROME_PROFILE_DIR=                      # perfil persistente para mantener la sesión (ej. ./chrome-profile)
CHROME_PATH=                             # Chrome propio en vez del de Puppeteer
SCRAPER=1                                # 0 = no arrancar el scraper integrado

# Compatibilidad iPad 1
MAX_HEIGHT=720                           # techo para elegir variante (H.264 Main ≤ 3.1 + AAC)
MAX_BANDWIDTH=4000000
TRANSCODE=0                              # 1 = ffmpeg → H.264 Baseline + AAC
TRANSCODE_HEIGHT=480
TRANSCODE_KBPS=1200
FFMPEG_PATH=ffmpeg

# YouTube (ver "YouTube")
YOUTUBE=1                                # 0 = sin el botón de YouTube
YTDLP_PATH=yt-dlp                        # binario de yt-dlp
YT_MAX_HEIGHT=480                        # 720 si la conexión del iPad da para ~3 Mbps

# Seguridad (ver "Clave de acceso")
ACCESS_KEY=                              # clave de la URL; vacía = la generada en el primer arranque, "off" = sin clave
CLIP_SECRET=                             # si se define, POST /api/clip exige X-Clip-Secret
BRIDGE_URL=http://127.0.0.1:3000/<clave> # sólo para "npm run scraper" corriendo aparte
```

El log muestra la dirección que tenés que abrir en el iPad, ya con la clave:

```
Puente escuchando en 0.0.0.0:3000 (modo proxy)
  → En el iPad abrí: http://192.168.1.50:3000/Xk3v9QpL2mN8rT5wY7zA1bC4/
  (clave generada y guardada en data/access-key.txt; para elegir otra, ACCESS_KEY en el .env)
[scraper] capturando (inicio)…
[scraper] token fresco de cdn.ejemplo.com; próximo en 10 min
```

### Clave de acceso

Todo vive bajo `/<clave>/`: la página, la API y el video. Cualquier pedido sin la clave recibe un `404`, como si no hubiera nada, así que un escáner que encuentre el puerto no ve nada ni puede cambiarte el canal.

- **La clave.** Sin `ACCESS_KEY`, el primer arranque genera una al azar (24 caracteres) y la guarda en `DATA_DIR/access-key.txt`, así el ícono del iPad sigue andando tras los reinicios. Para elegir otra, poné `ACCESS_KEY` en el `.env` (16 caracteres o más: letras, números, `-` y `_`), por ejemplo con `node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"`. Cambiarla deja afuera a todo el que tenía la anterior, también al iPad: hay que volver a agregar el ícono.
- **Por qué en la URL.** En iOS, el video no lo pide Safari sino el reproductor del sistema, que hace sus propios pedidos de playlist y segmentos. Con la clave en la ruta, cada URL que arma el servidor la lleva, sin depender de que ese reproductor reenvíe cookies o usuario y contraseña.
- **Lo que no cubre.** Todo va por HTTP, así que quien vea el tráfico (la Wi-Fi o el proveedor de internet) puede leer la clave. Para evitarlo haría falta HTTPS, y los certificados gratuitos de Let's Encrypt usan una raíz que iOS reconoce recién desde iOS 10.
- **Validar tiene tope:** 20 por minuto. Cada validación abre conexiones contra la fuente.
- `ACCESS_KEY=off` la apaga, por ejemplo para una red local de confianza. El log avisa que queda abierto.

### Cómo encontrar los valores del `.env`

1. Corré con `HEADLESS=0` para ver el Chrome que usa el scraper.
2. En tu navegador, abrí el canal → DevTools → pestaña **Network** → filtrá por `m3u8`. Esa URL de página va en `TARGET_URL`.
3. Si el video no arranca solo, inspeccioná el botón de play y poné su selector en `PLAY_SELECTOR` (también se busca dentro de iframes).
4. Si el sitio pasa publicidad en HLS antes del canal, acotá `M3U8_PATTERN` al host del CDN real (ej. `cdn\.ejemplo\.com/.*\.m3u8`).
5. ¿El sitio pide login? Usá `CHROME_PROFILE_DIR=./chrome-profile` con `HEADLESS=0`, iniciá sesión a mano una vez y después volvé a `HEADLESS=1`.

### Menú de canales

El botón **CANALES** del iPad muestra las categorías y, adentro, los canales en páginas que entran en la pantalla. Tocás uno y arranca a reproducirse. El último canal elegido queda guardado: el botón grande lo abre directo y sobrevive a reinicios del servidor.

Las fuentes se leen al arrancar y cada 12 h, y el catálogo se guarda en `DATA_DIR/catalog.json` para tener menú al instante. `PROVIDERS` dice de dónde sale:

| Fuente | Qué aporta | Cómo se consigue el enlace |
|---|---|---|
| Listas M3U (una URL por lista) | Por defecto, los canales en español de [iptv-org](https://github.com/iptv-org/iptv) | URL fija de la lista; las redirecciones se resuelven una vez por captura |
| `pluto` | El catálogo completo de Pluto TV del país del servidor, con sus categorías | API de Pluto, sesión renovada cada ~8 h |
| `TARGET_URL` | La página que configuraste, en la categoría "Configurado" | Chrome captura el `.m3u8` |

- **Todo entra, con su estado.** Cada canal tiene un foco: **verde** (validado), **amarillo** (por validar) o **gris** (no respondió). En cada categoría van primero los verdes, y la lista de categorías muestra cuántos andan (`80 / 120`). `M3U_ALLOW` filtra si querés acotar. Ojo: las listas públicas como iptv-org mezclan señales oficiales con retransmisiones sin derechos; qué cargar es decisión de quien configura.
- **Validación progresiva.** Un validador en segundo plano prueba los canales de las listas de a 40, empezando por los nunca probados: el canal está vivo sólo si **baja un segmento de verdad** (hay CDNs que entregan la playlist y rechazan el video por región). Los vivos se re-chequean cada 6 h; los caídos, cada vez más espaciado (30 min, 1 h, 2 h… hasta 1 día), porque muchos no son 24/7. Un vivo pasa a gris recién a la segunda falla seguida. El historial se guarda en `DATA_DIR/health.json`.
- **Validar a mano.** Cada canal tiene un botón **Validar / Revalidar**: el foco titila mientras se prueba y queda verde o gris en el momento. A mano manda el resultado: una falla ya lo deja en gris. En los de Pluto pide una sesión nueva a su API y baja un segmento.
- **Buscador.** Arriba a la derecha: busca por nombre en todas las categorías, sin importar mayúsculas ni acentos ("clasico" encuentra "Cine Clásico"). **Volver** limpia la búsqueda.
- **Sin duplicados.** Los canales de Pluto que aparecen en la lista y también en su catálogo van directo por la API, sin el redirector de terceros (`jmp2.uk`) que usa iptv-org.
- **Un canal a la vez.** Hay un solo ffmpeg y la CPU da para un stream. Cambiar de canal corta el anterior y el nuevo arranca en unos 3–5 s; el iPad nunca recibe segmentos del canal anterior.
- Las categorías de la lista se traducen y ordenan de más a menos canales (las de menos de 3 van a "Otros"). Después vienen las de Pluto, con las en español primero.

### Pluto TV

Pluto TV es gratis y legal, y tiene canales 24/7 que no se cortan cuando termina un evento. Ya están en el menú; si querés que uno sea el canal inicial, pegá en `TARGET_URL` la página del canal tal como la ves en el navegador:

```ini
TARGET_URL=https://pluto.tv/us/live-tv/cine-en-espanol
TRANSCODE=1
```

- En Chrome, la web de Pluto reproduce DASH y no HLS. Por eso, para estos links no se abre ningún navegador: la sesión se pide a la API de arranque de Pluto (`boot.pluto.tv`), que además es más liviana.
- La sesión se renueva cuando Pluto la pide (~8 h) y no cada `REFRESH_MINUTES`, porque cada sesión nueva reinicia la numeración de los segmentos.
- Los canales vienen en **H.264 High Profile** y el iPad 1 no lo decodifica: hace falta `TRANSCODE=1`.
- El catálogo depende del país de la IP del servidor.
- Los segmentos usan el cifrado AES-128 estándar de HLS, no DRM: cualquier reproductor HLS, incluido el del iPad, los descifra con la clave que entrega Pluto.

### YouTube

El botón **YOUTUBE** abre un buscador. Muestra 20 videos con miniatura, duración y canal, en páginas que entran en la pantalla. Tocás uno y arranca en unos 5 s, con avance y retroceso.

- **Cómo funciona.** [yt-dlp](https://github.com/yt-dlp/yt-dlp) busca y resuelve cada video. YouTube ya ofrece una versión HLS para iOS: video H.264 Main en TS y audio AAC, en playlists separadas con los mismos cortes. No está claro que el reproductor de iOS 5 soporte el audio en pista aparte, así que el servidor junta video y audio en cada segmento con `ffmpeg -c copy`, sin recodificar. El iPad recibe un HLS común y la CPU casi no trabaja.
- **Calidad.** 480p por defecto (`YT_MAX_HEIGHT`): H.264 Main, que el iPad 1 decodifica por hardware. Si un video tiene doblajes automáticos, se elige el audio original.
- **Qué no entra.** Las transmisiones en vivo de YouTube se filtran de los resultados, porque su playlist cambia todo el tiempo. Tampoco entran los videos con restricción de edad o solo para miembros: el servidor no inicia sesión en YouTube.
- **Instalación.** Hace falta `yt-dlp` en el `PATH` del servidor, o en `YTDLP_PATH`. Por ejemplo, el binario oficial para macOS en `~/.local/bin/yt-dlp`, verificado contra el `SHA2-256SUMS` del release. También usa Node para resolver los desafíos de YouTube; usa el mismo que corre el servidor.
- **Actualización.** El servidor corre `yt-dlp -U` al arrancar y una vez por día: YouTube cambia seguido y un yt-dlp viejo deja de andar.
- Sacar el video por fuera del reproductor oficial va contra los términos de uso de YouTube. Este proyecto es para uso personal, en un solo dispositivo.

### Variantes

- **Sin scraper, carga manual:**
  ```bash
  curl -X POST http://localhost:3000/<clave>/api/clip -H 'content-type: application/json' \
    -d '{"url":"https://cdn.ejemplo.com/live.m3u8?token=XYZ","headers":{"referer":"https://sitio.ejemplo/"}}'
  ```
- **Scraper en otra máquina** (sin menú de canales): en el puente poné `SCRAPER=0`, y en la otra máquina corré `BRIDGE_URL=http://192.168.1.50:3000/<clave> npm run scraper`. En este modo el puente no puede pedir un token nuevo al instante si el CDN rechaza el actual; queda sólo la renovación programada.

## Configurar la red local

| Paso | Qué hacer |
|------|-----------|
| IP fija | En el router, reservá por DHCP la IP de la PC. Si no lo hacés, el ícono del iPad deja de andar cuando la IP cambia. |
| Firewall macOS | Aceptá el aviso *"¿Permitir conexiones entrantes a node?"*, o andá a Ajustes → Red → Firewall → Opciones. |
| Firewall Windows | PowerShell como admin: `New-NetFirewallRule -DisplayName "IPTV iPad" -Direction Inbound -Protocol TCP -LocalPort 3000 -Action Allow -Profile Private`. Dejá la red Wi-Fi marcada como **Privada**. |
| Firewall Linux | `sudo ufw allow from 192.168.0.0/16 to any port 3000 proto tcp` |
| Router | Desactivá el *aislamiento de clientes / AP isolation* (las redes de invitados suelen traerlo activado). |
| Que no se duerma | macOS: `caffeinate -i npm start` o, con launchd (ver "Que arranque solo"), la Mac configurada para no entrar en reposo. Windows: plan de energía sin suspensión. |
| Prueba | En el Safari del iPad abrí `http://IP:3000/<clave>/api/status`. Si ves un JSON, la red anda. |

## Que arranque solo (macOS)

Con launchd, el servidor arranca al iniciar sesión y, si el proceso muere, vuelve solo en unos segundos (`KeepAlive`). Al caerse también termina su ffmpeg, así que no quedan procesos huérfanos.

Guardá esto en `~/Library/LaunchAgents/com.iptv-ios5.server.plist`. Cambiá las rutas: `which node` y la carpeta del proyecto.

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.iptv-ios5.server</string>
    <key>ProgramArguments</key>
    <array>
        <string>/RUTA/A/node</string>
        <string>/RUTA/AL/PROYECTO/server.js</string>
    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/RUTA/A/LA/CARPETA/DE/node:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    </dict>
    <key>WorkingDirectory</key>
    <string>/RUTA/AL/PROYECTO</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
    <key>StandardOutPath</key>
    <string>/RUTA/AL/PROYECTO/data/server.log</string>
    <key>StandardErrorPath</key>
    <string>/RUTA/AL/PROYECTO/data/server.log</string>
</dict>
</plist>
```

`WorkingDirectory` tiene que ser la carpeta del proyecto, porque de ahí se lee el `.env`. El `PATH` tiene que incluir ffmpeg, y también yt-dlp si lo pusiste en `~/.local/bin`. Si cambiás el `.plist`, aplicalo con `bootout` y `bootstrap`: `kickstart` no lo vuelve a leer.

| Para | Comando |
|---|---|
| Instalar y arrancar | `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.iptv-ios5.server.plist` |
| Reiniciar (por ejemplo, tras editar el `.env`) | `launchctl kickstart -k gui/$(id -u)/com.iptv-ios5.server` |
| Ver si corre y cuántas veces se reinició | `launchctl print gui/$(id -u)/com.iptv-ios5.server \| grep -E "state\|runs\|last exit"` |
| Ver el log | `tail -f data/server.log` |
| Desinstalar | `launchctl bootout gui/$(id -u)/com.iptv-ios5.server` y borrar el `.plist` |

Con `KeepAlive`, un `kill` común también lo reinicia. Para apagarlo de verdad, usá `bootout`.

## En el iPad

1. Safari → `http://IP-DE-LA-PC:3000/<clave>/` (la dirección exacta está en el log)
2. Botón **Compartir** → **Añadir a pantalla de inicio**.
3. Abrí el ícono → **VER EN VIVO** (el último canal elegido) o **CANALES** para cambiar.

Hace falta **un toque**: iOS no deja reproducir video sin un gesto del usuario, y eso no tiene vuelta. Después del toque ya no hay que hacer nada más. Si el stream se corta o la imagen queda congelada unos 20 s, la página reconecta sola.

El botón usa el `<video>` nativo, que usa el mismo decodificador por hardware que QuickTime, pero te deja volver al menú y permite reconectar solo. El enlace *"Abrir en el reproductor nativo"* abre el `.m3u8` directo; desde la web app instalada, puede dejarte sin botón para volver.

## Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| Todo da "Not Found" | Falta la clave en la URL, o cambió (`ACCESS_KEY` nueva, o se borró `DATA_DIR`) | Abrí la dirección que muestra el log y volvé a agregar el ícono |
| **Revalidar** no cambia el foco | Más de 20 validaciones en un minuto: el servidor responde `429` | Esperá un minuto |
| "Esperando señal" todo el tiempo | El scraper no encuentra el `.m3u8` | `HEADLESS=0` para mirar qué pasa; ajustá `PLAY_SELECTOR` / `M3U8_PATTERN` |
| Se escucha pero no se ve, o la app se cierra | El canal viene en 1080p, High Profile, 60 fps o HEVC | `TRANSCODE=1` (el log avisa con `AVISO:`) |
| Se corta cada tanto | El token vence antes de `REFRESH_MINUTES` | Bajá `REFRESH_MINUTES` |
| 403 aun con token recién capturado | El CDN liga el token a otra cosa (una VPN en el navegador, un header propio) | Revisá en DevTools qué headers manda el reproductor |
| `AVISO: ... DRM (FairPlay)` | Contenido con DRM | No se puede reproducir por este medio, y el proyecto no lo intenta |
| `la fuente está sin audio ahora … reintento` | El canal pasa un clip mudo (cortina, publicidad) justo al arrancar | Nada: reintenta solo. Si arrancara mudo, toda la sesión saldría muda. Tras 10 intentos (~40 s) arranca igual, sin audio |
| `la variante viene sin audio: pruebo con la pista de audio aparte de la master` | El canal manda el audio en una pista separada del video (por ejemplo, FOX Sports en Pluto) | Nada: arranca con sonido unos 3 s más tarde y recuerda esto hasta que cambies de canal |
| `la fuente cambió de pistas (cambio de programa): lo reinicio` | En los cambios de programa, Pluto manda el video en una pista nueva, y ffmpeg no toma pistas que aparecen después de arrancar | Nada: ffmpeg se reinicia solo y el iPad sigue tras un corte de unos segundos. Antes, la imagen quedaba congelada para siempre |
| `está trabado (20 s sin segmentos nuevos): lo reinicio` | ffmpeg sigue vivo pero no produce video | Nada: es la red de seguridad. Mientras tanto no se sirve la playlist vieja, así que la página no repite tramos al reconectar |
| `… rechazó un segmento (403)` | El CDN bloquea el video (región, token) | Si persiste, el canal no sirve desde el país del servidor: el validador lo pasa a gris (o tocá **Revalidar**) |
| El menú dice "el servidor está armando el catálogo" | Primer arranque: está bajando las listas (~10 s) | Esperá y volvé a abrir el menú. Los canales aparecen en amarillo y se van poniendo verdes o grises a medida que se validan |
| YouTube: "falta yt-dlp en el servidor" | No está instalado o no está en el `PATH` del servicio | Instalalo (ver "YouTube") o definí `YTDLP_PATH` |
| YouTube: un video no arranca y el log dice `Sign in…` o `HTTP Error 403` | Restricción de edad o solo para miembros, o YouTube empezó a bloquear la IP del servidor | Probá otro video. Si fallan todos: `yt-dlp -U` y revisá si YouTube pide confirmar que no sos un robot |
| Muchos canales en gris | Caídos, fuera de horario (no son 24/7) o bloqueados por región para el servidor | Nada: el validador los reintenta solo, cada vez más espaciado. **Revalidar** prueba uno en el momento |

## API

Todas las rutas van bajo `/<clave>/` (por ejemplo, `/<clave>/api/status`). Sin la clave, todo responde `404`.

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/clip` | Actualiza el enlace. Acepta JSON `{url, headers}` o texto plano con la URL. Si definiste `CLIP_SECRET`, exige el header `X-Clip-Secret`. |
| `GET` | `/api/clip` | Devuelve en texto plano la URL reproducible para el iPad, más `X-Clip-Age` (segundos desde que se renovó el token) y `X-Channel` (nombre del canal, URI-encoded). `204` si todavía no hay enlace. |
| `GET` | `/api/channels` | Catálogo para el menú: `{ active, play, groups: [{ name, channels: [[id, nombre, estado]] }] }`, con estado `ok`, `pending` o `dead`. |
| `POST` | `/api/channel` | Cambia de canal. Cuerpo: el `id` en texto plano o `{"id": "..."}`. `204`, o `404` si no existe. |
| `POST` | `/api/validate` | Valida un canal en el momento (mismo cuerpo). Responde `{ id, status }` con `ok` o `dead`; `404` si no existe o es la página de `TARGET_URL`; `429` pasadas las 20 por minuto. |
| `GET` | `/api/status` | Diagnóstico en JSON. |
| `GET` | `/live/index.m3u8` | Stream a través del proxy. |
| `GET` | `/tv/index.m3u8` | Stream transcodificado (con `TRANSCODE=1`). |
| `GET` | `/yt/search?q=texto` | Búsqueda en YouTube: `{ items: [[id, título, canal, segundos]] }`. |
| `GET` | `/yt/thumb/<id>.jpg` | Miniatura de un video, por HTTP plano. |
| `GET` | `/yt/<id>/index.m3u8` | Video de YouTube como HLS VOD, con video y audio juntos en cada segmento. |

## Uso responsable

Usalo sólo con contenido que tengas derecho a ver. El proyecto automatiza lo mismo que hace tu navegador al abrir la página: no rompe DRM ni cifrado.
