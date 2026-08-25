(() => {
  'use strict';

  const elStation = document.getElementById('station');
  const elTitle = document.getElementById('title');
  const elArtist = document.getElementById('artist');
  const elStatus = document.getElementById('status');
  const elCover = document.getElementById('cover');
  const btnEnter = document.getElementById('enter');

  let player = null;
  let ready = false;
  let currentId = '';
  let currentPlaying = false;
  let userStarted = false;
  let lastData = { id: '', title: '', artist: '', thumbnail: '', playing: false, station: '' };

  const YT_READY = Promise.race([
    new Promise((resolve) => { window.__ytListenReady = resolve; }),
    new Promise((resolve) => setTimeout(() => resolve(false), 12000)),
  ]);
  window.onYouTubeIframeAPIReady = () => { if (window.__ytListenReady) window.__ytListenReady(true); };

  const startPlayer = () => {
    if (player) return;
    player = new YT.Player('yt-host', {
      playerVars: { autoplay: 0, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, fs: 0, playsinline: 1 },
      events: {
        onReady: () => { ready = true; applyToPlayer(); },
        onStateChange: (e) => {
          const S = (window.YT && window.YT.PlayerState) || {};
          if (e.data === S.PLAYING) currentPlaying = true;
          else if (e.data === S.PAUSED) currentPlaying = false;
        },
        onError: () => { elStatus.textContent = 'Este tema está bloqueado por YouTube; esperando el siguiente…'; },
      },
    });
  };

  const applyToPlayer = () => {
    if (!ready || !player || !userStarted || !lastData.id) return;
    if (lastData.id !== currentId) {
      currentId = lastData.id;
      try { player.loadVideoById(lastData.id); } catch (e) {}
    }
    try {
      if (lastData.playing) player.playVideo();
      else player.pauseVideo();
    } catch (e) {}
    currentPlaying = !!lastData.playing;
  };

  const render = (d) => {
    elStation.textContent = (d.station && d.station.trim()) ? d.station.toUpperCase() : 'RADIO EN VIVO';
    if (d.id) {
      elTitle.textContent = d.title || 'Sin título';
      elArtist.textContent = d.artist || '';
      if (d.thumbnail) { elCover.src = d.thumbnail; elCover.style.display = 'block'; }
      else elCover.style.display = 'none';
    } else {
      elTitle.textContent = 'Esperando al DJ…';
      elArtist.textContent = 'El que comparte eligió la música';
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
        elStatus.textContent = userStarted ? '' : 'Presiona ▶ para escuchar la radio';
        if (userStarted && (d.id !== currentId || d.playing !== currentPlaying)) applyToPlayer();
      } else {
        elStatus.textContent = 'Conéctate para escuchar la radio';
      }
    } catch (e) {
      elStatus.textContent = 'Sin conexión con la radio…';
    }
  };

  btnEnter.addEventListener('click', () => {
    userStarted = true;
    btnEnter.style.display = 'none';
    elStatus.textContent = 'Conectando a la radio…';
    if (ready && lastData.id) applyToPlayer();
  });

  YT_READY.then((ok) => { if (ok) startPlayer(); else elStatus.textContent = 'No se pudo cargar el reproductor de YouTube'; });
  setInterval(poll, 2500);
  poll();
})();
