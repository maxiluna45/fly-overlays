// Reproducción de los avisos del coach.
//
// El problema con `speechSynthesis` del navegador es que reproduce el audio él
// mismo: no lo entrega, así que no se puede pasar del 100% de volumen ni
// procesarlo. Y hace falta — medido sobre la voz de Windows, el pico del WAV
// llega al 49% de la escala y el promedio al 2,6%: sale con la mitad del rango
// sin usar, y contra el ruido del juego se pierde.
//
// Acá el WAV lo genera el proceso principal (main/tts.js) y se reproduce por
// WebAudio, que permite tres cosas que suben mucho la inteligibilidad:
//
//   1. Normalizar: llevar el pico al máximo sin recortar (x2 en la medición).
//   2. Realzar la presencia: un pico suave en 3 kHz, la banda donde vive la
//      consonante. Es el truco de los intercomunicadores y las radios de
//      carrera, y es lo que hace que se entienda por encima del motor.
//   3. Comprimir: subir el nivel medio sin que los picos saturen. El volumen
//      PERCIBIDO depende del promedio, no del pico, y ese promedio es lo que
//      estaba en 2,6%.
//
// Con eso, el tope de volumen queda muy por encima del que puede dar la voz del
// navegador, y el limitador de la cadena evita que distorsione al amplificar.

const PRESENCE_HZ = 3000;
const PRESENCE_GAIN_DB = 6;
const HIGHPASS_HZ = 120;   // saca retumbe que sólo gasta rango
const PEAK_TARGET = 0.97;  // a cuánto se normaliza el pico

let ctx = null;
function audioCtx() {
  if (ctx) return ctx;
  try {
    const C = window.AudioContext || window.webkitAudioContext;
    ctx = C ? new C() : null;
  } catch (_) { ctx = null; }
  return ctx;
}

// Pico absoluto del buffer, para normalizar sin recortar.
function peakOf(buffer) {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const d = buffer.getChannelData(c);
    for (let i = 0; i < d.length; i++) {
      const v = Math.abs(d[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

const decoded = new Map(); // texto → AudioBuffer

export function isVoiceReady() {
  return !!audioCtx();
}

// Decodifica y guarda el WAV listo para sonar. Se llama por adelantado (el
// coach conoce las frases de la vuelta al cruzar meta), así que cuando toca
// decirlas no hay ni decodificación ni síntesis de por medio.
export async function preload(key, wavBytes) {
  const ac = audioCtx();
  if (!ac || !wavBytes || decoded.has(key)) return decoded.get(key) || null;
  try {
    const arr = wavBytes instanceof ArrayBuffer ? wavBytes : new Uint8Array(wavBytes).buffer;
    const buf = await ac.decodeAudioData(arr);
    // El pico se calcula una sola vez, acá, y no en cada reproducción.
    decoded.set(key, { buf, peak: peakOf(buf) || 1 });
    return decoded.get(key);
  } catch (_) {
    return null;
  }
}

export function isLoaded(key) {
  return decoded.has(key);
}

export function clearCache() {
  decoded.clear();
}

// `gain` es el volumen elegido por el usuario (1 = 100%). La normalización va
// aparte, así que 100% acá ya suena bastante más fuerte que la voz del
// navegador al 100%.
export function play(key, { gain = 1 } = {}) {
  const ac = audioCtx();
  const entry = decoded.get(key);
  if (!ac || !entry) return false;
  if (ac.state === 'suspended') { try { ac.resume(); } catch (_) {} }

  const src = ac.createBufferSource();
  src.buffer = entry.buf;

  const hp = ac.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = HIGHPASS_HZ;

  const presence = ac.createBiquadFilter();
  presence.type = 'peaking';
  presence.frequency.value = PRESENCE_HZ;
  presence.Q.value = 1;
  presence.gain.value = PRESENCE_GAIN_DB;

  // Normalización: el WAV de Windows viene con la mitad del rango sin usar.
  const norm = ac.createGain();
  norm.gain.value = PEAK_TARGET / entry.peak;

  // Compresor con ataque rápido: sube el nivel medio y contiene los picos, así
  // amplificar no distorsiona.
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = -20;
  comp.knee.value = 6;
  comp.ratio.value = 6;
  comp.attack.value = 0.004;
  comp.release.value = 0.12;

  const out = ac.createGain();
  out.gain.value = Math.max(0, gain);

  src.connect(hp).connect(presence).connect(norm).connect(comp).connect(out).connect(ac.destination);
  try { src.start(); return true; } catch (_) { return false; }
}

// Último recurso: la voz del navegador. Se usa sólo si la síntesis del sistema
// falló, y no puede pasar del 100% de volumen.
export function fallbackSpeak(text, { rate = 1 } = {}) {
  try {
    if (!window.speechSynthesis) return false;
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'es-ES';
    u.rate = rate;
    u.volume = 1;
    window.speechSynthesis.speak(u);
    return true;
  } catch (_) {
    return false;
  }
}
