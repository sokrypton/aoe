let audioCtx = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

// resume() before any user gesture is guaranteed to fail, and Chrome logs
// "The AudioContext was not allowed to start" for EVERY attempt — a match
// resumed on a freshly reloaded page (no gesture yet) fires sounds every
// tick and floods the console with tens of thousands of these. Try once,
// then stop until a real gesture (the pointerdown/keydown hook below)
// unlocks the context and clears the latch.
let _audioResumeBlocked = false;
function tryResumeAudio() {
  if (!audioCtx || audioCtx.state !== 'suspended' || _audioResumeBlocked) return;
  _audioResumeBlocked = true;
  audioCtx.resume().then(() => { _audioResumeBlocked = false; }).catch(() => {});
}

// ---- SHARED SYNTH INFRASTRUCTURE ----

// Master bus: everything routes through a gentle compressor so stacked
// events (battles) glue together instead of clipping.
let masterOut = null;
function getMaster() {
  if (!masterOut) {
    masterOut = audioCtx.createDynamicsCompressor();
    masterOut.threshold.value = -18;
    masterOut.knee.value = 12;
    masterOut.ratio.value = 5;
    masterOut.attack.value = 0.003;
    masterOut.release.value = 0.2;
    masterOut.connect(audioCtx.destination);
  }
  return masterOut;
}

// One reusable second of white noise for every impact/scrape/whoosh.
let _noiseBuf = null;
function noiseBuffer() {
  if (!_noiseBuf) {
    const len = audioCtx.sampleRate;
    _noiseBuf = audioCtx.createBuffer(1, len, audioCtx.sampleRate);
    const d = _noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = cosmeticRandom() * 2 - 1;
  }
  return _noiseBuf;
}

function rnd(a, b) { return a + cosmeticRandom() * (b - a); }

// Single enveloped oscillator note.
function tone(out, now, { type = 'sine', f0 = 440, f1 = null, t0 = 0, dur = 0.1, vol = 0.1, att = 0.005, detune = 0 }) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = type;
  o.detune.value = detune;
  o.frequency.setValueAtTime(f0, now + t0);
  if (f1) o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), now + t0 + dur);
  g.gain.setValueAtTime(0.0001, now + t0);
  g.gain.linearRampToValueAtTime(vol, now + t0 + att);
  g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + dur);
  o.connect(g); g.connect(out);
  o.start(now + t0); o.stop(now + t0 + dur + 0.05);
}

// Filtered noise burst.
function noiseHit(out, now, { t0 = 0, dur = 0.1, vol = 0.1, type = 'bandpass', f0 = 1000, f1 = null, q = 1, att = 0.003 }) {
  const src = audioCtx.createBufferSource();
  src.buffer = noiseBuffer(); src.loop = true;
  const fl = audioCtx.createBiquadFilter();
  fl.type = type;
  fl.frequency.setValueAtTime(f0, now + t0);
  if (f1) fl.frequency.exponentialRampToValueAtTime(Math.max(10, f1), now + t0 + dur);
  fl.Q.value = q;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, now + t0);
  g.gain.linearRampToValueAtTime(vol, now + t0 + att);
  g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + dur);
  src.connect(fl); fl.connect(g); g.connect(out);
  src.start(now + t0); src.stop(now + t0 + dur + 0.05);
}

// Builds an output node whose volume and stereo pan reflect where the event
// sits relative to the current camera view: full volume centered on screen,
// fading and panning as it moves off-view, silent about two screens away.
// Returns null when the event is too far off-view to hear at all.
function spatialOut(wx, wy) {
  if (typeof toIso !== 'function' || typeof camX === 'undefined') return getMaster();
  let iso = toIso(wx, wy);
  let zoom = (typeof ZOOM !== 'undefined') ? ZOOM : 1;
  let nx = ((iso.ix - camX) * zoom) / (W / 2);   // 0 = screen center, ±1 = screen edge
  let ny = ((iso.iy - camY) * zoom) / (H / 2);
  let edge = Math.max(Math.abs(nx), Math.abs(ny));
  let vol = edge <= 1 ? 1 : Math.max(0, 1 - (edge - 1) / 2);
  if (vol <= 0.02) return null;
  let g = audioCtx.createGain();
  g.gain.value = vol;
  if (audioCtx.createStereoPanner) {
    let p = audioCtx.createStereoPanner();
    p.pan.value = Math.max(-1, Math.min(1, nx)) * 0.7;
    g.connect(p); p.connect(getMaster());
  } else {
    g.connect(getMaster());
  }
  return g;
}

let _lastSoundAt = {};

// Sounds that still play in "Alerts Only" mode: the things you must not
// miss even with effects off (AoE2's minimal-audio style).
// 'chat' counts as an alert: an opponent's message is communication you
// asked for by playing multiplayer, not battlefield ambience to mute.
const ALERT_ONLY_SOUNDS = new Set(['alert', 'victory', 'defeat', 'bell', 'bell_clear', 'chat', 'farm_exhausted']);

// Sounds allowed while the game is PAUSED (menu open, opponent's menu open,
// mid-reconnect). World SFX are implicitly silent then (the sim isn't
// running) but local UI sounds from input.js aren't — this makes the pause
// gate explicit instead of relying on "all world-SFX callers live in
// update()". Exempt: chat/alerts (legitimately arrive with the menu open in
// MP), the menu's own clicks, and the end-of-game stingers.
const PAUSE_EXEMPT_SOUNDS = new Set(['chat', 'alert', 'click', 'error', 'victory', 'defeat', 'bell', 'bell_clear']);

