let audioCtx = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playSound(type) {
  if (window.audioMuted) return;
  try {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    let now = audioCtx.currentTime;
    
    switch (type) {
      case 'chop': {
        // Wood chop: click/impact transiency + triangle body resonance
        let clickOsc = audioCtx.createOscillator();
        let clickGain = audioCtx.createGain();
        clickOsc.type = 'sine';
        clickOsc.frequency.setValueAtTime(450, now);
        clickOsc.frequency.exponentialRampToValueAtTime(150, now + 0.02);
        clickGain.gain.setValueAtTime(0.3, now);
        clickGain.gain.exponentialRampToValueAtTime(0.001, now + 0.025);
        clickOsc.connect(clickGain);
        clickGain.connect(audioCtx.destination);
        clickOsc.start(now);
        clickOsc.stop(now + 0.03);

        let bodyOsc = audioCtx.createOscillator();
        let bodyGain = audioCtx.createGain();
        bodyOsc.type = 'triangle';
        bodyOsc.frequency.setValueAtTime(120, now);
        bodyOsc.frequency.exponentialRampToValueAtTime(35, now + 0.12);
        bodyGain.gain.setValueAtTime(0.25, now);
        bodyGain.gain.exponentialRampToValueAtTime(0.005, now + 0.15);
        bodyOsc.connect(bodyGain);
        bodyGain.connect(audioCtx.destination);
        bodyOsc.start(now);
        bodyOsc.stop(now + 0.16);
        break;
      }
      case 'mine': {
        // Mining: multi-frequency metallic bell/clang + fast decay
        let freqs = [987.77, 1318.51, 1567.98, 1975.53]; // high harmonics (B5, E6, G6, B6)
        freqs.forEach((freq, idx) => {
          let osc = audioCtx.createOscillator();
          let gain = audioCtx.createGain();
          osc.type = 'sine';
          osc.frequency.setValueAtTime(freq, now);
          osc.frequency.linearRampToValueAtTime(freq - 150, now + 0.18);
          
          let vol = idx === 0 ? 0.1 : 0.06;
          gain.gain.setValueAtTime(vol, now);
          gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.18 + idx * 0.02);
          
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now);
          osc.stop(now + 0.25);
        });
        break;
      }
      case 'build': {
        // Build: clicky wooden thud
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(75, now);
        osc.frequency.exponentialRampToValueAtTime(25, now + 0.08);
        
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.005, now + 0.08);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.09);
        break;
      }
      case 'forage':
      case 'farm': {
        // Shuffling grass sound (noise)
        let bufferSize = audioCtx.sampleRate * 0.12;
        let buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        let data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) {
          data[i] = Math.random() * 2 - 1;
        }
        let noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        
        let filter = audioCtx.createBiquadFilter();
        filter.type = 'bandpass';
        filter.frequency.value = 550;
        filter.Q.value = 2.5;
        
        let gain = audioCtx.createGain();
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        
        noise.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        noise.start(now);
        break;
      }
      case 'attack': {
        // Sword clash: dual clashing saw/sine frequencies + white noise highpass scrape
        let osc1 = audioCtx.createOscillator();
        let osc2 = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(520, now);
        osc1.frequency.exponentialRampToValueAtTime(120, now + 0.15);
        
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(950, now);
        osc2.frequency.exponentialRampToValueAtTime(320, now + 0.12);
        
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.16);
        
        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(audioCtx.destination);
        
        let bufferSize = audioCtx.sampleRate * 0.1;
        let buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        let data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        let noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        
        let filter = audioCtx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 1800;
        
        let noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.12, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.001, now + 0.09);
        
        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(audioCtx.destination);
        
        osc1.start(now);
        osc2.start(now);
        noise.start(now);
        osc1.stop(now + 0.18);
        osc2.stop(now + 0.18);
        break;
      }
      case 'arrow': {
        // Arrow whoosh: frequency sweep
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(700, now);
        osc.frequency.exponentialRampToValueAtTime(1300, now + 0.12);
        
        gain.gain.setValueAtTime(0.04, now);
        gain.gain.linearRampToValueAtTime(0.06, now + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.12);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.13);
        break;
      }
      case 'select_villager': {
        // Upgraded Villager Vocals: Gender pitch variation (Male/Female)
        let isFemale = Math.random() < 0.5;
        let baseFreq = isFemale ? 220 : 130; // A3 vs C3 range
        let pitchSway = isFemale ? 30 : 18;
        
        let osc1 = audioCtx.createOscillator();
        let osc2 = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(baseFreq, now);
        osc1.frequency.linearRampToValueAtTime(baseFreq + pitchSway, now + 0.14);
        
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(baseFreq * 2, now);
        
        let filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = isFemale ? 550 : 320; // Filter out high buzz for smooth vocal hum
        
        gain.gain.setValueAtTime(0.09, now);
        gain.gain.linearRampToValueAtTime(0.09, now + 0.09);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        
        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.2);
        osc2.stop(now + 0.2);
        break;
      }
      case 'select_military': {
        // Low, warm weapon-on-shield strike response (non-distracting)
        let osc1 = audioCtx.createOscillator();
        let osc2 = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        osc1.type = 'triangle';
        osc1.frequency.setValueAtTime(140, now);
        osc1.frequency.exponentialRampToValueAtTime(70, now + 0.14);
        
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(320, now);
        osc2.frequency.exponentialRampToValueAtTime(180, now + 0.09);
        
        let filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.setValueAtTime(450, now); // lowpass filter out high buzz
        
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.15);
        
        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.16);
        osc2.stop(now + 0.16);
        break;
      }
      case 'train': {
        // Trumpet herald chord
        let notes = [261.63, 329.63, 392.00, 523.25]; // C major
        notes.forEach((freq, i) => {
          let osc = audioCtx.createOscillator();
          let gain = audioCtx.createGain();
          osc.type = 'sawtooth';
          osc.frequency.setValueAtTime(freq, now + i * 0.03);
          
          gain.gain.setValueAtTime(0.025, now);
          gain.gain.exponentialRampToValueAtTime(0.001, now + 0.35);
          
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now);
          osc.stop(now + 0.4);
        });
        break;
      }
      case 'alert': {
        // Dual alarm trumpet
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = 'square';
        osc.frequency.setValueAtTime(440, now);
        osc.frequency.setValueAtTime(392, now + 0.07);
        osc.frequency.setValueAtTime(440, now + 0.14);
        
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.26);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.28);
        break;
      }
      case 'sheep': {
        // Modulated formant synth for sheep "baa"
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        let filter = audioCtx.createBiquadFilter();
        
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(200, now);
        
        let lfo = audioCtx.createOscillator();
        let lfoGain = audioCtx.createGain();
        lfo.frequency.value = 14;
        lfoGain.gain.value = 6;
        lfo.connect(lfoGain);
        lfoGain.connect(osc.frequency);
        
        filter.type = 'bandpass';
        filter.frequency.setValueAtTime(750, now);
        filter.frequency.linearRampToValueAtTime(550, now + 0.25);
        filter.Q.value = 2.8;
        
        gain.gain.setValueAtTime(0.05, now);
        gain.gain.linearRampToValueAtTime(0.05, now + 0.2);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.3);
        
        osc.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        
        lfo.start(now);
        osc.start(now);
        lfo.stop(now + 0.35);
        osc.stop(now + 0.35);
        break;
      }
      case 'victory': {
        // Ascending victory progression
        let melody = [
          {f: 261.63, t: 0, d: 0.12}, // C4
          {f: 329.63, t: 0.12, d: 0.12}, // E4
          {f: 392.00, t: 0.24, d: 0.12}, // G4
          {f: 523.25, t: 0.36, d: 0.24}, // C5
          {f: 392.00, t: 0.6, d: 0.12}, // G4
          {f: 523.25, t: 0.72, d: 0.5}  // C5
        ];
        melody.forEach(note => {
          let osc = audioCtx.createOscillator();
          let gain = audioCtx.createGain();
          osc.type = 'triangle';
          osc.frequency.setValueAtTime(note.f, now + note.t);
          
          gain.gain.setValueAtTime(0.06, now + note.t);
          gain.gain.exponentialRampToValueAtTime(0.001, now + note.t + note.d);
          
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(now + note.t);
          osc.stop(now + note.t + note.d + 0.05);
        });
        break;
      }
      case 'defeat': {
        // Solemn organ chord dirge
        let chords = [
          {f: [220.00, 261.63, 329.63], t: 0, d: 0.5}, // Am
          {f: [196.00, 246.94, 293.66], t: 0.5, d: 0.5}, // G
          {f: [174.61, 220.00, 261.63], t: 1.0, d: 0.9}  // F
        ];
        chords.forEach(chord => {
          chord.f.forEach(freq => {
            let osc = audioCtx.createOscillator();
            let gain = audioCtx.createGain();
            osc.type = 'sine';
            osc.frequency.setValueAtTime(freq, now + chord.t);
            
            gain.gain.setValueAtTime(0.04, now + chord.t);
            gain.gain.linearRampToValueAtTime(0.04, now + chord.t + chord.d - 0.08);
            gain.gain.exponentialRampToValueAtTime(0.001, now + chord.t + chord.d);
            
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start(now + chord.t);
            osc.stop(now + chord.t + chord.d + 0.05);
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
  if (window.audioMuted) return;
  if (!audioCtx || gamePaused || gameOver || !gameStarted) return;
  
  let now = audioCtx.currentTime;
  let chords = [
    [220.00, 261.63, 329.63], // Am (A3, C4, E4)
    [293.66, 349.23, 440.00], // Dm (D3, F3, A3)
    [196.00, 246.94, 293.66], // G (G3, B3, D3)
    [164.81, 196.00, 246.94]  // Em (E3, G3, B3)
  ];
  
  let chord = chords[ambientSeq % chords.length];
  ambientSeq++;
  
  let filter = audioCtx.createBiquadFilter();
  filter.type = 'lowpass';
  filter.frequency.setValueAtTime(220, now); // very warm, lowpass string drone
  
  let mainGain = audioCtx.createGain();
  mainGain.gain.setValueAtTime(0, now);
  mainGain.gain.linearRampToValueAtTime(0.015, now + 1.5); // very soft atmospheric backing pad
  mainGain.gain.setValueAtTime(0.015, now + 4.5);
  mainGain.gain.linearRampToValueAtTime(0, now + 6.0);
  
  filter.connect(mainGain);
  mainGain.connect(audioCtx.destination);
  
  chord.map(freq => {
    let osc = audioCtx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, now);
    osc.connect(filter);
    osc.start(now);
    osc.stop(now + 6.0);
  });
  
  // Periodically add a gentle lute pluck (high pitch sine note)
  if (Math.random() < 0.65) {
    let luteNotes = [523.25, 587.33, 659.25, 783.99, 880.00]; // C5, D5, E5, G5, A5
    let noteFreq = luteNotes[Math.floor(Math.random() * luteNotes.length)];
    let luteOsc = audioCtx.createOscillator();
    let luteGain = audioCtx.createGain();
    
    luteOsc.type = 'sine';
    luteOsc.frequency.setValueAtTime(noteFreq, now + 2.0);
    
    luteGain.gain.setValueAtTime(0, now + 2.0);
    luteGain.gain.linearRampToValueAtTime(0.008, now + 2.15);
    luteGain.gain.exponentialRampToValueAtTime(0.0001, now + 3.8);
    
    luteOsc.connect(luteGain);
    luteGain.connect(audioCtx.destination);
    luteOsc.start(now + 2.0);
    luteOsc.stop(now + 3.9);
  }
}

function startAmbientMusic() {
  if (ambientTimer) clearInterval(ambientTimer);
  ambientSeq = 0;
  playAmbientChord();
  ambientTimer = setInterval(playAmbientChord, 6200); // loop pad chords every 6.2s
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
