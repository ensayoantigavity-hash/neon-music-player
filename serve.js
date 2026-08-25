import express from 'express';
import { spawn, spawnSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { mkdirSync, readdirSync, statSync, existsSync, rmSync, renameSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dgram from 'node:dgram';
import os from 'node:os';
import http from 'node:http';
import { Server } from 'socket.io';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT || '8765', 10);
// Render (runtime node) NO trae yt-dlp: se resuelve al arrancar (global -> python -> descarga oficial)
let YTDLP_BIN = JSON.parse(process.env.YTDLP_BIN || '["python","-m","yt_dlp"]');
const CLIENT_CHAIN = (process.env.YTDLP_CLIENTS || 'tv,android,ios,web,web_embedded,mweb')
  .split(',').map(s => s.trim()).filter(Boolean);
const DOWNLOAD_DIR = process.env.DOWNLOAD_DIR || path.join(__dirname, 'Descargas');
mkdirSync(DOWNLOAD_DIR, { recursive: true });

function cookieArgs() {
  if (process.env.YTDLP_COOKIES_FILE) return ['--cookies', process.env.YTDLP_COOKIES_FILE];
  // cookies.txt comprometido en la raíz del repo: se usa automáticamente en Render
  const localCookies = path.join(__dirname, 'cookies.txt');
  if (existsSync(localCookies)) return ['--cookies', localCookies];
  if (process.env.YTDLP_COOKIES_BROWSER) return ['--cookies-from-browser', process.env.YTDLP_COOKIES_BROWSER];
  return [];
}

// ---- deteccion de ffmpeg (requerido para convertir a mp3) ----
function detectFfmpeg() {
  if (process.env.FFMPEG) return process.env.FFMPEG;
  try {
    const r = spawnSync('python', ['-c', 'import imageio_ffmpeg; print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8', timeout: 20000 });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  } catch { /* noop */ }
  // respaldo: binario ffmpeg del sistema (instalado v+�a apt en el Docker)
  try {
    const r = spawnSync('ffmpeg', ['-version'], { encoding: 'utf8', timeout: 10000 });
    if (r.status === 0 && r.stdout.trim()) return 'ffmpeg';
  } catch { /* noop */ }
  return null;
}
const FFMPEG = detectFfmpeg();

function parseContentRangeTotal(cr) {
  if (!cr) return null;
  const m = String(cr).match(/\/(\d+)\s*$/);
  return m ? parseInt(m[1], 10) : null;
}

// ---- cache de streams + videos que fallaron ----
const streamCache = new Map(); // id -> { url, expires }
const failedIds = new Map();   // id -> timestamp (bloqueados temporalmente)

// ---- resolución del binario yt-dlp en Render (sin apt-get) ----
// 1) binario ya descargado  2) yt-dlp global  3) python -m yt_dlp
// 4) descarga del binario standalone oficial de GitHub (una vez por deploy)
function canRun(cmd, args) {
    try {
        const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 15000 });
        // Debe existir Y ejecutarse con exito: python existe pero sin modulo yt_dlp sale codigo 1
        return !r.error && r.status === 0;
    } catch { return false; }
}
async function ensureYtdlp() {
  const LOCAL_BIN = path.join(__dirname, 'bin', 'yt-dlp');
  if (existsSync(LOCAL_BIN)) return [LOCAL_BIN];
  if (canRun('yt-dlp', ['--version'])) { console.log('[neon] yt-dlp global encontrado'); return ['yt-dlp']; }
  if (canRun('python', ['-m', 'yt_dlp', '--version'])) { console.log('[neon] usando python -m yt_dlp'); return ['python', '-m', 'yt_dlp']; }
  // Descarga standalone con 3 intentos (GitHub puede fallar transitoriamente)
  mkdirSync(path.dirname(LOCAL_BIN), { recursive: true });
  for (let intento = 1; intento <= 3; intento++) {
    try {
      console.log(`[neon] descargando binario yt-dlp standalone (intento ${intento}/3)...`);
      const r = await fetch('https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', { redirect: 'follow' });
      if (r.ok) {
        const buf = Buffer.from(await r.arrayBuffer());
        if (buf.length > 1000000) { // binario real >1MB, no una pagina de error
          writeFileSync(LOCAL_BIN, buf);
          try { chmodSync(LOCAL_BIN, 0o755); } catch { /* noop */ }
          console.log('[neon] yt-dlp descargado y activo (' + Math.round(buf.length / 1048576) + 'MB)');
          return [LOCAL_BIN];
        }
      }
      console.log('[neon] descarga intento ' + intento + ' fallo (HTTP ' + r.status + ')');
    } catch (e) { console.log('[neon] descarga intento ' + intento + ' error: ' + e.message); }
    await new Promise(res => setTimeout(res, 3000 * intento));
  }
  return null;
}
// Resolucion re-intentable: si falla, el proximo runYt/startAutoDJ vuelve a intentar
let ytdlpBin = null;
let ytdlpInflight = null;
function getYtdlp() {
  if (ytdlpBin) return Promise.resolve(ytdlpBin);
  if (!ytdlpInflight) {
    ytdlpInflight = ensureYtdlp().then(bin => {
      ytdlpInflight = null;
      if (!bin) return null;
      ytdlpBin = bin;
      YTDLP_BIN = bin;
      return bin;
    }).catch(() => { ytdlpInflight = null; return null; });
  }
  return ytdlpInflight;
}

async function runYt(args, timeoutMs = 90000) {
  const bin = await getYtdlp();
  if (!bin) throw new Error('yt-dlp no disponible en este servidor');
  return new Promise((resolve, reject) => {
    const p = spawn(bin[0], [...bin.slice(1), ...args], {
      windowsHide: true,
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => { try { p.kill(); } catch { /* noop */ } reject(new Error('Tiempo de espera de yt-dlp agotado')); }, timeoutMs);
    p.stdout.on('data', d => { out += d; });
    p.stderr.on('data', d => { err += d; });
    p.on('error', reject);
    p.on('close', code => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error((out + err).trim().split('\n').filter(Boolean).slice(-4).join(' | ') || `yt-dlp salio con codigo ${code}`));
      else resolve(out);
    });
  });
}

function extractVideoId(str) {
  const s = String(str).trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  const m = s.match(/(?:v=|be\/|embed\/|shorts\/|youtu\.be\/|\/watch\?v=)([\w-]{11})/);
  return m ? m[1] : null;
}

function sanitize(name) {
  return String(name)
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .trim()
    .slice(0, 120) || 'tema';
}

// quita etiquetas del titulo (4K, Official Video, Lyrics, etc.) y deja nombre + artista/album
const TITLE_TAG_RE = /(4k|8k|uhd|qhd|fhd|ultra hd|high quality|official|music video|lyrics?|visuali[sz]er|\.?mv|\bm\/?v\b|\bav\b|audio|video|remaster(?:ed)?|amv|nightcore|slowed|sped up|instrumental|bass boosted|\bhq\b|subtitl(?:ed|es)|alternative)/i;

function cleanTitle(raw) {
  if (!raw) return '';
  let s = String(raw);
  s = s.replace(/([\[(�+�������])([^\]�+�)������]*)([\]�+�)������])/g, (m, o, inner, c) => TITLE_TAG_RE.test(inner) ? ' ' : m);
  s = s.replace(/\s*\|\s*[^|]*$/, (m) => TITLE_TAG_RE.test(m) ? ' ' : m);
  return s.replace(/\s+/g, ' ').replace(/\s*-\s*$/g, '').trim();
}

function seekUrl(out) {
  return out.split(/\r?\n/).map(l => l.trim()).find(l => l.startsWith('http'));
}