function playSound(type, wx, wy) {
  if (window.__resim) return; // rollback resim replays past ticks silently (js/lockstep.js)
  if (window.audioMuted) return;
  let mode = window.soundMode || 'all';
  if (mode === 'off') return;
  if (mode === 'alerts' && !ALERT_ONLY_SOUNDS.has(type)) return;
  if (typeof gamePaused !== 'undefined' && gamePaused && !PAUSE_EXEMPT_SOUNDS.has(type)) return;
  try {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      tryResumeAudio();
      // Still suspended (no user gesture yet on this page — e.g. a freshly
      // reloaded host mid-recovery): skip scheduling entirely. currentTime
      // is frozen while suspended, so queued events would all pile onto the
      // same instant and blast at once on the unlocking click.
      if (audioCtx.state === 'suspended') return;
    }

    // Rate-limit per sound type so a crowd of identical events (a mob all
    // striking at once) doesn't stack into one loud clang.
    let nowMs = performance.now();
    if (nowMs - (_lastSoundAt[type] || 0) < 45) return;
    _lastSoundAt[type] = nowMs;

    // Positional events route through the view-relative output; events with
    // no position (UI, fanfares, alerts) stay at full center volume.
    let out = getMaster();
    if (wx !== undefined) {
      // Events hidden by the fog of war are silent — you only hear what you
      // can currently see (own units always carry vision with them).
      if (typeof fog !== 'undefined' && fog.length) {
        let tx = Math.round(wx), ty = Math.round(wy);
        if (tx < 0 || ty < 0 || tx >= MAP || ty >= MAP || fog[ty][tx] !== 2) return;
      }
      out = spatialOut(wx, wy);
      if (out === null) return; // too far off-view to hear
    }

    let now = audioCtx.currentTime;
    // Every effect gets a fresh pitch factor so repetitive work never plays
    // the exact same sound twice — the single biggest "organic" win.
    let p = rnd(0.9, 1.12);

    switch (type) {
      case 'chop': {
        // Axe on wood: sharp thwack, low body knock, occasional fiber crack
        noiseHit(out, now, { dur: 0.045, vol: 0.2, type: 'bandpass', f0: 900 * p, f1: 250, q: 0.8 });
        tone(out, now, { type: 'triangle', f0: 300 * p, f1: 85, dur: 0.055, vol: 0.17 });
        tone(out, now, { type: 'triangle', f0: 110 * p, f1: 38, dur: 0.18, vol: 0.13 });
        if (cosmeticRandom() < 0.15) {
          // fiber crack, kept in the mids — high-pitched accents read harsh
          noiseHit(out, now, { t0: 0.02, dur: 0.09, vol: 0.05, type: 'bandpass', f0: 1300, q: 1 });
        }
        break;
      }
      case 'mine': {
        // Pick on rock: inharmonic metallic partials + stone chink.
        // Deliberately subtle — this plays constantly from every miner, so it
        // sits lower in pitch and volume than one-off event sounds.
        const base = 170 * p;
        [[1, 0.06], [2.76, 0.038], [5.4, 0.024], [8.93, 0.012]].forEach(([mult, vol], i) => {
          tone(out, now, { type: 'sine', f0: base * mult, f1: base * mult * 0.94, dur: 0.2 + i * 0.02, vol, detune: rnd(-8, 8) });
        });
        noiseHit(out, now, { dur: 0.03, vol: 0.06, type: 'bandpass', f0: 1400, q: 1.2 }); // stone chink, mids not treble
        break;
      }
      case 'build': {
        // Hammer on frame: woody knock + mallet noise, sometimes a double tap
        const knock = (t0) => {
          tone(out, now, { type: 'square', f0: 95 * p, f1: 34, t0, dur: 0.09, vol: 0.13 });
          noiseHit(out, now, { t0, dur: 0.05, vol: 0.16, type: 'lowpass', f0: 650, q: 0.7 });
        };
        knock(0);
        if (Math.random() < 0.35) knock(0.13);
        break;
      }
      case 'forage':
      case 'farm': {
        // Leafy rustle: two staggered soft noise brushes
        noiseHit(out, now, { dur: 0.13, vol: 0.11, type: 'bandpass', f0: rnd(420, 720), q: 1.8 });
        noiseHit(out, now, { t0: 0.07, dur: 0.1, vol: 0.07, type: 'bandpass', f0: rnd(600, 900), q: 2.2 });
        break;
      }
      case 'farm_exhausted': {
        // "Field ran dry" notification — a soft DESCENDING two-note chime
        // (C5→G4), the opposite motif to 'chat's rising blips and 'train's
        // fanfare, so it reads unmistakably as "depleted / needs attention".
        // A dry leafy-rustle tail roots it in farming. Non-positional (played
        // via feedbackFor for the owning human only) so it alerts regardless of
        // where the view is, like AoE2's farm-exhausted cue.
        tone(out, now, { type: 'triangle', f0: 523.25, f1: 515, t0: 0,    dur: 0.15, vol: 0.12 });
        tone(out, now, { type: 'triangle', f0: 392.0,  f1: 384, t0: 0.13, dur: 0.28, vol: 0.12 });
        noiseHit(out, now, { t0: 0.13, dur: 0.18, vol: 0.05, type: 'bandpass', f0: 520, q: 2 });
        break;
      }
      case 'ram_hit': {
        // Battering ram strike: a LOT of mass landing — deep timber boom,
        // sharp splintering crack, masonry debris. Sits between 'build'
        // (light hammer) and 'collapse' (whole building) in weight.
        // Impact crack first, so the transient reads on small speakers.
        noiseHit(out, now, { dur: 0.07, vol: 0.24, type: 'bandpass', f0: 1100 * p, f1: 500, q: 1.1 });
        // Heavy wooden boom body
        tone(out, now, { type: 'square', f0: 130 * p, f1: 42, dur: 0.16, vol: 0.14 });
        tone(out, now, { type: 'sine', f0: 70 * p, f1: 34, dur: 0.34, vol: 0.14, att: 0.008 });
        // A little rubble settling after the blow
        [0.09, 0.17].forEach(t0 => {
          noiseHit(out, now, { t0, dur: 0.05, vol: 0.08, type: 'bandpass', f0: rnd(600, 1300), q: 1.6 });
        });
        break;
      }
      case 'ram_creak': {
        // Rolling ram: slow wooden axle creak — a pitch-bent groan in the
        // low mids plus a faint wheel rumble. Quiet by design: it repeats
        // the whole march, ambience rather than event.
        const f = rnd(140, 190) * p;
        tone(out, now, { type: 'sawtooth', f0: f, f1: f * 1.35, dur: 0.22, vol: 0.035, att: 0.05 });
        tone(out, now, { type: 'sawtooth', f0: f * 0.51, f1: f * 0.62, t0: 0.05, dur: 0.18, vol: 0.025, att: 0.04 });
        noiseHit(out, now, { dur: 0.3, vol: 0.03, type: 'lowpass', f0: 240, q: 0.7, att: 0.06 });
        break;
      }
      case 'attack': {
        // Steel clash: bright inharmonic ring + metal scrape
        const base = 520 * p;
        tone(out, now, { type: 'sawtooth', f0: base, f1: base * 0.25, dur: 0.14, vol: 0.07 });
        tone(out, now, { type: 'sine', f0: base * 1.83, f1: base * 0.6, dur: 0.11, vol: 0.06, detune: rnd(-12, 12) });
        tone(out, now, { type: 'sine', f0: base * 2.79, f1: base * 1.1, dur: 0.09, vol: 0.04 });
        noiseHit(out, now, { dur: 0.09, vol: 0.13, type: 'highpass', f0: 1900, q: 0.7 });
        break;
      }
      case 'arrow': {
        // Airy whoosh: rising band-swept noise, not a synth beep
        noiseHit(out, now, { dur: 0.16, vol: 0.2, type: 'bandpass', f0: 600 * p, f1: 2600 * p, q: 2.4, att: 0.03 });
        break;
      }
      case 'select_villager': {
        // Short low vocal hum — villagers always answer in a low register
        let baseFreq = 130 * rnd(0.95, 1.06);
        const fl = audioCtx.createBiquadFilter();
        fl.type = 'lowpass';
        fl.frequency.value = 330;
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.09, now + 0.03);
        g.gain.setValueAtTime(0.09, now + 0.1);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        const o1 = audioCtx.createOscillator();
        o1.type = 'sawtooth';
        o1.frequency.setValueAtTime(baseFreq, now);
        o1.frequency.linearRampToValueAtTime(baseFreq + 18, now + 0.14);
        const o2 = audioCtx.createOscillator();
        o2.type = 'triangle';
        o2.frequency.setValueAtTime(baseFreq * 2, now);
        o1.connect(fl); o2.connect(fl); fl.connect(g); g.connect(out);
        o1.start(now); o2.start(now);
        o1.stop(now + 0.2); o2.stop(now + 0.2);
        break;
      }
      case 'select_military': {
        // Firm gauntlet-on-shield acknowledgement
        tone(out, now, { type: 'triangle', f0: 140 * p, f1: 68, dur: 0.14, vol: 0.08 });
        tone(out, now, { type: 'sine', f0: 320 * p, f1: 175, dur: 0.09, vol: 0.06 });
        noiseHit(out, now, { dur: 0.04, vol: 0.06, type: 'lowpass', f0: 900, q: 0.7 });
        break;
      }
      case 'train': {
        // Herald trumpet: two-voice detuned brass through a lowpass, C-E-G-C
        const notes = [261.63, 329.63, 392.0, 523.25];
        const fl = audioCtx.createBiquadFilter();
        fl.type = 'lowpass';
        fl.frequency.setValueAtTime(900, now);
        fl.frequency.linearRampToValueAtTime(1600, now + 0.25);
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.055, now + 0.02);
        g.gain.setValueAtTime(0.055, now + 0.3);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.5);
        fl.connect(g); g.connect(out);
        notes.forEach((freq, i) => {
          [-6, 6].forEach(det => {
            const o = audioCtx.createOscillator();
            o.type = 'sawtooth';
            o.detune.value = det;
            o.frequency.setValueAtTime(freq, now + i * 0.04);
            o.connect(fl);
            o.start(now + i * 0.04);
            o.stop(now + 0.5);
          });
        });
        break;
      }
      case 'chat': {
        // Two quick soft sine blips, rising — unmistakably "message", quiet
        // enough to never compete with combat audio.
        [660, 880].forEach((freq, i) => {
          const o = audioCtx.createOscillator();
          const g = audioCtx.createGain();
          o.type = 'sine';
          o.frequency.setValueAtTime(freq, now + i * 0.09);
          g.gain.setValueAtTime(0.0001, now + i * 0.09);
          g.gain.linearRampToValueAtTime(0.045, now + i * 0.09 + 0.015);
          g.gain.exponentialRampToValueAtTime(0.001, now + i * 0.09 + 0.12);
          o.connect(g); g.connect(out);
          o.start(now + i * 0.09);
          o.stop(now + i * 0.09 + 0.13);
        });
        break;
      }
      case 'bell':
      case 'bell_clear': {
        // Church bell: a struck bell is defined by its inharmonic partials —
        // hum (0.5), prime (1), tierce (minor third ~1.2), quint (1.5),
        // nominal (2) — with the low partials ringing far longer than the
        // bright ones, plus a short clapper "clank" at the strike.
        const strike = (t0, base, volMul, ringDur) => {
          [ [0.5,  0.30, 1.00],   // hum — longest ring
            [1.0,  0.34, 0.80],   // prime
            [1.19, 0.20, 0.55],   // tierce — gives the bell its minor-key wistfulness
            [1.5,  0.12, 0.45],   // quint
            [2.0,  0.16, 0.35],   // nominal — the "note" you whistle back
            [2.74, 0.07, 0.22],   // upper partials — strike brightness
            [3.76, 0.045,0.15]
          ].forEach(([mult, vol, durMul]) => {
            tone(out, now, { type: 'sine', f0: base * mult, f1: base * mult * 0.997,
              t0, dur: ringDur * durMul, vol: vol * volMul, att: 0.004, detune: rnd(-4, 4) });
          });
          // Clapper impact: brief metallic clank
          noiseHit(out, now, { t0, dur: 0.025, vol: 0.14 * volMul, type: 'bandpass', f0: base * 4.2, q: 1.4 });
        };
        if (type === 'bell') {
          // Alarm: three urgent strikes of a heavy town bell
          const base = 233 * rnd(0.99, 1.01); // ~Bb3 nominal at 2x
          strike(0,    base, 1.0,  2.6);
          strike(0.55, base, 0.92, 2.6);
          strike(1.1,  base, 1.0,  3.2);
        } else {
          // All clear: two lighter, brighter chimes, the second a fourth up —
          // reads as "question resolved" rather than danger
          const base = 349 * rnd(0.99, 1.01); // F4
          strike(0,   base,        0.65, 1.8);
          strike(0.4, base * 4/3,  0.6,  2.2);
        }
        break;
      }
      case 'alert': {
        // War horn: low detuned blast that swells, unmistakably "danger"
        const fl = audioCtx.createBiquadFilter();
        fl.type = 'lowpass';
        fl.frequency.setValueAtTime(500, now);
        fl.frequency.linearRampToValueAtTime(1100, now + 0.3);
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.09, now + 0.08);
        g.gain.setValueAtTime(0.09, now + 0.4);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.7);
        fl.connect(g); g.connect(out);
        [196, 196 * 1.007, 98].forEach(freq => {
          const o = audioCtx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(freq, now);
          o.frequency.setValueAtTime(freq * 0.89, now + 0.35);
          o.connect(fl);
          o.start(now); o.stop(now + 0.72);
        });
        break;
      }
      case 'bear': {
        // Low rumbling growl: detuned saws sliding down through a dark
        // lowpass, with a slow wobble so it reads "animal", not "engine"
        const bp = rnd(0.9, 1.15);
        const fl = audioCtx.createBiquadFilter();
        fl.type = 'lowpass';
        fl.frequency.setValueAtTime(420 * bp, now);
        fl.frequency.linearRampToValueAtTime(180 * bp, now + 0.5);
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.09, now + 0.06);
        g.gain.setValueAtTime(0.09, now + 0.35);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.6);
        const lfo = audioCtx.createOscillator();
        const lfoGain = audioCtx.createGain();
        lfo.frequency.value = rnd(18, 24);
        lfoGain.gain.value = 6 * bp;
        lfo.connect(lfoGain); // wire the growl wobble (was missing — LFO ran connected to nothing)
        fl.connect(g); g.connect(out);
        [72, 72 * 1.02, 108].forEach(freq => {
          const o = audioCtx.createOscillator();
          o.type = 'sawtooth';
          o.frequency.setValueAtTime(freq * bp, now);
          o.frequency.linearRampToValueAtTime(freq * bp * 0.8, now + 0.55);
          lfoGain.connect(o.frequency);
          o.connect(fl);
          o.start(now); o.stop(now + 0.62);
        });
        lfo.start(now); lfo.stop(now + 0.62);
        break;
      }
      case 'sheep': {
        // Bleat with random pitch so the flock doesn't sound cloned
        const bp = rnd(0.85, 1.3);
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        const fl = audioCtx.createBiquadFilter();
        o.type = 'sawtooth';
        o.frequency.setValueAtTime(200 * bp, now);
        const lfo = audioCtx.createOscillator();
        const lfoGain = audioCtx.createGain();
        lfo.frequency.value = rnd(11, 16);
        lfoGain.gain.value = 7 * bp;
        lfo.connect(lfoGain); lfoGain.connect(o.frequency);
        fl.type = 'bandpass';
        fl.frequency.setValueAtTime(750 * bp, now);
        fl.frequency.linearRampToValueAtTime(540 * bp, now + 0.25);
        fl.Q.value = 2.8;
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.055, now + 0.03);
        g.gain.setValueAtTime(0.055, now + 0.2);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        o.connect(fl); fl.connect(g); g.connect(out);
        lfo.start(now); o.start(now);
        lfo.stop(now + 0.35); o.stop(now + 0.35);
        break;
      }
      case 'victory': {
        // Triumphal fanfare: three-voice brass ensemble, war drums, and a
        // held final chord with shimmer — a proper "the day is ours".
        const brass = (t0, freq, dur, vol) => {
          const fl = audioCtx.createBiquadFilter();
          fl.type = 'lowpass';
          fl.frequency.setValueAtTime(700, now + t0);
          fl.frequency.linearRampToValueAtTime(1900, now + t0 + Math.min(0.2, dur * 0.5));
          const g = audioCtx.createGain();
          g.gain.setValueAtTime(0.0001, now + t0);
          g.gain.linearRampToValueAtTime(vol, now + t0 + 0.03);
          g.gain.setValueAtTime(vol, now + t0 + dur * 0.7);
          g.gain.exponentialRampToValueAtTime(0.001, now + t0 + dur);
          fl.connect(g); g.connect(out);
          [-7, 0, 7].forEach(det => {
            const o = audioCtx.createOscillator();
            o.type = 'sawtooth'; o.detune.value = det;
            o.frequency.setValueAtTime(freq, now + t0);
            o.connect(fl); o.start(now + t0); o.stop(now + t0 + dur + 0.05);
          });
        };
        const drum = (t0, vol) => {
          tone(out, now, { type: 'sine', f0: 90, f1: 50, t0, dur: 0.25, vol, att: 0.005 });
          noiseHit(out, now, { t0, dur: 0.06, vol: vol * 0.5, type: 'lowpass', f0: 500, q: 0.7 });
        };
        // Triple-tongued call, rise, and a held high C over the full chord
        [ { f: 261.63, t: 0,    d: 0.2 },
          { f: 261.63, t: 0.25, d: 0.2 },
          { f: 261.63, t: 0.5,  d: 0.2 },
          { f: 329.63, t: 0.75, d: 0.38 },
          { f: 392.0,  t: 1.15, d: 0.38 },
          { f: 523.25, t: 1.55, d: 1.5 }
        ].forEach(n => brass(n.t, n.f, n.d, 0.05));
        [261.63, 329.63, 392.0].forEach(f => brass(1.55, f, 1.5, 0.026)); // final chord
        [0, 0.5, 1.15].forEach(t => drum(t, 0.05));
        drum(1.55, 0.07);
        tone(out, now, { type: 'sine', f0: 1046.5, t0: 1.55, dur: 1.3, vol: 0.018, att: 0.03 }); // shimmer
        break;
      }
      case 'defeat': {
        // Funeral dirge: low drone, a slow falling line, distant tolling bell
        const dfl = audioCtx.createBiquadFilter();
        dfl.type = 'lowpass'; dfl.frequency.value = 260;
        const droneG = audioCtx.createGain();
        droneG.gain.setValueAtTime(0.0001, now);
        droneG.gain.linearRampToValueAtTime(0.035, now + 0.4);
        droneG.gain.setValueAtTime(0.035, now + 3.2);
        droneG.gain.exponentialRampToValueAtTime(0.001, now + 4.6);
        dfl.connect(droneG); droneG.connect(out);
        [110, 164.81].forEach(f => [-5, 5].forEach(det => {  // A2 + E3 open fifth
          const o = audioCtx.createOscillator();
          o.type = 'triangle'; o.detune.value = det;
          o.frequency.setValueAtTime(f, now);
          o.connect(dfl); o.start(now); o.stop(now + 4.7);
        }));
        // Falling line: E - D - C - B - A, each step a small farewell
        [ { f: 329.63, t: 0.3,  d: 0.7 },
          { f: 293.66, t: 1.05, d: 0.7 },
          { f: 261.63, t: 1.8,  d: 0.7 },
          { f: 246.94, t: 2.55, d: 0.6 },
          { f: 220.0,  t: 3.2,  d: 1.4 }
        ].forEach(n => tone(out, now, { type: 'sine', f0: n.f, t0: n.t, dur: n.d, vol: 0.05, att: 0.05 }));
        // Distant bell tolls (same partial recipe as the town bell, quieter)
        [0.2, 1.7, 3.2].forEach(t0 => {
          [[0.5, 0.045], [1, 0.055], [1.19, 0.032], [2, 0.018]].forEach(([m, v]) => {
            tone(out, now, { type: 'sine', f0: 155.56 * m, t0, dur: 1.7, vol: v, att: 0.004, detune: rnd(-4, 4) });
          });
        });
        break;
      }
      case 'click': {
        // Subtle UI tick for menu/toggle buttons — short, quiet, unpitched
        // enough to never compete with battlefield audio.
        noiseHit(out, now, { dur: 0.025, vol: 0.06, type: 'bandpass', f0: 1300 * p, q: 2.5 });
        tone(out, now, { type: 'sine', f0: 750 * p, f1: 560, dur: 0.03, vol: 0.04 });
        break;
      }
      case 'error': {
        // "Denied" blip: two quick descending low tones, AoE2-style refusal.
        tone(out, now, { type: 'square', f0: 220 * p, f1: 200, dur: 0.07, vol: 0.05 });
        tone(out, now, { type: 'square', f0: 165 * p, f1: 150, t0: 0.09, dur: 0.1, vol: 0.055 });
        break;
      }
      case 'death': {
        // Unit death: short falling cry + a soft body thud. Kept quick and
        // low-key — battles produce many of these (rate limiter helps too).
        // Cry sits in the mids so it carries on small speakers.
        tone(out, now, { type: 'sawtooth', f0: 340 * p, f1: 120, dur: 0.22, vol: 0.075, att: 0.01 });
        tone(out, now, { type: 'triangle', f0: 150 * p, f1: 60, t0: 0.1, dur: 0.15, vol: 0.06 });
        noiseHit(out, now, { t0: 0.16, dur: 0.07, vol: 0.1, type: 'bandpass', f0: 550, q: 1 });
        break;
      }
      case 'collapse': {
        // Building destruction. The first version was a pure sub-300Hz
        // rumble — measured at near-zero energy above a laptop woofer's
        // roll-off, i.e. inaudible on MacBook/phone speakers ("deleting a
        // building plays no sound"). The rumble stays for speakers that can
        // render it, but the read now comes from mid-band timber cracks and
        // tumbling debris that any speaker reproduces.
        // Sharp initial timber crack
        noiseHit(out, now, { dur: 0.08, vol: 0.26, type: 'bandpass', f0: 1500 * p, f1: 650, q: 1.2 });
        tone(out, now, { type: 'square', f0: 240 * p, f1: 90, dur: 0.12, vol: 0.09 });
        // Low rumble body
        noiseHit(out, now, { dur: 0.55, vol: 0.17, type: 'lowpass', f0: 380, f1: 130, q: 0.8 });
        tone(out, now, { type: 'sine', f0: 95 * p, f1: 40, dur: 0.6, vol: 0.12, att: 0.01 });
        // Mid-band debris tumbling out over the rumble
        [0.1, 0.2, 0.31, 0.43, 0.55].forEach(t0 => {
          noiseHit(out, now, { t0, dur: 0.06, vol: 0.15, type: 'bandpass', f0: rnd(700, 1800), q: 1.8 });
        });
        break;
      }
    }
  } catch (err) {
    console.warn("Audio Context Error: ", err);
  }
}

