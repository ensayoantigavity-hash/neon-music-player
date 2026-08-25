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
  const blockedIds = new Set(); // videos bloqueados por YouTube (no se repiten)
  const GENRES = ['pop', 'rock', 'reggaeton', 'musica latina', 'clasicos de los 80', 'exitos 2024'];
  const JINGLE = '/station-id.mp3'; // cortina "Estás escuchando Neon Music" entre temas

  const setIcon = () => { playBtn.textContent = audio.paused ? '▶' : '⏸'; };
  const spin = (on) => { if (vinyl) vinyl.classList.toggle('playing', on); };

  audio.addEventListener('playing', () => { spin(true); setIcon(); userPaused = false; statusEl.textContent = ''; });
  audio.addEventListener('pause', () => { spin(false); setIcon(); });
  audio.addEventListener('ended', () => {
    if (currentSource !== 'local') return;
    if (playingJingle) { playingJingle = false; playLocalNext(); }
    else { playJingle(); }
  });
  audio.addEventListener('error', () => {
    if (currentSource === 'local') {
      if (currentYtId && currentYtId !== JINGLE) blockedIds.add(currentYtId);
      statusEl.textContent = 'Bloqueado por YouTube · saltando al siguiente…';
      playLocalNext();
    } else if (currentSource === 'master') {
      statusEl.textContent = 'Este tema está bloqueado por YouTube en tu región; sigue al DJ…';
    }
  });

  const setTrack = (id, info) => {
    currentYtId = id;
    audio.src = 'yt:' + id;
    audio.play().catch(() => {});
    userPaused = false;
    playBtn.disabled = false; vol.disabled = false;
    if (info) {
      elTitle.textContent = info.title || 'NEON MUSIC';
      elArtist.textContent = info.artist || '';
      if (info.thumbnail) { elCover.src = info.thumbnail; elCover.style.display = 'block'; }
      else elCover.style.display = 'none';
    }
  };

  // ---- modo master: sigue lo que el DJ está poniendo ----
  const followMaster = (d) => {
    if (currentSource !== 'master' || currentYtId !== d.id) {
      currentSource = 'master';
      setTrack(d.id, d);
      elStation.textContent = (d.station && d.station.trim()) ? d.station.toUpperCase() : 'NEON MUSIC';
    }
    if (d.playing && audio.paused && !userPaused) { audio.play().catch(() => {}); }
    else if (!d.playing && !audio.paused) { audio.pause(); }
  };

  // ---- modo local: radio propia cuando nadie transmite ----
  const fetchBatch = async (genre) => {
    try {
      const r = await fetch('/api/search?q=' + encodeURIComponent(genre) + '&type=playlist');
      const j = await r.json();
      if (j && Array.isArray(j.results) && j.results.length) return j.results;
    } catch (e) {}
    return [];
  };

  const playLocalNext = async () => {
    if (currentSource !== 'local') return;
    if (!localQueue.length) {
      statusEl.textContent = 'Cargando radio…';
      let batch = await fetchBatch(localGenre);
      if (!batch.length) {
        localGenre = GENRES[(GENRES.indexOf(localGenre) + 1) % GENRES.length];
        batch = await fetchBatch(localGenre);
      }
      if (currentSource !== 'local') return;
      if (batch.length) localQueue = batch; else { statusEl.textContent = 'Sin conexión con la radio…'; return; }
    }
    const t = localQueue.shift();
    if (!t || !t.id) return;
    if (blockedIds.has(t.id)) return playLocalNext();
    elStation.textContent = 'NEON MUSIC · RADIO';
    setTrack(t.id, t);
    statusEl.textContent = '';
    localCount++;
    if (localCount % 12 === 0) localGenre = GENRES[(GENRES.indexOf(localGenre) + 1) % GENRES.length];
  };

  const startLocal = async () => {
    currentSource = 'local';
    elStation.textContent = 'NEON MUSIC · RADIO';
    await playLocalNext();
  };

  // cortina de identidad de la radio entre tema y tema
  const playJingle = () => {
    playingJingle = true;
    currentYtId = JINGLE;
    elStation.textContent = 'NEON MUSIC';
    elTitle.textContent = 'Estás escuchando Neon Music';
    elArtist.textContent = '';
    elCover.style.display = 'none';
    spin(true);
    audio.src = JINGLE; // modo archivo: usa el <audio> real
    audio.play().catch(() => {});
  };

  // ---- consulta el estado del master ----
  const poll = async () => {
    try {
      const r = await fetch('/api/nowplaying');
      const d = await r.json();
      if (dot) dot.className = 'dot on';
      if (d && d.id) {
        followMaster(d);
      } else if (currentSource !== 'local') {
        startLocal();
      }
    } catch (e) {
      if (dot) dot.className = 'dot off';
      if (currentSource !== 'local') statusEl.textContent = 'Sin conexión con la radio…';
    }
  };

  // Play/Pausa: si está sonando, pausa. Si está pausado, reanuda y se sincroniza
  // con lo que Neon Music está emitiendo en este momento (master) o sigue la radio.
  playBtn.addEventListener('click', () => {
    if (!audio.paused) { audio.pause(); userPaused = true; return; }
    userPaused = false;
    if (lastData && lastData.id) {
      followMaster(lastData);            // sincroniza al tema actual del master
    } else if (currentSource === 'local') {
      if (currentYtId && currentYtId !== JINGLE) audio.play().catch(() => {});
      else playLocalNext();              // no hay tema local aún: busca uno
    } else {
      startLocal();                      // arranca la radio autónoma
    }
  });

  // Autoarranque: intenta sonar al cargar; si el navegador lo bloquea, el primer
  // toque en cualquier parte de la página lo libera (política de autoplay).
  const unlock = () => {
    if (currentYtId && audio.paused && !userPaused) audio.play().catch(() => {});
    window.removeEventListener('pointerdown', unlock);
    window.removeEventListener('touchstart', unlock);
  };
  window.addEventListener('pointerdown', unlock);
  window.addEventListener('touchstart', unlock);

  vol.addEventListener('input', () => { audio.volume = vol.value / 100; vol.style.setProperty('--pct', vol.value + '%'); });
  vol.style.setProperty('--pct', '80%');
  audio.volume = 0.8;

  setInterval(poll, 1500);
  poll();
})();