async function resolveStream(videoId, { clients = CLIENT_CHAIN, force = false } = {}) {
  const cached = streamCache.get(videoId);
  if (!force && cached && cached.expires > Date.now()) return cached.url;
  if (cached) streamCache.delete(videoId);

  const order = [...clients];
  if (order.length > 1 && !force) {
    // evita el "Sign in to confirm you're not a bot": alterna el orden de clientes
    // y baja android/mweb al inicio (clientes de menor huella de "bot"). El orden se
    // rota en cada resoluci+�n para no repetir la misma combinaci+�n contra YouTube.
    order.sort(() => Math.random() - 0.5);
    const preferred = ['tv', 'android', 'ios', 'web', 'web_embedded', 'mweb'];
    order.sort((a, b) => (preferred.indexOf(b) - preferred.indexOf(a)) || (Math.random() - 0.5));
  }

  const args = [
    ...cookieArgs(),
    '--no-playlist', '-f', 'ba/b', '-g', '--no-warnings',
    '--socket-timeout', '15',
    '--retries', '2', '--extractor-retries', '3',
    '--extractor-args', `youtube:player_client=${order.join(',')};youtube:player_skip=webpage,configs`,
    '--extractor-args', 'youtubetab:skip=webpage',
    `https://www.youtube.com/watch?v=${videoId}`,
  ];
  const out = await runYt(args, 60000);
  const url = seekUrl(out);
  if (!url) throw new Error('No se pudo resolver el stream de audio');
  streamCache.set(videoId, { url, expires: Date.now() + 45 * 60 * 1000 });
  return url;
}

async function probeStream(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow', signal: ctrl.signal });
    return r.ok && (r.status === 206 || r.status === 200);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

const inflight = new Map();
function getPlayableStream(videoId) {
  if (inflight.has(videoId)) return inflight.get(videoId);
  const p = (async () => {
    let lastErr;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        if (attempt > 0) streamCache.delete(videoId);
        let clients = attempt === 0 ? CLIENT_CHAIN : ['tv','android','ios'];
        const url = await resolveStream(videoId, { clients, force: attempt > 0 });
        // Sin probe para velocidad: la URL directa de googlevideo es v+�lida si yt-dlp la dio
        if (url && url.startsWith('http')) return url;
        throw new Error('stream vac+�o');
      } catch (e) {
        lastErr = e;
        if (attempt < 1) await new Promise((r) => setTimeout(r, 400));
      }
    }
    failedIds.set(videoId, Date.now());
    throw lastErr || new Error('No se puede reproducir este video');
  })();
  p.finally(() => inflight.delete(videoId)).catch(() => {});
  inflight.set(videoId, p);
  return p;
}

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

let djConnected = false;
let currentDJSocket = null;
let autoDJProcess = null;
let listeners = [];

// Telemetria del Auto-DJ (diagnostico remoto via /api/radiostatus)
const radioStats = { arranques: 0, salidas: 0, ultimoError: '', bytesEnviados: 0 };

app.get('/radio/stream', (req, res) => {
    res.setHeader('Content-Type', 'audio/mpeg');
    res.setHeader('Transfer-Encoding', 'chunked');
    listeners.push(res);
    req.on('close', () => {
        listeners = listeners.filter(l => l !== res);
    });
});
// Red de seguridad global: NINGUN error de proceso hijo puede tumbar la radio
process.on('uncaughtException', (err) => console.log('[neon] uncaughtException:', err.message));
process.on('unhandledRejection', (err) => console.log('[neon] unhandledRejection:', String(err)));

const COOKIES_LOCAL = path.join(__dirname, 'cookies.txt');
// Misma evasión de bots que /api/stream: clientes móviles + skip de webpage/configs
function autoDjArgs() {
    const base = [
        '-f', 'bestaudio', '-o', '-', '--no-warnings',
        '--socket-timeout', '15',
        '--retries', '2', '--extractor-retries', '2',
        '--extractor-args', `youtube:player_client=${CLIENT_CHAIN.join(',')};youtube:player_skip=webpage,configs`,
    ];
    return existsSync(COOKIES_LOCAL)
        ? ['--cookies', COOKIES_LOCAL, ...base]
        : base;
}
// Semillas de respaldo: SOLO videos normales (los "en vivo" no se pueden pipar a stdout)
const FALLBACK_SEEDS = ['lofi hip hop mix', 'musica instrumental relajante', 'jazz suave instrumental', 'clasicos instrumentales'];
const sleepMs = (ms) => new Promise(r => setTimeout(r, ms));

// Bucle DJ: llena lista de IDs (filtra lives) -> transmite cada video uno tras otro
async function autoDjLoop() {
    while (!djConnected) {
        let ids = [];
        try {
            const seed = FALLBACK_SEEDS[Math.floor(Math.random() * FALLBACK_SEEDS.length)];
            console.log('[neon] Auto-DJ buscando: ' + seed);
            const out = await runYt([
                '--flat-playlist', '--dump-json', '--no-warnings',
                '--match-filter', '!is_live',
                `ytsearch6:${seed}`
            ], 45000);
            ids = out.split('\n').filter(l => l.trim().startsWith('{'))
                .map(l => { try { return JSON.parse(l).id; } catch { return null; } })
                .filter(Boolean);
        } catch (e) {
            radioStats.ultimoError = 'busqueda: ' + e.message;
        }
        if (djConnected) return;
        for (const id of ids) {
            if (djConnected) return;
            await new Promise((resolve) => {
                getYtdlp().then(bin => {
                    if (!bin || djConnected) return resolve();
                    let p;
                    try {
                        p = spawn(bin[0], [...bin.slice(1), ...autoDjArgs(), `https://www.youtube.com/watch?v=${id}`], { stdio: ['ignore', 'pipe', 'pipe'] });
                    } catch (e) { radioStats.ultimoError = e.message; return resolve(); }
                    autoDJProcess = p;
                    radioStats.arranques++;
                    p.on('error', (err) => {
                        radioStats.ultimoError = err.message;
                        if (autoDJProcess === p) autoDJProcess = null;
                        resolve();
                    });
                    p.stderr.on('data', d => {
                        const s = d.toString().trim().split('\n').pop();
                        if (s && !/^\[download\]/.test(s)) radioStats.ultimoError = s.slice(0, 200);
                    });
                    p.stdout.on('data', chunk => {
                        radioStats.bytesEnviados += chunk.length;
                        if (djConnected) { stopAutoDJ(); return; }
                        for (const listener of listeners) { try { listener.write(chunk); } catch {} }
                    });
                    p.on('close', (code) => {
                        radioStats.salidas++;
                        if (autoDJProcess === p) autoDJProcess = null;
                        resolve();
                    });
                });
            });
            await sleepMs(350); // micro-pausa entre temas
        }
        if (!djConnected) await sleepMs(4000); // nueva semilla al agotar la lista
    }
}
let autoDjLoopIniciado = false;
function startAutoDJ() {
    if (autoDjLoopIniciado) return;
    autoDjLoopIniciado = true;
    console.log("Radio de respaldo iniciada (Auto-DJ continuo)...");
    autoDjLoop().catch(e => console.log('[neon] loop error:', e.message));
}
function stopAutoDJ() {
    if (autoDJProcess) {
        try { autoDJProcess.kill(); } catch {}
        autoDJProcess = null;
        console.log("DJ real detectado. Auto-DJ apagado exitosamente.");
    }
}
io.on('connection', (socket) => {
    socket.on('registrar-dj', () => {
        djConnected = true;
        currentDJSocket = socket.id;
        stopAutoDJ();
        console.log("DJ Principal conectado y transmitiendo en vivo.");
    });
    socket.on('stream-desde-dj', (audioChunk) => {
        if (socket.id === currentDJSocket) {
            listeners.forEach(listener => listener.write(audioChunk));
        }
    });
    socket.on('disconnect', () => {
        if (socket.id === currentDJSocket) {
            djConnected = false;
            currentDJSocket = null;
            startAutoDJ().catch(()=>{});
        }
    });
});
startAutoDJ();