window.playSound = playSound;
window.initAudio = initAudio;

// ---- GENERATIVE MEDIEVAL SOUNDTRACK ----
// AoE2-flavored: a modal (D dorian) melody over a drone of open fifths,
// alternating lute/flute lead voices, with a soft frame drum underneath.
// Each timer tick schedules one 8-beat phrase; phrases are composed (not
// random walks) so the tune has shape, and variation comes from voice
// choice, ornaments, drum pattern, and light humanization of timing.
let ambientSeq = 0;
let ambientTimer = null;

const MUSIC_PHRASE_BEATS = 8;

// Modal scales, degree 0 = tonic. Negative degrees dip below.
// Mixolydian: bright major-with-flat-7 "heroic folk". Dorian: minor-leaning,
// determined — the march. Phrygian: flat 2 right above the tonic — instant
// menace, the "we're in trouble" mode.
const MUSIC_SCALES = {
  dorian:     [293.66, 329.63, 349.23, 392.00, 440.00, 493.88, 523.25], // D E F G A B C
  mixolydian: [392.00, 440.00, 493.88, 523.25, 587.33, 659.25, 698.46], // G A B C D E F
  phrygian:   [329.63, 349.23, 392.00, 440.00, 493.88, 523.25, 587.33]  // E F G A B C D
};
// Peacetime scale preference (kept from before): 'mixolydian' | 'dorian'
window.musicMode = window.musicMode || 'mixolydian';
function degFreq(deg, scaleName) {
  let scale = MUSIC_SCALES[scaleName] || MUSIC_SCALES.mixolydian;
  let oct = Math.floor(deg / 7);
  let idx = ((deg % 7) + 7) % 7;
  return scale[idx] * Math.pow(2, oct);
}

