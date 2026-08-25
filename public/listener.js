(() => {
  'use strict';

  const elStation = document.getElementById('station');
  const elTitle = document.getElementById('title');
  const elArtist = document.getElementById('artist');
  const elStatus = document.getElementById('status');
  const elCover = document.getElementById('cover');
  const btnEnter = document.getElementById('enter');
  const card = document.querySelector('.card');
  const dot = document.getElementById('dot');

  let player = null;
  let ready = false;
  let currentId = '';
  let currentPlaying = false;
  let userStarted = false;
  let lastData = { id: '', title: '', artist: '', thumbnail: '', playing: false, station: '' };

  const YT_READY = Promise.race([
    new Promise((resolve) => { window.__ytListenReady = resolve; }),
    new Promise((resolve) => setTimeout(() => resolve(false), 10000)),
  ]);
  window.onYouTubeIframeAPIReady = () => { if (window.__ytListenReady) window.__ytListenReady(true); };

  const startPlayer = () => {
    if (player) return;
    player = new YT.Player('yt-host', {
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, fs: 0, playsinline: 1 },
      events: {
        onReady: () => { ready = true; applyState(); },
        onStateChange: (e) => {
          const S = (window.YT && window.YT.PlayerState) || {};
          if (e.data === S.PLAYING) { currentPlaying = true; userStarted = true; btnEnter.style.display = 'none'; elStatus.textContent = ''; }
          else if (e.data === S.PAUSED) currentPlaying = false;
        },
        onError: () => { elStatus.textContent = 'Este tema está bloqueado por YouTube; esperando el siguiente…'; },
      },
    });
  };

  // Refleja el estado del DJ: precarga el video y reproduce/pausa según corresponda.
  // El play se intenta en cada consulta (reproducción automática si el navegador lo permite).
  const applyState = () => {
    if (!ready || !player) return;
    if (lastData.id && lastData.id !== currentId) {
      currentId = lastData.id;
      try { player.cueVideoById(lastData.id); } catch (e) {}
    }
    if (lastData.playing && !currentPlaying) { try { player.playVideo(); } catch (e) {} }
    else if (!lastData.playing && currentPlaying) { try { player.pauseVideo(); } catch (e) {} currentPlaying = false; }
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
      if (d.id) elStatus.textContent = '';
      else elStatus.textContent = '';
      applyState();
    } catch (e) {
      if (dot) dot.className = 'dot off';
      elStatus.textContent = 'Sin conexión con la radio…';
    }
  };

  const enter = () => {
    if (userStarted) return;
    userStarted = true;
    btnEnter.style.display = 'none';
    elStatus.textContent = 'Conectando a la radio…';
    if (ready && currentId) { try { player.playVideo(); } catch (e) {} currentPlaying = true; }
    applyState();
  };

  btnEnter.addEventListener('click', enter);
  if (card) card.addEventListener('click', () => { if (!userStarted) enter(); });

  YT_READY.then((ok) => { if (ok) startPlayer(); else elStatus.textContent = 'No se pudo cargar el reproductor de YouTube'; });
  setInterval(poll, 1500);
  poll();
})();
