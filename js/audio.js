let audioCtx = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
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
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }
  return _noiseBuf;
}

function rnd(a, b) { return a + Math.random() * (b - a); }

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
const ALERT_ONLY_SOUNDS = new Set(['alert', 'victory', 'defeat']);

function playSound(type, wx, wy) {
  if (window.audioMuted) return;
  let mode = window.soundMode || 'all';
  if (mode === 'off') return;
  if (mode === 'alerts' && !ALERT_ONLY_SOUNDS.has(type)) return;
  try {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
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
        noiseHit(out, now, { dur: 0.045, vol: 0.32, type: 'bandpass', f0: 900 * p, f1: 250, q: 0.8 });
        tone(out, now, { type: 'triangle', f0: 300 * p, f1: 85, dur: 0.055, vol: 0.28 });
        tone(out, now, { type: 'triangle', f0: 110 * p, f1: 38, dur: 0.18, vol: 0.2 });
        if (Math.random() < 0.15) {
          noiseHit(out, now, { t0: 0.02, dur: 0.09, vol: 0.12, type: 'highpass', f0: 2200, q: 0.7 });
        }
        break;
      }
      case 'mine': {
        // Pick on rock: inharmonic metallic partials + stone chink
        const base = 230 * p;
        [[1, 0.11], [2.76, 0.07], [5.4, 0.05], [8.93, 0.028]].forEach(([mult, vol], i) => {
          tone(out, now, { type: 'sine', f0: base * mult, f1: base * mult * 0.94, dur: 0.22 + i * 0.02, vol, detune: rnd(-8, 8) });
        });
        noiseHit(out, now, { dur: 0.03, vol: 0.22, type: 'highpass', f0: 3200, q: 0.7 });
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
        // Short vocal hum, male or female
        let isFemale = Math.random() < 0.5;
        let baseFreq = (isFemale ? 220 : 130) * rnd(0.95, 1.06);
        const fl = audioCtx.createBiquadFilter();
        fl.type = 'lowpass';
        fl.frequency.value = isFemale ? 560 : 330;
        const g = audioCtx.createGain();
        g.gain.setValueAtTime(0.0001, now);
        g.gain.linearRampToValueAtTime(0.09, now + 0.03);
        g.gain.setValueAtTime(0.09, now + 0.1);
        g.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        const o1 = audioCtx.createOscillator();
        o1.type = 'sawtooth';
        o1.frequency.setValueAtTime(baseFreq, now);
        o1.frequency.linearRampToValueAtTime(baseFreq + (isFemale ? 30 : 18), now + 0.14);
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
        // Ascending fanfare, doubled an octave up for shimmer
        const melody = [
          { f: 261.63, t: 0, d: 0.12 },
          { f: 329.63, t: 0.12, d: 0.12 },
          { f: 392.0, t: 0.24, d: 0.12 },
          { f: 523.25, t: 0.36, d: 0.24 },
          { f: 392.0, t: 0.6, d: 0.12 },
          { f: 523.25, t: 0.72, d: 0.5 }
        ];
        melody.forEach(note => {
          tone(out, now, { type: 'triangle', f0: note.f, t0: note.t, dur: note.d, vol: 0.06, att: 0.01 });
          tone(out, now, { type: 'sine', f0: note.f * 2, t0: note.t, dur: note.d, vol: 0.02, att: 0.01 });
        });
        break;
      }
      case 'defeat': {
        // Solemn organ dirge
        const chords = [
          { f: [220.0, 261.63, 329.63], t: 0, d: 0.5 },
          { f: [196.0, 246.94, 293.66], t: 0.5, d: 0.5 },
          { f: [174.61, 220.0, 261.63], t: 1.0, d: 0.9 }
        ];
        chords.forEach(chord => {
          chord.f.forEach(freq => {
            tone(out, now, { type: 'sine', f0: freq, t0: chord.t, dur: chord.d, vol: 0.04, att: 0.05 });
          });
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
let ambientSeq = 0;
let ambientTimer = null;

function playAmbientChord() {
  if (window.audioMuted || window.musicEnabled === false) return;
  if (!audioCtx || gamePaused || gameOver || !gameStarted) return;

  let now = audioCtx.currentTime;
  let chords = [
    [220.00, 261.63, 329.63], // Am
    [293.66, 349.23, 440.00], // Dm
    [196.00, 246.94, 293.66], // G
    [164.81, 196.00, 246.94]  // Em
  ];

  let chord = chords[ambientSeq % chords.length];
  ambientSeq++;

  let filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(220, now);

  let mainGain = audioCtx.createGain();
  mainGain.gain.setValueAtTime(0, now);
  mainGain.gain.linearRampToValueAtTime(0.015, now + 1.5);
  mainGain.gain.setValueAtTime(0.015, now + 4.5);
  mainGain.gain.linearRampToValueAtTime(0, now + 6.0);

  filter.connect(mainGain);
  mainGain.connect(getMaster());

  // Two slightly detuned voices per chord note — a warm ensemble pad
  // instead of a static single-oscillator drone.
  chord.forEach(freq => {
    [-4, 4].forEach(det => {
      let osc = audioCtx.createOscillator();
      osc.type = 'triangle';
      osc.detune.value = det;
      osc.frequency.setValueAtTime(freq, now);
      osc.connect(filter);
      osc.start(now);
      osc.stop(now + 6.0);
    });
  });

  // Gentle lute plucks: one or occasionally two notes per phrase
  let plucks = Math.random() < 0.65 ? (Math.random() < 0.3 ? 2 : 1) : 0;
  let luteNotes = [523.25, 587.33, 659.25, 783.99, 880.00];
  for (let i = 0; i < plucks; i++) {
    let noteFreq = luteNotes[Math.floor(Math.random() * luteNotes.length)];
    let t0 = 2.0 + i * 1.4 + rnd(-0.3, 0.3);
    let luteOsc = audioCtx.createOscillator();
    let luteGain = audioCtx.createGain();
    luteOsc.type = 'sine';
    luteOsc.frequency.setValueAtTime(noteFreq, now + t0);
    luteGain.gain.setValueAtTime(0, now + t0);
    luteGain.gain.linearRampToValueAtTime(0.008, now + t0 + 0.15);
    luteGain.gain.exponentialRampToValueAtTime(0.0001, now + t0 + 1.8);
    luteOsc.connect(luteGain);
    luteGain.connect(getMaster());
    luteOsc.start(now + t0);
    luteOsc.stop(now + t0 + 1.9);
  }
}

function startAmbientMusic() {
  if (window.musicEnabled === false) return;
  if (ambientTimer) clearInterval(ambientTimer);
  ambientSeq = 0;
  playAmbientChord();
  ambientTimer = setInterval(playAmbientChord, 6200);
}

function stopAmbientMusic() {
  if (ambientTimer) {
    clearInterval(ambientTimer);
    ambientTimer = null;
  }
}

window.startAmbientMusic = startAmbientMusic;
window.stopAmbientMusic = stopAmbientMusic;

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
