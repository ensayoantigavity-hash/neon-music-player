(() => {
  'use strict';

  const elStation = document.getElementById('station');
  const elTitle = document.getElementById('title');
  const elArtist = document.getElementById('artist');
  const elStatus = document.getElementById('status');
  const elCover = document.getElementById('cover');
  const playBtn = document.getElementById('playBtn');
  const vol = document.getElementById('vol');
  const dot = document.getElementById('dot');
  const card = document.querySelector('.card');

  let player = null;
  let ready = false;
  let currentId = '';
  let currentPlaying = false;
  let localPaused = false; // el amigo pausó manualmente
  let lastData = { id: '', title: '', artist: '', thumbnail: '', playing: false, station: '' };

  const YT_READY = Promise.race([
    new Promise((resolve) => { window.__ytListenReady = resolve; }),
    new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
  ]);
  window.onYouTubeIframeAPIReady = () => { if (window.__ytListenReady) window.__ytListenReady(true); };

  const setIcon = () => { playBtn.textContent = currentPlaying ? '⏸' : '▶'; };

  const startPlayer = () => {
    if (player) return;
    player = new YT.Player('yt-host', {
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, fs: 0, playsinline: 1 },
      events: {
        onReady: () => { ready = true; try { player.setVolume(vol.value); } catch (e) {} applyState(); },
        onStateChange: (e) => {
          const S = (window.YT && window.YT.PlayerState) || {};
          if (e.data === S.PLAYING) { currentPlaying = true; localPaused = false; setIcon(); elStatus.textContent = ''; }
          else if (e.data === S.PAUSED) { currentPlaying = false; setIcon(); }
        },
        onError: () => { elStatus.textContent = 'Este tema está bloqueado por YouTube; esperando el siguiente…'; },
      },
    });
  };

  // Sigue al master: cambia de tema y obedece play/pausa del DJ.
  // El amigo puede pausar (localPaused) o bajar el volumen sin perder la conexión.
  const applyState = () => {
    if (!ready || !player) return;
    if (lastData.id && lastData.id !== currentId) {
      currentId = lastData.id;
      localPaused = false;
      try { player.cueVideoById(lastData.id); } catch (e) {}
      playBtn.disabled = false; vol.disabled = false;
    }
    if (!lastData.id) { playBtn.disabled = true; vol.disabled = true; return; }
    if (lastData.playing && !currentPlaying && !localPaused) { try { player.playVideo(); } catch (e) {} }
    else if (!lastData.playing && currentPlaying) { try { player.pauseVideo(); } catch (e) {} currentPlaying = false; setIcon(); }
  };

  const render = (d) => {
    elStation.textContent = (d.station && d.station.trim()) ? d.station.toUpperCase() : 'NEON MUSIC';
    if (d.id) {
      elTitle.textContent = d.title || 'NEON MUSIC';
      elArtist.textContent = d.artist || '';
      if (d.thumbnail) { elCover.src = d.thumbnail; elCover.style.display = 'block'; }
      else elCover.style.display = 'none';
    } else {
      elTitle.textContent = 'NEON MUSIC';
      elArtist.textContent = '';
      elCover.style.display = 'none';
    }
  };

  const poll = async () => {
    try {
      const r = await fetch('/api/nowplaying');
      const d = await r.json();
      if (dot) dot.className = 'dot on';
      lastData = d || lastData;
      render(d);
      applyState();
    } catch (e) {
      if (dot) dot.className = 'dot off';
      elStatus.textContent = 'Sin conexión con la radio…';
    }
  };

  playBtn.addEventListener('click', () => {
    if (!ready || !player || !currentId) return;
    if (currentPlaying) { try { player.pauseVideo(); } catch (e) {} localPaused = true; }
    else { try { player.playVideo(); } catch (e) {} localPaused = false; }
  });

  vol.addEventListener('input', () => { if (player && player.setVolume) { try { player.setVolume(vol.value); } catch (e) {} } });

  YT_READY.then((ok) => { if (ok) startPlayer(); else elStatus.textContent = 'No se pudo cargar el reproductor de YouTube'; });
  setInterval(poll, 1500);
  poll();
})();
