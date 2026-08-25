// serve.js
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const PORT = process.env.PORT || 10000;

// 1. CORS abierto para cualquier navegador
app.use(cors());
// 2. Rutas estáticas limpias
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

const YTDLP_BIN = JSON.parse(process.env.YTDLP_BIN || '["python","-m","yt_dlp"]');
const CLIENT_CHAIN = (process.env.YTDLP_CLIENTS || 'tv,android,ios,web').split(',').map(s=>s.trim());
const COOKIES = process.env.YTDLP_COOKIES_FILE || 'cookies.txt';
function cookieArgs(){ return COOKIES && (await import('node:fs')).existsSync(COOKIES) ? ['--cookies', COOKIES] : []; }

// Helper yt-dlp
function runYt(args, t=20000){
  return new Promise((res,rej)=>{
    const p=spawn(YTDLP_BIN[0], [...YTDLP_BIN.slice(1), ...args]);
    let o='',e=''; p.stdout.on('data',d=>o+=d); p.stderr.on('data',d=>e+=d);
    const tm=setTimeout(()=>{try{p.kill()}catch{};rej(new Error('timeout'))},t);
    p.on('close',c=>{ clearTimeout(tm); c===0?res(o):rej(new Error(e||o)) });
  });
}

// /api/search - evasión móvil intacta
app.get('/api/search', async(req,res)=>{
  const q=String(req.query.q||'').trim(); if(!q) return res.status(400).json({error:'Falta q'});
  try{
    const out=await runYt(['--cookies',COOKIES,'--flat-playlist','--dump-json','--no-warnings',
      '--extractor-args',`youtube:player_client=${CLIENT_CHAIN.join(',')}`, `ytsearch15:${q}`]);
    const results=out.split('\n').filter(l=>l.startsWith('{')).map(l=>JSON.parse(l)).map(j=>({
      id:j.id, title:j.title, channel:j.channel, duration:j.duration,
      thumbnail:`https://i.ytimg.com/vi/${j.id}/hqdefault.jpg`
    }));
    res.json({results});
  }catch(e){ res.status(500).json({error:e.message}); }
});

// /api/stream - evasión móvil intacta, solo audio
app.get('/api/stream', async(req,res)=>{
  const id=String(req.query.id||'').trim(); if(!id) return res.status(400).json({error:'Falta id'});
  try{
    const out=await runYt(['--cookies',COOKIES,'-f','bestaudio','-g',
      '--extractor-args',`youtube:player_client=${CLIENT_CHAIN.join(',')}`,
      `https://www.youtube.com/watch?v=${id}`]);
    const url=out.split('\n').find(l=>l.startsWith('http'))?.trim();
    if(!url) throw new Error('No url');
    res.json({url});
  }catch(e){ res.status(500).json({error:e.message}); }
});

app.get('/escuchar',(req,res)=>res.sendFile(path.resolve('public','listener.html')));
app.listen(PORT,()=>console.log('Neon http://localhost:'+PORT));