// ---- ADAPTIVE MOOD ----
// Checked once per phrase: the music reacts to what's happening on the map.
//   peace  — building & gathering: bright, gentle, flute/lute alternate
//   war    — our army is at their gates: driving march, lute lead
//   danger — enemies near our buildings: fast, dark, urgent drums
const MUSIC_MOODS = {
  peace:  { get scale(){ return window.musicMode; }, bpm: 84,  droneVol: 0.014, melVol: 1.0, drum: 'gentle', drumVol: 1.0 },
  // Combat moods play noticeably louder — they have to cut through the
  // clash/arrow SFX of the very battles that trigger them.
  war:    { scale: 'dorian',   bpm: 100, droneVol: 0.024, melVol: 1.7, drum: 'march',  drumVol: 1.8 },
  danger: { scale: 'phrygian', bpm: 116, droneVol: 0.03,  melVol: 1.9, drum: 'urgent', drumVol: 2.0 }
};
let _moodHold = { war: 0, danger: 0 };
let _currentMoodName = 'peace';
let _moodWatcher = null;
// Everything in the current phrase plays through this bus so a mood change
// or game over can fade the whole phrase out at once instead of letting
// up to ~6s of already-scheduled notes ring on.
let _phraseBus = null;
function newPhraseBus() {
  _phraseBus = audioCtx.createGain();
  _phraseBus.gain.value = 1;
  _phraseBus.connect(getMaster());
  return _phraseBus;
}
function fadeOutPhrase(dur) {
  if (!_phraseBus || !audioCtx) { _phraseBus = null; return; }
  try {
    let g = _phraseBus.gain, t = audioCtx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(0.0001, t + (dur || 0.3));
  } catch (_) {}
  _phraseBus = null;
}
function detectMusicMood() {
  try {
    if (typeof entities === 'undefined') return 'peace';
    const NEAR = 10;
    let myBldgs = [], theirBldgs = [];
    entities.forEach(en => {
      if (en.type === 'building') (en.team === myTeam ? myBldgs : theirBldgs).push(en);
    });
    let danger = false, war = false;
    // Strongest signal: actual damage in the last ~8 seconds (set by
    // damageEntity) — catches open-field battles far from any building.
    if (typeof tick !== 'undefined') {
      if (tick - (window.lastDangerTick || -1e9) < 240) danger = true;
      if (tick - (window.lastWarTick || -1e9) < 240) war = true;
    }
    entities.forEach(en => {
      if (en.type !== 'unit' || en.utype === 'villager' || en.utype === 'sheep' || en.utype === 'sheep_carcass' || en.garrisonedIn) return;
      // A unit that ISN'T mine near MY buildings = danger; MY unit near
      // THEIR buildings = war. Neutral (gaia — bears/wildlife) excluded
      // entirely, same as the original team-0/1-only branching did.
      let list = en.team === GAIA_TEAM ? [] : (en.team !== myTeam ? myBldgs : theirBldgs);
      for (let i = 0; i < list.length; i++) {
        let b = list[i];
        let dx = en.x - (b.x + b.w / 2), dy = en.y - (b.y + b.h / 2);
        if (dx * dx + dy * dy <= NEAR * NEAR) {
          if (en.team !== myTeam) danger = true; else war = true;
          break;
        }
      }
    });
    // Hold combat moods for 2 extra phrases so the music doesn't flicker
    // back to peace the moment armies briefly disengage.
    if (danger) _moodHold.danger = ambientSeq + 2;
    if (war) _moodHold.war = ambientSeq + 2;
    if (danger || ambientSeq < _moodHold.danger) return 'danger';
    if (war || ambientSeq < _moodHold.war) return 'war';
    return 'peace';
  } catch (_) { return 'peace'; }
}

