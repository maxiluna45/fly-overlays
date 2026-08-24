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
// Medido sobre la voz de Windows (Raul, es-MX) con la cadena completa: al 100%
// el nivel medio sube +10 dB respecto del WAV original y sin una sola muestra
// recortada; al 300%, +16,4 dB. Como la voz del navegador reproduce el WAV tal
// cual, el 100% de acá ya suena unas tres veces más fuerte que el 100% de antes.
//
// Al final hay un saturador suave (tanh) en vez de un recorte duro: garantiza
// que la señal no pase del máximo, y cuando el usuario sube el volumen al tope
// la distorsión que aparece es la de una radio, que encima ayuda a entender por
// encima del motor, en vez del chasquido del recorte digital.

const PRESENCE_HZ = 3000;
const PRESENCE_GAIN_DB = 6;
const HIGHPASS_HZ = 120;   // saca retumbe que sólo gasta rango
const PEAK_TARGET = 0.97;  // a cuánto se normaliza el pico
// Compresor: valores elegidos midiendo: con ratio más alto se gana ~2 dB más de
// nivel medio pero empieza a saturar ya al 100%, y eso se escucha áspero.
const COMP_THRESHOLD_DB = -20;
const COMP_RATIO = 6;
const COMP_KNEE_DB = 6;
const COMP_ATTACK_S = 0.003;
const COMP_RELEASE_S = 0.15;
const SOFT_CLIP_DRIVE = 1.6;

// Curva del saturador, calculada una sola vez: tanh normalizada para que la
// entrada 1 salga 1 y por encima se doble en vez de recortarse.
let clipCurve = null;
function softClipCurve() {
  if (clipCurve) return clipCurve;
  const N = 1024;
  const c = new Float32Array(N);
  const k = Math.tanh(SOFT_CLIP_DRIVE);
  for (let i = 0; i < N; i++) {
    const x = (i / (N - 1)) * 2 - 1;
    c[i] = Math.tanh(x * SOFT_CLIP_DRIVE) / k;
  }
  clipCurve = c;
  return c;
}

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

  // Compresor con ataque rápido: sube el nivel medio y contiene los picos.
  const comp = ac.createDynamicsCompressor();
  comp.threshold.value = COMP_THRESHOLD_DB;
  comp.knee.value = COMP_KNEE_DB;
  comp.ratio.value = COMP_RATIO;
  comp.attack.value = COMP_ATTACK_S;
  comp.release.value = COMP_RELEASE_S;

  // El volumen del usuario va al final, después de comprimir: si fuera antes,
  // el compresor se comería el aumento y el control casi no se notaría (medido:
  // de 100% a 300% subía 3 dB en vez de 6,4).
  const out = ac.createGain();
  out.gain.value = Math.max(0, gain);

  const limiter = ac.createWaveShaper();
  limiter.curve = softClipCurve();
  limiter.oversample = '4x';

  src.connect(hp).connect(presence).connect(norm).connect(comp)
     .connect(out).connect(limiter).connect(ac.destination);
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
