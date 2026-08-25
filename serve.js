import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { createRequire } from 'node:module';
import { PassThrough } from 'node:stream';
import path from 'node:path';
import { exec } from 'node:child_process';

const require = createRequire(import.meta.url);
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
  console.log("Iniciando Auto-DJ de respaldo...");
  
  // Usamos un comando nativo del sistema llamando directamente a yt-dlp instalado por la librería
  const cmd = `npx yt-dlp --cookies "${COOKIES}" -f bestaudio -o - "ytsearch:lofi music radio en vivo"`;
  
  autoDJProcess = exec(cmd, { maxBuffer: 1024 * 1024 * 50 });
  
  autoDJProcess.stdout.on('data', c => {
    if (djConnected) { stopAutoDJ(); return; }
    listeners.forEach(r => { try { r.write(c); } catch {} });
  });
  
  autoDJProcess.on('close', () => {
    autoDJProcess = null;
    if (!djConnected) startAutoDJ();
  });
  
  autoDJProcess.on('error', () => { autoDJProcess = null; });
}

function stopAutoDJ() {
  if (autoDJProcess) {
    try { autoDJProcess.kill(); } catch {}
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
  
  socket.on('stream-desde-dj', c => {
    if (socket.id === currentDJSocket) {
      listeners.forEach(r => { try { r.write(Buffer.from(c)); } catch {} });
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
server.listen(PORT, () => console.log('Radio corriendo en puerto ' + PORT));