// Melody phrases: arrays of [degree, startBeat, lengthBeats].
// Written as two answering pairs (A asks, B resolves to the tonic) plus a
// higher-reaching C section — the classic bar-form feel of medieval song.
const MELODY_PHRASES = [
  // A: rising question, hangs on the 5th
  [[0,0,1],[1,1,0.5],[2,1.5,0.5],[3,2,1],[4,3,1],[2,4,1],[4,5,0.5],[5,5.5,0.5],[4,6,2]],
  // B: answer, falls back home
  [[5,0,1],[4,1,1],[2,2,0.5],[1,2.5,0.5],[2,3,1],[0,4,1],[1,5,0.5],[-1,5.5,0.5],[0,6,2]],
  // A': like A but ornamented turn at the top
  [[0,0,1],[2,1,1],[3,2,0.5],[4,2.5,0.5],[5,3,1],[4,4,0.5],[3,4.5,0.5],[4,5,1],[2,6,2]],
  // C: reaches the high octave — the "banner on the hill" moment
  [[4,0,1],[5,1,0.5],[6,1.5,0.5],[7,2,1.5],[6,3.5,0.5],[5,4,1],[4,5,0.5],[2,5.5,0.5],[4,6,2]],
  // B': final cadence, dips below the tonic before landing
  [[3,0,1],[2,1,1],[1,2,0.5],[0,2.5,0.5],[-1,3,1],[-3,4,1],[-1,5,0.5],[1,5.5,0.5],[0,6,2]],
  // D: high lament — starts on the octave and sighs stepwise back down
  [[7,0,1],[6,1,0.5],[5,1.5,0.5],[4,2,1],[5,3,0.5],[4,3.5,0.5],[2,4,1],[1,5,0.5],[2,5.5,0.5],[0,6,2]],
  // E: dancing round — quicker note pairs circling the 5th, estampie feel
  [[0,0,0.5],[2,0.5,0.5],[4,1,1],[4,2,0.5],[5,2.5,0.5],[6,3,1],[5,4,0.5],[4,4.5,0.5],[2,5,1],[1,6,0.5],[0,6.5,1.5]]
];
// Phrase order forms two answering verses so long games repeat less:
// A B A' C B' | A D A' E B' — same bar-form skeleton, new middle lines.
const PHRASE_ORDER = [0, 1, 2, 3, 4, 0, 5, 2, 6, 4];

