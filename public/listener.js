(() => {
  'use strict';

  const elStation = document.getElementById('station');
  const elTitle = document.getElementById('title');
  const elArtist = document.getElementById('artist');
  const elStatus = document.getElementById('status');
  const elCover = document.getElementById('cover');
  const btnEnter = document.getElementById('enter');
  const card = document.querySelector('.card');

  let player = null;
  let ready = false;
  let currentId = '';
  let currentPlaying = false;
  let userStarted = false;
  let lastData = { id: '', title: '', artist: '', thumbnail: '', playing: false, station: '' };

  const YT_READY = Promise.race([
    new Promise((resolve) => { window.__ytListenReady = resolve; }),
    new Promise((resolve) => setTimeout(() => resolve(false), 8000)),
  ]);
  window.onYouTubeIframeAPIReady = () => { if (window.__ytListenReady) window.__ytListenReady(true); };

  const startPlayer = () => {
    if (player) return;
    player = new YT.Player('yt-host', {
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, fs: 0, playsinline: 1 },
      events: {
        onReady: () => {
          ready = true;
          cueCurrent();
          if (lastData.playing) { try { player.playVideo(); } catch (e) {} } // intento automático (mismo navegador del DJ)
        },
        onStateChange: (e) => {
          const S = (window.YT && window.YT.PlayerState) || {};
          if (e.data === S.PLAYING) { currentPlaying = true; userStarted = true; btnEnter.style.display = 'none'; }
          else if (e.data === S.PAUSED) currentPlaying = false;
        },
        onError: () => { elStatus.textContent = 'Este tema está bloqueado por YouTube; esperando el siguiente…'; },
      },
    });
  };

  // Precarga el video en cuanto sabemos cuál es (sin sonar), para que el tap sea instantáneo
  const cueCurrent = () => {
    if (!ready || !player || !lastData.id) return;
    if (lastData.id !== currentId) {
      currentId = lastData.id;
      try { player.cueVideoById(lastData.id); } catch (e) {}
    }
  };

  // Sigue al DJ: reproduce/pausa según el estado compartido (solo si el amigo ya inició)
  const syncPlay = () => {
    if (!ready || !player || !userStarted) return;
    if (lastData.playing && !currentPlaying) { try { player.playVideo(); } catch (e) {} currentPlaying = true; }
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
      lastData = d || lastData;
      render(d);
      if (d.id) {
        elStatus.textContent = '';
        cueCurrent();           // precarga aunque aún no haya tap
        if (userStarted) syncPlay();
      } else {
        elStatus.textContent = '';
      }
    } catch (e) {
      elStatus.textContent = 'Sin conexión con la radio…';
    }
  };

  const enter = () => {
    if (userStarted) return;
    userStarted = true;
    btnEnter.style.display = 'none';
    elStatus.textContent = 'Conectando a la radio…';
    // ya está precargado: arranca de inmediato si el DJ está sonando
    if (ready && currentId) { try { player.playVideo(); } catch (e) {} currentPlaying = true; }
    syncPlay();
  };

  btnEnter.addEventListener('click', enter);
  // un solo toque en cualquier parte de la tarjeta inicia la escucha
  if (card) card.addEventListener('click', () => { if (!userStarted) enter(); });

  YT_READY.then((ok) => { if (ok) startPlayer(); else elStatus.textContent = 'No se pudo cargar el reproductor de YouTube'; });
  setInterval(poll, 1500);
  poll();
})();
