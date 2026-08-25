(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);

  const audio = $('#audio');
  // CORS: permite que Web Audio (AnalyserNode) lea las frecuencias del stream del proxy
  // sin taint; debe fijarse ANTES de cargar cualquier src.
  audio.crossOrigin = 'anonymous';
  const form = $('#search-form');
  const input = $('#query');
  const statusText = $('#status-text');
  const RELEASE = true; // true = producción (sin logs de depuración). Poner false para depurar.
  const dbg = RELEASE ? () => {} : (msg) => { try { console.log(msg); } catch (ignored) { } };
  // ---------- puente con la app Android (Now Playing, pantalla encendida) ----------
  const native = () => { try { return window.NeonNative || null; } catch (ignored) { return null; } };
  const pushMedia = (track) => {
    try {
      const n = native(); if (!n) return;
      n.setMedia(
        (track && track.title) || songTitle.textContent,
        (track && (track.channel || track.artist)) || songArtist.textContent,
        'NEON MUSIC',
        track && track.duration ? Math.round(track.duration * 1000) : 0,
        track && track.thumbnail ? track.thumbnail : ''
      );
    } catch (ignored) { }
  };
  const pushPlaying = (playing) => {
    try { const n = native(); if (n) n.setPlaying(!!playing); } catch (ignored) { }
  };
  const pushPosition = () => {
    try {
      if (nativeMode) return; // la posición real la sincroniza startNativePoll (MediaPlayer)
      const n = native();
      if (n) n.setPosition(Math.round(audio.currentTime * 1000));
    } catch (ignored) { }
  };
  // Sesión de medios del navegador (móviles sin la app nativa: barra de control del sistema)
  const mss = (typeof navigator !== 'undefined' && 'mediaSession' in navigator) ? navigator.mediaSession : null;
  const updateMss = (playing) => {
    if (!mss) return;
    try {
      mss.playbackState = playing ? 'playing' : 'paused';
      mss.metadata = new MediaMetadata({
        title: songTitle.textContent,
        artist: songArtist.textContent,
        album: 'NEON MUSIC',
      });
    } catch (ignored) { }
  };
  if (mss) {
    try {
      mss.setActionHandler('play', () => audio.play());
      mss.setActionHandler('pause', () => audio.pause());
      mss.setActionHandler('previoustrack', () => { if (!playingFile) play(current - 1); });
      mss.setActionHandler('nexttrack', () => { if (!playingFile) goNext(); });
      mss.setActionHandler('seekto', (d) => {
        if (d && Number.isFinite(d.seekTime)) audio.currentTime = d.seekTime;
      });
    } catch (ignored) { }
  }
  window.__mediaCmd = (c) => {
    if (!c) return;
    if (c === 'play') {
      playIntent = true;
      const n = native();
      if (nativeMode && n) n.setPlaying(true);
      else if (audio.paused) audio.play();
    }
    else if (c === 'pause') {
      playIntent = false;
      const n = native();
      if (nativeMode && n) n.setPlaying(false);
      else if (!audio.paused) audio.pause();
    }
    else if (c === 'next') { if (!playingFile) goNext(); }
    else if (c === 'prev') { if (!playingFile) play(current - 1); }
    else if (c.indexOf('seek:') === 0) {
      const t = parseFloat(c.slice(5));
      if (Number.isFinite(t) && t >= 0) {
        const n = native();
        if (nativeMode && n) n.seekTo(t);
        else audio.currentTime = t / 1000;
      }
    }
    else if (c === 'repeat') {
      loopMode = (loopMode + 1) % 3;
      btnRepeat.classList.toggle('on', loopMode !== 0);
      btnRepeat.textContent = loopMode === 2 ? '🔂' : '🔁';
      btnRepeat.title = loopMode === 2 ? 'Repetir esta canción' : loopMode === 1 ? 'Repetir la lista' : 'Repetir: desactivado';
      showToast(loopMode === 2 ? '🔂 Repetir esta canción: activado' : loopMode === 1 ? '🔁 Repetir la lista: activado' : 'Repetir: desactivado');
    }
    else if (c === 'repeat:off') {
      loopMode = 0;
      btnRepeat.classList.toggle('on', false);
      btnRepeat.textContent = '🔁';
      btnRepeat.title = 'Repetir: desactivado';
    }
    else if (c === 'shuffle') {
      shuffleOn = !shuffleOn;
      btnShuffle.classList.toggle('on', shuffleOn);
      if (shuffleOn) resetShuffle();
      showToast(shuffleOn ? '🔀 Reproducción aleatoria: activada' : '🔀 Reproducción aleatoria: desactivada');
    }
    else if (c === 'shuffle:off') {
      shuffleOn = false;
      btnShuffle.classList.toggle('on', false);
      showToast('🔀 Reproducción aleatoria: desactivada');
    }
    else if (c === 'autonext:on') {
      autonext.checked = true;
      showToast('▶ Reproducción continua: activada');
    }
    else if (c === 'autonext:off') {
      autonext.checked = false;
      showToast('▶ Reproducción continua: desactivada');
    }
  };
  // Intento profundo desde asistentes (Bixby/Gemini) o desde el lanzador: neon://buscar?q=…
  window.__appIntent = (q) => {
    try {
      if (!q || typeof q !== 'string' || !q.trim()) return;
      const query = q.trim();
      searchType = 'track';
      document.querySelectorAll('#search-type .st-btn').forEach((b) => {
        b.classList.toggle('active', b.dataset.type === 'track');
      });
      input.value = query;
      ensureAudioGraph();
      doSearch(query);
    } catch (ignored) { }
  };
  // Eventos del reproductor nativo (APK): los emite PlaybackService hacia la web.
  window.__nativeEvent = (ev, data) => {
    if (ev === 'wave') {
      if (Array.isArray(data) && data.length) {
        liveBins = data;
        liveTime = nowMs();
      }
      return;
    }
    if (ev === 'playing') {
      nativePlaying = true;
      playIntent = true;
      retried.clear();
      modeStep = MODE_SEQ[0];
      consecFails = 0; // un tema empezó bien: reiniciar el contador de fallos encadenados
      if (data && data === lastEndedId) lastEndedId = ''; // el mismo tema se vuelve a reproducir
      syncNativeTrack(data); // si el servicio avanzó solo, sincronizar tema y UI
      pushNativeQueue();
      setPlaying({ playing: true });
      pushPlaying(true);
      updateMss(true);
      startNativePoll();
      startWave();
      updateLyrics(true);
    } else if (ev === 'paused') {
      nativePlaying = false;
      playIntent = false;
      setPlaying({ playing: false });
      pushPlaying(false);
      updateMss(false);
      stopNativePoll();
      stopWave();
    } else if (ev === 'ended') {
      nativePlaying = false;
      stopNativePoll();
      stopWave();
      if (data && data === lastEndedId) return; // 'ended' obsoleto (el watchdog ya avanzó)
      lastEndedId = data || '';
      if (nativeQueueActive) {
        // el servicio ya decidió: si iba a seguir, llegará 'playing'; aquí solo UI de parada
        setPlaying({ playing: false });
        pushPlaying(false);
        updateMss(false);
        return;
      }
      handleNativeEnded();
    } else if (ev === 'error') {
      nativePlaying = false;
      stopNativePoll();
      stopWave();
      handleNativeError();
    }
  };
  const handleNativeEnded = () => {
    clearStall();
    stopAgc();
    setPlaying({ playing: false });
    pushPlaying(false);
    updateMss(false);
    if (!playingFile) {
      if (loopMode === 2) {
        lastEndedId = ''; // se re-reproduce el mismo tema: permitir su próximo 'ended'
        const n = native();
        if (n) { n.seekTo(0); n.setPlaying(true); }
        return;
      }
      if (autonext.checked && queue().length) {
        const n = nextIndex();
        if (n >= 0) { play(n); return; }
      }
    }
    setPlaying({ playing: false });
  };
  const handleNativeError = () => {
    clearStall();
    stopAgc();
    const track = playingFile ? null : listOf(activeSrc)[current];
    dbg(`✖ error nativo · ${track ? track.id : 'archivo'}`);
    try { const n = native(); if (n && n.log) n.log('native error · ' + (track ? track.id : 'archivo')); } catch (ignored) { }
    setPlaying({ playing: false });
    pushPlaying(false);
    updateMss(false);
    if (playingFile) {
      statusText.textContent = 'error de archivo';
      return;
    }
    if (track && !retried.has(track.id)) {
      const nm = nextMode();
      if (nm !== null) {
        retried.add(track.id);
        modeStep = nm;
        dbg(`↻ modo ${modeStep} (falló el anterior)`);
        setTimeout(() => play(current), 250);
        return;
      }
    }
    if (track && (track._fr || 0) < 2) {
      track._fr = (track._fr || 0) + 1;
      modeStep = MODE_SEQ[0];
      retried.clear();
      setTimeout(() => play(current), 250);
      return;
    }
    consecFails++;
    // sin tormenta de saltos: máximo 3 temas seguidos con fallo, con espera real, y luego se
    // para limpio con mensaje claro (el contador se reinicia en cuanto un tema suena)
    if (!playingFile && consecFails <= 3 && autonext.checked && queue().length) {
      const n = nextIndex();
      setTimeout(() => { if (n >= 0) play(n); }, 1500);
    } else {
      setPlaying({ playing: false });
      consecFails = 0;
      statusText.textContent = 'no se pudo reproducir · ' + ((track && track.title) || 'tema');
      warnProtected();
      showToast('⚠ No se pudo reproducir. Revisa tu conexión a Internet.', true);
    }
  };
  const engineDot = $('#engine-status');

  const vinyl = $('#vinyl');
  const spectrum = $('#spectrum');
  const songTitle = $('#song-title');
  const songArtist = $('#song-artist');
  const timeCur = $('#time-cur');
  const timeTotal = $('#time-total');
  const seek = $('#seek');
  const volume = $('#volume');
  const liveBadge = $('#live-badge');
  const durBadge = $('#dur-badge');

  const btnPlay = $('#btn-play');
  const btnPrev = $('#btn-prev');
  const btnNext = $('#btn-next');
  const btnDownload = $('#btn-download');
  const btnLyrics = $('#btn-lyrics');
  const btnRepeat = $('#btn-repeat');
  const lyricsView = $('#lyrics-view');
  const autonext = $('#autonext');
  const toast = $('#toast');

  // ---------- fondo adaptativo (paleta de la carátula) ----------
  const ambLayers = [document.querySelector('.amb-i1'), document.querySelector('.amb-i2')];
  let ambAct = 0;
  // paleta actual del fondo adaptativo (la comparte el ecualizador LED para que las
  // barras sigan los cambios de tono de la interfaz cuando cambia la carátula)
  let currentAmbPalette = { c1: [193, 255, 38], c2: [243, 186, 47] };

  const panelResults = $('#results');
  const panelPlaylist = $('#playlist');
  const panelDownloads = $('#downloads');
  const playlistCount = $('#playlist-count');
  const qlbar = $('#qlbar');
  const btnClearPlaylist = $('#btn-clear-playlist');
  const btnRefreshDownloads = $('#btn-refresh-downloads');

  const wave = $('#wave');

  // ---------- estado ----------
  const PLAYLIST_KEY = 'neon_playlist';
  let results = [];
  let plist = JSON.parse(localStorage.getItem(PLAYLIST_KEY) || '[]');
  let lastQuery = '';
  let current = -1;
  let activeSrc = 'results';
  let playingFile = false;
  let lastFiles = [];
  let playingFileName = '';
  let retried = new Set();
  const inApk = !!(native() && typeof window !== 'undefined' && window.NeonNative);
  // El proxy Java (modo 0) traduce rangos abiertos y sirve por chunks, igual que el
  // servidor Node: es el modo fiable en la APK. Raw/direct solo como respaldo.
  const MODE_SEQ = inApk ? [0, 2, 1] : [0, 1, 2];
  let modeStep = MODE_SEQ[0];
  let stallTimer = null;
  // intención de reproducción (no se limpia si el sistema pausa al ir a segundo plano)
  let playIntent = false;
  // Reproducción nativa (APK): el audio lo toca MediaPlayer en PlaybackService, no el WebView.
  // Así la música no se pausa ni se calla al apagar la pantalla o ir a segundo plano, y la
  // Now Bar muestra la carátula del tema.
  const nativeMode = inApk;
  let nativePlaying = false;
  let nativePollTimer = null;
  let nativeWaveRaf = 0;
  let nativeDurMs = 0; // respaldo si MediaPlayer no reporta duración
  const nowSec = () => {
    if (nativeMode && nativePlaying) {
      try {
        const n = native();
        if (n) {
          const ms = n.getPosition();
          if (Number.isFinite(ms) && ms >= 0) return ms / 1000;
        }
      } catch (ignored) { }
    }
    return audio.currentTime || 0;
  };
  const startNativePoll = () => {
    if (nativePollTimer) return;
    nativePollTimer = setInterval(() => {
      try {
        const n = native();
        if (!n || !nativePlaying) return;
        const ms = n.getPosition();
        const durMs = n.getDuration();
        if (!Number.isFinite(ms) || ms < 0) return;
        const s = ms / 1000;
        const d = (Number.isFinite(durMs) && durMs > 0) ? durMs / 1000 : (nativeDurMs > 0 ? nativeDurMs / 1000 : 0);
        if (d > 0) {
          if (!seek.matches(':active')) seek.value = (s / d) * 1000;
          seek.style.setProperty('--pct', ((s / d) * 100).toFixed(1) + '%');
          timeTotal.textContent = fmt(d);
          if (d - s <= 15) warmNext();
        }
        timeCur.textContent = fmt(s);
        n.setPosition(ms);
        updateLyrics();
        try {
          // watchdog: si la posición se congela en los últimos ~2s y no llega 'ended',
          // forzar la transición (auto-next a prueba de fallos de onCompletion)
          if (d > 0 && s >= d - 2) {
            const t = listOf(activeSrc)[current];
            const tid = (t && t.id) || '';
            if (endWatchId === tid && s === endWatchPos) {
              if (endWatchAt === 0) endWatchAt = nowMs();
              else if (nowMs() - endWatchAt >= 6000) {
                endWatchId = ''; endWatchPos = -1; endWatchAt = 0;
                dbg('fin de tema no entregado → avanzando');
                if (nativeMode && nativeQueueActive) {
                  // el servicio avanza solo (stallWatch nativo); no tocar la cola desde aquí
                } else {
                  lastEndedId = tid;
                  handleNativeEnded();
                }
                return;
              }
            } else {
              endWatchId = tid; endWatchPos = s; endWatchAt = 0;
            }
          } else {
            endWatchId = ''; endWatchPos = -1; endWatchAt = 0;
          }
        } catch (ignored) { }
      } catch (ignored) { }
    }, 500);
  };
  const stopNativePoll = () => {
    if (nativePollTimer) { clearInterval(nativePollTimer); nativePollTimer = null; }
  };
  const nextMode = () => {
    const i = MODE_SEQ.indexOf(modeStep);
    return i >= 0 && i < MODE_SEQ.length - 1 ? MODE_SEQ[i + 1] : null;
  };
  const clearStall = () => { if (stallTimer) { clearTimeout(stallTimer); stallTimer = null; } };
  // Watchdog anti-colgado: si tras 20s no hay datos (ni src ni readyState >= 2) y no está en
  // pausa intencional, fuerza el fallback de modo / re-resolución / siguiente pista.
  const armStall = (track) => {
    if (nativeMode) return; // en la APK el watchdog no aplica (eventos nativos)
    clearStall();
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!track) return;
      if (audio.paused && audio.src) return;
      if (audio.readyState >= 2) return;
      dbg('⚠ stall: sin datos en 20s → forzar fallback');
      try { const n = native(); if (n && n.log) n.log('stall watchdog: sin datos'); } catch (ignored) { }
      audio.pause();
      retried.clear();
      const nm = nextMode();
      if (nm !== null) { modeStep = nm; dbg(`↻ watchdog → modo ${modeStep}`); play(current); return; }
      if ((track._fr || 0) < 2) { track._fr = (track._fr || 0) + 1; modeStep = MODE_SEQ[0]; retried.clear(); play(current); return; }
      const n2 = nextIndex();
      if (autonext.checked && n2 >= 0) { play(n2); return; }
      setPlaying({ playing: false });
      statusText.textContent = 'no se pudo reproducir · sin datos';
    }, 20000);
  };
  let loopMode = 0; // 0 = sin repetición, 1 = repetir lista, 2 = repetir una canción
  let shuffleOn = false;
  let shuffleOrder = []; // índices pendientes de reproducir en modo aleatorio
  let autoDjOn = false;            // radio infinita por artista/género/época
  let autoDjSeed = { artist: '', query: '' };
  let autoDjBusy = false;          // evita fetches duplicados en paralelo
  let toastTimer = null;
  let searchMeta = null;
  let searchType = 'track';
  let waveAmp = (parseFloat(localStorage.getItem('neon_waveamp')) || 100) / 100;

  const savePlaylist = () => localStorage.setItem(PLAYLIST_KEY, JSON.stringify(plist));
  const listOf = (name) => (name === 'playlist' ? plist : results);

  // ---------- utilidades ----------
  const fmt = (s) => {
    if (!Number.isFinite(s) || s < 0) return '0:00';
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  };

  const humanSize = (b) => {
    if (!b) return '—';
    if (b > 1e6) return `${(b / 1e6).toFixed(1)} MB`;
    return `${Math.round(b / 1000)} KB`;
  };

  const showToast = (msg, isErr = false) => {
    toast.textContent = msg;
    toast.classList.toggle('err', isErr);
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
  };
  let warnedProtected = false;
  const warnProtected = () => {
    if (warnedProtected) return;
    warnedProtected = true;
    showToast('⚠ Algunas canciones están bloqueadas por YouTube ahora mismo', true);
  };

  const setEngine = (on) => {
    engineDot.textContent = on ? 'motor listo' : 'motor offline';
    engineDot.classList.toggle('on', on);
  };

  const updatePlaylistCount = () => { playlistCount.textContent = plist.length; };

  const updateStatusLine = () => {
    if (activeTab === 'playlist') statusText.textContent = plist.length ? `${plist.length} temas en tu lista` : 'Tu lista está vacía';
    else if (activeTab === 'downloads') statusText.textContent = 'MP3 guardados en Descargas/';
    else statusText.textContent = lastQuery ? `${results.length} resultados · "${lastQuery}"` : 'Sin búsqueda';
  };

  let activeTab = 'results';
  const switchTab = (name) => {
    activeTab = name;
    if (lyricsMode) closeLyrics();
    activeTab = name;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
    [panelResults, panelPlaylist, panelDownloads].forEach((p) => p.classList.remove('active'));
    $(`#${name}`).classList.add('active');
    qlbar.classList.toggle('hidden', name === 'results');
    btnClearPlaylist.style.display = name === 'playlist' ? '' : 'none';
    btnRefreshDownloads.style.display = name === 'downloads' ? '' : 'none';
    updateStatusLine();
    if (name === 'playlist') renderPlaylist();
    if (name === 'downloads') renderDownloads();
  };
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchTab(t.dataset.tab)));

  // ---------- render de listas ----------
  const itemShell = () => {
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="item">
        <img class="th" alt="" loading="lazy" />
        <span class="idx"></span>
        <div class="meta">
          <div class="t">
            <span class="track-title-container">
              <span class="track-title-active">
                <span class="m-item"></span><span class="m-item"></span>
              </span>
            </span>
          </div>
          <div class="a"><span class="a-txt"></span></div>
          <div class="al"></div>
        </div>
        <span class="dur"><span class="dur-txt"></span></span>
        <span class="icn-slot">
          <button class="icn byte-play" title="Reproducir">▶</button>
          <button class="btn-sm byte-dl" title="Descargar en MP3">⬇</button>
          <button class="btn-sm byte-x" title="Añadir a Mi lista">＋</button>
        </span>
      </div>`;
    return li;
  };

  const makeHero = () => {
    if (!searchMeta || !results.length) return null;
    const li = document.createElement('li');
    li.innerHTML = `
      <div class="hero-card">
        <img class="hero-img" alt="" />
        <div class="hero-info">
          <span class="hero-kind"></span>
          <span class="hero-name"></span>
          <span class="hero-sub"></span>
        </div>
      </div>`;
    const img = li.querySelector('.hero-img');
    if (searchMeta.img) { img.src = searchMeta.img; img.onerror = () => { img.style.display = 'none'; }; }
    else img.style.display = 'none';
    li.querySelector('.hero-kind').textContent = searchMeta.kind === 'artist' ? 'ARTISTA'
      : searchMeta.kind === 'playlist' ? 'LISTA DE REPRODUCCIÓN'
      : searchMeta.kind === 'smart' ? 'LO MÁS SONADO'
      : searchMeta.kind === 'track' ? 'CANCIÓN' : `ÁLBUM · ${searchMeta.album || ''}`;
    li.querySelector('.hero-name').textContent = searchMeta.name;
    li.querySelector('.hero-sub').textContent = searchMeta.sub;
    return li;
  };

  const fillItem = (li, track, i) => {
    const th = li.querySelector('.th');
    if (track.thumbnail) { th.src = track.thumbnail; th.onerror = () => { th.style.display = 'none'; }; }
    else th.style.display = 'none';
    li.querySelector('.idx').textContent = String(i + 1).padStart(2, '0');
    const tLine = li.querySelector('.t');
    const titleTxt = track.title || 'Tema sin título';
    tLine.querySelectorAll('.m-item').forEach((m) => {
      m.textContent = titleTxt;
    });
    if (track.official) {
      const b = document.createElement('span');
      b.className = 'of';
      b.textContent = 'OFICIAL';
      tLine.appendChild(b);
    }
    li.querySelector('.a-txt').textContent = (track.artist || track.channel || '').trim();
    const al = li.querySelector('.al');
    if (track.album) {
      al.innerHTML = '<b>Álbum:</b> ' + (track.album.replace(/&/g, '&amp;').replace(/</g, '&lt;'));
    } else {
      al.textContent = '';
    }
    li.querySelector('.dur-txt').textContent = track.duration ? fmt(track.duration) : '—';
  };

  const renderList = (container, list, mode, opts = {}) => {
    container.innerHTML = '';
    if (opts.hero) container.appendChild(opts.hero);
    if (!list.length) {
      container.innerHTML = mode === 'playlist'
        ? '<li class="hint">➕ Toca el botón “＋” junto a cualquier resultado para armar tu propia lista de reproducción.</li>'
        : '<li class="hint">🔍 Escribe el nombre de una canción. Buscaré en toda la web y la reproduciré al instante, sin anuncios.</li>';
      return;
    }
    const frag = document.createDocumentFragment();
    list.forEach((track, i) => {
      const li = itemShell();
      fillItem(li, track, i);
      const active = activeSrc === mode && current === i && !playingFile;
      li.querySelector('.item').classList.toggle('active', active);

      li.addEventListener('click', () => playFrom(i, mode, true));
      li.querySelector('.byte-play').addEventListener('click', (e) => { e.stopPropagation(); playFrom(i, mode, true); });
      li.querySelector('.byte-dl').addEventListener('click', (e) => { e.stopPropagation(); downloadTrack(track, e.currentTarget); });

      const x = li.querySelector('.byte-x');
      if (mode === 'playlist') {
        x.textContent = '🗑';
        x.classList.add('danger');
        x.title = 'Quitar de Mi lista';
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          plist.splice(i, 1);
          savePlaylist();
          renderPlaylist();
updatePlaylistCount();
  feedCatalog(plist); // semilla inicial de búsqueda difusa (tu lista guardada)
          if (activeSrc === 'playlist') renderActiveList();
          showToast('Removida de Mi lista');
        });
      } else {
        x.addEventListener('click', (e) => {
          e.stopPropagation();
          addToPlaylist(track);
        });
      }
      frag.appendChild(li);
    });
    container.appendChild(frag);
  };

  const renderResults = () => renderList(panelResults, results, 'results', { hero: makeHero() });
  const renderPlaylist = () => renderList(panelPlaylist, plist, 'playlist');

  const renderActiveList = () => {
    renderResults();
    renderPlaylist();
  };

  const addToPlaylist = (track) => {
    if (plist.some((t) => t.id === track.id)) { showToast('Ya está en tu lista'); return; }
    plist.push({ id: track.id, title: track.title, artist: track.artist, channel: track.channel, album: track.album, thumbnail: track.thumbnail, duration: track.duration, views: track.views, official: !!track.official });
    catalogPush(track);
    savePlaylist();
    updatePlaylistCount();
    if (activeTab === 'playlist') renderPlaylist();
    showToast('➕ Agregada a Mi lista');
  };

  btnClearPlaylist.addEventListener('click', () => {
    plist = [];
    savePlaylist();
    updatePlaylistCount();
    renderPlaylist();
    if (activeSrc === 'playlist' && playingFile) setPlaying({ playing: false });
    showToast('Lista vaciada');
  });

  // ---------- fondo adaptativo (color predominante de la carátula) ----------
  const DEF1 = [59, 130, 246];
  const DEF2 = [30, 64, 175];
  const DEF_B1 = '#0b1220';
  const DEF_B2 = '#070c17';
  const rgbStr = (a) => a.join(',');
  const hexC = (a) => '#' + a.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  const lumI = (a) => (a[0] + a[1] + a[2]) / 3 / 255;

  // re-tint a un HSL cómodo para el fondo (nunca neón).
  const tuneHSL = (rgbA, sTarget, lTarget) => {
    const [r, g, b] = rgbA.map((v) => v / 255);
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
    const l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
      else if (mx === g) h = ((b - r) / d + 2) / 6;
      else h = ((r - g) / d + 4) / 6;
    }
    s = sTarget;
    const q = lTarget < 0.5 ? lTarget * (1 + s) : lTarget + s - lTarget * s;
    const p = 2 * lTarget - q;
    const h2r = (t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [Math.round(h2r(h + 1 / 3) * 255), Math.round(h2r(h) * 255), Math.round(h2r(h - 1 / 3) * 255)];
  };

  const avgBucket = (b) => [b.r, b.g, b.b].map((v, i) => Math.round(v / b.c));

  // extrae [c1, c2, base1, base2] desde la carátula mediante un canvas (mismo origen vía /api/img).
  const PALETTE_CACHE = {};
  const extractPalette = (src) => {
    if (PALETTE_CACHE[src]) return Promise.resolve(PALETTE_CACHE[src]);
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => {
        try {
          const s = 28;
          const c = document.createElement('canvas');
          c.width = s; c.height = s;
          const g = c.getContext('2d', { willReadFrequently: true });
          g.drawImage(img, 0, 0, s, s);
          let d;
          try { d = g.getImageData(0, 0, s, s).data; } catch { resolve(null); return; }
          const buckets = new Map();
          for (let i = 0; i < d.length; i += 4) {
            const r = d[i], gg = d[i + 1], b = d[i + 2];
            const sat = Math.max(r, gg, b) - Math.min(r, gg, b);
            if (sat < 12) continue;
            if (r + gg + b < 150) continue;
            if (r > 250 && gg > 250 && b > 250) continue;
            const k = (((r >> 4) & 15) << 8) | (((gg >> 4) & 15) << 4) | ((b >> 4) & 15);
            const e = buckets.get(k);
            if (e) { e.c++; e.r += r; e.g += gg; e.b += b; }
            else buckets.set(k, { c: 1, r, g: gg, b });
          }
          if (!buckets.size) { resolve(null); return; }
          const list = [...buckets.values()].sort((x, y) => y.c - x.c);
          const c1 = tuneHSL(avgBucket(list[0]), 0.46, 0.42);
          let pick = list[1] || list[0];
          let best = -1;
          for (const bk of list.slice(1, 6)) {
            const d1 = Math.abs(bk.r - list[0].r) + Math.abs(bk.g - list[0].g) + Math.abs(bk.b - list[0].b);
            if (d1 > best) { best = d1; pick = bk; }
          }
          const c2 = tuneHSL(avgBucket(pick), 0.34, 0.6);
          const p = {
            c1,
            c2,
            base1: hexC(c1.map((v) => Math.round(v * 0.42))),
            base2: hexC(c2.map((v) => Math.round(v * 0.3))),
          };
          PALETTE_CACHE[src] = p;
          resolve(p);
        } catch { resolve(null); }
      };
      img.onerror = () => resolve(null);
      img.src = src;
    });
  };

  const setAmbient = (p) => {
    const c1 = (p && p.c1) ? p.c1 : DEF1;
    const c2 = (p && p.c2) ? p.c2 : DEF2;
    currentAmbPalette.c1 = c1;
    currentAmbPalette.c2 = c2;
    const next = ambAct ^ 1;
    const L = ambLayers[next];
    L.style.setProperty('--amb-a1', rgbStr(c1));
    L.style.setProperty('--amb-a2', rgbStr(c2));
    L.style.setProperty('--amb-base', (p && p.base1) || DEF_B1);
    L.style.setProperty('--amb-base2', (p && p.base2) || DEF_B2);
    L.classList.add('vis-active');
    const O = ambLayers[ambAct];
    O.classList.remove('vis-active');
    ambAct = next;
  };

  // ---------- carátulas: paleta del fondo adaptativo ----------
  const artSrc = (t) => (t && t.thumbnail) ? '/api/img?u=' + encodeURIComponent(t.thumbnail) : '';
  const updateAmbient = (t) => {
    const s = artSrc(t);
    if (!s) { setAmbient(null); return; }
    extractPalette(s).then((p) => setAmbient(p));
  };

  // ---------- precarga activa: resolver el enlace de la siguiente canción ----------
  let warmNextFor = -1;
  // id del tema cuyo 'ended' ya se gestionó (evita transiciones dobles con el watchdog)
  let lastEndedId = '';
  // el servicio tiene una cola espejo y avanza solo (next/auto-next con pantalla apagada)
  let nativeQueueActive = false;
  // watchdog de fin de tema: si la posición queda congelada en los últimos ~2s durante 6s
  // sin que llegue 'ended', fuerza la transición al siguiente (auto-next infalible)
  let endWatchId = '';
  let endWatchPos = -1;
  let endWatchAt = 0;
  const warmNext = () => {
    if (playingFile || !autonext.checked) return;
    const list = listOf(activeSrc);
    if (!list.length) { warmNextFor = -1; return; }
    let n;
    if (shuffleOn) {
      // en aleatorio la próxima es impredecible: calentar un índice pendiente (sin consumir la cola)
      if (!shuffleOrder.length) { warmNextFor = -1; return; }
      n = shuffleOrder[Math.floor(Math.random() * shuffleOrder.length)];
    } else {
      n = current + 1;
      if (n >= list.length) n = loopMode === 1 ? 0 : -1;
      if (n < 0) {
        // cerca del final y Auto-DJ activo: pre-extender la cola para una transición sin hueco
        if (autoDjOn && !autoDjBusy) extendAutoDj();
        warmNextFor = -1; return;
      }
    }
    if (n === current || !list[n] || !list[n].id) { warmNextFor = n; return; }
    const key = list[n].id;
    if (warmNextFor === key) return;
    warmNextFor = key;
    const url = '/api/stream/' + list[n].id
      + (modeStep === 1 ? '?direct=1' : (modeStep === 2 ? '?raw=1' : ''));
    dbg('⏳ pre-cargando siguiente (' + key + ')');
    fetch(url, { headers: { Range: 'bytes=0-0' } })
      .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error('HTTP ' + r.status))))
      .then(() => dbg('✅ siguiente pre-cargada'))
      .catch(() => { warmNextFor = -1; dbg('pre-carga siguiente falló'); });
  };

  // ---------- Auto-DJ: extiende la cola con música del mismo artista / género / época ----------
  // Se llama al terminar una canción (o al acercarse al final) cuando el modo está ON.
  // Añade temas únicos al final de `results` (no altera el índice actual de reproducción).
  const extendAutoDj = async () => {
    if (!autoDjOn) return;
    const seed = (autoDjSeed.artist || autoDjSeed.query || '').trim();
    if (!seed) return;
    if (autoDjBusy) return;
    autoDjBusy = true;
    try {
      const params = new URLSearchParams();
      if (autoDjSeed.artist) params.set('artist', autoDjSeed.artist);
      else params.set('seed', autoDjSeed.query);
      const res = await fetch('/api/autodj?' + params.toString());
      const data = await res.json();
      if (data.error || !Array.isArray(data.results)) return;
      const have = new Set(results.map((r) => r.id));
      let added = 0;
      for (const t of data.results) {
        if (have.has(t.id)) continue;
        have.add(t.id);
        results.push(t);
        added++;
      }
      if (added) {
        if (activeTab === 'results') renderResults();
        pushNativeQueue();
        dbg('📻 Auto-DJ +' + added + ' temas (cola=' + results.length + ')');
      }
    } catch (e) {
      dbg('📻 Auto-DJ err: ' + (e && e.message));
    } finally {
      autoDjBusy = false;
    }
  };

  // ---------- reproduccion ----------
  const playFrom = (index, src = activeSrc, manual = false) => {
    const list = listOf(src);
    if (!list.length) return;
    if (index < 0) index = list.length - 1;
    if (index >= list.length) index = 0;
    if (shuffleOn && manual) resetShuffle();
    activeSrc = src;
    current = index;
    playingFile = false;
    const track = list[current];
    // sembrar el Auto-DJ con la canción que el usuario eligió (estilo/época de esa búsqueda)
    // pero sin pisar una semilla de consulta ya puesta por una búsqueda de género/época
    if (manual && !playingFile && track && !autoDjSeed.query) {
      autoDjSeed = { artist: (track.artist || track.channel || '').trim(), query: lastQuery || (track.title || '').trim() };
    }

    renderActiveList();
    pushNativeQueue();
    ensureAudioGraph();
    if (actx && actx.state === 'suspended') actx.resume();
    const srcUrl = (m) => {
      const qs = [];
      if (m === 1) qs.push('direct=1');
      if (m === 2) qs.push('raw=1');
      if (track._fr) qs.push('r=' + track._fr);
      return '/api/stream/' + track.id + (qs.length ? '?' + qs.join('&') : '');
    };
    // APK: reproducción nativa (MediaPlayer en el servicio). No toca el WebView, así que
    // la música sigue con pantalla apagada / segundo plano y la Now Bar muestra la carátula.
    const ntv = native();
    if (nativeMode && ntv && ntv.playStream) {
      const startNative = (u) => {
        if (!u) { handleNativeError(); return; }
        dbg(`→ native play[${modeStep}] ${u}`);
        nativeDurMs = Math.round((track.duration || 0) * 1000);
        ntv.playStream(u, track.id || '', track.title || '',
          track.channel || track.artist || '', 'NEON MUSIC',
          nativeDurMs, track.thumbnail || '', 0);
        if (ntv.setVolume) ntv.setVolume(volume.value / 100);
      };
      if (modeStep === 2) {
        const ctl = new AbortController();
        const rawTo = setTimeout(() => ctl.abort(), 30000);
        fetch(srcUrl(2), { signal: ctl.signal })
          .then((r) => r.json())
          .then((j) => { clearTimeout(rawTo); startNative(j && j.url ? j.url : null); })
          .catch(() => { clearTimeout(rawTo); handleNativeError(); });
      } else {
        startNative(srcUrl(modeStep));
      }
      setPlaying({ playing: true, track });
      playIntent = true;
      pushMedia(track);
      updateMss(true);
      liveBadge.classList.toggle('hidden', true);
      durBadge.textContent = track.duration ? fmt(track.duration) : '';
      prepareLyrics(track);
      warmNextFor = -1;
      updateAmbient(track);
      return;
    }
    armStall(track);
    let autoPlay = true; // en modo 0/1 el play() se dispara aquí abajo (src ya asignado)
    if (modeStep < 2) {
      const url = srcUrl(modeStep);
      audio.src = url;
      dbg(`→ play[${modeStep}] ${url}`);
      const ctl = new AbortController();
      const probeTo = setTimeout(() => ctl.abort(), 15000);
      fetch(url, { headers: { Range: 'bytes=0-0' }, signal: ctl.signal })
        .then(async (r) => {
          clearTimeout(probeTo);
          const ct = r.headers.get('content-type') || '?';
          if (r.ok) {
            dbg(`probe HTTP ${r.status} · ${ct} · len ${r.headers.get('content-length') || '?'}`);
          } else {
            let msg = `HTTP ${r.status}`;
            try { const j = await r.json(); if (j && j.error) msg = j.error; } catch (ignored) { }
            dbg(`probe ${msg}`);
            try { const n = native(); if (n && n.log) n.log(`probe ${track.id} → ${msg}`); } catch (ignored) { }
            if (r.status === 502) {
              statusText.textContent = lastQuery ? `${results.length} resultados · "${lastQuery}"` : 'Sin búsqueda';
              warnProtected();
            }
          }
        })
        .catch((e) => { clearTimeout(probeTo); dbg('probe fail: ' + e.message); });
    } else {
      // modo 2: https directo de googlevideo, sin proxy/redirección
      autoPlay = false; // el src llega después; el play() lo dispara el handler
      const startPlayback = () => {
        audio.play().then(() => setEngine(true)).catch(() => {
          playIntent = true;
          setPlaying({ playing: false });
          showToast('▶ Toca el botón de reproducir', true);
        });
      };
      dbg(`→ play[2] raw ${srcUrl(2)}`);
      const ctl = new AbortController();
      const rawTo = setTimeout(() => ctl.abort(), 30000);
      const fallbackToProxy = () => { audio.src = srcUrl(0); };
      fetch(srcUrl(2), { signal: ctl.signal })
        .then(async (r) => {
          clearTimeout(rawTo);
          const ct = r.headers.get('content-type') || '';
          if (/application\/json/i.test(ct)) {
            const j = await r.json().catch(() => null);
            if (j && j.url) audio.src = j.url;
            else fallbackToProxy(); // el servidor no devolvió url usable
          } else {
            fallbackToProxy(); // servidor antiguo: /api/stream devuelve bytes, usar proxy
          }
          startPlayback();
        })
        .catch(() => { clearTimeout(rawTo); fallbackToProxy(); startPlayback(); });
    }

    setPlaying({ playing: true, track });
    playIntent = true;
    pushMedia(track);
    updateMss(true);
    liveBadge.classList.toggle('hidden', true);
    durBadge.textContent = track.duration ? fmt(track.duration) : '';
    prepareLyrics(track);
    warmNextFor = -1;
    updateAmbient(track);

    if (autoPlay) {
      audio.play().then(() => setEngine(true)).catch(() => {
        // Autoplay bloqueado por la política del navegador (Safari/WebView): se muestra
        // pausado y se reintenta con el próximo gesto del usuario (resumeAudio).
        playIntent = true;
        setPlaying({ playing: false });
        showToast('▶ Toca el botón de reproducir', true);
      });
    }
  };

  const play = (index) => playFrom(index, activeSrc);

  const playFile = (name) => {
    activeSrc = 'results';
    current = -1;
    playingFile = true;
    playingFileName = name;
    retried.clear();
    pushNativeQueue(); // vacía la cola nativa: los archivos no tienen auto-next nativo
    ensureAudioGraph();
    if (actx && actx.state === 'suspended') actx.resume();
    const ntv = native();
    if (nativeMode && ntv && ntv.playStream) {
      const u = `/dl/${encodeURIComponent(name)}`;
      nativeDurMs = 0;
      ntv.playStream(u, 'dl', name, 'Descargas', 'NEON MUSIC', 0, '', 0);
      if (ntv.setVolume) ntv.setVolume(volume.value / 100);
      setPlaying({ playing: true, track: { title: name, channel: 'Descargas' } });
      pushMedia({ title: name, channel: 'Descargas' });
      updateMss(true);
      liveBadge.classList.toggle('hidden', true);
      durBadge.textContent = '';
      prepareLyrics(null);
      warmNextFor = -1;
      return;
    }
    audio.src = `/dl/${encodeURIComponent(name)}`;
    setPlaying({ playing: true, track: { title: name, channel: 'Descargas' } });
    pushMedia({ title: name, channel: 'Descargas', duration: audio.duration || 0 });
    updateMss(true);
    liveBadge.classList.toggle('hidden', true);
    durBadge.textContent = '';
    prepareLyrics(null);
    warmNextFor = -1;
    audio.play().then(() => setEngine(true)).catch(() => {
      playIntent = true;
      setPlaying({ playing: false });
      showToast('▶ Toca el botón de reproducir', true);
    });
  };

  const setPlaying = ({ playing, track }) => {
    if (track) {
      songTitle.textContent = track.title || 'Tema sin título';
      songArtist.textContent = track.channel || 'Artista desconocido';
      document.title = `${track.title} · NEON MUSIC`;
    }
    vinyl.classList.toggle('playing', playing);
    if (spectrum) spectrum.classList.toggle('playing', playing);
    btnPlay.textContent = playing ? '❚❚' : '▶';
  };

  // ---------- Web Audio (gain estable en 1; el volumen lo manda el slider) ----------
  const hasWebAudio = 'AudioContext' in window || 'webkitAudioContext' in window;

  let actx = null;
  let srcNode = null;
  let analyser = null;
  let gainNode = null;
  let agcBusy = false;
  let graphBuilt = false;

  const buildGraph = () => {
    if (!hasWebAudio || graphBuilt) return;
    if (!actx || actx.state !== 'running') return;
    try {
      srcNode = actx.createMediaElementSource(audio);
      graphBuilt = true; // el MediaElementSource solo puede crearse UNA vez por elemento
      analyser = actx.createAnalyser();
      analyser.fftSize = 2048; // AGC / detección de onset (modo web)
      analyser.smoothingTimeConstant = 0.7;
      gainNode = actx.createGain();
      gainNode.gain.value = 1;
      srcNode.connect(analyser);
      analyser.connect(gainNode);
      gainNode.connect(actx.destination);
    } catch {
      graphBuilt = false;
    }
  };

  const ensureAudioGraph = async () => {
    if (!hasWebAudio || graphBuilt) return;
    if (!actx) {
      try { actx = new (window.AudioContext || window.webkitAudioContext)(); } catch { actx = null; return; }
    }
    if (actx.state === 'suspended') {
      try { await actx.resume(); } catch (ignored) { }
    }
    if (actx.state === 'running') buildGraph();
    else actx = null;
  };

  const resumeAudio = () => {
    if (actx && actx.state === 'suspended') {
      actx.resume().then(() => { if (actx && actx.state === 'running') buildGraph(); }).catch(() => {});
    } else {
      buildGraph();
    }
    // si quedó una reproducción pendiente (autoplay bloqueado), el gesto del usuario la retoma
    if (playIntent && !nativeMode && audio.src && audio.paused) {
      audio.play().catch(() => {});
    }
  };
  document.addEventListener('pointerdown', resumeAudio, true);
  document.addEventListener('touchstart', resumeAudio, true);

  // ---------- VISUALIZADOR DIGITAL PREMIUM (canvas, 60 fps, simulación rítmica) ----------
  // Ecualizador de bloques digitales con reflejo espejo y glow neón. NO usa micrófono ni
  // RECORD_AUDIO: las alturas se generan con ruido matemático (Perlin/Simplex aprox.) +
  // senos/cosenos, moduladas por el estado y el volumen del reproductor. Al pausar, las
  // barras caen por gravedad hasta 0 y el bucle se apaga solo (ahorro de batería).
  const wctx = wave.getContext('2d');
  const WAVE_BARS = 32;
  const vh = new Array(WAVE_BARS).fill(0);   // alturas actuales (0..1)
  const vt = new Array(WAVE_BARS).fill(0);   // objetivos rítmicos (0..1)
  let waveRaf = 0;
  let waveW = 0, waveH = 0, waveDpr = 1;
  let lastT = 0;

  const wHash = (x, y) => {
    let n = Math.imul(x, 374761393) + Math.imul(y, 668265263);
    n = Math.imul(n ^ (n >>> 13), 1274126177);
    n ^= n >>> 16;
    return (n >>> 0) / 4294967295;
  };
  const wSmooth = (t) => t * t * (3 - 2 * t);
  const wNoise = (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const a = wHash(ix, iy), b = wHash(ix + 1, iy), c = wHash(ix, iy + 1), d = wHash(ix + 1, iy + 1);
    const ux = wSmooth(fx), uy = wSmooth(fy);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
  const wFbm = (x, y) =>
    0.5 * wNoise(x, y) + 0.3 * wNoise(x * 2.1, y * 2.1) + 0.2 * wNoise(x * 4.3, y * 4.3);

  const sizeWave = () => {
    try {
      waveDpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = Math.max(1, Math.round(wave.clientWidth * waveDpr));
      const h = Math.max(1, Math.round(wave.clientHeight * waveDpr));
      if (wave.width !== w) wave.width = w;
      if (wave.height !== h) wave.height = h;
      waveW = wave.width; waveH = wave.height;
      lastT = 0;
    } catch (ignored) { }
  };

  const volNow = () => {
    try {
      if (nativeMode) return Math.max(0, Math.min(1, parseFloat(volume.value) / 100 || 0.8));
      return Math.max(0, Math.min(1, audio.volume || 0.8));
    } catch (ignored) { return 0.8; }
  };
  const playingNow = () => (nativeMode ? nativePlaying : !audio.paused);

  const nowMs = () => (window.performance && performance.now ? performance.now() : Date.now());
  let liveBins = null; // magnitudes FFT reales (APK: Visualizer nativo; web: AnalyserNode)
  let liveTime = 0;
  const freqMap = new Uint8Array(2048); // buffer reutilizable para el AnalyserNode (modo web)

  // Estado del "pulso rítmico" y normalización adaptativa del espectro.
  let specNorm = 0.35;   // nivel de referencia del FFT (sigue la dinámica de la canción)
  let bassTarget = 0;    // energía de graves del frame (0..1)
  let bassEnv = 0;       // envolvente suavizada del bajo (ataque rápido / caída media)
  let wavePulse = 1;     // multiplicador rítmico de la amplitud (1 en silencio/pausa)

  // Mapeo del espectro real a las 32 barras con distribución logarítmica (más detalle en
  // graves, como los visualizadores clásicos de getByteFrequencyData): agrupa los bins de
  // frecuencia de cada barra y combina su PICO con el promedio (los golpes se notan al
  // instante). Incluye ganancia adaptativa y un pulso rítmico desde la banda de graves.
  const mapFreq = (bins) => {
    const nb = Math.max(1, bins.length);
    // 1) Normalización adaptativa: referencia al pico global del frame para que la onda se
    //    vea "llena" tanto en temas suaves como fuertes (sin llegar a saturar).
    let peak = 0;
    for (let j = 0; j < nb; j++) { const v = bins[j] || 0; if (v > peak) peak = v; }
    const pk = peak / 255;
    specNorm += (pk - specNorm) * 0.18;
    const gain = Math.max(1.15, Math.min(2.4, 1.05 / Math.max(0.12, specNorm)));
    const boost = (1.25 + volNow() * 0.25) * gain;
    // 2) Energía de graves (≈ hasta 6% del espectro: bajo + bombo) para el pulso rítmico.
    const loHi = Math.max(2, Math.min(nb, Math.ceil(Math.pow(0.06, 1.6) * nb)));
    let loSum = 0;
    for (let j = 0; j < loHi; j++) loSum += bins[j] || 0;
    bassTarget = Math.min(1, (loSum / loHi) / 255 * 2.2);
    // 3) Barras: 50% pico + 50% promedio, con ganancia.
    for (let i = 0; i < WAVE_BARS; i++) {
      const a0 = i / WAVE_BARS;
      const a1 = (i + 1) / WAVE_BARS;
      const lo = Math.max(0, Math.floor(Math.pow(a0, 1.6) * nb));
      const hi = Math.max(lo + 1, Math.ceil(Math.pow(a1, 1.6) * nb));
      let sum = 0, mx = 0;
      for (let j = lo; j < hi; j++) { const v = bins[j] || 0; sum += v; if (v > mx) mx = v; }
      const avg = (sum / (hi - lo)) / 255;
      const pkBar = mx / 255;
      vt[i] = Math.max(0.05, Math.min(1, (0.5 * pkBar + 0.5 * avg) * boost));
    }
  };

  // simulación rítmica (perdida: ruido Perlin/Simplex + senos) cuando no hay datos reales
  const simStep = (t) => {
    const vol = volNow();
    const beat = 0.62 + 0.38 * Math.sin(t * 5.3) * Math.sin(t * 3.1);
    const intensity = 0.32 + 0.68 * vol;
    const base = 0.24 + 0.76 * intensity;
    bassTarget = Math.min(1, base * 1.2);
    for (let i = 0; i < WAVE_BARS; i++) {
      const n = wFbm(i * 0.37 + Math.sin(t * 0.7) * 0.3, t * 1.15);
      const wav = 0.5 + 0.5 * Math.sin(i * 0.9 + t * 3.7);
      vt[i] = Math.pow(Math.max(0, Math.min(1, (0.32 * wav + 0.68 * n) * base * (0.72 + 0.6 * beat))), 1.12);
    }
  };

  const stepWave = (now, dt) => {
    lastT = now;
    const playing = playingNow();
    if (playing) {
      const t = now / 1000;
      const live = nativeMode ? (liveBins && nowMs() - liveTime < 800) : false;
      if (live) {
        mapFreq(liveBins); // APK: FFT real del MediaPlayer vía Visualizer (sin permisos)
      } else if (!nativeMode && analyser && actx && actx.state === 'running' && analyser.frequencyBinCount > 0) {
        try {
          analyser.getByteFrequencyData(freqMap); // web: AnalyserNode real
          mapFreq(freqMap);
        } catch (ignored) {
          simStep(t);
        }
      } else {
        simStep(t);
      }
      const vol = volNow();
      // pulso rítmico: los graves atacan rápido y decaen lento → la onda "late" con el ritmo
      bassEnv += (bassTarget - bassEnv) * Math.min(1, dt * (bassTarget > bassEnv ? 30 : 8));
      wavePulse = 1 + bassEnv * 0.6;
      for (let i = 0; i < WAVE_BARS; i++) {
        const target = vt[i];
        const cur = vh[i];
        vh[i] = target > cur
          ? cur + (target - cur) * Math.min(1, (15 + 8 * vol) * dt)   // ataque rápido (golpe)
          : cur + (target - cur) * Math.min(1, 3.6 * dt);             // caída para marcar el ritmo
      }
    } else {
      bassEnv *= Math.max(0, 1 - 2.5 * dt);
      wavePulse = 1;
      for (let i = 0; i < WAVE_BARS; i++) {
        vt[i] = 0;
        vh[i] = Math.max(0, vh[i] - (1.1 + vh[i] * 1.8) * dt); // gravedad → 0
      }
    }
  };

  // ---------- ECUALIZADOR DIGITAL LED (colores de la interfaz) ----------
  // Barras LED segmentadas con la paleta de NEON MUSIC (lima → oro) mezclada con la
  // paleta de la carátula actual (vía currentAmbPalette), de modo que las barras varían
  // su tono con la animación y los cambios de color de la interfaz. Tonalidad rebajada
  // a propósito: opacidades y brillo contenidos para no competir con la UI.
  const NUM_LED_BARS = 20;
  const MAX_SEGMENTS = 16;

  // Paleta oficial de la app (gradiente del logo: #f2ffc2 → #C1FF26 → #F3BA2F)
  const IFACE_COLORS = [
    [205, 226, 120], // lime pálido (f2ffc2 suavizado)
    [193, 255, 38],  // electric lime  (--lime)
    [230, 255, 160], // lime lite      (--lime-lite)
    [243, 186, 47],  // gold           (--gold)
    [143, 188, 0],   // lime profundo  (--lime-deep)
  ];

  const lerpRgb = (a, b, t) => [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t),
  ];

  // Color de cada barra: paleta de la app + mezcla sutil de la paleta de la carátula +
  // oscilación temporal lenta → las barras "respiran" con los tonos de la interfaz.
  const getLedColor = (u, now) => {
    const p = currentAmbPalette || { c1: [193, 255, 38], c2: [243, 186, 47] };
    const idx = u * (IFACE_COLORS.length - 1);
    const i = Math.min(IFACE_COLORS.length - 1, Math.floor(idx));
    const frac = idx - i;
    const ifColor = lerpRgb(IFACE_COLORS[i], IFACE_COLORS[Math.min(i + 1, IFACE_COLORS.length - 1)], frac);
    const coverColor = lerpRgb(p.c1, p.c2, u);
    const cycle = 0.5 + 0.5 * Math.sin((now || 0) / 9000 * Math.PI * 2);
    const base = lerpRgb(ifColor, coverColor, 0.30 + 0.18 * cycle);
    // tonalidad rebajada (dim) para que las barras no resalten demasiado
    const dim = 0.55 + 0.06 * (0.5 + 0.5 * Math.sin((now || 0) / 13000 * Math.PI * 2 + 1.3));
    return {
      r: Math.min(255, Math.round(base[0] * dim)),
      g: Math.min(255, Math.round(base[1] * dim)),
      b: Math.min(255, Math.round(base[2] * dim)),
    };
  };

  const drawLedBars = (now, dt) => {
    const c = wctx;
    c.clearRect(0, 0, waveW, waveH);
    c.globalCompositeOperation = 'screen';

    const playing = playingNow();
    const baseline = waveH * 0.74;
    const marginX = Math.max(6, waveW * 0.05);
    const availW = waveW - 2 * marginX;
    const slotW = availW / NUM_LED_BARS;
    const barW = Math.max(3, slotW * 0.68);
    const segH = Math.max(3, (baseline * 0.86) / MAX_SEGMENTS);
    const blockH = Math.max(2, segH * 0.76);
    const segGap = Math.max(1, Math.round(segH - blockH));
    const rad = Math.min(2 * waveDpr, blockH / 2);

    for (let b = 0; b < NUM_LED_BARS; b++) {
      const u = b / (NUM_LED_BARS - 1);
      const x = marginX + b * slotW + (slotW - barW) / 2;

      const binStart = Math.floor(b * (WAVE_BARS / NUM_LED_BARS));
      const binEnd = Math.min(WAVE_BARS, Math.ceil((b + 1) * (WAVE_BARS / NUM_LED_BARS)));
      let sum = 0, count = 0;
      for (let k = binStart; k < binEnd; k++) { sum += vh[k] || 0; count++; }
      const binVal = count > 0 ? sum / count : (vh[binStart] || 0);

      const bassBoost = b < 6 ? bassEnv * 0.3 : 0;
      const heightFrac = Math.max(0, Math.min(1, (binVal + bassBoost) * waveAmp));
      let active = Math.round(heightFrac * MAX_SEGMENTS);
      if (playing && active < 1 && heightFrac > 0.02) active = 1;

      const col = getLedColor(u, now);

      // 1) bloques LED principales (opacidad y brillo contenidos)
      for (let s = 0; s < active; s++) {
        const y = baseline - (s + 1) * segH;
        c.globalAlpha = 0.30 + 0.30 * (s / Math.max(1, active - 1));
        c.fillStyle = `rgb(${col.r},${col.g},${col.b})`;
        c.shadowBlur = (s === active - 1 ? 4 : 2) * waveDpr;
        c.shadowColor = c.fillStyle;
        c.beginPath();
        if (c.roundRect) c.roundRect(x, y, barW, blockH, rad);
        else c.rect(x, y, barW, blockH);
        c.fill();
      }

      // 2) reflejo espejo inferior, muy tenue
      const refl = Math.min(active, Math.max(1, Math.floor((waveH - baseline) / segH)));
      for (let s = 0; s < refl; s++) {
        const ry = baseline + s * segH + segGap;
        c.globalAlpha = Math.max(0, 0.10 * (1 - s / Math.max(1, refl)));
        c.fillStyle = `rgb(${col.r},${col.g},${col.b})`;
        c.shadowBlur = 2 * waveDpr;
        c.shadowColor = c.fillStyle;
        c.beginPath();
        if (c.roundRect) c.roundRect(x, ry, barW, blockH * 0.8, rad);
        else c.rect(x, ry, barW, blockH * 0.8);
        c.fill();
      }
      c.globalAlpha = 1;
    }

    c.shadowBlur = 0;
    c.globalCompositeOperation = 'source-over';
  };

  const loopWave = (now) => {
    if (!waveRaf) return;
    const dt = Math.min(0.05, Math.max(0.001, lastT ? (now - lastT) / 1000 : 0.016));
    stepWave(now, dt);
    drawLedBars(now, dt);
    if (!playingNow() && vh.every((h) => h < 0.005) && bassEnv < 0.005) {
      waveRaf = 0; // apagado total; el bucle se reactiva con startWave
      return;
    }
    waveRaf = requestAnimationFrame(loopWave);
  };

  // reproducir → arranca/continúa el bucle; pausa/fin/error → la gravedad baja las barras
  const startWave = () => {
    if (waveRaf) return;
    sizeWave();
    waveRaf = requestAnimationFrame(loopWave);
  };
  const stopWave = () => { /* deja que las barras caigan a 0; el bucle se apaga solo */ };

  sizeWave();
  window.addEventListener('resize', sizeWave);
  if (window.ResizeObserver) {
    try { new ResizeObserver(sizeWave).observe(wave); } catch (ignored) { }
  }

  const finalizeOnset = () => {
    onsetCollect = false;
    const arr = onsetBuckets.filter((b) => b !== undefined);
    if (arr.length < 10) return;
    const s = arr.slice().sort((a, b) => a - b);
    const noise = s[Math.floor(s.length * 0.25)] || 0;
    const thresh = Math.min(0.45, Math.max(0.015, noise * 3.5));
    let onset = 0;
    for (let i = 0; i < onsetBuckets.length; i++) {
      const b = onsetBuckets[i] || 0;
      if (b > thresh) { onset = i / 10; break; }
    }
    if (onset >= 0.2) {
      const before = onsetBuckets.slice(0, Math.floor(onset * 10));
      const beforeMax = before.length ? Math.max(...before.map((b) => b || 0)) : 0;
      const level = (onsetBuckets[Math.floor(onset * 10)] || 0);
      if (level > 0 && beforeMax > level * 0.6) onset = 0;
    }
    onsetSec = (onset >= 0.2 && onset <= 5) ? Math.round(onset * 10) / 10 : 0;
    if (onsetKey && onsetSec && lyricShift[onsetKey] === undefined) {
      autoOffsets[onsetKey] = onsetSec;
      try { localStorage.setItem('neon_lyrics_auto_offsets', JSON.stringify(autoOffsets)); } catch {}
    }
  };

  const agcFrame = () => {
    if (!actx || !analyser || !gainNode) { agcBusy = false; stopWave(); return; }
    if (audio.paused || audio.ended) { stopAgc(); return; }
    if (actx.state === 'suspended') actx.resume();

    const n = analyser.fftSize;
    const td = new Uint8Array(n);
    analyser.getByteTimeDomainData(td);
    let sum = 0;
    for (let i = 0; i < n; i++) {
      const v = (td[i] - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / n);

    const tk = currentTrackKey();
    if (tk !== onsetKey) {
      onsetKey = tk;
      onsetCollect = !!tk && autoOffsets[tk] === undefined && lyricShift[tk] === undefined;
      onsetBuckets = [];
      onsetSec = 0;
    }
    if (onsetCollect) {
      if (audio.currentTime >= 6) finalizeOnset();
      else {
        const bi = Math.max(0, Math.min(399, Math.floor(audio.currentTime * 10)));
        onsetBuckets[bi] = Math.max(onsetBuckets[bi] || 0, rms);
      }
    }

    // AGC desactivado: el gain del nodo se mantiene en 1 para que el volumen lo
    // controle exclusivamente el slider (estable entre canciones y sin saltos al
    // interactuar con la ventana). Solo se conserva la colección de onset para letras.
    if (gainNode) gainNode.gain.value = 1;

    requestAnimationFrame(agcFrame);
  };

  const startAgc = () => {
    if (!actx || nativeMode) return; // en modo nativo el AGC no toca el gain (elemento mudo)
    agcBusy = false;
    if (actx.state === 'suspended') actx.resume();
    requestAnimationFrame(agcFrame);
  };

  const stopAgc = () => {
    agcBusy = false;
    if (gainNode) gainNode.gain.value = 1;
    stopWave();
  };

  // ---------- descargas ----------
  const renderDownloads = async () => {
    try {
      const res = await fetch('/api/downloads');
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      lastFiles = data.files;
      panelDownloads.innerHTML = '';
      if (!data.files.length) {
        panelDownloads.innerHTML = '<p class="hint">⏬ Usa el botón ⬇ para guardar canciones en MP3 dentro de la carpeta <code>Descargas</code>.</p>';
        return;
      }
      const rows = document.createElement('div');
      rows.className = 'drows';
      data.files.forEach((f) => {
        const row = document.createElement('div');
        row.className = 'drow';
        row.innerHTML = `
          <span class="f"></span>
          <span class="s"></span>
          <button class="btn-sm" data-act="play" title="Reproducir">▶</button>
          <button class="btn-sm danger" data-act="del" title="Eliminar">🗑</button>`;
        row.querySelector('.f').textContent = f.name;
        row.querySelector('.s').textContent = humanSize(f.size);
        row.querySelector('[data-act="play"]').addEventListener('click', (e) => { e.stopPropagation(); playFile(f.name); });
        row.querySelector('[data-act="del"]').addEventListener('click', async (e) => {
          e.stopPropagation();
          await fetch(`/api/downloads/${encodeURIComponent(f.name)}`, { method: 'DELETE' });
          renderDownloads();
        });
        row.addEventListener('click', () => playFile(f.name));
        rows.appendChild(row);
      });
      panelDownloads.appendChild(rows);
      const p = document.createElement('p');
      p.className = 'hint';
      p.textContent = `📁 ${data.dir}`;
      panelDownloads.prepend(p);
    } catch (e) {
      panelDownloads.innerHTML = `<p class="hint">Error: ${e.message}</p>`;
    }
  };

  const downloadTrack = async (track, btn) => {
    if (!track) return;
    if (btn) btn.disabled = true;
    showToast(`⏬ Descargando «${track.title}» en MP3…`);
    try {
      const res = await fetch(`/api/download/${track.id}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      showToast(`✅ Guardado: ${data.file}`);
      btnDownload.disabled = false;
      if (activeTab === 'downloads') renderDownloads();
    } catch (e) {
      showToast(`Error al descargar: ${e.message}`, true);
    } finally {
      if (btn) btn.disabled = false;
    }
  };

  btnDownload.addEventListener('click', () => {
    const track = playingFile ? null : listOf(activeSrc)[current];
    if (!track) { showToast('Primero elige una canción'); return; }
    downloadTrack(track, btnDownload);
  });

  btnRefreshDownloads.addEventListener('click', renderDownloads);

  // ---------- letras (toggle 🎤) ----------
  let lyricsMode = false;
  let lyricsData = null;
  let lyricsTrack = null;
  let lpLastIdx = -1;
  let lineEls = [];
  let dotsAfter = new Map();
  let lyricsOffset = 0;
  let autoOffsets = {};
  try { autoOffsets = JSON.parse(localStorage.getItem('neon_lyrics_auto_offsets') || '{}') || {}; } catch { autoOffsets = {}; }
  let lyricShift = {};
  try { lyricShift = JSON.parse(localStorage.getItem('neon_lyric_shift') || '{}') || {}; } catch { lyricShift = {}; }
  let onsetKey = null;
  let onsetCollect = false;
  let onsetBuckets = [];
  let onsetSec = 0;

  const currentTrackKey = () => {
    if (!lyricsTrack) return null;
    return lyricsTrack.id || ((lyricsTrack.artist || lyricsTrack.channel || '') + '|' + (lyricsTrack.title || ''));
  };

  const applyAutoOffset = (trackKey) => {
    if (trackKey && lyricShift[trackKey] !== undefined) { lyricsOffset = lyricShift[trackKey]; return; }
    if (trackKey && autoOffsets[trackKey] !== undefined) lyricsOffset = autoOffsets[trackKey];
    else if (onsetSec && onsetKey === trackKey) lyricsOffset = onsetSec;
    else lyricsOffset = 0;
  };

  function closeLyrics() {
    lyricsMode = false;
    btnLyrics.classList.remove('on');
    lyricsView.hidden = true;
    const panel = $(`#${activeTab}`);
    if (panel) panel.classList.add('active');
  }

  function openLyrics() {
    if (!lyricsData) return;
    lyricsMode = true;
    btnLyrics.classList.add('on');
    const panel = $(`#${activeTab}`);
    if (panel) panel.classList.remove('active');
    renderLyrics();
    lyricsView.hidden = false;
    updateLyrics(true);
    if (!localStorage.getItem('neon_lyric_hint')) {
      localStorage.setItem('neon_lyric_hint', '1');
      showToast('La letra se sincroniza sola; si se adelanta pulsa ] y si va tarde pulsa [');
    }
  }

  function renderLyrics() {
    const d = lyricsData;
    lpLastIdx = -1;
    const trackKey = currentTrackKey();
    applyAutoOffset(trackKey);
    lyricsView.innerHTML = `
      <div class="lyrics-card">
        <img class="lyrics-th" alt="" />
        <div class="lyrics-body">
          <div class="lyrics-scroll">
            <div class="lyrics-fill"></div>
          </div>
        </div>
      </div>`;
    const img = lyricsView.querySelector('.lyrics-th');
    if (lyricsTrack && lyricsTrack.thumbnail) {
      img.src = lyricsTrack.thumbnail;
      img.onerror = () => { img.style.display = 'none'; };
    } else {
      img.style.display = 'none';
    }
    const fill = lyricsView.querySelector('.lyrics-fill');
    const frag = document.createDocumentFragment();
    const lyricsItems = d.lines.map((l) => ({ sec: l.t, text: l.x }));
    const mkDots = () => {
      const el = document.createElement('p');
      el.className = 'lyr line-ellipsis';
      for (const del of ['0s', '.22s', '.44s']) {
        const s = document.createElement('span');
        s.style.setProperty('--d', del);
        s.textContent = '.';
        el.appendChild(s);
      }
      return el;
    };
    lineEls = [];
    dotsAfter = new Map();
    for (let i = 0; i < lyricsItems.length; i++) {
      const raw = (lyricsItems[i].text || '').trim();
      const isDots = raw === '...' || raw === '…' || raw === '…' || /^\.{1,3}$/.test(raw);
      const p = document.createElement('p');
      p.dataset.sec = d.lines[i].t;
      if (isDots) {
        p.className = 'lyr line-ellipsis';
        p.title = 'Ritmo instrumental';
        for (const del of ['0s', '.22s', '.44s']) {
          const s = document.createElement('span');
          s.style.setProperty('--d', del);
          s.textContent = '.';
          p.appendChild(s);
        }
      } else {
        p.className = 'lyr';
        p.textContent = raw;
      }
      p.addEventListener('click', () => {
        const t = Number(p.dataset.sec);
        if (Number.isFinite(t)) {
          const seekSec = Math.max(0, t + (lyricsOffset || 0));
          const n = native();
          if (nativeMode && n) n.seekTo(Math.round(seekSec * 1000));
          else audio.currentTime = seekSec;
          if (nativeMode && n) n.setPlaying(true);
          else if (audio.paused) audio.play().catch(() => {});
          updateLyrics(true);
        }
      });
      frag.appendChild(p);
      lineEls.push(p);
      const gap = (i + 1 < lyricsItems.length) ? lyricsItems[i + 1].sec - lyricsItems[i].sec : Infinity;
      if (!isDots && gap >= 3.5) {
        const d = mkDots();
        d.dataset.after = String(i);
        d.title = 'Ritmo instrumental';
        frag.appendChild(d);
        dotsAfter.set(i, d);
      }
    }
    fill.appendChild(frag);
    const scrollEl = lyricsView.querySelector('.lyrics-scroll');
    if (scrollEl) scrollEl.scrollTop = 0;
    updateLyrics(true);
  }

  function updateLyrics(force = false) {
    if (!lyricsMode || !lyricsData || !lyricsData.synced) return;
    const scroll = lyricsView.querySelector('.lyrics-scroll');
    if (!scroll) return;
    const lines = lyricsData.lines;
    const st = nowSec() - (lyricsOffset || 0);
    let idx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].t <= st) idx = i;
      else break;
    }
    let activeEl = null;
    let activeIndex = -1;
    let showDots = false;
    let prog = 0;
    if (idx >= 0 && idx < lines.length) {
      const L = lines[idx];
      const nextT = (idx + 1 < lines.length) ? lines[idx + 1].t : L.t + 6;
      const space = Math.max(0, nextT - L.t);
      const est = Math.min(space, Math.max(1.4, Math.min(7, (L.x || '').length * 0.11)));
      if (st < L.t + est && st >= L.t) {
        activeIndex = idx;
        activeEl = lineEls[idx];
        prog = Math.min(1, Math.max(0, (st - L.t) / Math.max(0.001, est)));
      } else {
        showDots = true;
      }
    } else {
      showDots = false;
    }
    lineEls.forEach((el, i) => {
      const on = i === activeIndex;
      el.classList.toggle('active', on);
      if (!on) {
        el.style.backgroundImage = '';
        el.style.webkitBackgroundClip = '';
        el.style.backgroundClip = '';
        el.style.color = '';
      }
    });
    dotsAfter.forEach((el, i) => {
      el.classList.toggle('active', showDots && i === idx);
    });
    if (activeEl) {
      if (!activeEl.classList.contains('line-ellipsis')) {
        const pct = (prog * 100).toFixed(1);
        activeEl.style.backgroundImage = `linear-gradient(90deg, #fff ${pct}%, rgba(255,255,255,0.24) ${pct}%)`;
        activeEl.style.webkitBackgroundClip = 'text';
        activeEl.style.backgroundClip = 'text';
        activeEl.style.color = 'transparent';
      } else {
        activeEl.style.backgroundImage = '';
        activeEl.style.webkitBackgroundClip = '';
        activeEl.style.backgroundClip = '';
        activeEl.style.color = '';
      }
    }
    let target = null;
    if (showDots) target = dotsAfter.get(idx) || null;
    else if (activeEl) target = activeEl;
    else target = lineEls[0] || null;
    if (target && (idx !== lpLastIdx || force)) {
      lpLastIdx = idx;
      requestAnimationFrame(() => {
        try { target.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch { /* noop */ }
      });
    }
  }

  btnLyrics.addEventListener('click', () => {
    if (lyricsMode) closeLyrics();
    else openLyrics();
  });

  window.addEventListener('keydown', (e) => {
    if (!lyricsMode || !lyricsData || !lyricsTrack) return;
    const tag = e.target && e.target.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;
    if (e.key !== '[' && e.key !== ']') return;
    e.preventDefault();
    const trackKey = currentTrackKey();
    const step = (e.key === ']' ? 1 : -1) * 0.25;
    lyricsOffset = Math.max(-8, Math.min(8, (lyricsOffset || 0) + step));
    lyricsOffset = Math.round(lyricsOffset * 100) / 100;
    if (trackKey) {
      lyricShift[trackKey] = lyricsOffset;
      try { localStorage.setItem('neon_lyric_shift', JSON.stringify(lyricShift)); } catch {}
    }
    updateLyrics(true);
    showToast(`Sincronía de la letra: ${lyricsOffset >= 0 ? '+' : ''}${lyricsOffset.toFixed(2)}s`);
  });

  function prepareLyrics(track) {
    closeLyrics();
    lyricsData = null;
    lyricsTrack = track;
    btnLyrics.hidden = true;
    if (!track || playingFile) return;
    (async () => {
      try {
        const url = `/api/lyrics?artist=${encodeURIComponent(track.artist || track.channel || '')}&title=${encodeURIComponent(track.title || '')}&duration=${track.duration || 0}`;
        const r = await fetch(url);
        const d = await r.json();
        if (d.ok && d.lines && d.lines.length) {
          lyricsData = d;
          btnLyrics.hidden = false;
          if (lyricsMode) openLyrics();
        }
      } catch { /* sin letras */ }
    })();
  }

  // ---------- catálogo local + búsqueda difusa (fuzzy search) ----------
  const CATALOG_KEY = 'neon_catalog';
  let catalog = [];
  try { catalog = JSON.parse(localStorage.getItem(CATALOG_KEY) || '[]') || []; } catch { catalog = []; }

  // 1) NORMALIZACIÓN: minúsculas, sin acentos ni símbolos, espacios colapsados.
  //    "Fría Como El Viento" -> "fria como el viento"
  const normTex = (s) => String(s || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w\s\u00C0-\u024F\u1E00-\u1EFF\u0370-\u03FF\u0400-\u04FF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  // 2) Distancia de Levenshtein (DP de 2 filas, O(a*b), tolerante a 1-3 letras).
  const levDist = (a, b) => {
    if (a === b) return 0;
    const la = a.length, lb = b.length;
    if (!la) return lb;
    if (!lb) return la;
    let prev = new Array(lb + 1);
    let cur = new Array(lb + 1);
    for (let j = 0; j <= lb; j++) prev[j] = j;
    for (let i = 1; i <= la; i++) {
      cur[0] = i;
      for (let j = 1; j <= lb; j++) {
        const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      }
      const t = prev; prev = cur; cur = t;
    }
    return prev[lb];
  };

// Similitud 0..1: combina la cadena completa con la cobertura por palabras.
// Tolerante a orden, letras cambiadas y palabras sobrantes del campo.
const similar = (a, b) => {
  const na = normTex(a);
  const nb = normTex(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const whole = 1 - levDist(na, nb) / Math.max(na.length, nb.length);
  const wA = na.split(' ').filter((w) => w.length > 1);
  const wB = nb.split(' ').filter((w) => w.length > 1);
  if (!wA.length || !wB.length) return whole;
  // Cobertura: cuántas palabras de un lado encuentran pareja razonable en el otro.
  const cover = (src, dst) => {
    let acc = 0, hits = 0;
    for (const s of src) {
      let best = 0;
      for (const d of dst) {
        const m = 1 - levDist(s, d) / Math.max(s.length, d.length);
        if (m > best) best = m;
      }
      if (best >= 0.6) { acc += best; hits++; }
    }
    return hits ? acc / hits : 0;
  };
  return Math.max(whole, cover(wB, wA), cover(wA, wB));
};

  // 3) Umbral flexible (~0.4 en Fuse.js equivale a >= 0.6 aquí).
  const FUZZY_MIN = 0.6;
  const FIELD_PRIO = { exact: 0, artist: 1, title: 2, album: 3 };

  // Catálogo persistente (todo lo que ya apareció en la app: búsquedas + lista).
  const catalogPush = (track) => {
    if (!track || !track.id) return;
    if (catalog.some((t) => t.id === track.id)) return;
    catalog.push({
      id: track.id,
      title: track.title || '',
      artist: track.artist || track.channel || '',
      album: track.album || '',
      thumbnail: track.thumbnail || '',
      duration: track.duration || 0,
      views: track.views || 0,
      official: !!track.official,
    });
    if (catalog.length > 1200) catalog = catalog.slice(-1200);
    try { localStorage.setItem(CATALOG_KEY, JSON.stringify(catalog)); } catch { }
  };
  const feedCatalog = (list) => { for (const t of (list || [])) catalogPush(t); };

  // Ranking de un tema: campo (artista > título > álbum) + grado de similitud.
  const bestFuzzy = (track, nq) => {
    const nT = normTex(track.title);
    const nA = normTex(track.artist);
    const nAl = normTex(track.album);
    if (nT && nT === nq) return { s: 1.01, field: 'exact', t: track };
    if (nA && nA === nq) return { s: 1.02, field: 'exact', t: track };
    const checks = [];
    if (nA) checks.push(['artist', nA, 1]);
    if (nT) checks.push(['title', nT, 0.92]);
    if (nAl) checks.push(['album', nAl, 0.85]);
    let best = { s: 0, field: 'title', t: track };
    for (const [field, val, w] of checks) {
      const s = similar(val, nq) * w;
      if (s > best.s) best = { s, field, t: track };
    }
    return best;
  };
  const fuzzyRank = (list, query) => {
    const nq = normTex(query);
    if (!nq) return [];
    const scored = [];
    for (const t of list) {
      const r = bestFuzzy(t, nq);
      if (r.s >= FUZZY_MIN) scored.push(r);
    }
    scored.sort((x, y) =>
      (FIELD_PRIO[x.field] - FIELD_PRIO[y.field]) ||
      (y.s - x.s) ||
      ((y.t.views || 0) - (x.t.views || 0)));
    return scored;
  };
  // Uso previsto: para la lista de la API y para recuperar del catálogo local.
// Reordena los resultados por relevancia SIN vaciar la lista:
// los que pasan el umbral suben; el resto se conserva abajo.
const fuzzyTrackList = (list, query) => {
  const nq = normTex(query);
  if (!nq || !list || !list.length) return list || [];
  return list
    .map((t) => bestFuzzy(t, nq))
    .sort((x, y) =>
      (FIELD_PRIO[x.field] - FIELD_PRIO[y.field]) ||
      (y.s - x.s) ||
      ((y.t.views || 0) - (x.t.views || 0)))
    .map((r) => r.t);
};
const fuzzyCatalog = (query, limit = 8) => {
  const r = fuzzyRank(catalog, query);
  if (r.length) return r.slice(0, limit);
  // sin coincidencias por encima del umbral: mantener el mejor intento
  return catalog
    .map((t) => bestFuzzy(t, normTex(query)))
    .sort((x, y) => (y.s - x.s) || ((y.t.views || 0) - (x.t.views || 0)))
    .slice(0, limit)
    .map((r) => r.t);
};

  // ---------- buscar ----------
  const renderResultsHeader = () => {
    if (activeTab !== 'results') switchTab('results');
  };

  // ---------- enrutamiento inteligente (épocas / géneros / "lo más sonado") ----------
  const GENRE_LIST = ['salsa','rock','bachata','merengue','cumbia','reggaeton','pop','vallenato','balada','jazz','blues','clasica','electronica','house','techno','banda','corridos','nortena','ranchera','metal','punk','indie','hip hop','rap','dance','dubstep','lofi','kpop','opera','gospel','soul','funk','disco','country','folk','trova','bolero','tango','flamenco','cuarteto','reggae','ska','swing','new wave','synth','grunge','heavy metal','afrobeat','dembow','tropical','romantica','navidad','cristiana','infantil','dancehall'];
  const ERA_RE = /\b(80|90|70|60)s?\b|\bde\s+los\s+(ochenta|noventa|setenta|sesenta|80|90|70|60)\b|\bdecada\s+de\s+los\s+(80|90|70|60)\b/;
  const PLAYLIST_HINTS_RE = /\b(clasicos|clasicas|clasica|classic|exitos|mix|lo mas sonado|lo mas sonadas|mas sonadas|mas escuchadas|del momento|grandes exitos|los mejores|mejores canciones|hits|best of|greatest|golden|top|todas las canciones|temas de oro)\b/;

  const smartGenre = (t) => {
    for (const g of GENRE_LIST) {
      if (new RegExp('\\b' + g.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&') + '(s|es)?\\b').test(t)) return g;
    }
    return null;
  };
  const smartPlan = (q) => {
    const t = normTex(q);
    if (!t) return { type: 'none' };
    if (ERA_RE.test(t) || PLAYLIST_HINTS_RE.test(t)) return { type: 'playlist' };
    const g = smartGenre(t);
    if (g) return { type: 'genre', genre: g };
    return { type: 'none' };
  };
  // Regla 2: concatenar términos de relevancia en segundo plano (género → "exitos de la historia").
  const boostGenre = (t) => `${t} exitos de la historia`;
  const boostPlaylist = (t) => `${t} lo mas sonado`;

  // Regla 1 + 3: búsqueda tipo Lista de Reproducción. Si el backend la encuentra,
  // despliega la colección completa en cola (índice, miniatura, duración) y reproduce.
  const smartPlaylistSearch = async (q, raw) => {
    renderResultsHeader();
    lastQuery = raw;
    statusText.textContent = '🕸 organizando colección inteligente…';
    panelResults.innerHTML = '<li class="hint">🎶 Buscando una lista de reproducción con los temas más sonados…</li>';
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(normTex(q))}&type=playlist`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (data.type === 'playlist' && Array.isArray(data.results) && data.results.length) {
        feedCatalog(data.results);
        results = data.results;
        const meta = data.playlist || {};
        searchMeta = { kind: 'playlist', name: meta.name || data.name || raw, sub: `${results.length} canciones en la colección · "${raw}"`, img: meta.thumbnail || (results[0] ? results[0].thumbnail : '') };
        renderResults();
        statusText.textContent = `🎵 Colección inteligente · ${results.length} canciones para "${raw}"`;
        autoDjSeed = { artist: '', query: raw }; // la radio continúa por género/época, no por un artista
        playFrom(0, 'results', true);
        showToast('▶ Colección inteligente cargada en la cola');
        return;
      }
      await plainSearch(raw, boostGenre(normTex(raw)), true);
    } catch (e) {
      await plainSearch(raw, boostGenre(normTex(raw)), true);
    }
  };

  const plainSearch = async (displayQ, boost, smart) => {
    renderResultsHeader();
    lastQuery = displayQ;
    statusText.textContent = 'buscando…';
    panelResults.innerHTML = '<li class="hint">🔎 Buscando en la web (solo música, pre-cargando el audio)…</li>';
    // 1) Normalización antes de consultar: minúsculas, sin acentos/símbolos.
    const apiQ = boost || normTex(displayQ);
    if (!apiQ) { statusText.textContent = 'sin resultados'; return; }
    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(apiQ)}&type=${searchType}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      feedCatalog(data.results);
      let ranked = data.results;
      if (data.results.length > 1) {
        // 3) Priorización: exactas > artista > título > álbum, y por similitud.
        try {
          ranked = fuzzyTrackList(data.results, apiQ);
        } catch (fuzzyErr) {
          ranked = data.results;
        }
      }
      results = ranked;
      // sembrar el Auto-DJ: por artista si es una canción, si no por la consulta (género/época)
      const isGenre = smart || searchType !== 'track';
      autoDjSeed = { artist: isGenre ? '' : (results[0] ? (results[0].artist || results[0].channel || '') : ''), query: displayQ };
      searchMeta = null;
      const n = results.length;
      if (n) {
        if (searchType === 'artist') {
          searchMeta = { kind: 'artist', name: displayQ, sub: `${n} canciones de ${displayQ}`, img: results[0].thumbnail || '' };
        } else if (searchType === 'album') {
          searchMeta = { kind: 'album', album: displayQ, name: displayQ, sub: `${n} temas del álbum`, img: results[0].thumbnail || '' };
        } else if (smart) {
          searchMeta = { kind: 'smart', name: results[0].title || displayQ, sub: `Lo más sonado · ${n} canciones para "${displayQ}"`, img: results[0].thumbnail || '' };
        } else {
          searchMeta = { kind: 'track', name: results[0].title || displayQ, sub: `${n} coincidencias en la canción`, img: results[0].thumbnail || '' };
        }
      }
      renderResults();
      if (n) {
        statusText.textContent = searchType === 'artist' ? `${n} canciones de "${displayQ}"`
          : searchType === 'album' ? `${n} temas del álbum "${displayQ}"`
          : smart ? `🔥 ${n} éxitos de "${displayQ}"`
          : `${n} canciones · "${displayQ}"`;
        playFrom(0, 'results');
        showToast(smart ? '▶ Reproduciendo los más sonados' : '▶ Reproduciendo la mejor coincidencia');
      }
      // 2) Tolerancia ortográfica: si la API no reconoce el nombre,
      //    recuperamos del catálogo local las coincidencias aproximadas.
      else {
        let fb = [];
        try {
          fb = fuzzyCatalog(displayQ, 8);
        } catch (fuzzyErr) {
          fb = [];
        }
        if (fb.length) {
          results = fb.map((r) => r.t);
          const best = results[0];
          searchMeta = { kind: 'track', name: best.title, sub: `${fb.length} coincidencia(s) aproximada(s) · ortografía corregida`, img: best.thumbnail || '' };
          renderResults();
          statusText.textContent = `≈ ${fb.length} coincidencia(s) aproximada(s) · "${displayQ}"`;
          playFrom(0, 'results');
          showToast(`🔎 ¿Quisiste decir «${best.title}»?`);
        } else {
          results = [];
          statusText.textContent = 'sin resultados exactos ni aproximados';
          panelResults.innerHTML = '<li class="hint">⚠ Sin resultados. Revisa la ortografía; la app ya tolera errores de 1 a 3 letras, espacios o acentos.</li>';
        }
      }
    } catch (e) {
      showToast(`Error al buscar: ${e.message}`, true);
      statusText.textContent = 'error de búsqueda';
    }
  };

  const doSearch = async (q) => {
    if (!q) return;
    // Limpieza al pegar: comillas, puntuación sobrante y espacios repetidos.
    const url = String(q).trim().replace(/["'<>]+/g, '').replace(/\s+/g, ' ');
    // Detección de lista de reproducción de YouTube (cualquier forma de URL):
    // watch?v=...&list=..., playlist?list=..., youtu.be/...?list=...
    const pl = url.match(/[?&]list=([\w-]{8,})/);
    if (pl) { doPlaylist(url); return; }
    const plan = smartPlan(q);
    // Regla 1: época / pistas de "lo más sonado", o el usuario eligió "Lista" → búsqueda tipo playlist.
    if (searchType === 'playlist' || plan.type === 'playlist') {
      const pq = plan.type === 'genre' ? boostPlaylist(normTex(q)) : normTex(q);
      await smartPlaylistSearch(pq, q);
      return;
    }
    // Regla 2: género con "Canción" seleccionada → términos de relevancia en segundo plano.
    const boost = (searchType === 'track' && plan.type === 'genre') ? boostGenre(normTex(q)) : '';
    await plainSearch(q, boost, !!boost);
  };

  // ---------- lista de reproducción (cola) ----------
  const ytVideoId = (url) => {
    const m = String(url).match(/(?:[?&]v=|youtu\.be\/|embed\/|shorts\/|live\/)([\w-]{11})/);
    return m ? m[1] : null;
  };

  const doPlaylist = async (url) => {
    renderResultsHeader();
    lastQuery = url;
    statusText.textContent = 'extrayendo lista de reproducción…';
    panelResults.innerHTML = '<li class="hint">🎵 Extrayendo los videos de la lista de reproducción…</li>';
    try {
      const res = await fetch(`/api/playlist?url=${encodeURIComponent(url)}`);
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      feedCatalog(data.results);
      results = data.results;
      searchMeta = { kind: 'playlist', name: data.name || 'Playlist', sub: `${results.length} canciones en la cola`, img: results[0] ? results[0].thumbnail : '' };
      renderResults();
      if (results.length) {
        statusText.textContent = `🎵 ${results.length} canciones · "${data.name || 'lista'}"`;
        playFrom(0, 'results', true);
        showToast('▶ Reproduciendo la lista de reproducción');
      } else {
        statusText.textContent = 'sin resultados en la lista';
      }
    } catch (e) {
      // Fallback: si la lista no se pudo extraer pero la URL trae un video concreto,
      // reproduce ese tema para no dejar la búsqueda vacía.
      const vid = ytVideoId(url);
      if (vid) {
        try {
          const single = { id: vid, title: 'Video solicitado', channel: '', album: '', duration: 0, views: 0, thumbnail: `https://i.ytimg.com/vi/${vid}/mqdefault.jpg`, official: false };
          results = [single];
          searchMeta = { kind: 'playlist', name: 'Video solicitado', sub: 'No se pudo extraer la lista; reproduciendo el video', img: single.thumbnail };
          renderResults();
          playFrom(0, 'results', true);
          showToast('▶ No se pudo extraer la lista; reproduciendo el video');
          return;
        } catch (ignored) { }
      }
      showToast(`Error al abrir la lista: ${e.message}`, true);
      statusText.textContent = 'error al extraer la lista';
    }
  };

  // ---------- eventos de audio ----------
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    ensureAudioGraph();
    doSearch(input.value.trim());
  });

  const stBtns = [...document.querySelectorAll('#search-type .st-btn')];
  stBtns.forEach((b) => b.addEventListener('click', () => {
    searchType = b.dataset.type;
    stBtns.forEach((x) => x.classList.toggle('active', x === b));
    input.focus();
  }));

  btnPlay.addEventListener('click', () => {
    if (!listOf(activeSrc).length && !playingFile) { input.focus(); return; }
    const n = native();
    if (nativeMode && n) {
      if (nativePlaying) { playIntent = false; n.setPlaying(false); }
      else { playIntent = true; n.setPlaying(true); }
      return;
    }
    if (actx && actx.state === 'suspended') actx.resume();
    if (audio.paused) { playIntent = true; audio.play(); }
    else { playIntent = false; audio.pause(); }
  });

  btnNext.addEventListener('click', () => { if (!playingFile) goNext(); });
  btnPrev.addEventListener('click', () => { if (!playingFile) play(current - 1); });

  const btnShuffle = $('#btn-shuffle');

  // ---------- cola de reproducción (shuffle / loop) ----------
  const queue = () => listOf(activeSrc);

  // Espejo de la cola en el servicio: permite NEXT/PREV y auto-next 100% nativos
  // (funcionan con la pantalla apagada / WebView destruido por el sistema).
  const pushNativeQueue = () => {
    try {
      const n = native();
      if (!n || !n.setQueue) return;
      if (playingFile || !queue().length) {
        n.setQueue('[]', -1, loopMode, !!autonext.checked);
        nativeQueueActive = false;
        return;
      }
      const list = listOf(activeSrc);
      let order = [];
      if (shuffleOn && shuffleOrder.length) {
        if (shuffleOrder.indexOf(current) === -1) order.push(current);
        for (const i of shuffleOrder) order.push(i);
      } else {
        for (let i = 0; i < list.length; i++) order.push(i);
      }
      if (!order.length) {
        n.setQueue('[]', -1, loopMode, !!autonext.checked);
        nativeQueueActive = false;
        return;
      }
      const pos = Math.max(0, order.indexOf(current));
      const arr = order.map((i) => ({
        id: list[i].id,
        title: list[i].title || '',
        artist: (list[i].channel || list[i].artist) || '',
        dur: Math.round((list[i].duration || 0) * 1000),
        art: list[i].thumbnail || ''
      }));
      n.setQueue(JSON.stringify(arr), pos, loopMode, !!autonext.checked);
      nativeQueueActive = true;
    } catch (ignored) { }
  };

  // El servicio avanzó solo (Now Bar o auto-next): sincronizar tema actual y UI en la web
  const syncNativeTrack = (id) => {
    if (!id || !nativeMode || !nativeQueueActive) return;
    try {
      const list = listOf(activeSrc);
      const idx = list.findIndex((t) => t.id === id);
      if (idx < 0 || idx === current) return;
      current = idx;
      const t = list[idx];
      setPlaying({ playing: true, track: t });
      pushMedia(t);
      updateMss(true);
      liveBadge.classList.toggle('hidden', true);
      durBadge.textContent = t.duration ? fmt(t.duration) : '';
      prepareLyrics(t);
      warmNextFor = -1;
      updateAmbient(t);
      renderActiveList();
      if (shuffleOn && shuffleOrder.length) shuffleOrder = shuffleOrder.filter((i) => i !== idx);
    } catch (ignored) { }
  };

  // Mezcla los índices pendientes (Fisher-Yates). Al empezar, la cola es todos los índices.
  const resetShuffle = () => {
    const n = queue().length;
    shuffleOrder = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = shuffleOrder[i]; shuffleOrder[i] = shuffleOrder[j]; shuffleOrder[j] = t;
    }
  };

  // Devuelve el índice a reproducir tras terminar la canción actual, o -1 si hay que parar.
  const nextIndex = () => {
    const q = queue();
    if (!q.length) return -1;
    if (shuffleOn) {
      if (!shuffleOrder.length) {
        if (loopMode === 1) resetShuffle();
        else return -1;
      }
      // no repetir la misma canción dos veces seguidas
      if (shuffleOrder.length > 1 && shuffleOrder[0] === current) {
        const j = Math.floor(Math.random() * (shuffleOrder.length - 1)) + 1;
        const t = shuffleOrder[0]; shuffleOrder[0] = shuffleOrder[j]; shuffleOrder[j] = t;
      }
      return shuffleOrder.shift();
    }
    const n = current + 1;
    if (n < q.length) return n;
    return loopMode === 1 ? 0 : -1;
  };

  const goNext = () => {
    if (playingFile) return;
    const n = nextIndex();
    if (n >= 0) play(n);
  };

  btnShuffle.addEventListener('click', () => {
    shuffleOn = !shuffleOn;
    btnShuffle.classList.toggle('on', shuffleOn);
    if (shuffleOn) resetShuffle();
    pushNativeQueue();
    showToast(shuffleOn ? '🔀 Reproducción aleatoria: activada' : '🔀 Reproducción aleatoria: desactivada');
  });

  btnRepeat.addEventListener('click', () => {
    loopMode = (loopMode + 1) % 3;
    btnRepeat.classList.toggle('on', loopMode !== 0);
    btnRepeat.textContent = loopMode === 2 ? '🔂' : '🔁';
    btnRepeat.title = loopMode === 2 ? 'Repetir esta canción' : loopMode === 1 ? 'Repetir la lista' : 'Repetir: desactivado';
    pushNativeQueue();
    showToast(loopMode === 2 ? '🔂 Repetir esta canción: activado' : loopMode === 1 ? '🔁 Repetir la lista: activado' : 'Repetir: desactivado');
  });

  const btnAutodj = $('#btn-autodj');
  btnAutodj.addEventListener('click', () => {
    autoDjOn = !autoDjOn;
    btnAutodj.classList.toggle('on', autoDjOn);
    showToast(autoDjOn ? '📻 Auto-DJ activado: radio infinita por estilo y época' : '📻 Auto-DJ desactivado');
    if (autoDjOn) {
      const t = (!playingFile && current >= 0) ? listOf(activeSrc)[current] : null;
      if (t && !autoDjSeed.artist && !autoDjSeed.query) {
        autoDjSeed = { artist: (t.artist || t.channel || '').trim(), query: lastQuery || (t.title || '').trim() };
      }
      if (!autoDjSeed.artist && !autoDjSeed.query) autoDjSeed = { artist: '', query: lastQuery || input.value.trim() };
      extendAutoDj();
    }
  });

  autonext.addEventListener('change', () => { pushNativeQueue(); });

  seek.addEventListener('input', () => {
    const n = native();
    if (nativeMode && nativePlaying && n) {
      const durMs = n.getDuration();
      const d = (Number.isFinite(durMs) && durMs > 0) ? durMs : nativeDurMs;
      if (d > 0) n.seekTo(Math.round((seek.value / 1000) * d));
    } else if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = (seek.value / 1000) * audio.duration;
    }
    seek.style.setProperty('--pct', (seek.value / 10) + '%');
  });

  volume.addEventListener('input', () => {
    const n = native();
    if (nativeMode && n) n.setVolume(volume.value / 100);
    audio.volume = volume.value / 100;
    volume.style.setProperty('--pct', volume.value + '%');
  });
  volume.style.setProperty('--pct', '80%');
  audio.volume = 0.8;

  // barra de progreso suave (interpola entre timeupdate con requestAnimationFrame, sin saltos)
  let lastEvtAt = 0, lastEvtTime = 0, smoothRaf = 0;
  const progressTick = () => {
    if (nativeMode) { smoothRaf = 0; return; } // en modo nativo la barra la mueve el poll real
    if (audio.paused) { smoothRaf = 0; return; }
    if (audio.duration) {
      const shownT = Math.min(lastEvtTime + (performance.now() - lastEvtAt) / 1000, audio.duration);
      if (!seek.matches(':active')) seek.value = (shownT / audio.duration) * 1000;
      seek.style.setProperty('--pct', ((shownT / audio.duration) * 100).toFixed(1) + '%');
      timeCur.textContent = fmt(shownT);
      timeTotal.textContent = fmt(audio.duration);
    }
    smoothRaf = requestAnimationFrame(progressTick);
  };
  audio.addEventListener('timeupdate', () => {
    lastEvtAt = performance.now();
    lastEvtTime = audio.currentTime;
    pushPosition();
    if (audio.duration && isFinite(audio.duration) && audio.duration - audio.currentTime <= 15) warmNext();
  });
  audio.addEventListener('seeked', () => {
    lastEvtAt = performance.now();
    lastEvtTime = audio.currentTime;
  });
  audio.addEventListener('playing', () => {
    lastEvtAt = performance.now();
    lastEvtTime = audio.currentTime;
    if (!smoothRaf) smoothRaf = requestAnimationFrame(progressTick);
  });
  audio.addEventListener('pause', () => {
    if (smoothRaf) { cancelAnimationFrame(smoothRaf); smoothRaf = 0; }
  });

  // letras: sincronización pegada al evento nativo 'timeupdate' + refresco al saltar
  audio.addEventListener('timeupdate', () => updateLyrics());
  audio.addEventListener('seeked', () => updateLyrics(true));

  audio.addEventListener('loadedmetadata', () => {
    if (nativeMode) return; // la metadata real en APK la mantiene startNativePoll
    timeTotal.textContent = fmt(audio.duration);
    pushMedia();
    updateMss(!audio.paused);
  });

  audio.addEventListener('playing', () => {
    if (nativeMode) return; // el estado real en APK llega por __nativeEvent del servicio
    setPlaying({ playing: true });
    retried.clear();
    startAgc();
    startWave();
  });
  audio.addEventListener('pause', () => { if (nativeMode) return; setPlaying({ playing: false }); stopAgc(); });
  audio.addEventListener('waiting', () => { if (nativeMode) return; statusText.textContent = 'cargando stream…'; });
  audio.addEventListener('stalled', () => {
    if (nativeMode) return; // el elemento mudo no debe disparar fallbacks de modo
    statusText.textContent = 'cargando stream…';
    if (!audio.paused && audio.readyState < 2) {
      const t = listOf(activeSrc)[current];
      if (t) armStall(t);
    }
  });
  audio.addEventListener('canplay', () => { clearStall(); });
  audio.addEventListener('loadedmetadata', () => {
    if (nativeMode) return;
    clearStall();
    dbg(`meta dur=${audio.duration || '?'} w=${audio.videoWidth}x${audio.videoHeight}`);
    timeTotal.textContent = fmt(audio.duration);
  });

  // Si el sistema pausa el audio al apagar la pantalla/segundo plano, al volver se reanuda.
  document.addEventListener('visibilitychange', () => {
    try {
      const n = native();
      if (nativeMode && n) {
        if (document.visibilityState === 'visible' && playIntent && !nativePlaying) n.setPlaying(true);
        return;
      }
      if (document.visibilityState === 'visible' && playIntent && audio.src && audio.paused) {
        audio.play().catch(() => {});
      }
    } catch (ignored) { }
  });

  audio.addEventListener('playing', () => {
    if (nativeMode) return; // en la APK el elemento mudo no debe gobernar el estado
    dbg('▶ playing');
    clearStall();
    if (statusText.textContent === 'cargando stream…') {
      statusText.textContent = lastQuery ? `${results.length} resultados · "${lastQuery}"` : 'Sin búsqueda';
    }
    setPlaying({ playing: true });
    retried.clear();
    modeStep = MODE_SEQ[0];
    consecFails = 0;
    startAgc();
    pushPlaying(true);
    updateMss(true);
    pushPosition();
    warmNext();
  });
  audio.addEventListener('pause', () => {
    if (nativeMode) return;
    setPlaying({ playing: false });
    pushPlaying(false);
    updateMss(false);
  });
  audio.addEventListener('ended', () => {
    if (nativeMode) return; // el fin real en APK llega por __nativeEvent('ended')
    dbg('⏹ ended');
    clearStall();
    stopAgc();
    pushPlaying(false);
    updateMss(false);
    if (!playingFile) {
      if (loopMode === 2) {
        // repetir una sola pista: reiniciar la canción actual
        audio.currentTime = 0;
        audio.play().catch(() => {});
        return;
      }
      if (autonext.checked && queue().length) {
        const n = nextIndex();
        if (n >= 0) { play(n); return; }
      }
      // Auto-DJ: la cola se agotó → extender con música del mismo estilo/época y seguir
      if (autoDjOn) {
        statusText.textContent = '📻 Auto-DJ: buscando más temas de la época…';
        extendAutoDj().then(() => {
          const n = nextIndex();
          if (n >= 0) { play(n); return; }
          setPlaying({ playing: false });
          statusText.textContent = '📻 Auto-DJ: sin más temas por ahora';
        });
        return;
      }
    }
    setPlaying({ playing: false });
  });

  const errLabel = () => {
    const c = audio.error ? audio.error.code : 0;
    const names = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
    return `${c} ${names[c] || '?'} · ${audio.error ? audio.error.message : ''}`;
  };

  let consecFails = 0;

  audio.addEventListener('error', () => {
    if (nativeMode) {
      // en la APK el elemento solo alimenta el analizador: registrar su fallo (CORS, red…)
      try {
        const c = audio.error ? audio.error.code : 0;
        const n = native();
        if (n && n.log) n.log('muted · element error code=' + c);
      } catch (ignored) { }
      return;
    }
    clearStall();
    const track = playingFile ? null : listOf(activeSrc)[current];
    const errCode = errLabel();
    dbg(`✖ error ${errCode} · ${track ? track.id : 'archivo'}`);
    try { const n = native(); if (n && n.log) n.log(`audio error ${errCode} · ${track ? track.id : 'archivo'}`); } catch (ignored) { }
    stopAgc();
    setPlaying({ playing: false });
    pushPlaying(false);
    updateMss(false);
    if (track && !retried.has(track.id)) {
      // agotar los modos en orden (en APK: raw primero) antes de rendirse
      const nm = nextMode();
      if (nm !== null) {
        retried.add(track.id);
        modeStep = nm;
        dbg(`↻ modo ${modeStep} (falló el anterior)`);
        setTimeout(() => play(current), 250);
        return;
      }
    }
    if (track && (track._fr || 0) < 2) {
      // con todos los modos probados: re-resolver con r= y volver a empezar
      track._fr = (track._fr || 0) + 1;
      modeStep = MODE_SEQ[0];
      retried.clear();
      setTimeout(() => play(current), 250);
      return;
    }
    const name = playingFile ? 'archivo' : (track && track.title) || 'tema';
    consecFails++;
    if (!playingFile && consecFails < 4 && autonext.checked && queue().length) {
      const n = nextIndex();
      setTimeout(() => { if (n >= 0) play(n); }, 400);
    } else {
      setPlaying({ playing: false });
      consecFails = 0;
      statusText.textContent = playingFile ? 'error de archivo' : `no se pudo reproducir · ${errLabel()}`;
      warnProtected();
    }
  });

  // ---------- redimensionar columnas (menú y reproductor) ----------
  const appEl = document.querySelector('.app');
  const clampN = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  const applyResize = () => {
    if (window.matchMedia('(max-width: 900px)').matches) return;
    let s = parseInt(localStorage.getItem('neon_sidebar_w'), 10) || 240;
    let p = parseInt(localStorage.getItem('neon_player_w'), 10) || 310;
    s = clampN(s, 170, 380);
    p = clampN(p, 220, 480);
    const avail = window.innerWidth - 300 - 14;
    if (s + p > avail) {
      const k = avail / (s + p);
      s = Math.max(170, Math.round(s * k));
      p = Math.max(220, Math.round(p * k));
    }
    appEl.style.setProperty('--sidebar-w', `${s}px`);
    appEl.style.setProperty('--player-w', `${p}px`);
  };
  applyResize();
  window.addEventListener('resize', applyResize);

  let drag = null;
  const curS = () => parseInt(appEl.style.getPropertyValue('--sidebar-w')) || 240;
  const curP = () => parseInt(appEl.style.getPropertyValue('--player-w')) || 310;

  document.querySelectorAll('.handle').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      if (window.matchMedia('(max-width: 900px)').matches) return;
      drag = {
        handle: h,
        side: h.classList.contains('h-side') ? 'sidebar' : 'player',
        startX: e.clientX,
        startS: curS(),
        startP: curP(),
      };
      h.classList.add('dragging');
      document.body.style.userSelect = 'none';
      e.preventDefault();
      if (h.setPointerCapture) h.setPointerCapture(e.pointerId);
    });
    h.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const s = clampN(drag.side === 'sidebar' ? drag.startS + dx : curS(), 170, 380);
      const p = clampN(drag.side === 'player' ? drag.startP - dx : curP(), 220, 480);
      appEl.style.setProperty('--sidebar-w', `${s}px`);
      appEl.style.setProperty('--player-w', `${p}px`);
    });
  });

  const endDrag = () => {
    if (!drag) return;
    drag.handle.classList.remove('dragging');
    document.body.style.userSelect = '';
    localStorage.setItem('neon_sidebar_w', curS());
    localStorage.setItem('neon_player_w', curP());
    drag = null;
  };
  window.addEventListener('pointerup', endDrag);
  window.addEventListener('pointercancel', endDrag);

  // ---------- arranque ----------
  audio.preload = 'auto';
  dbg('códecs → mp4:' + audio.canPlayType('audio/mp4; codecs="mp4a.40.2"') + ' opus:' + audio.canPlayType('audio/webm; codecs="opus"') + ' mp3:' + audio.canPlayType('audio/mpeg'));
  updatePlaylistCount();
  // fondo adaptativo: capa 0 visible con el gradiente azul por defecto
  if (ambLayers[0]) {
    ambLayers[0].style.setProperty('--amb-a1', rgbStr(DEF1));
    ambLayers[0].style.setProperty('--amb-a2', rgbStr(DEF2));
    ambLayers[0].style.setProperty('--amb-base', DEF_B1);
    ambLayers[0].style.setProperty('--amb-base2', DEF_B2);
    ambLayers[0].classList.add('vis-active');
  }
  const confirmEngine = async () => {
    try {
      const res = await fetch('/api/ping');
      const data = await res.json();
      if (data.ok) { setEngine(true); return; }
      setEngine(false);
    } catch {
      setEngine(false);
    }
  };
  confirmEngine();

  // ---------- relación Now Bar ↔ interfaz ----------
  // La APK persiste el estado de la UI (búsqueda, listado, canción actual) en localStorage:
  // si la Activity se recrea (o el usuario abre la app desde la Now Bar), la interfaz se
  // restaura con EL MISMO listado que está sonando, no uno vacío/nuevo.
  const SAVE_KEY = 'neon_ui_state_v1';
  const saveUiState = () => {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify({
        activeTab,
        lastQuery,
        results,
        current,
        activeSrc,
        playingFile,
        q: input.value,
        file: playingFile ? playingFileName : '',
        trackId: !playingFile && current >= 0 && listOf(activeSrc)[current] ? listOf(activeSrc)[current].id : '',
        title: songTitle.textContent,
        artist: songArtist.textContent,
        posMs: nativeMode ? Math.round((nowSec() || 0) * 1000) : 0,
        nativePlaying
      }));
    } catch (ignored) { }
  };
  window.addEventListener('pagehide', saveUiState);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') saveUiState();
  });

  const restoreUiState = () => {
    try {
      if (!nativeMode) return;
      let s = null;
      try { s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (ignored) { }
      if (!s || !Array.isArray(s.results) || !s.results.length) return;
      results = s.results;
      lastQuery = s.lastQuery || '';
      current = typeof s.current === 'number' ? s.current : -1;
      activeSrc = s.activeSrc === 'playlist' ? 'playlist' : 'results';
      playingFile = !!s.playingFile;
      if (s.activeTab === 'playlist' || s.activeTab === 'downloads') switchTab(s.activeTab);
      renderActiveList();
      updateStatusLine();
      if (typeof s.q === 'string') input.value = s.q;
      const n = native();
      if (n && n.getPlaying && n.getPlaying()) {
        nativePlaying = true;
        playIntent = true;
        if (!playingFile && current >= 0 && results[current]) {
          const track = results[current];
          songTitle.textContent = track.title || 'Tema sin título';
          songArtist.textContent = track.channel || 'Artista desconocido';
          document.title = `${track.title} · NEON MUSIC`;
          pushMedia(track);
        }
        setPlaying({ playing: true });
        pushPlaying(true);
        startNativePoll();
        startWave();
        updateLyrics(true);
      }
    } catch (ignored) { }
  };
  restoreUiState();
})();