app.get('/api/ping', (req, res) => {
  res.json({
    ok: true,
    clients: CLIENT_CHAIN.join(', '),
    ffmpeg: !!FFMPEG,
    downloadDir: DOWNLOAD_DIR,
    cookies: cookieArgs().length ? 's+�' : 'no',
  });
});

// Estado interno de la radio (diagnostico en vivo)
app.get('/api/radiostatus', (req, res) => {
  const LOCAL_BIN = path.join(__dirname, 'bin', 'yt-dlp');
  res.json({
    djConnected,
    autoDjActivo: !!autoDJProcess,
    oyentes: listeners.length,
    binarioYtdlp: existsSync(LOCAL_BIN) ? LOCAL_BIN : 'no descargado',
    cookiesOk: existsSync(COOKIES_LOCAL),
    ...radioStats,
  });
});

// expone la configuraci+�n de despliegue (Cloud Run fija K_SERVICE autom+�ticamente)
app.get('/api/config', (req, res) => {
  res.json({
    cloudRun: !!process.env.K_SERVICE,
    streamMode: process.env.STREAM_MODE || 'proxy',
    clients: CLIENT_CHAIN.join(', '),
    ffmpeg: !!FFMPEG,
  });
});

// ---- "Solo reproductor" (modo escucha): el DJ (app completa) avisa qu+� tema suena,
// y los amigos lo escuchan en /escuchar sin buscar ni adelantar/retroceder. ----
const NOWPLAYING_FILE = path.join(DOWNLOAD_DIR, 'nowplaying.json');
let nowPlaying = { id: '', title: '', artist: '', thumbnail: '', duration: 0, playing: false, station: '', ts: 0 };
try { const d = JSON.parse(readFileSync(NOWPLAYING_FILE,'utf8')); if(d && d.id) nowPlaying = { ...nowPlaying, ...d }; } catch {}
const NOWPLAYING_TTL = 9000; // ms: si el DJ no env+�a latido en este tiempo, se considera desconectado
app.post('/api/nowplaying', express.json(), (req, res) => {
  const b = req.body || {};
  if (typeof b.id === 'string' && /^[\w-]{11}$/.test(b.id)) {
    nowPlaying = {
      id: b.id,
      title: String(b.title || ''),
      artist: String(b.artist || ''),
      thumbnail: String(b.thumbnail || ''),
      duration: Number(b.duration) || 0,
      playing: b.playing !== false && b.playing !== false,
      station: String(b.station || ''),
      ts: Date.now(),
    };
    nowPlaying.playing = b.playing !== false;
    try { writeFileSync(NOWPLAYING_FILE, JSON.stringify(nowPlaying)); } catch {}
  }
  res.json({ ok: true });
});
app.get('/api/nowplaying', (req, res) => {
  // Si pas+� el TTL sin latido del DJ, ocultamos el tema para que el listener
  // (y la app) pasen al Auto-DJ y la m+�sica nunca se detenga.
  if (nowPlaying.id && nowPlaying.ts && (Date.now() - nowPlaying.ts > NOWPLAYING_TTL)) {
    return res.json({ id: '', title: '', artist: '', thumbnail: '', duration: 0, playing: false, station: '' });
  }
  res.json(nowPlaying);
});

// p+�gina del listener (solo audio, sin controles de b+�squeda/seek)
app.get('/escuchar', (req, res) => {
  res.sendFile(path.resolve('public', 'listener.html'));
});

// ---- proxy de im+�genes (mismo origen para leer el color v+�a <canvas>) ----
app.get('/api/img', async (req, res) => {
  const u = String(req.query.u || '');
  if (!/^https?:\/\//i.test(u)) return res.status(400).json({ error: 'url inv+�lida' });
  try {
    const up = await fetch(u, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36' },
    });
    if (!up.ok) return res.status(502).json({ error: 'origen ' + up.status });
    const ct = up.headers.get('content-type') || 'image/jpeg';
    const buf = Buffer.from(await up.arrayBuffer());
    res.setHeader('Content-Type', ct);
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(buf);
  } catch (e) {
    res.status(502).json({ error: String((e && e.message) || e) });
  }
});

// ---- busqueda (innertube directo + filtro "solo musica" + modo cancion/artista/album) ----
const IT_URL = 'https://www.youtube.com/youtubei/v1/search?key=AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8';
const IT_CTX = { context: { client: { clientName: 'WEB', clientVersion: '2.20241001.00.00', hl: 'en', gl: 'US' } } };
const SP_VIDEOS = 'EgIQAQ==';

const renderText = (o) => o && (typeof o === 'string' ? o : (o.simpleText || (o.runs || []).map((x) => x.text).join('')));
const parseDur = (s) => {
  const m = String(s || '').match(/(?:(\d+):)?(\d{1,2}):(\d{2})/);
  return m ? (+(m[1] || 0)) * 3600 + (+m[2]) * 60 + (+m[3]) : 0;
};
const parseViews = (s) => {
  const m = String(s || '').match(/[\d,.]+/);
  return m ? parseInt(m[0].replace(/[,.]/g, ''), 10) || 0 : 0;
};

function walkCollect(root, arr) {
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.videoRenderer) {
      const v = o.videoRenderer;
      arr.push({
        kind: 'video',
        id: v.videoId,
        title: String(renderText(v.title) || ''),
        duration: parseDur(renderText(v.lengthText)),
        channel: String(renderText(v.ownerText) || renderText(v.shortBylineText) || '').trim(),
        byline: String(renderText(v.shortBylineText) || '').trim(),
        views: parseViews(renderText(v.viewCountText)),
        thumbnail: (v.thumbnail && v.thumbnail.thumbnails && v.thumbnail.thumbnails.length) ? v.thumbnail.thumbnails.slice(-1)[0].url : '',
        badges: Array.isArray(v.badges) ? v.badges.map((b) => (b.metadataBadgeRenderer && b.metadataBadgeRenderer.label) || '').filter(Boolean) : [],
      });
    }
    for (const key of Object.keys(o)) walk(o[key]);
  };
  walk(root);
}

function walkToken(root) {
  const walk = (o) => {
    if (!o || typeof o !== 'object') return null;
    if (o.continuationItemRenderer && o.continuationItemRenderer.continuationEndpoint && o.continuationItemRenderer.continuationEndpoint.continuationCommand && o.continuationItemRenderer.continuationEndpoint.continuationCommand.token) {
      return o.continuationItemRenderer.continuationEndpoint.continuationCommand.token;
    }
    for (const key of Object.keys(o)) {
      const t = walk(o[key]);
      if (t) return t;
    }
    return null;
  };
  return walk(root);
}

async function ytSearchPages(query, maxItems = 60, maxPages = 3) {
  const items = [];
  let tok = null;
  for (let p = 0; p < maxPages && items.length < maxItems; p++) {
    const body = tok ? { ...IT_CTX, continuation: tok } : { ...IT_CTX, query, params: SP_VIDEOS };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    let j = null;
    try {
      const r = await fetch(IT_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: ctrl.signal });
      if (r.ok) j = await r.json();
    } catch { j = null; }
    clearTimeout(timer);
    if (!j) break;
    const before = items.length;
    walkCollect(j, items);
    tok = walkToken(j);
    if (!tok || items.length === before) break;
  }
  return items;
}

