(() => {
  'use strict';

  // ===== NEON MUSIC ESCUCHA · Receptor puro del stream centralizado =====
  // Solo sintoniza /radio/stream (lo que suena en la radio). Sin busquedas,
  // sin YouTube, sin API. Reconexion automatica cada 3s ante cortes.

  const $ = (sel) => document.querySelector(sel);
  const audioEl = $('#audio');
  const playBtn = $('#btn-play');
  const volEl = $('#volume');
  const dotEl = $('#dot');
  const vinyl = $('#vinyl');
  const cover = $('#cover');
  const titleEl = $('#song-title');
  const artistEl = $('#song-artist');
  const statusEl = $('#status');

  let stallTimer = null;
  let isPlaying = false;
  let userPaused = false;
  let metaTimer = null;

  const setStatus = (m) => { if (statusEl) statusEl.textContent = m || ''; };
  const setDot = (on) => { if (dotEl) dotEl.className = 'dot ' + (on ? 'on' : 'off'); };

  function connectStream() {
    try { audioEl.pause(); } catch (e) {}
    audioEl.src = '/radio/stream?_t=' + Date.now(); // cache-bust
    audioEl.load();
    setStatus('Sintonizando la estacion...');
    audioEl.play().then(() => {
      isPlaying = true;
      if (playBtn) playBtn.textContent = '\u23F8';
      setDot(true);
      if (vinyl) vinyl.classList.add('playing');
      setStatus('En vivo \u00b7 NEON MUSIC');
    }).catch(() => {
      // Autoplay bloqueado: queda listo, el primer toque en Play lo libera
      setStatus('Toca \u25B6 para sintonizar');
      scheduleReconnect();
    });
  }

  function scheduleReconnect() {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      if (userPaused) return;
      setStatus('Reconectando senal...');
      try { audioEl.pause(); } catch (e) {}
      audioEl.removeAttribute('src');
      audioEl.load();
      setTimeout(connectStream, 300);
    }, 3000);
  }

  // ---- eventos de red del elemento de audio ----
  audioEl.addEventListener('stalled', () => { if (!userPaused) { setStatus('Senal debil...'); scheduleReconnect(); } });
  audioEl.addEventListener('waiting', () => { if (!userPaused) { setStatus('Buffering...'); scheduleReconnect(); } });
  audioEl.addEventListener('error', () => { if (!userPaused) scheduleReconnect(); });
  audioEl.addEventListener('playing', () => {
    clearTimeout(stallTimer);
    isPlaying = true;
    setDot(true);
    if (playBtn) playBtn.textContent = '\u23F8';
    if (vinyl) vinyl.classList.add('playing');
    setStatus('En vivo \u00b7 NEON MUSIC');
  });
  audioEl.addEventListener('canplay', () => clearTimeout(stallTimer));
  audioEl.addEventListener('pause', () => {
    if (!userPaused) scheduleReconnect(); // pausa externa (sistema/red): reconecta
  });

  // ---- boton Play/Pausa ----
  if (playBtn) playBtn.addEventListener('click', () => {
    if (isPlaying) {
      userPaused = true;
      try { audioEl.pause(); } catch (e) {}
      isPlaying = false;
      clearTimeout(stallTimer);
      if (playBtn) playBtn.textContent = '\u25B6';
      setDot(false);
      if (vinyl) vinyl.classList.remove('playing');
      setStatus('Radio pausada');
    } else {
      userPaused = false;
      connectStream();
    }
  });

  // ---- volumen ----
  if (volEl) volEl.addEventListener('input', () => {
    audioEl.volume = (parseInt(volEl.value, 10) || 0) / 100;
    if (volEl.style) volEl.style.setProperty('--pct', volEl.value + '%');
  });

  // ---- metadatos de lo que suena (solo lectura, sin buscar nada) ----
  async function refreshMeta() {
    try {
      const r = await fetch('/api/nowplaying', { cache: 'no-store' });
      const d = await r.json();
      if (d && d.id && d.title) {
        titleEl.textContent = d.title || 'NEON MUSIC';
        artistEl.textContent = d.artist || '';
        if (d.thumbnail) { cover.src = d.thumbnail; cover.style.display = 'block'; }
      } else {
        titleEl.textContent = 'NEON MUSIC';
        artistEl.textContent = 'Transmision de respaldo';
        cover.style.display = 'none';
      }
    } catch (e) { /* sin metadatos no pasa nada */ }
  }

  // ---- arranque: autoplay automatico + latidos ----
  connectStream();
  setTimeout(connectStream, 700); // segundo intento temprano
  window.addEventListener('pointerdown', () => { if (!isPlaying && !userPaused) connectStream(); }, { once: true });
  setInterval(refreshMeta, 4000);
  refreshMeta();
})();
