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

  // ---- AudioShim: copia fiel del reproductor original (este es el que te funciona) ----
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
            onReady: () => { this._ready = true; this._dispatch('loadedmetadata'); this._dispatch('canplay'); },
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

  // ---- UI del listener (play + volumen, sigue al master) ----
  const elStation = $('#station');
  const elTitle = $('#song-title');
  const elArtist = $('#song-artist');
  const elCover = $('#cover');
  const playBtn = $('#btn-play');
  const vol = $('#volume');
  const dot = $('#dot');
  const vinyl = $('#vinyl');
  const statusEl = $('#status');

  let currentId = '';
  let localPaused = false; // el amigo pausó manualmente
  let lastData = { id: '', title: '', artist: '', thumbnail: '', playing: false, station: '' };

  const setIcon = () => { playBtn.textContent = audio.paused ? '▶' : '⏸'; };
  const spin = (on) => { if (vinyl) vinyl.classList.toggle('playing', on); };

  audio.addEventListener('playing', () => { spin(true); setIcon(); localPaused = false; statusEl.textContent = ''; });
  audio.addEventListener('pause', () => { spin(false); setIcon(); });
  audio.addEventListener('error', () => { statusEl.textContent = 'Este tema está bloqueado por YouTube; esperando el siguiente…'; });

  // Refleja el estado del master: cambia de tema y obedece play/pausa del DJ.
  const applyMaster = () => {
    if (!lastData.id) { playBtn.disabled = true; vol.disabled = true; return; }
    if (lastData.id !== currentId) {
      currentId = lastData.id;
      localPaused = false;
      audio.src = 'yt:' + lastData.id;
      audio.play().catch(() => {});
      playBtn.disabled = false; vol.disabled = false;
    }
    if (lastData.playing && audio.paused && !localPaused) { audio.play().catch(() => {}); }
    else if (!lastData.playing && !audio.paused) { audio.pause(); }
  };

  const render = (d) => {
    elStation.textContent = (d.station && d.station.trim()) ? d.station.toUpperCase() : 'NEON MUSIC';
    elTitle.textContent = d.id ? (d.title || 'NEON MUSIC') : 'NEON MUSIC';
    elArtist.textContent = d.id ? (d.artist || '') : '';
    if (d.thumbnail) { elCover.src = d.thumbnail; elCover.style.display = 'block'; }
    else elCover.style.display = 'none';
  };

  const poll = async () => {
    try {
      const r = await fetch('/api/nowplaying');
      const d = await r.json();
      if (dot) dot.className = 'dot on';
      lastData = d || lastData;
      render(d);
      applyMaster();
    } catch (e) {
      if (dot) dot.className = 'dot off';
      statusEl.textContent = 'Sin conexión con la radio…';
    }
  };

  playBtn.addEventListener('click', () => {
    if (!currentId) return;
    if (audio.paused) { audio.play().catch(() => {}); localPaused = false; }
    else { audio.pause(); localPaused = true; }
  });

  vol.addEventListener('input', () => { audio.volume = vol.value / 100; vol.style.setProperty('--pct', vol.value + '%'); });
  vol.style.setProperty('--pct', '80%');
  audio.volume = 0.8;

  setInterval(poll, 1500);
  poll();
})();