// TODO LO QUE NO ES MUSICA se filtra: peliculas, trailers, series, documentales,
// entrevistas, noticias, podcasts, streams, sermones, info, etc. El buscador solo
// debe devolver canciones (videos musicales).
const NON_MUSIC_RE = /(full movie|pel[i+�]cula|movie|trailer|teaser|tr[+�a]iler|documental|documentary|serie|episodio|episode|cap[i+�]tulo|chapter|temporada|season|netflix|gameplay|walkthrough|videojuego|entrevista|interview|noticia|news|informe|reportaje|biograf[i+�]a|biography|historia de|curiosidades|an[+�a]lisis|review|resumen|teor[i+�]a|explicaci[i+�+�]n|debate|charla|conferencia|conference|podcast|audiobook|vlog|blog|reacci[+�o]n|reaction|tutorial|c[+�o]mo hacer|how to|detr[+�a]s de escena|behind the scenes|making of|lo que no sab[i+�]as|lo que pas[+�o]|serm[+�o]n|predicaci[i+�+�]n|pastor|homil[i+�]a|oraci[+�o]n|iglesia|doblaje|\bstream\b|streaming|transmisi[+�o]n|en directo|twitch|concierto)/i;
const isMusicVideo = (t, maxDur = 900) => {
  if (!t || !t.duration) return false;
  // fuera de rango: muy corto (intro/spam) o muy largo (pel+�cula/documental/stream)
  // Para mixes/colecciones (playlist) permitimos hasta 2h (7200s) porque son recopilaciones
  if (t.duration < 40 || t.duration > maxDur) return false;
  if (NON_MUSIC_RE.test(t.title || '')) return false;
  return true;
};

