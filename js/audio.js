let audioCtx = null;

function initAudio() {
  if (audioCtx) return;
  audioCtx = new (window.AudioContext || window.webkitAudioContext)();
}

function playSound(type) {
  try {
    initAudio();
    if (!audioCtx) return;
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    let now = audioCtx.currentTime;
    
    switch (type) {
      case 'chop': {
        // Wood chop: low pitch decay sound with a click
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(110, now);
        osc.frequency.exponentialRampToValueAtTime(30, now + 0.1);
        
        gain.gain.setValueAtTime(0.25, now);
        gain.gain.exponentialRampToValueAtTime(0.01, now + 0.12);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.15);
        break;
      }
      case 'mine': {
        // Mining: high pitch metal clang
        let osc1 = audioCtx.createOscillator();
        let osc2 = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        osc1.type = 'sine';
        osc1.frequency.setValueAtTime(880, now);
        osc1.frequency.linearRampToValueAtTime(680, now + 0.15);
        
        osc2.type = 'sine';
        osc2.frequency.setValueAtTime(1320, now);
        
        gain.gain.setValueAtTime(0.12, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        
        osc1.connect(gain);
        osc2.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.25);
        osc2.stop(now + 0.25);
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
        // Sword clash: metal strike + noise burst
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(380, now);
        osc.frequency.exponentialRampToValueAtTime(80, now + 0.1);
        
        let bufferSize = audioCtx.sampleRate * 0.08;
        let buffer = audioCtx.createBuffer(1, bufferSize, audioCtx.sampleRate);
        let data = buffer.getChannelData(0);
        for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
        let noise = audioCtx.createBufferSource();
        noise.buffer = buffer;
        
        let filter = audioCtx.createBiquadFilter();
        filter.type = 'highpass';
        filter.frequency.value = 1200;
        
        let noiseGain = audioCtx.createGain();
        noiseGain.gain.setValueAtTime(0.1, now);
        noiseGain.gain.exponentialRampToValueAtTime(0.005, now + 0.08);
        
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.005, now + 0.1);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        
        noise.connect(filter);
        filter.connect(noiseGain);
        noiseGain.connect(audioCtx.destination);
        
        osc.start(now);
        noise.start(now);
        osc.stop(now + 0.12);
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
        // Synthesized vocal hum "Mandatum?"
        let osc1 = audioCtx.createOscillator();
        let osc2 = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        
        osc1.type = 'sawtooth';
        osc1.frequency.setValueAtTime(135, now);
        osc1.frequency.linearRampToValueAtTime(155, now + 0.12);
        
        osc2.type = 'triangle';
        osc2.frequency.setValueAtTime(270, now);
        
        let filter = audioCtx.createBiquadFilter();
        filter.type = 'lowpass';
        filter.frequency.value = 350;
        
        gain.gain.setValueAtTime(0.1, now);
        gain.gain.linearRampToValueAtTime(0.1, now + 0.08);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.18);
        
        osc1.connect(filter);
        osc2.connect(filter);
        filter.connect(gain);
        gain.connect(audioCtx.destination);
        
        osc1.start(now);
        osc2.start(now);
        osc1.stop(now + 0.18);
        osc2.stop(now + 0.18);
        break;
      }
      case 'select_military': {
        // Short brassy trumpet blast
        let osc = audioCtx.createOscillator();
        let gain = audioCtx.createGain();
        osc.type = 'sawtooth';
        osc.frequency.setValueAtTime(329.63, now); // E4
        osc.frequency.setValueAtTime(440.00, now + 0.06); // A4
        
        gain.gain.setValueAtTime(0.06, now);
        gain.gain.linearRampToValueAtTime(0.06, now + 0.12);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.start(now);
        osc.stop(now + 0.23);
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
