(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const realAudioEl = document.getElementById('audio');

  // ---- mismo arranque del reproductor original de la app ----
  let __ytReadyDone = false;
  const YT_READY = Promise.race([
    new Promise((resolve) => { window.__ytResolve = (v) => { if (!__ytReadyDone) { __ytReadyDone = true; resolve(v); } }; }),
    new Promise((resolve) => setTimeout(() => { if (!__ytReadyDone) { __ytReadyDone = true; resolve(false); } }, 12000)),
  ]);
  window.onYouTubeIframeAPIReady = () => { if (window.__ytResolve) window.__ytResolve(true); };

  // ---- AudioShim: copia fiel del reproductor original (el que te funciona) ----
  class AudioShim {
    constructor(real) {
      this.real = real;
      this.__isShim = true;
      this.mode = null;
      this._src = '';
      this._ytId = '';
      this._paused = true;
      this._ended = false;
      this._ready = false;
      this._error = null;
      this._volume = 0.8;
      this._muted = false;
      this._listeners = {};
      this._yt = null;
      this._ytResolve = null;
      this._tick = null;
      const fwd = ['timeupdate', 'seeked', 'playing', 'pause', 'ended', 'waiting', 'stalled', 'canplay', 'loadedmetadata', 'error', 'durationchange', 'progress'];
      fwd.forEach((t) => { if (this.real) this.real.addEventListener(t, (e) => this._dispatch(t, e)); });
    }
    addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); }
    removeEventListener(t, fn) { if (this._listeners[t]) this._listeners[t] = this._listeners[t].filter((f) => f !== fn); }
    _dispatch(t, evt) { (this._listeners[t] || []).forEach((fn) => { try { fn(evt || { type: t, target: this }); } catch (e) {} }); }
    get src() { return this._src || ''; }
    set src(v) {
      this._src = v || '';
      if (typeof v === 'string' && v.indexOf('yt:') === 0) {
        this.mode = 'yt';
        this._ytId = v.slice(3);
        this._ended = false; this._error = null;
        if (this.real) { try { this.real.pause(); } catch (e) {} }
      } else {
        this.mode = 'file';
        if (this._yt) { try { this._yt.stopVideo(); } catch (e) {} }
        if (this.real) this.real.src = v || '';
      }
    }
    _ensureYt() {
      if (this._yt && this._yt.loadVideoById) {
        try { this._yt.loadVideoById(this._ytId); } catch (e) { this._yt = null; }
      }
      if (!this._yt) {
        this._yt = new YT.Player('yt-host', {
          videoId: this._ytId,
          playerVars: { autoplay: 1, controls: 0, disablekb: 1, modestbranding: 1, rel: 0, fs: 0, playsinline: 1 },
          events: {
            onReady: () => { this._ready = true; try { this._yt.setVolume(this._volume * 100); } catch (e) {} this._dispatch('loadedmetadata'); this._dispatch('canplay'); },
            onStateChange: (e) => this._onState(e),
            onError: (e) => { const c = (e && e.data) || 1; this._error = { code: c, message: 'YouTube bloqueó este video para reproducción embebida (dueño, región o copyright)' }; this._dispatch('error'); },
          },
        });
      }
    }
    _onState(e) {
      const S = (window.YT && window.YT.PlayerState) || {};
      const st = e && e.data;
      if (st === S.PLAYING) {
        this._paused = false; this._ended = false; this._dispatch('playing'); this._startTick();
        if (this._ytResolve) { this._ytResolve(); this._ytResolve = null; }
      } else if (st === S.PAUSED) {
        this._paused = true; this._stopTick(); this._dispatch('pause');
      } else if (st === S.ENDED) {
        this._paused = true; this._ended = true; this._stopTick(); this._dispatch('ended');
      } else if (st === S.BUFFERING) {
        this._dispatch('waiting');
      } else if (st === S.CUED) {
        this._ready = true; this._dispatch('loadedmetadata');
      }
    }
    _startTick() { this._stopTick(); this._tick = setInterval(() => this._dispatch('timeupdate'), 500); }
    _stopTick() { if (this._tick) { clearInterval(this._tick); this._tick = null; } }
    play() {
      if (this.mode === 'file') return this.real ? this.real.play() : Promise.resolve();
      return YT_READY.then((ok) => {
        if (!ok) { this._error = { code: 1, message: 'No se pudo cargar el reproductor de YouTube' }; this._dispatch('error'); return; }
        this._ensureYt();
        return new Promise((res) => { this._ytResolve = res; });
      });
    }
    pause() {
      if (this.mode === 'file') { if (this.real) this.real.pause(); return; }
      if (this._yt && this._yt.pauseVideo) { try { this._yt.pauseVideo(); } catch (e) {} }
    }
    get paused() { return this.mode === 'yt' ? this._paused : (this.real ? this.real.paused : true); }
    get ended() { return this.mode === 'yt' ? this._ended : (this.real ? this.real.ended : false); }
    get duration() { return this.mode === 'yt' ? (this._yt && this._yt.getDuration ? this._yt.getDuration() : 0) : (this.real ? (this.real.duration || 0) : 0); }
    get currentTime() {
      if (this.mode === 'yt') return this._yt && this._yt.getCurrentTime ? this._yt.getCurrentTime() : 0;
      return this.real ? (this.real.currentTime || 0) : 0;
    }
    set currentTime(v) {
      if (this.mode === 'yt') { if (this._yt && this._yt.seekTo) this._yt.seekTo(v, true); }
      else if (this.real) this.real.currentTime = v;
    }
    get volume() { return this.mode === 'yt' ? (this._yt && this._yt.getVolume ? this._yt.getVolume() / 100 : this._volume) : (this.real ? this.real.volume : this._volume); }
    set volume(v) {
      this._volume = v;
      if (this.mode === 'yt') { if (this._yt && this._yt.setVolume) this._yt.setVolume(v * 100); }
      else if (this.real) this.real.volume = v;
    }
    get muted() { return this.mode === 'yt' ? this._muted : (this.real ? this.real.muted : false); }
    set muted(v) {
      this._muted = v;
      if (this.mode === 'yt') { if (this._yt && this._yt.mute) { if (v) this._yt.mute(); else this._yt.unMute(); } }
      else if (this.real) this.real.muted = v;
    }
    get readyState() { return this.mode === 'yt' ? (this._ready ? 4 : 0) : (this.real ? this.real.readyState : 0); }
    get error() { return this.mode === 'yt' ? this._error : (this.real ? this.real.error : null); }
    load() { if (this.mode === 'file' && this.real) this.real.load(); }
    canPlayType() { return ''; }
    set crossOrigin(v) {}
    set preload(v) { if (this.real) { try { this.real.preload = v; } catch (e) {} } }
    setAttribute() {}
    getAttribute() { return null; }
  }

  const audio = new AudioShim(realAudioEl);

  // ===== Reproducción nativa en el APK (Android) =====
  // El teléfono recibe SOLO el audio del servidor (onrender.com) vía stream, sin
  // tocar YouTube: así YouTube no puede bloquear nada en el móvil y la pantalla
  // puede apagarse / abrir otra app sin que el audio se pause (suena en primer
  // plano mediante un MediaPlayer nativo con wake lock).
  const nativeMode = !!(window.AndroidBridge && window.AndroidBridge.updateTrack);
  const streamCache = new Map();
  const blockedNativeIds = new Set();
  const absoluteUrl = (p) => (p && /^[a-z]+:\/\//i.test(p) ? p : (location.origin + p));
  const resolveStreamUrl = async (id) => {
    if (!id) return '';
    if (streamCache.has(id)) return streamCache.get(id);
    // Intenta 3 modos: raw (URL directa) -> direct (302) -> proxy, para esquivar bloqueo por cliente/IP
    let url = '';
    const tryFetch = async (suffix) => {
      try {
        const r = await fetch('/api/stream/' + encodeURIComponent(id) + suffix);
        if (r.status === 410) { streamCache.set(id, ''); return ''; } // bloqueado permanente, no reintentar
        if (r.ok) {
          const ct = r.headers.get('content-type') || '';
          if (ct.includes('application/json')) {
            const j = await r.json().catch(() => null);
            if (j && j.url) return j.url;
            if (j && j.blocked) return '';
          } else if (r.ok) {
            // proxy devuelve audio directo, usamos la URL del proxy
            return '/api/stream/' + encodeURIComponent(id);
          }
        }
      } catch (e) {}
      return null;
    };
    url = await tryFetch('?raw=1');
    if (url === '') { streamCache.set(id, ''); return ''; }
    if (!url) url = await tryFetch('?direct=1');
    if (!url) url = '/api/stream/' + encodeURIComponent(id);
    // Si el proxy también daría 410, el audio fallará y el handler de error saltará al siguiente
    streamCache.set(id, url);
    return url;
  };
  let nativePlaying = true;
  let lastMasterData = null;

  // ---- UI ----
  const elStation = $('#station');
  const elTitle = $('#song-title');
  const elArtist = $('#song-artist');
  const elCover = $('#cover');
  const playBtn = $('#btn-play');
  const vol = $('#volume');
  const dot = $('#dot');
  const vinyl = $('#vinyl');
  const statusEl = $('#status');

  let currentSource = 'idle'; // 'master' | 'local'
  let currentYtId = '';
  let userPaused = false;
  let localQueue = [];
  let localGenre = 'pop';
  let localCount = 0;
  let playingJingle = false;
  const blockedIds = new Set(); // videos bloqueados por YouTube (no se repiten, modo web)
  const GENRES = ['pop', 'rock', 'reggaeton', 'musica latina', 'clasicos de los 80', 'exitos 2024'];
  const JINGLE = '/station-id.mp3'; // cortina "Estás escuchando Neon Music" entre temas

  const setIcon = () => { playBtn.textContent = audio.paused ? '▶' : '⏸'; };
  const setIconNative = () => { playBtn.textContent = nativePlaying ? '⏸' : '▶'; };
  const spin = (on) => { if (vinyl) vinyl.classList.toggle('playing', on); };

  audio.addEventListener('playing', () => { if (nativeMode) return; spin(true); setIcon(); userPaused = false; statusEl.textContent = ''; });
  audio.addEventListener('pause', () => { if (nativeMode) return; spin(false); setIcon(); });
  audio.addEventListener('ended', () => {
    if (nativeMode) return;
    if (currentSource === 'local') {
      if (playingJingle) { playingJingle = false; startLocal(); }
      else { playJingle(); }
    }
  });
  audio.addEventListener('error', () => {
    if (nativeMode) return;
    if (currentSource === 'local') {
      if (currentYtId && currentYtId !== JINGLE) blockedIds.add(currentYtId);
      statusEl.textContent = 'Esperando transmisión…';
      startLocal();
    } else if (currentSource === 'master') {
      statusEl.textContent = 'Esperando al DJ…';
    }
  });

  const setTrack = async (id, info) => {
    currentYtId = id;
    const t = info ? (info.title || 'NEON MUSIC') : 'NEON MUSIC';
    const a = info ? (info.artist || '') : '';
    userPaused = false;
    playBtn.disabled = false; vol.disabled = false;
    if (info) {
      elTitle.textContent = info.title || 'NEON MUSIC';
      elArtist.textContent = info.artist || '';
      if (info.thumbnail) { elCover.src = info.thumbnail; elCover.style.display = 'block'; }
      else elCover.style.display = 'none';
    }
    // Stream en el servidor (yt-dlp) para que YouTube no bloquee embebido.
    // Si el servidor responde 410/bloqueado, saltamos inmediato al siguiente sin pausar.
    const url = await resolveStreamUrl(id);
    if (currentYtId !== id) return; // el tema ya cambió mientras resolvíamos
    if (!url) {
      // Video bloqueado en todos los modos -> marcar y saltar sin mostrar bloqueo
      if (id !== JINGLE) {
        if (currentSource === 'local') blockedIds.add(id);
        else blockedNativeIds.add(id);
      }
      if (currentSource === 'local') { playLocalNext(); return; }
      if (currentSource === 'master') { masterGone().then(g=>{ if(g) startLocal(); }); return; }
      return;
    }
    // Avisa al reproductor nativo (APK): título, artista y URL absoluta del stream.
    try {
      if (window.AndroidBridge && window.AndroidBridge.updateTrack) {
        window.AndroidBridge.updateTrack(t, a, absoluteUrl(url) || '');
      }
    } catch (e) {}
    if (nativeMode) return; // suena el MediaPlayer nativo; el WebView queda en silencio
    // Web: reproducimos el stream directo (sin yt: embebido) para que no bloquee.
    audio.muted = false;
    audio.src = url; audio.play().catch(() => {});
  };

  // ---- modo master: sigue lo que el DJ está poniendo ----
  const followMaster = (d) => {
    if (currentSource !== 'master' || currentYtId !== d.id) {
      currentSource = 'master';
      setTrack(d.id, d);
      elStation.textContent = (d.station && d.station.trim()) ? d.station.toUpperCase() : 'NEON MUSIC';
    }
    if (nativeMode) return; // el reproductor nativo maneja play/pausa en el APK
    if (d.playing && audio.paused && !userPaused) { audio.play().catch(() => {}); }
    else if (!d.playing && !audio.paused) { audio.pause(); }
  };

  // ---- modo escucha puro: solo reproduce lo que emite el DJ en onrender ----
  // Sin radio local ni búsquedas propias: si no hay master, espera.
  const playJingle = () => {
    playingJingle = true;
    currentYtId = JINGLE;
    elStation.textContent = 'NEON MUSIC';
    elTitle.textContent = 'Estás escuchando Neon Music';
    elArtist.textContent = '';
    elCover.style.display = 'none';
    spin(true);
    const jurl = absoluteUrl(JINGLE);
    try { if (window.AndroidBridge && window.AndroidBridge.updateTrack) window.AndroidBridge.updateTrack('Estás escuchando Neon Music', '', jurl); } catch (e) {}
    if (nativeMode) return;
    audio.muted = false; audio.src = JINGLE; audio.play().catch(() => {});
  };
  // Placeholders para compatibilidad con handlers nativos (ya no hay cola local)
  const playLocalNext = async () => {};
  const startLocal = async () => {
    currentSource = 'idle';
    elStation.textContent = 'NEON MUSIC · EN ESPERA';
    statusEl.textContent = 'Esperando transmisión del DJ…';
    spin(false);
  };

  // ---- consulta el estado del master ----
  const poll = async () => {
    try {
      const r = await fetch('/api/nowplaying');
      const d = await r.json();
      if (dot) dot.className = 'dot on';
      if (d && d.id) {
        lastMasterData = d;
        followMaster(d);
      } else if (currentSource !== 'local') {
        startLocal();
      }
    } catch (e) {
      if (dot) dot.className = 'dot off';
      if (currentSource !== 'local') statusEl.textContent = 'Sin conexión con la radio…';
    }
  };

  // Llamados desde el reproductor nativo (APK) cuando un tema termina o falla.
  // Si el DJ (master) sigue activo, nos sincronizamos con su siguiente tema; si
  // no (PC apagada / sin DJ), el Auto-DJ local sigue sonando sin parar.
  const masterGone = async () => {
    try {
      const r = await fetch('/api/nowplaying');
      const d = await r.json();
      if (d && d.id && d.id !== currentYtId) { followMaster(d); return false; }
    } catch (e) {}
    return true;
  };
  window.__neonTrackEnded = () => {
    if (currentSource === 'local') {
      if (playingJingle) { playingJingle = false; startLocal(); }
      else { playJingle(); }
    } else if (currentSource === 'master') {
      masterGone().then((gone) => { if (gone) startLocal(); });
    }
  };
  window.__neonTrackError = () => {
    if (currentSource === 'local') {
      if (currentYtId && currentYtId !== JINGLE) blockedNativeIds.add(currentYtId);
      if (playingJingle) { playingJingle = false; startLocal(); }
      else { startLocal(); }
    } else if (currentSource === 'master') {
      if (currentYtId && currentYtId !== JINGLE) blockedNativeIds.add(currentYtId);
      masterGone().then((gone) => { if (gone) startLocal(); });
    }
  };

  // Play/Pausa: si está sonando, pausa. Si está pausado, reanuda y se sincroniza
  // con lo que Neon Music está emitiendo en este momento (master) o sigue la radio.
  playBtn.addEventListener('click', () => {
    if (nativeMode) {
      nativePlaying = !nativePlaying;
      setIconNative();
      try { if (window.AndroidBridge && window.AndroidBridge.setPlaying) window.AndroidBridge.setPlaying(nativePlaying); } catch (e) {}
      return;
    }
    if (!audio.paused) { audio.pause(); userPaused = true; return; }
    userPaused = false;
    if (lastMasterData && lastMasterData.id) {
      followMaster(lastMasterData);
    } else {
      startLocal();
    }
  });

  // Autoarranque: intenta sonar al cargar; si el navegador lo bloquea, el primer
  // toque en cualquier parte de la página lo libera (política de autoplay).
  const unlock = () => {
    if (nativeMode) return;
    if (currentYtId && audio.paused && !userPaused) audio.play().catch(() => {});
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('touchstart', unlock);

  vol.addEventListener('input', () => {
    vol.style.setProperty('--pct', vol.value + '%');
    if (nativeMode) { try { if (window.AndroidBridge && window.AndroidBridge.setVolume) window.AndroidBridge.setVolume(parseInt(vol.value, 10) || 0); } catch (e) {} }
    else audio.volume = vol.value / 100;
  });
  vol.style.setProperty('--pct', '80%');
  vol.value = 80;
  audio.volume = 0.8;

  if (nativeMode) {
    setIconNative();
    try { if (window.AndroidBridge && window.AndroidBridge.setVolume) window.AndroidBridge.setVolume(80); } catch (e) {}
  }
  setInterval(poll, 1500);
  poll();
})();
