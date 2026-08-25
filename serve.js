import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const ytdlp = require('youtube-dl-exec');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors({ origin: "*" }));
app.use(express.json());
app.use(express.static('public'));

const COOKIES = path.resolve('cookies.txt');
const PORT = process.env.PORT || 10000;

let djConnected = false, currentDJSocket = null, autoDJProcess = null;
let listeners = [];

// Historial dinámico para la retroalimentación infinita
let historialBusquedas = ["lofi music radio en vivo", "vaporwave mix 24/7", "synthwave music live", "chillhop beats"];

app.get('/escuchar', (req, res) => {
  res.sendFile(path.resolve('public', 'listener.html'));
});

app.get('/radio/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'audio/mpeg',
    'Transfer-Encoding': 'chunked',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  listeners.push(res);
  req.on('close', () => {
    listeners = listeners.filter(l => l !== res);
  });
});

function startAutoDJ() {
  if (djConnected || autoDJProcess) return;
  console.log("Activando Auto-DJ de respaldo inteligente...");

  // Selecciona un género o búsqueda previa de forma aleatoria para retroalimentarse
  const proximaBusqueda = historialBusquedas[Math.floor(Math.random() * historialBusquedas.length)];
  console.log(`Buscando nueva música infinita para la radio: "${proximaBusqueda}"`);

  // Llamamos de forma segura mediante la librería instalada localmente en Render
  autoDJProcess = ytdlp.exec(['--cookies', COOKIES, '-f', 'bestaudio', '-o', '-', `ytsearch5:${proximaBusqueda}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

  autoDJProcess.child.stdout.on('data', c => {
    if (djConnected) { stopAutoDJ(); return; }
    listeners.forEach(r => { try { r.write(c); } catch {} });
  });

  autoDJProcess.child.on('close', () => {
    autoDJProcess = null;
    if (!djConnected) startAutoDJ();
  });

  autoDJProcess.catch((err) => {
    console.log("Aviso de stream: Buscando siguiente bloque encadenado...");
    autoDJProcess = null;
    if (!djConnected) startAutoDJ();
  });
}

function stopAutoDJ() {
  if (autoDJProcess) {
    try { autoDJProcess.child.kill(); } catch {}
    autoDJProcess = null;
    console.log("Auto-DJ detenido.");
  }
}

io.on('connection', socket => {
  socket.on('registrar-dj', () => {
    djConnected = true; 
    currentDJSocket = socket.id;
    stopAutoDJ();
  });

  // Captura lo que reproduce el DJ y lo añade al historial para retroalimentar la IA de la radio
  socket.on('stream-desde-dj', data => {
    if (data && data.titulo && !historialBusquedas.includes(data.titulo)) {
      historialBusquedas.push(data.titulo);
    }
    if (socket.id === currentDJSocket) {
      listeners.forEach(r => { try { r.write(Buffer.from(data.audio || data)); } catch {} });
    }
  });

  socket.on('disconnect', () => {
    if (socket.id === currentDJSocket) {
      djConnected = false; 
      currentDJSocket = null;
      startAutoDJ();
    }
  });
});

startAutoDJ();
server.listen(PORT, () => console.log('Radio corriendo de forma infinita en puerto ' + PORT));