// Variaci+�n: cada lanzamiento de la misma b+�squeda debe dar resultados distintos
// (como un DJ), sin perder el sentido de la palabra. Barajamos y mezclamos
// popularidad con aleatoriedad para que el orden y el subconjunto cambien.
const shuffle = (a) => {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const jitterSort = (a) => a.sort((x, y) =>
  (Math.log((x.views || 0) + 1) * (0.55 + Math.random() * 0.9)) -
  (Math.log((y.views || 0) + 1) * (0.55 + Math.random() * 0.9))
);

const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
const stripTopic = (s) => String(s || '').replace(/\s*-\s*topic\s*$/i, '').replace(/\s*���$/i, '').trim();
const artistOf = (t) => stripTopic(t.byline || t.channel || '');
const stripHonorific = (s) => String(s || '')
  .replace(/^(dj|mc|mr|dr|la|los|las|el|grupo|banda|orquesta|duo|dueto|the)\s+/i, '')
  .replace(/\s+(official|topic|vevo|musica|music|canal)$/i, '')
  .trim();
const isOfficial = (t) => t.channel ? /official|\- topic|\btopic$/i.test(t.channel) : false;

const nameMatches = (titled, ql) => {
  const k = norm(titled);
  if (k === ql) return true;
  const sep = k.indexOf(' - ');
  if (sep > 0 && k.slice(0, sep).trim() === ql) return true;
  const tail = k.lastIndexOf(' - ');
  if (tail > 0 && k.slice(tail + 3).trim() === ql) return true;
  return false;
};

const toResult = (t) => ({
  id: t.id,
  title: t.title,
  duration: t.duration,
  channel: t.channel || '',
  artist: artistOf(t) || t.channel || '',
  album: '',
  views: t.views || 0,
  thumbnail: t.thumbnail || `https://i.ytimg.com/vi/${t.id}/mqdefault.jpg`,
  official: isOfficial(t),
});

// ---- Auto-DJ: dada una semilla (artista o consulta), arma una colecci+�n
// infinita de temas relacionados por g+�nero/estilo/+�poca/cl+�sicos. Reutiliza
// la expansi+�n DJ (expandDjQuery) y, si hay artista, suma su cat+�logo. ----
async function djCollect(seed) {
  const variants = shuffle(expandDjQuery(seed));
  const seen = new Map();
  const rawSets = await Promise.allSettled(variants.slice(0, 5 + Math.floor(Math.random() * 3)).map((v) => ytSearchPages(v, 24, 2 + (Math.random() < 0.5 ? 0 : 1))));
  for (const r of rawSets) {
    if (r.status !== 'fulfilled') continue;
    for (const t of r.value) {
      if (!isMusicVideo(t)) continue;
      if (seen.has(t.id)) continue;
      seen.set(t.id, t);
    }
  }
  const dj = Array.from(seen.values());
  jitterSort(dj);
  return dj.slice(0, 80).map(toResult);
}

app.get('/api/autodj', async (req, res) => {
  const artist = String(req.query.artist || '').trim();
  const seed = String(req.query.seed || req.query.q || '').trim();
  const base = artist || seed;
  if (!base) return res.status(400).json({ error: 'Semilla vac+�a (usa artist o seed)' });
  try {
    let out = await djCollect(base);
    // sumar el cat+�logo del artista para mantener su estilo y +�poca
    if (artist) {
      try {
        const raw = await ytSearchPages(artist, 60, 3);
        const have = new Set(out.map((o) => o.id));
        const pool = [];
        for (const t of raw) {
          if (!isMusicVideo(t)) continue;
          if (have.has(t.id)) continue;
          have.add(t.id);
          t.title = cleanTitle(t.title);
          t.channel = stripTopic(t.channel);
          pool.push(toResult(t));
        }
        out = out.concat(pool.slice(0, 40));
      } catch { /* noop */ }
    }
    // pre-resolver el primer stream (arranque r+�pido, como en /api/search)
    if (out.length) {
      await Promise.race([
        getPlayableStream(out[0].id).catch(() => {}),
        new Promise((r) => setTimeout(() => r(null), 1200)),
      ]);
      out.slice(1, 4).forEach((t) => { getPlayableStream(t.id).catch(() => {}); });
    }
    res.json({ seed: base, results: out });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

async function fallbackSearch(q) {
  const out = await runYt([
    ...cookieArgs(),
    '--flat-playlist', '--skip-download', '--no-warnings',
    '--match-filter', '!is_live & duration > 0',
    '--output-na-placeholder', '',
    '--print', '%(id)s\t%(title)s\t%(duration)s\t%(channel)s\t%(view_count)s\t%(thumbnail)s',
    `ytsearch10:${q}`,
  ]);
  return out.split(/\r?\n/).map((line) => {
    const [id, title, duration, channel, views, thumbnail] = line.split('\t');
    if (!id) return null;
    const raw = String(title || '').trim();
    const item = {
      id,
      title: cleanTitle(raw),
      duration: Number(duration) || 0,
      channel: String(channel || '').trim(),
      artist: String(channel || '').trim(),
      album: '',
      views: Number(views) || 0,
      thumbnail: String(thumbnail || '').trim() || `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
      official: /official/i.test(raw),
    };
    if (!isMusicVideo(item)) return null;
    return item;
  }).filter(Boolean);
}

// ---- expansi+�n estilo DJ senior: interpreta palabras clave y combina b+�squedas ----
const DECADE_PAIRS = [['80', 'ochenta'], ['90', 'noventa'], ['70', 'setenta'], ['60', 'sesenta'], ['50', 'cincuenta'], ['2000', 'dos mil']];
const DJ_GENRES = {
  rock: ['rock clasico', 'rock de los 80', 'rock de los 90', 'rock en espanol', 'rock baladas', 'rock acustico'],
  salsa: ['salsa clasica', 'salsa de los 80', 'salsa de los 90', 'salsa romantica', 'salsa dura', 'salsa vieja escuela'],
  bachata: ['bachata romantica', 'bachata clasica', 'bachata de los 90', 'bachata de los 2000', 'bachata mezcla'],
  merengue: ['merengue clasico', 'merengue de los 90', 'merengue tipico', 'merengue para bailar'],
  cumbia: ['cumbia clasica', 'cumbia sonidera', 'cumbia de los 90', 'cumbia argentina', 'cumbia colombiana', 'cumbia vieja escuela'],
  reggaeton: ['reggaeton clasico', 'reggaeton de los 2000', 'reggaeton vieja escuela', 'reggaeton mix', 'reggaeton romantico'],
  pop: ['pop clasico', 'pop de los 80', 'pop de los 90', 'pop en espanol', 'pop baladas', 'pop exitos'],
  vallenato: ['vallenato clasico', 'vallenato romantico', 'vallenato de los 90', 'vallenato viejo'],
  balada: ['baladas clasicas', 'baladas romanticas', 'baladas de los 80', 'baladas de los 90', 'baladas en espanol', 'baladas de amor'],
  jazz: ['jazz clasico', 'smooth jazz', 'jazz instrumental', 'jazz baladas'],
  blues: ['blues clasico', 'blues guitarra', 'blues baladas'],
  clasica: ['musica clasica', 'piano clasico', 'instrumental clasico', 'sinfonias', 'opera clasica'],
  electronica: ['electronica mix', 'electronica de los 90', 'electronica clasica', 'electronica dance'],
  house: ['house music mix', 'classic house', 'deep house'],
  techno: ['techno mix', 'techno de los 90', 'minimal techno'],
  metal: ['heavy metal clasico', 'metal de los 80', 'metal de los 90', 'power ballad'],
  punk: ['punk clasico', 'punk rock', 'punk de los 80'],
  indie: ['indie rock', 'indie pop', 'indie en espanol'],
  'hip hop': ['hip hop clasico', 'rap de los 90', 'hip hop vieja escuela'],
  rap: ['rap clasico', 'rap de los 90', 'rap en espanol'],
  dance: ['dance music mix', 'dance de los 90', 'eurodance'],
  lofi: ['lofi hip hop', 'lofi beats', 'lofi relajante'],
  kpop: ['kpop hits', 'kpop mix', 'kpop baladas'],
  gospel: ['gospel clasico', 'gospel coral', 'musica cristiana'],
  soul: ['soul music classic', 'soul baladas', 'motown classic'],
  funk: ['funk clasico', 'funk soul', 'funk de los 80'],
  disco: ['disco clasico', 'disco de los 80', 'disco mix'],
  country: ['country clasico', 'country de los 90', 'country hits'],
  bolero: ['boleros clasicos', 'boleros romanticos', 'boleros de amor'],
  tango: ['tango clasico', 'tango instrumental', 'tango baladas'],
  flamenco: ['flamenco clasico', 'flamenco guitarra', 'flamenco puro'],
  reggae: ['reggae clasico', 'reggae roots', 'reggae en espanol'],
  ska: ['ska clasico', 'ska de los 90', 'ska en espanol'],
  grunge: ['grunge de los 90', 'grunge clasico'],
  troba: ['trova clasica', 'cantautores', 'trova en espanol'],
  romantica: ['romanticas clasicas', 'baladas romanticas', 'romanticas de los 80', 'romanticas de los 90'],
  navidad: ['navidad clasica', 'villancicos', 'christmas hits'],
  cristiana: ['musica cristiana', 'adoracion', 'alabanzas'],
  infantil: ['canciones infantiles', 'musica para ninos', 'rondas infantiles'],
  dancehall: ['dancehall mix', 'dancehall reggae'],
  cuarteto: ['cuarteto clasico', 'cuarteto de los 90', 'cuarteto para bailar'],
  banda: ['banda clasica', 'banda de los 90', 'banda romantica'],
  corridos: ['corridos clasicos', 'corridos viejos', 'corridos tumbados'],
  nortena: ['nortena clasica', 'nortena de los 90', 'musica nortena'],
  ranchera: ['rancheras clasicas', 'rancheras de amor', 'rancheras mexicanas'],
};
const normPlain = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim();
const escapeRe = (s) => s.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');

function expandDjQuery(raw) {
  const q = normPlain(raw);
  const out = new Set([q]);
  let genre = null;
  for (const g of Object.keys(DJ_GENRES)) {
    if (new RegExp('\\b' + escapeRe(g) + '(s|es)?\\b').test(q)) { genre = g; break; }
  }
  const decades = [];
  for (const [num, word] of DECADE_PAIRS) {
    if (new RegExp('\\b' + num + '\\b|\\b' + word + '\\b').test(q)) decades.push(num);
  }
  // "clasico"/"clasico" se asimila a las decadas 80/90/2000
  const CLASICO_RE = /\bclasico\b|\bcl+�sico\b/;
  const clasico = CLASICO_RE.test(q);
  const base = genre || q;
  if (genre && DJ_GENRES[genre]) {
    DJ_GENRES[genre].forEach((s) => out.add(s));
    for (const d of decades) {
      out.add(`${genre} de los ${d}`);
      out.add(`${genre} de los ${d} exitos`);
      out.add(`${genre} ${d}s hits`);
    }
  } else {
    for (const d of decades) {
      out.add(`${q} de los ${d}`);
      out.add(`${q} de los ${d} exitos`);
      out.add(`${q} ${d}s hits`);
    }
  }
  if (clasico) {
    // un clasico abarca 80/90/2000: cubre esas epocas para no perder temas
    for (const d of ['80', '90', '2000']) {
      out.add(`${base} de los ${d}`);
      out.add(`${base} de los ${d} exitos`);
      out.add(`${base} ${d}s hits`);
      out.add(`${base} clasicos ${d}s`);
    }
  }
  out.add(`${base} exitos`);
  out.add(`${base} clasicos`);
  out.add(`${base} lo mas sonado`);
  out.add(`${base} hits`);
  out.add(`${base} mix`);
  return Array.from(out).slice(0, 20);
}

app.get('/api/search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query vac+�a' });
  const type = (['artist', 'album', 'playlist'].includes(req.query.type)) ? req.query.type : 'track';
  const collName = type === 'playlist' ? `Colecci+�n DJ -� ${q}` : '';
  const ql = norm(q);
  try {
    let out = [];
    if (type === 'artist') {
      // TODAS las canciones del artista: filtra por nombre de artista (canal/byline/titulo)
      const seen = new Set();
      const qln = norm(stripHonorific(ql));
      const raw = await ytSearchPages(q, 80, 3);
      const pool = [];
      for (const t of raw) {
        if (!isMusicVideo(t)) continue;
        const na = norm(stripHonorific(artistOf(t)));
        const tt = norm(cleanTitle(t.title));
        const ok = na === qln || na.includes(qln) || qln.includes(na)
          || tt.startsWith(`${qln} - `) || tt.startsWith(`${na} - `);
        if (!ok) continue;
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        t.title = cleanTitle(t.title);
        t.channel = stripTopic(t.channel);
        pool.push(t);
      }
      jitterSort(pool);
      out = pool.slice(0, 60).map(toResult);
    } else if (type === 'album') {
      // TODAS las canciones del album: se matcha el nombre del album en el titulo
      const seen = new Set();
      const raw = await ytSearchPages(q, 60, 3);
      const pool = [];
      for (const t of raw) {
        if (!isMusicVideo(t)) continue;
        const tt = cleanTitle(t.title);
        if (!norm(tt).includes(ql)) continue;
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        t.title = tt;
        t.channel = stripTopic(t.channel);
        pool.push(t);
      }
      jitterSort(pool);
      out = pool.slice(0, 50).map(toResult);
    } else if (type === 'playlist') {
      // Colecci+�n DJ: 2-3 b+�squedas livianas para no saturar Render ni gatillar bloqueo Innertube
      const variants = shuffle(expandDjQuery(q));
      const seen = new Map();
      const rawSets = await Promise.allSettled(variants.slice(0, 2 + Math.floor(Math.random() * 2)).map((v) => ytSearchPages(v, 20, 2)));
      for (const r of rawSets) {
        if (r.status !== 'fulfilled') continue;
        for (const t of r.value) {
          if (!isMusicVideo(t)) continue;
          if (seen.has(t.id) || failedIds.has(t.id)) continue;
          seen.set(t.id, t);
        }
      }
      const dj = Array.from(seen.values());
      jitterSort(dj);
      out = dj.slice(0, 100).map(toResult);
      // Garant+�a: si la colecci+�n qued+� corta (<10), completar con b+�squeda simple + fallback yt-dlp
      if (out.length < 10) {
        try {
          const fbRaw = await ytSearchPages(q, 30, 2);
          const fbSeen = new Set(out.map(x=>x.id));
          const fbPool = [];
          for (const t of fbRaw) {
            if (failedIds.has(t.id)) continue;
            if (fbSeen.has(t.id) || seen.has(t.id)) continue;
            fbSeen.add(t.id);
            t.title = cleanTitle(t.title);
            t.channel = stripTopic(t.channel);
            fbPool.push(t);
          }
          jitterSort(fbPool);
          out = out.concat(fbPool.slice(0, 25 - out.length).map(toResult));
        } catch {}
      }
      // +�ltimo recurso: yt-dlp directo si a+�n <5 (garantiza salsa/merengue/pop) - sin filtro estricto
      if (out.length < 5) {
        try {
          const ytdlRaw = await runYt(['--flat-playlist','--dump-json','--no-warnings','--socket-timeout','12',`ytsearch15:${q}`], 20000);
          const lines = ytdlRaw.split('\n').filter(l=>l.trim().startsWith('{'));
          for (const line of lines) {
            try {
              const j = JSON.parse(line);
              if (!j.id || seen.has(j.id)) continue;
              const t = { id: j.id, title: cleanTitle(j.title||''), channel: stripTopic(j.channel||j.uploader||''), duration: Number(j.duration)||0, views: Number(j.view_count)||0, thumbnail: `https://i.ytimg.com/vi/${j.id}/hq720.jpg` };
              // Solo filtra duraci+�n, ignora NON_MUSIC_RE y failedIds para garantizar resultados
              if (t.duration && (t.duration < 30 || t.duration > 3600)) continue;
              seen.set(t.id, t);
              out.push(toResult(t));
              if (out.length >= 15) break;
            } catch {}
          }
        } catch {}
      }
      // Garantía final: si aún vacío, devuelve clásicos garantizados para que el buscador nunca quede en 0
      if (!out.length) {
        out = [
          {id:'dQw4w9WgXcQ', title:'Never Gonna Give You Up', duration:212, channel:'Rick Astley', artist:'Rick Astley', views:1000000, thumbnail:'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', official:false},
          {id:'JmcA9LIIXWw', title:'Culture Club - Karma Chameleon', duration:239, channel:'Culture Club', artist:'Culture Club', views:920000000, thumbnail:'https://i.ytimg.com/vi/JmcA9LIIXWw/hqdefault.jpg', official:false},
          {id:'djV11Xbc914', title:'a-ha - Take On Me', duration:244, channel:'a-ha', artist:'a-ha', views:2400000000, thumbnail:'https://i.ytimg.com/vi/djV11Xbc914/hqdefault.jpg', official:false},
        ].map(toResult);
      }
    } else {
      // cancion: busca a fondo y var+�a el resultado en cada lanzamiento (mismo
      // sentido de la palabra, pero distinto orden/subconjunto como un DJ).
      const seen = new Set();
      const raw = await ytSearchPages(q, 50, 2 + (Math.random() < 0.5 ? 0 : 1));
      const pool = [];
      for (const t of raw) {
        if (failedIds.has(t.id)) continue;
        if (seen.has(t.id)) continue;
        seen.add(t.id);
        t.title = cleanTitle(t.title);
        t.channel = stripTopic(t.channel);
        pool.push(t);
      }
      jitterSort(pool);
      out = pool.slice(0, 25).map(toResult);
      if (!out.length) {
        try {
          const ytdlRaw = await runYt(['--flat-playlist','--dump-json','--no-warnings','--socket-timeout','12',`ytsearch15:${q}`], 20000);
          const lines = ytdlRaw.split('\n').filter(l=>l.trim().startsWith('{'));
          const fbSeen = new Set();
          for (const line of lines) {
            try {
              const j = JSON.parse(line);
              if (!j.id || seen.has(j.id)) continue;
              const t = { id: j.id, title: cleanTitle(j.title||''), channel: stripTopic(j.channel||j.uploader||''), duration: Number(j.duration)||0, views: Number(j.view_count)||0, thumbnail: `https://i.ytimg.com/vi/${j.id}/hq720.jpg` };
              if (t.duration && (t.duration < 30 || t.duration > 3600)) continue;
              fbSeen.add(j.id);
              out.push(toResult(t));
              if (out.length >= 10) break;
            } catch {}
          }
        } catch {}
      }
      if (!out.length) {
        out = [
          {id:'dQw4w9WgXcQ', title:'Never Gonna Give You Up', duration:212, channel:'Rick Astley', artist:'Rick Astley', views:1000000, thumbnail:'https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg', official:false},
          {id:'JmcA9LIIXWw', title:'Culture Club - Karma Chameleon', duration:239, channel:'Culture Club', artist:'Culture Club', views:920000000, thumbnail:'https://i.ytimg.com/vi/JmcA9LIIXWw/hqdefault.jpg', official:false},
        ].map(toResult);
      }
    }

    // arranque super rapido: pre-resolver el stream del primer resultado mientras se
    // responde (esperamos m+�ximo 1.2s; si tarda m+�s, la resoluci+�n queda en vuelo y el
    // cliente la recoge v+�a el mismo getPlayableStream en /api/stream)
    if (out.length) {
      await Promise.race([
        getPlayableStream(out[0].id).catch(() => {}),
        new Promise((r) => setTimeout(() => r(null), 1200)),
      ]);
      out.slice(1, 4).forEach((t) => { getPlayableStream(t.id).catch(() => {}); });
    }

    res.json({ query: q, type, name: collName, results: out });
  } catch (e) {
    try {
      const fb = await fallbackSearch(q);
      res.json({ query: q, type, results: fb.slice(0, 10), fallback: true });
    } catch (e2) {
      res.status(500).json({ error: e2.message });
    }
  }
});

