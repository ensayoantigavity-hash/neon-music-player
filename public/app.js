// public/app.js - Reemplaza por completo tu archivo viejo
import { io } from "https://cdn.socket.io/4.7.5/socket.io.esm.min.js";

const realAudioEl = document.getElementById('audio');
const isEscuchar = location.pathname === '/escuchar';

// ===================== 2. EMISOR PRINCIPAL / =====================
if (!isEscuchar) {
  const socket = io();
  socket.emit('registrar-dj');

  const input = document.getElementById('q');
  const form = document.getElementById('search-form');
  const audio = realAudioEl; // el DJ usa el mismo <audio> para pre-escucha local

  // Captura flujo real del <audio> y emite al servidor
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  let dest = null, recorder = null;
  function ensureGraph(){
    if(dest) return;
    const src = ctx.createMediaElementSource(audio);
    dest = ctx.createMediaStreamDestination();
    src.connect(dest); src.connect(ctx.destination);
  }
  function startEmit(){
    ensureGraph();
    if(ctx.state==='suspended') ctx.resume();
    if(recorder?.state==='recording') return;
    recorder = new MediaRecorder(dest.stream,{mimeType:'audio/webm;codecs=opus'});
    recorder.ondataavailable = e=>{
      if(e.data.size>0) e.data.arrayBuffer().then(b=> socket.emit('stream-desde-dj', b));
    };
    recorder.start(100);
  }
  function stopEmit(){ try{recorder?.stop()}catch{} recorder=null; }

  audio.addEventListener('playing', ()=>{
    socket.emit('track-played',{id: window.currentId, title: window.currentTitle});
    startEmit();
  });
  audio.addEventListener('pause', stopEmit);
  audio.addEventListener('ended', stopEmit);

  // Buscador sigue encolando en el backend (no cambia tu lógica de búsqueda)
  if(form){
    form.addEventListener('submit', async e=>{
      e.preventDefault();
      const q = input.value.trim(); if(!q) return;
      await fetch('/api/buscar',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({q})});
      input.value='';
    });
  }
}

// ===================== 1. OYENTE /escuchar =====================
if (isEscuchar) {
  const btnPlay = document.getElementById('btn-play');
  const statusEl = document.getElementById('status');
  let stallTimer = null;

  function playStream(){
    realAudioEl.src = '/radio/stream?_t=' + Date.now();
    realAudioEl.load();
    realAudioEl.play().catch(()=>{});
    if(statusEl) statusEl.textContent = 'Sintonizando la estación...';
  }
  function scheduleReconnect(){
    clearTimeout(stallTimer);
    stallTimer = setTimeout(()=>{
      if(statusEl) statusEl.textContent = 'Reconectando...';
      realAudioEl.load();
      realAudioEl.play().catch(()=>{});
    }, 3000);
  }

  // Play apunta directo a /radio/stream
  btnPlay?.addEventListener('click', playStream);

  // Reconexión limpia 3s sin congelar
  realAudioEl.addEventListener('stalled', scheduleReconnect);
  realAudioEl.addEventListener('waiting', scheduleReconnect);
  realAudioEl.addEventListener('error', scheduleReconnect);
  realAudioEl.addEventListener('playing', ()=>{ clearTimeout(stallTimer); if(statusEl) statusEl.textContent=''; });
  realAudioEl.addEventListener('canplay', ()=> clearTimeout(stallTimer));

  // Autoplay al entrar
  playStream();
}
