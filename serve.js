// server.js
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import { createReadStream, existsSync } from 'node:fs';
import path from 'node:path';
import needle from 'needle';

const app = express();
const server = http.createServer(app);
const io = new Server(server,{cors:{origin:"*"}});

app.use(cors({origin:"*"}));
app.use(express.json());
app.use(express.static('public'));

const PORT = process.env.PORT || 10000;
let djConnected=false, currentDJSocket=null, autoDJProcess=null;
let listeners=[];

// URL pública estable 24h (cámbiala por tu MP3 directo si prefieres)
const FALLBACK_URL = 'https://stream.laut.fm/lofi'; 
const FALLBACK_FILE = path.resolve('public/station-id.mp3');

app.get('/radio/stream',(req,res)=>{
  res.writeHead(200,{'Content-Type':'audio/mpeg','Transfer-Encoding':'chunked','Cache-Control':'no-cache','Connection':'keep-alive'});
  listeners.push(res);
  req.on('close',()=>{ listeners = listeners.filter(l => l !== res); });
});

function startAutoDJ(){
  if(djConnected || autoDJProcess) return;
  console.log("Auto-DJ directo: sin yt-dlp, usando stream público/archivo local");

  // Intenta stream de red directo con needle (liviano, sin npx)
  const isUrl = FALLBACK_URL.startsWith('http');
  const stream = isUrl ? needle.get(FALLBACK_URL) : createReadStream(FALLBACK_FILE);

  autoDJProcess = stream;

  stream.on('data', chunk=>{
    if(djConnected){ try{stream.destroy()}catch{}; autoDJProcess=null; return; }
    listeners.forEach(r=>{ try{r.write(chunk)}catch{} });
  });
  stream.on('end',()=>{
    autoDJProcess=null;
    if(!djConnected) setTimeout(startAutoDJ, 500);
  });
  stream.on('error',()=>{
    autoDJProcess=null;
    // Si falla la URL, cae al archivo local en bucle
    if(isUrl && existsSync(FALLBACK_FILE)){
      const fileStream = createReadStream(FALLBACK_FILE);
      autoDJProcess = fileStream;
      fileStream.on('data',c=>{ if(!djConnected) listeners.forEach(r=>r.write(c)); });
      fileStream.on('end',()=>{ autoDJProcess=null; if(!djConnected) startAutoDJ(); });
    }else if(!djConnected){
      setTimeout(startAutoDJ, 2000);
    }
  });
}
function stopAutoDJ(){
  if(autoDJProcess){ try{autoDJProcess.destroy()}catch{}; autoDJProcess=null; }
}

io.on('connection',socket=>{
  socket.on('registrar-dj',()=>{ djConnected=true; currentDJSocket=socket.id; stopAutoDJ(); });
  socket.on('stream-desde-dj',c=>{ if(socket.id===currentDJSocket) listeners.forEach(r=>r.write(Buffer.from(c))); });
  socket.on('disconnect',()=>{ if(socket.id===currentDJSocket){ djConnected=false; currentDJSocket=null; startAutoDJ(); }});
});

startAutoDJ();
server.listen(PORT,()=>console.log('Radio http://localhost:'+PORT));