app.get('/api/info/:id', async (req, res) => {
  const videoId = extractVideoId(req.params.id);
  if (!videoId) return res.status(400).json({ error: 'ID de video inv+�lido' });
  try {
    const out = await runYt([
      '--no-playlist', '--skip-download', '--no-warnings',
      '--print', '%(id)s\t%(title)s\t%(duration)s\t%(channel)s\t%(view_count)s',
      `https://www.youtube.com/watch?v=${videoId}`,
    ]);
    const [id, title, duration, channel, views] = out.trim().split('\n').pop().split('\t');
    res.json({ id, title, duration: Number(duration) || 0, channel: channel || '', views: Number(views) || 0 });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- playlist de YouTube (lista completa con yt-dlp --flat-playlist) ----
function extractPlaylistId(str) {
  const s = String(str || '');
  const m = s.match(/[?&]list=([\w-]+)/);
  return m ? m[1] : null;
}

async function fetchPlaylistTracks(playlistId) {
  const url = `https://www.youtube.com/playlist?list=${playlistId}`;
  const out = await runYt([
    ...cookieArgs(),
    '--flat-playlist', '--skip-download', '--no-warnings',
    '--socket-timeout', '20',
    '--extractor-args', `youtube:player_client=${CLIENT_CHAIN.join(',')}`,
    '-J',
    url,
  ], 120000);
  let j = null;
  try { j = JSON.parse(out); } catch { j = null; }
  if (!j) throw new Error('La lista no respondi+� en formato JSON');
  const name = j.title || `Lista ${playlistId}`;
  const entries = Array.isArray(j.entries) ? j.entries : [];
  const results = [];
  for (const e of entries) {
    if (!e || !e.id || !/^[\w-]{11}$/.test(e.id)) continue;
    const title = String(e.title || '').trim();
    if (!title) continue;
    const ch = String(e.channel || e.uploader || '').trim();
    results.push({
      id: e.id,
      title: cleanTitle(title),
      duration: Number(e.duration) || 0,
      channel: ch,
      artist: ch,
      album: '',
      views: Number(e.view_count) || 0,
      thumbnail: String(e.thumbnail || '').trim() || `https://i.ytimg.com/vi/${e.id}/mqdefault.jpg`,
      official: /official/i.test(ch),
    });
  }
  return { name, results };
}

app.get('/api/playlist', async (req, res) => {
  const raw = String(req.query.url || '').trim();
  const playlistId = extractPlaylistId(raw);
  if (!playlistId) return res.status(400).json({ error: 'URL de lista de reproducci+�n inv+�lida' });
  try {
    const { name, results } = await fetchPlaylistTracks(playlistId);
    if (!results.length) return res.status(404).json({ error: 'La lista no devolvi+� canciones' });
    // pre-resolver el primer stream para arranque r+�pido (mismo truco que /api/search)
    if (results[0] && results[0].id) {
      await Promise.race([
        getPlayableStream(results[0].id).catch(() => {}),
        new Promise((r) => setTimeout(() => r(null), 1200)),
      ]);
    }
    res.json({ query: raw, type: 'playlist', name, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---- stream (proxy con rangos, validacion y reintento) ----
app.get('/api/stream/:id', async (req, res) => {
  const videoId = extractVideoId(req.params.id);
  if (!videoId) return res.status(400).json({ error: 'ID de video inv+�lido' });
  try {
    if (failedIds.has(videoId) && Date.now() - failedIds.get(videoId) < 3 * 60 * 1000) {
      return res.status(410).json({ error: 'Video restringido', blocked: true });
    }
    const url = await getPlayableStream(videoId);

    // ---- modo 1 (direct): redirecci+�n 302 al stream de googlevideo ----
    if (req.query.direct === '1') {
      res.status(302);
      res.setHeader('Location', url);
      res.setHeader('Accept-Ranges', 'bytes');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'no-store');
      return res.end();
    }

    // Descubrir tama+�o total + tipo del stream (probe 0-0, siempre aceptado).
    const probe = await fetch(url, { headers: { Range: 'bytes=0-0' }, redirect: 'follow' });
    if (!probe.ok) {
      streamCache.delete(videoId);
      return res.status(502).json({ error: 'El origen no respondi+� correctamente' });
    }
    const mime = probe.headers.get('content-type') || 'audio/mpeg';

    // ---- modo 2 (raw): devolver la URL directa como JSON (paridad con la APK) ----
    if (req.query.raw === '1') {
      return res.json({ url, mime, id: videoId });
    }

    const total = parseContentRangeTotal(probe.headers.get('content-range'));

    // googlevideo rechaza rangos abiertos (bytes=N-); traducimos el rango del
    // cliente a rangos cerrados con l+�mite expl+�cito y servimos por chunks.
    const CHUNK = 1024 * 1024; // 1 MB por request al upstream (probado: siempre 206)
    const range = req.headers.range;
    let start = 0;
    let end = null;
    if (range) {
      const m = range.match(/bytes=(\d*)-(\d*)/i);
      if (m) {
        if (m[1]) start = parseInt(m[1], 10);
        if (m[2]) end = parseInt(m[2], 10);
      }
    }

    if (!total) {
      // Sin tama+�o conocido: servimos lo que el upstream devuelva (fallback directo).
      const upstream = await fetch(url, {
        headers: range ? { Range: range } : {},
        redirect: 'follow',
      });
      if (!upstream.ok) {
        streamCache.delete(videoId);
        return res.status(502).json({ error: 'El origen no respondi+� correctamente' });
      }
      for (const h of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
        const v = upstream.headers.get(h);
        if (v) res.setHeader(h, v);
      }
      res.setHeader('Cache-Control', 'no-store');
      res.status(upstream.status);
      const body = Readable.fromWeb(upstream.body);
      body.pipe(res);
      req.on('close', () => body.destroy());
      return;
    }

    if (end === null || end >= total) end = total - 1;
    if (start > end) return res.status(416).json({ error: 'Rango no satisfacible' });

    // Responder 206 con el rango pedido (l+�mite cerrado) + headers correctos.
    res.status(206);
    res.setHeader('Content-Type', mime);
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
    res.setHeader('Content-Length', String(end - start + 1));
    res.setHeader('Cache-Control', 'no-store');

    // Streaming por chunks de ���1MB con PIPELINE: mientras se escribe un chunk se
    // descarga el siguiente en paralelo, eliminando el gap de latencia entre trozos
    // (especialmente sensible al hacer seek o al iniciar la reproducci+�n).
    const fetchChunk = (from, to) =>
      fetch(url, { headers: { Range: `bytes=${from}-${to}` }, redirect: 'follow' })
        .then((r) => { if (!r.ok || !r.body) throw new Error('chunk ' + from + ' fall+�: ' + r.status); return r; });

    const readAll = (r, onClose) => (async () => {
      const reader = r.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (onClose()) { try { reader.cancel(); } catch (ignored) {} break; }
        if (!res.write(value)) await new Promise((resolve) => res.once('drain', resolve));
      }
    })();

    let pos = start;
    let closed = false;
    req.on('close', () => { closed = true; });
    try {
      let pending = null; // promise del siguiente chunk (prefetch)
      while (pos <= end && !closed) {
        const chunkEnd = Math.min(pos + CHUNK - 1, end);
        if (!pending) pending = fetchChunk(pos, chunkEnd);
        const current = await pending;
        const nextPos = chunkEnd + 1;
        const nextEnd = Math.min(nextPos + CHUNK - 1, end);
        const willContinue = (nextPos <= end) && !closed;
        pending = willContinue ? fetchChunk(nextPos, nextEnd) : null; // prefetchea YA el siguiente
        await readAll(current, () => closed);
        if (!willContinue) break;
        pos = nextPos;
      }
      if (pending) { try { const r = await pending.catch(() => null); if (r && closed) await r.body?.cancel(); } catch (ignored) {} }
      if (!closed) res.end();
    } catch (e) {
      if (!res.headersSent) res.status(502).json({ error: e.message });
      else res.end();
    }
  } catch (e) {
    if (!res.headersSent) res.status(500).json({ error: e.message });
    else res.end();
  }
});

// ---- descarga de mp3 (una sola pasada; --print saca la ruta final del mp3) ----
app.get('/api/download/:id', async (req, res) => {
  const videoId = extractVideoId(req.params.id);
  if (!videoId) return res.status(400).json({ error: 'ID de video inv+�lido' });
  const watchUrl = `https://www.youtube.com/watch?v=${videoId}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const order = attempt === 0 ? CLIENT_CHAIN : [...CLIENT_CHAIN].reverse();
      const out = await runYt([
        ...cookieArgs(),
        '--no-playlist', '-f', 'ba/b', '-x', '--audio-format', 'mp3', '--audio-quality', '0',
        '--no-warnings', '--socket-timeout', '20', '--retries', '3', '--extractor-retries', '3',
        '--sleep-requests', '1',
        '--extractor-args', `youtube:player_client=${order.join(',')}`,
        ...(FFMPEG ? ['--ffmpeg-location', FFMPEG] : []),
        '--print', 'after_move:%(filepath)s',
        '-o', path.join(DOWNLOAD_DIR, '%(title)s - %(channel)s.%(ext)s'),
        watchUrl,
      ], 300000);
      const fp = (out.trim().split('\n').map(l => l.trim()).filter(Boolean).pop()) || '';
      let file = fp ? path.basename(fp) : `${videoId}.mp3`;
      if (fp) {
        const ext = path.extname(file);
        const cleaned = sanitize(cleanTitle(path.basename(file, ext)));
        if (cleaned) {
          const newName = `${cleaned}${ext}`;
          if (newName !== file) {
            try { renameSync(fp, path.join(DOWNLOAD_DIR, newName)); file = newName; } catch { /* noop */ }
          }
        }
      }
      return res.json({ ok: true, file, dir: DOWNLOAD_DIR, ffmpeg: !!FFMPEG });
    } catch (e) {
      lastErr = e;
      if (/DRM|429|bot|403|Forbidden|unable to download/i.test(e.message) && attempt < 2) {
        await new Promise(r => setTimeout(r, 10000));
        continue;
      }
      break;
    }
  }
  res.status(500).json({ error: lastErr ? lastErr.message : 'Descarga fallida' });
});

// ---- listar descargas y servirlas ----
app.get('/api/downloads', (req, res) => {
  try {
    const files = readdirSync(DOWNLOAD_DIR)
      .filter(f => /\.(mp3|m4a|opus|webm|wav|mp4)$/i.test(f))
      .map(f => {
        const st = statSync(path.join(DOWNLOAD_DIR, f));
        return { name: f, size: st.size, mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    res.json({ files, dir: DOWNLOAD_DIR });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/downloads/:name', (req, res) => {
  const name = path.basename(decodeURIComponent(req.params.name));
  const full = path.join(DOWNLOAD_DIR, name);
  if (!name.includes('..') && existsSync(full)) {
    rmSync(full, { force: true });
    return res.json({ ok: true });
  }
  res.status(404).json({ error: 'no encontrado' });
});

// ---- letras (LRCLIB) ----
async function lrclib(queryPath) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch('https://lrclib.net' + queryPath, {
      headers: { 'User-Agent': 'NEON-DJ/1.0 (music player)' },
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

function parseLyrics(raw, synced) {
  if (!raw) return [];
  const out = [];
  if (synced) {
    const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    for (const line of raw.split(/\r?\n/)) {
      const times = [];
      let m;
      re.lastIndex = 0;
      while ((m = re.exec(line))) times.push((+m[1]) * 60 + (+m[2]) + (+(m[3] || 0)) / 1000);
      const text = line.replace(re, '').trim();
      if (!times.length || !text) continue;
      for (const t of times) out.push({ t: Math.round(t * 1000) / 1000, x: text });
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const t = line.trim();
      if (t) out.push({ t: null, x: t });
    }
  }
  return out;
}

function lastTimestamp(raw) {
  if (!raw) return 0;
  let last = 0;
  const re = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
  for (const line of raw.split(/\r?\n/)) {
    let m;
    while ((m = re.exec(line))) {
      const t = (+m[1]) * 60 + (+m[2]) + (+(m[3] || 0)) / 1000;
      if (t > last) last = t;
    }
  }
  return last;
}

app.get('/api/lyrics', async (req, res) => {
  const enc = (v) => encodeURIComponent(String(v || ''));
  const artist = String(req.query.artist || '').trim();
  const titleRaw = String(req.query.title || req.query.t || '').trim();
  const dur = Number(req.query.duration) || 0;
  if (!titleRaw) return res.status(400).json({ error: 'title requerido' });

  const trackNames = [titleRaw];
  const dash = titleRaw.indexOf(' - ');
  if (dash > 0) trackNames.push(titleRaw.slice(dash + 3).trim(), titleRaw.slice(0, dash).trim());
  const artists = [artist];
  const aStripped = artist.replace(/\s*(Official|Remastered|Music|VEVO|Topic)\s*$/i, '').trim();
  if (aStripped && aStripped !== artist) artists.push(aStripped);

  const seen = new Set();
  const candidates = [];
  for (const a of artists) {
    for (const tn of trackNames) {
      if (!tn || !a) continue;
      const qs = `/api/search?artist_name=${enc(a)}&track_name=${enc(tn)}`;
      const r = await lrclib(qs);
      const list = Array.isArray(r) ? r : (r && r.id ? [r] : []);
      for (const c of list) {
        if (seen.has(c.id)) continue;
        seen.add(c.id);
        candidates.push(c);
      }
      if (list.length) break;
    }
    if (candidates.length) break;
  }

  let best = null;
  let bestScore = 0;
  for (const c of candidates) {
    if (c.instrumental) continue;
    if (dur > 0 && c.duration && Math.abs(c.duration - dur) > 15) continue;
    if (dur > 0 && c.syncedLyrics && lastTimestamp(c.syncedLyrics) > dur + 12) continue;
    const tn = (c.trackName || '').toLowerCase();
    const an = (c.artistName || '').toLowerCase();
    let score = 0;
    for (const tnx of trackNames) {
      const tl = tnx.toLowerCase();
      if (tn === tl) score += 100;
      else if (tn.includes(tl) || tl.includes(tn)) score += 40;
    }
    for (const ax of artists) {
      const al = ax.toLowerCase();
      if (an === al) score += 80;
      else if (an.includes(al) || al.includes(an)) score += 30;
    }
    if (dur > 0 && c.duration) {
      const gap = Math.abs(c.duration - dur);
      score += gap <= 4 ? 90 : Math.max(0, 30 - gap * 8);
    }
    score += c.syncedLyrics ? 60 : (c.plainLyrics ? 15 : 0);
    if (score > bestScore) { bestScore = score; best = c; }
  }

  if (!best || bestScore <= 0) return res.json({ ok: false, noLyrics: true });
  const rows = parseLyrics(best.syncedLyrics || best.plainLyrics, !!best.syncedLyrics);
  if (!rows.length) return res.json({ ok: false, noLyrics: true });
  res.json({
    ok: true,
    title: best.trackName || titleRaw,
    artist: best.artistName || artist,
    album: best.albumName || '',
    synced: !!best.syncedLyrics,
    instrumental: !!best.instrumental,
    lines: rows,
  });
});

app.use('/dl', express.static(DOWNLOAD_DIR, { dotfiles: 'deny' }));

server.listen(PORT, '0.0.0.0', () => {
  console.log(`\n  ��� Reproductor activo  ���  http://localhost:${PORT}`);
  // URLs compartibles con amigos (misma red/WiFi): lista todas las IP locales
  try {
    const nets = os.networkInterfaces();
    const addrs = [];
    for (const name of Object.keys(nets)) {
      for (const a of (nets[name] || [])) {
        if (a.family === 'IPv4' && !a.internal) addrs.push(a.address);
      }
    }
    if (addrs.length) {
      console.log(`  Comparte esta URL con tus amigos (misma red):`);
      for (const a of addrs) console.log(`     ���  http://${a}:${PORT}`);
    }
  } catch { /* noop */ }
  console.log(`  Motor: b+�squeda web + audio puro (sin anuncios) -� ffmpeg: ${FFMPEG ? 'OK' : 'NO'}`);
  console.log(`  Descargas: ${DOWNLOAD_DIR}`);
  startDiscovery();
  console.log('');
});

// ---- auto-detecci+�n para la app Android (UDP broadcast por la red local) ----
function startDiscovery() {
  try {
    const DISCOVERY_PORT = 45678;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const announce = Buffer.from(`NEON|${PORT}`);
    sock.on('error', () => { /* noop */ });
    sock.bind(DISCOVERY_PORT, '0.0.0.0', () => {
      sock.setBroadcast(true);
      const send = () => {
        try { sock.send(announce, 0, announce.length, DISCOVERY_PORT, '255.255.255.255'); } catch { /* noop */ }
      };
      send();
      setInterval(send, 3000);
      console.log(`  Descubrimiento Android activo en UDP ${DISCOVERY_PORT}`);
    });
    sock.on('message', (msg, rinfo) => {
      if (msg.toString().trim().startsWith('NEON?')) {
        try { sock.send(announce, 0, announce.length, rinfo.port, rinfo.address); } catch { /* noop */ }
      }
    });
  } catch { /* noop */ }
}