// Drone roots per PHRASE (as scale degrees), parallel to MELODY_PHRASES:
// i — VII — i — III — i for the original five; the high lament keeps the
// tonic under it, the dance sits on VII for lift.
const DRONE_ROOTS = [0, -1, 0, 2, 0, 0, -1];

// Plucked string: bright attack that decays fast, plus a soft octave partial.
function lutePluck(out, now, t0, freq, vol) {
  tone(out, now, { type: 'triangle', f0: freq, t0, dur: 1.1, vol, att: 0.004, detune: rnd(-3, 3) });
  tone(out, now, { type: 'sine', f0: freq * 2, t0, dur: 0.5, vol: vol * 0.35, att: 0.004 });
  // Fingertip contact noise — makes it read as a plucked string, not a synth
  noiseHit(out, now, { t0, dur: 0.015, vol: vol * 0.5, type: 'highpass', f0: 2400, q: 0.7 });
}

// Breathy flute: soft attack sine with gentle vibrato and a whisper of air.
function fluteNote(out, now, t0, freq, dur, vol) {
  const o = audioCtx.createOscillator(), g = audioCtx.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(freq, now + t0);
  const vib = audioCtx.createOscillator(), vibG = audioCtx.createGain();
  vib.frequency.value = rnd(4.5, 5.5);
  vibG.gain.setValueAtTime(0, now + t0);
  vibG.gain.linearRampToValueAtTime(freq * 0.008, now + t0 + Math.min(0.4, dur * 0.5));
  vib.connect(vibG); vibG.connect(o.frequency);
  g.gain.setValueAtTime(0.0001, now + t0);
  g.gain.linearRampToValueAtTime(vol, now + t0 + 0.06);
  g.gain.setValueAtTime(vol, now + t0 + Math.max(0.06, dur - 0.15));
  g.gain.exponentialRampToValueAtTime(0.0001, now + t0 + dur);
  o.connect(g); g.connect(out);
  o.start(now + t0); vib.start(now + t0);
  o.stop(now + t0 + dur + 0.05); vib.stop(now + t0 + dur + 0.05);
  noiseHit(out, now, { t0, dur: Math.min(0.3, dur), vol: vol * 0.12, type: 'bandpass', f0: freq * 2, q: 3, att: 0.05 });
}

