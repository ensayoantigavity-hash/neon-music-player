// public/script.js
const audio = new Audio();
const qInput = document.getElementById('q');
const btnBuscar = document.getElementById('btn-buscar');
const btnPlay = document.getElementById('btn-play');
const listaEl = document.getElementById('lista');

let cola = [];
let estiloSemilla = '';
let current = -1;

// NUNCA http://localhost:3000 - siempre relativo
async function buscar(){
  const q = qInput.value.trim(); if(!q) return;
  estiloSemilla = q;
  const r = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await r.json();
  cola = data.results || [];
  current = -1;
  renderLista();
  if(cola.length) play(0);
}
async function play(i){
  if(i<0||i>=cola.length) return;
  current = i;
  const id = cola[current].id;
  // Relativo + Audio nativo
  const r = await fetch(`/api/stream?id=${encodeURIComponent(id)}`);
  const {url} = await r.json();
  audio.src = url;
  await audio.play();
  renderLista();
}

// Auto-DJ infinito: si faltan <=2, rellena con estiloSemilla
audio.addEventListener('ended', async()=>{
  if(cola.length -1 - current <= 2 && estiloSemilla){
    try{
      const r = await fetch(`/api/search?q=${encodeURIComponent(estiloSemilla)}`);
      const d = await r.json();
      const ids = new Set(cola.map(x=>x.id));
      const nuevos = (d.results||[]).filter(x=>!ids.has(x.id));
      cola.push(...nuevos);
      renderLista();
    }catch{}
  }
  const n = current+1 < cola.length ? current+1 : -1;
  if(n>=0) play(n);
});

function renderLista(){
  listaEl.innerHTML = cola.map((t,i)=>`<li class="${i===current?'on':''}" onclick="play(${i})">${t.title} - ${t.channel}</li>`).join('');
}
btnBuscar.addEventListener('click', buscar);
btnPlay.addEventListener('click', ()=> audio.paused ? audio.play() : audio.pause());
window.play = play; // para onclick