// Plays one phrase in the current mood; returns the phrase duration in
// seconds so the scheduler knows when the next phrase is due (tempo varies).
function playAmbientChord() {
  let moodName = detectMusicMood();
  let mood = MUSIC_MOODS[moodName] || MUSIC_MOODS.peace;
  let beat = 60 / mood.bpm;
  let phraseDur = MUSIC_PHRASE_BEATS * beat;
  if (window.audioMuted || window.musicEnabled === false) return phraseDur;
  if (!audioCtx || gamePaused || gameOver || !gameStarted) return phraseDur;
  // Hidden tab, SINGLE-PLAYER only: rAF halts the sim there, so music over a
  // frozen game is wrong. An MP host keeps simulating in hidden tabs (the
  // background interval in js/init.js) and its music should keep playing.
  if (netRole === null && document.hidden) return phraseDur;
  // Same self-heal as playSound: a context that re-suspended after a long
  // background stint would otherwise stay silent until the next click.
  if (audioCtx.state === 'suspended') {
    tryResumeAudio();
    if (audioCtx.state === 'suspended') return phraseDur; // no gesture yet — inaudible anyway
  }

  _currentMoodName = moodName;
  let bus = newPhraseBus();
  let now = audioCtx.currentTime;
  let phraseIdx = PHRASE_ORDER[ambientSeq % PHRASE_ORDER.length];
  let verse = Math.floor(ambientSeq / PHRASE_ORDER.length);
  ambientSeq++;
  let scale = mood.scale;

  // ---- Drone: root + open fifth, detuned ensemble, swelling under the phrase
  let rootFreq = degFreq(DRONE_ROOTS[phraseIdx], scale) / 2; // an octave below melody
  let filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(300, now);
  let droneGain = audioCtx.createGain();
  droneGain.gain.setValueAtTime(0.0001, now);
  droneGain.gain.linearRampToValueAtTime(mood.droneVol, now + phraseDur * 0.25);
  droneGain.gain.setValueAtTime(mood.droneVol, now + phraseDur * 0.8);
  droneGain.gain.linearRampToValueAtTime(0.0001, now + phraseDur + 0.3);
  filter.connect(droneGain);
  droneGain.connect(bus);
  [rootFreq, rootFreq * 1.5, rootFreq * 2].forEach(freq => {
    [-5, 5].forEach(det => {
      let osc = audioCtx.createOscillator();
      osc.type = 'triangle';
      osc.detune.value = det;
      osc.frequency.setValueAtTime(freq, now);
      osc.connect(filter);
      osc.start(now);
      osc.stop(now + phraseDur + 0.4);
    });
  });

  // ---- Melody: peace alternates flute/lute by verse; war marches on the
  // lute; danger puts the flute up high over the drums like a warning cry.
  let useFlute = mood.drum === 'urgent' ? true : (mood.drum === 'march' ? false : verse % 2 === 0);
  let mVol = (useFlute ? 0.028 : 0.035) * mood.melVol;
  MELODY_PHRASES[phraseIdx].forEach(([deg, beat_, len]) => {
    // Humanize, but never before the phrase start: at audioCtx creation
    // (first Start click) currentTime≈0 and a negative offset makes
    // setValueAtTime throw, aborting startGame mid-way.
    let t0 = Math.max(0, beat_ * beat + rnd(-0.015, 0.015));
    let freq = degFreq(deg, scale);
    let dur = len * beat * 0.95;
    if (useFlute) fluteNote(bus, now, t0, freq, dur, mVol);
    else lutePluck(bus, now, t0, freq, mVol);
    // Occasional grace note a step above, medieval ornament style (peace only —
    // combat phrases stay stark)
    if (mood.drum === 'gentle' && len >= 1 && Math.random() < 0.18) {
      let gf = degFreq(deg + 1, scale);
      let gt = Math.max(0, t0 - 0.07);
      if (useFlute) fluteNote(bus, now, gt, gf, 0.07, mVol * 0.5);
      else lutePluck(bus, now, gt, gf, mVol * 0.4);
    }
  });

  // ---- Frame drum, per mood
  const thump = (t0, vol) => {
    tone(bus, now, { type: 'sine', f0: 82, f1: 55, t0, dur: 0.18, vol, att: 0.005 });
    noiseHit(bus, now, { t0, dur: 0.03, vol: vol * 0.6, type: 'lowpass', f0: 400, q: 0.7 });
  };
  const edgeTap = (t0, vol) => {
    noiseHit(bus, now, { t0, dur: 0.02, vol, type: 'bandpass', f0: 1800, q: 2 });
  };
  let dv = mood.drumVol || 1;
  if (mood.drum === 'gentle') {
    // Soft heartbeat, sits out every third verse for air
    if (verse % 3 !== 2) {
      for (let b = 0; b < MUSIC_PHRASE_BEATS; b += 2) {
        thump(b * beat, 0.03 * dv);
        if (Math.random() < 0.5) edgeTap((b + 1.5) * beat, 0.012 * dv);
      }
    }
  } else if (mood.drum === 'march') {
    // Steady march: thump every beat, taps on the off-beats
    for (let b = 0; b < MUSIC_PHRASE_BEATS; b++) {
      thump(b * beat, (b % 2 === 0 ? 0.042 : 0.028) * dv);
      edgeTap((b + 0.5) * beat, 0.014 * dv);
    }
  } else if (mood.drum === 'urgent') {
    // Galloping alarm: thump-thump rest pattern with insistent taps
    for (let b = 0; b < MUSIC_PHRASE_BEATS; b++) {
      thump(b * beat, 0.048 * dv);
      if (b % 2 === 0) thump((b + 0.5) * beat, 0.026 * dv);
      edgeTap((b + 0.75) * beat, 0.016 * dv);
    }
  }
  return phraseDur;
}

// One-shot low horn hit for the peace→combat mood transition — the same
// detuned-sawtooth recipe as the 'alert' war horn, but shorter and quieter
// (it accompanies the music, it isn't an alert the player must act on).
function moodStinger() {
  try {
    if (!audioCtx || window.audioMuted || window.musicEnabled === false) return;
    const out = getMaster();
    const now = audioCtx.currentTime;
    const fl = audioCtx.createBiquadFilter();
    fl.type = 'lowpass';
    fl.frequency.setValueAtTime(420, now);
    fl.frequency.linearRampToValueAtTime(900, now + 0.25);
    const g = audioCtx.createGain();
    g.gain.setValueAtTime(0.0001, now);
    g.gain.linearRampToValueAtTime(0.045, now + 0.06);
    g.gain.setValueAtTime(0.045, now + 0.28);
    g.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
    fl.connect(g); g.connect(out);
    [147, 147 * 1.006, 73.5].forEach(freq => {
      const o = audioCtx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(freq, now);
      o.connect(fl);
      o.start(now); o.stop(now + 0.6);
    });
  } catch (_) {}
}

function startAmbientMusic() {
  if (window.musicEnabled === false) return;
  if (ambientTimer) clearTimeout(ambientTimer);
  if (_moodWatcher) clearInterval(_moodWatcher);
  ambientSeq = 0;
  _moodHold = { war: 0, danger: 0 };
  _currentMoodName = 'peace';
  const loop = () => {
    let dur = playAmbientChord();
    ambientTimer = setTimeout(loop, dur * 1000);
  };
  loop();
  // Mood watcher: checks the battlefield twice a second. When the mood
  // shifts (raid starts, battle won…) the current phrase fades over ~0.3s
  // and the new mood's phrase begins immediately instead of waiting out the
  // rest of the bar. Game over cuts the ambient entirely — gameLoop plays
  // the victory/defeat piece on top of silence.
  _moodWatcher = setInterval(() => {
    if (!audioCtx || !gameStarted) return;
    if (gameOver) { fadeOutPhrase(0.25); return; }
    if (gamePaused || window.audioMuted || window.musicEnabled === false) return;
    if (netRole === null && document.hidden) return; // SP hidden tab: sim frozen, hold the music
    let m = detectMusicMood();
    if (m !== _currentMoodName) {
      // Entering combat from peace gets a one-shot horn stinger over the
      // crossfade, so the mood change lands as an event instead of the
      // soundtrack just quietly changing gears.
      if (_currentMoodName === 'peace' && (m === 'war' || m === 'danger')) moodStinger();
      fadeOutPhrase(0.3);
      clearTimeout(ambientTimer);
      ambientTimer = setTimeout(loop, 320);
    }
  }, 500);
}

function stopAmbientMusic() {
  if (ambientTimer) {
    clearTimeout(ambientTimer);
    ambientTimer = null;
  }
  if (_moodWatcher) {
    clearInterval(_moodWatcher);
    _moodWatcher = null;
  }
  fadeOutPhrase(0.25);
}

// ---- GAME OVER MUSIC ----
// The one-shot fanfare/dirge plays as an intro, then a proper looping theme
// takes over for as long as the end screen is up: victory gets a bright
// mixolydian celebration with march drums, defeat a slow phrygian lament
// with a tolling bell. Stopped (with a fade) when a new game starts.
const GAMEOVER_TUNES = {
  victory: {
    scale: 'mixolydian', bpm: 104, droneVol: 0.018, lead: 'lute', melVol: 0.04, drums: true,
    phrases: [
      // Celebration: bounding upward, landing on the high tonic
      [[0,0,0.5],[0,0.5,0.5],[2,1,1],[4,2,1],[5,3,1],[4,4,1],[7,5,1.5],[4,6.5,1.5]],
      // Answer: down from the top, cadence on home
      [[7,0,1],[5,1,0.5],[4,1.5,0.5],[5,2,1],[4,3,1],[2,4,1],[1,5,0.5],[2,5.5,0.5],[0,6,2]]
    ]
  },
  defeat: {
    scale: 'phrygian', bpm: 66, droneVol: 0.028, lead: 'flute', melVol: 0.034, drums: false, bell: true,
    phrases: [
      // Lament: long falling steps
      [[4,0,1.5],[3,1.5,1.5],[2,3,1],[1,4,1.5],[0,5.5,2.5]],
      // Deeper still, dipping under the tonic before settling
      [[2,0,1.5],[1,1.5,1.5],[0,3,1],[-3,4,1.5],[0,5.5,2.5]]
    ]
  }
};
let _gameOverTimer = null;
let _goSeq = 0;
let _goBus = null;
function playGameOverPhrase(cfg) {
  let beat = 60 / cfg.bpm;
  let phraseDur = MUSIC_PHRASE_BEATS * beat;
  if (!audioCtx || window.audioMuted || window.soundMode === 'off') return phraseDur;
  if (audioCtx.state === 'suspended') {
    tryResumeAudio(); // self-heal like playSound
    if (audioCtx.state === 'suspended') return phraseDur;
  }
  let now = audioCtx.currentTime;
  let bus = audioCtx.createGain();
  bus.gain.value = 1;
  bus.connect(getMaster());
  _goBus = bus;
  let phrase = cfg.phrases[_goSeq % cfg.phrases.length];
  _goSeq++;
  // Drone: root + fifth under the whole phrase
  let rootFreq = degFreq(0, cfg.scale) / 2;
  const dfl = audioCtx.createBiquadFilter();
  dfl.type = 'lowpass'; dfl.frequency.value = 300;
  const dg = audioCtx.createGain();
  dg.gain.setValueAtTime(0.0001, now);
  dg.gain.linearRampToValueAtTime(cfg.droneVol, now + phraseDur * 0.2);
  dg.gain.setValueAtTime(cfg.droneVol, now + phraseDur * 0.85);
  dg.gain.linearRampToValueAtTime(0.0001, now + phraseDur + 0.2);
  dfl.connect(dg); dg.connect(bus);
  [rootFreq, rootFreq * 1.5].forEach(f => [-5, 5].forEach(det => {
    const o = audioCtx.createOscillator();
    o.type = 'triangle'; o.detune.value = det;
    o.frequency.setValueAtTime(f, now);
    o.connect(dfl); o.start(now); o.stop(now + phraseDur + 0.3);
  }));
  // Melody
  phrase.forEach(([deg, b, len]) => {
    let t0 = Math.max(0, b * beat + rnd(-0.012, 0.012));
    let freq = degFreq(deg, cfg.scale);
    let dur = len * beat * 0.95;
    if (cfg.lead === 'flute') fluteNote(bus, now, t0, freq, dur, cfg.melVol);
    else lutePluck(bus, now, t0, freq, cfg.melVol);
  });
  // Victory: march drums. Defeat: a single bell toll opening each phrase.
  if (cfg.drums) {
    for (let b = 0; b < MUSIC_PHRASE_BEATS; b++) {
      tone(bus, now, { type: 'sine', f0: 90, f1: 50, t0: b * beat, dur: 0.22, vol: b % 2 === 0 ? 0.04 : 0.026, att: 0.005 });
      noiseHit(bus, now, { t0: (b + 0.5) * beat, dur: 0.02, vol: 0.012, type: 'bandpass', f0: 1800, q: 2 });
    }
  }
  if (cfg.bell && _goSeq % 2 === 1) {
    [[0.5, 0.045], [1, 0.055], [1.19, 0.03], [2, 0.016]].forEach(([m, v]) => {
      tone(bus, now, { type: 'sine', f0: 155.56 * m, dur: 2.2, vol: v, att: 0.004, detune: rnd(-4, 4) });
    });
  }
  return phraseDur;
}
function startGameOverMusic(wonFlag) {
  stopGameOverMusic();
  _goSeq = 0;
  let cfg = wonFlag ? GAMEOVER_TUNES.victory : GAMEOVER_TUNES.defeat;
  playSound(wonFlag ? 'victory' : 'defeat'); // intro stinger
  const loop = () => {
    let dur = playGameOverPhrase(cfg);
    _gameOverTimer = setTimeout(loop, dur * 1000);
  };
  // Theme enters as the intro finishes
  _gameOverTimer = setTimeout(loop, wonFlag ? 3100 : 4700);
}
function stopGameOverMusic() {
  if (_gameOverTimer) {
    clearTimeout(_gameOverTimer);
    _gameOverTimer = null;
  }
  if (_goBus && audioCtx) {
    try {
      let g = _goBus.gain, t = audioCtx.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.linearRampToValueAtTime(0.0001, t + 0.3);
    } catch (_) {}
    _goBus = null;
  }
}
window.startGameOverMusic = startGameOverMusic;
window.stopGameOverMusic = stopGameOverMusic;

window.startAmbientMusic = startAmbientMusic;
window.stopAmbientMusic = stopAmbientMusic;

// Autoplay policy: an AudioContext created before any user gesture starts
// 'suspended' and stays silent until resumed FROM a gesture handler. The
// host always initializes audio inside a click (Start/Host button), but a
// GUEST arrives via a ?join= link with no interaction at all — its music
// (started by the first full sync, js/net-sync.js) would sit scheduled but
// inaudible. playSound() resumes too, but only when some event happens to
// fire one; this hook guarantees the very first click/keypress anywhere
// unblocks audio. Listeners stay registered (cheap no-ops once running) to
// also cover the context re-suspending later (some browsers do on long
// background stints).
['pointerdown', 'keydown'].forEach(evt => {
  document.addEventListener(evt, () => {
    // Direct resume (not tryResumeAudio): a real gesture always may resume,
    // and it must also clear the auto-resume latch set before the gesture.
    if (audioCtx && audioCtx.state === 'suspended') {
      audioCtx.resume().then(() => { _audioResumeBlocked = false; }).catch(() => {});
    }
  }, { capture: true });
});

window.audioMuted = false;
function toggleMute() {
  window.audioMuted = !window.audioMuted;
  let btn = document.getElementById('mute-btn');
  if (btn) {
    btn.textContent = window.audioMuted ? '🔇' : '🔊';
  }
  if (window.audioMuted) {
    stopAmbientMusic();
  } else {
    if (gameStarted && !gamePaused && !gameOver) {
      startAmbientMusic();
    }
  }
}
window.toggleMute = toggleMute;
