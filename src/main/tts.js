const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { app } = require('electron');

// Síntesis de voz a WAV, para los avisos del coach.
//
// Por qué no usamos `speechSynthesis` del renderer: reproduce el audio él mismo
// y no lo entrega, así que el volumen no puede pasar del 100% ni se le puede
// aplicar compresión. Y hace falta: medido sobre la voz de Windows, el pico
// llega al 49% de la escala y el promedio al 2,6%, o sea que sale con la mitad
// del rango sin usar y por eso se pierde contra el ruido del juego.
//
// Generando el WAV acá, el renderer lo pasa por WebAudio y puede normalizarlo,
// comprimirlo y amplificarlo (ver renderer/lib/voice.js).
//
// El motor es el sintetizador de Windows por WinRT, que expone las voces
// "OneCore" — las mismas que usa Chromium y las mejores que trae el sistema.
// Se invoca con -EncodedCommand para no depender de un .ps1 en disco, que no
// sería accesible dentro del asar del build.

const PS = 'powershell.exe';
const TIMEOUT_MS = 20000;
const MAX_TEXT = 400;
const MAX_CACHE_FILES = 300;

// Prólogo común: acceso a WinRT y un helper para esperar operaciones async.
const PRELUDE = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType=WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType=WindowsRuntime]
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) {
  $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $t.Wait(15000)) { throw 'timeout' }
  $t.Result
}
`;

const SYNTH_SCRIPT = `${PRELUDE}
$synth = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
if ($env:IFLY_TTS_VOICE) {
  $v = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
       Where-Object { $_.DisplayName -eq $env:IFLY_TTS_VOICE } | Select-Object -First 1
  if ($v) { $synth.Voice = $v }
}
$stream = Await $synth.SynthesizeTextToStreamAsync($env:IFLY_TTS_TEXT) ([Windows.Media.SpeechSynthesis.SpeechSynthesisStream])
$size = [uint32]$stream.Size
$reader = New-Object Windows.Storage.Streams.DataReader($stream)
$null = Await $reader.LoadAsync($size) ([uint32])
$bytes = New-Object byte[] $size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($env:IFLY_TTS_OUT, $bytes)
`;

const VOICES_SCRIPT = `${PRELUDE}
[Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices |
  ForEach-Object { $_.DisplayName + '|' + $_.Language + '|' + $_.Gender }
`;

const encode = (script) => Buffer.from(script, 'utf16le').toString('base64');

function run(script, env = {}) {
  return new Promise((resolve, reject) => {
    execFile(
      PS,
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', encode(script)],
      { timeout: TIMEOUT_MS, windowsHide: true, env: { ...process.env, ...env } },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout || '')))
    );
  });
}

function cacheDir() {
  const d = path.join(app.getPath('userData'), 'tts-cache');
  try { fs.mkdirSync(d, { recursive: true }); } catch (_) {}
  return d;
}

// El caché es lo que hace viable esto en vivo: sintetizar cuesta ~450 ms, que
// llegando a una curva es tarde. El coach pide las frases de la vuelta al
// cruzar meta (las conoce con una vuelta de anticipación), así que cuando toca
// decirlas ya están en disco y sonar es instantáneo.
function cachePath(text, voice) {
  const key = crypto.createHash('sha1').update(`${voice || ''}::${text}`).digest('hex');
  return path.join(cacheDir(), `${key}.wav`);
}

// Borra lo más viejo cuando el caché crece. Las frases llevan números
// ("frená 23 m antes"), así que el conjunto no es acotado.
function pruneCache() {
  try {
    const d = cacheDir();
    const files = fs.readdirSync(d)
      .filter((f) => f.endsWith('.wav'))
      .map((f) => { const p = path.join(d, f); return { p, t: fs.statSync(p).mtimeMs }; })
      .sort((a, b) => b.t - a.t);
    for (const f of files.slice(MAX_CACHE_FILES)) { try { fs.unlinkSync(f.p); } catch (_) {} }
  } catch (_) {}
}

let _voices = null;
async function listVoices() {
  if (_voices) return _voices;
  try {
    const out = await run(VOICES_SCRIPT);
    _voices = out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [name, lang, gender] = l.split('|');
      return { name, lang: lang || '', gender: gender || '' };
    });
  } catch (_) {
    _voices = [];
  }
  return _voices;
}

// Síntesis en curso por clave, para que dos pedidos del mismo texto no lancen
// dos procesos de PowerShell.
const inFlight = new Map();

async function synth(text, voice) {
  const clean = String(text || '').slice(0, MAX_TEXT).trim();
  if (!clean) return null;
  const out = cachePath(clean, voice);
  if (fs.existsSync(out)) {
    try { return fs.readFileSync(out); } catch (_) {}
  }
  if (inFlight.has(out)) return inFlight.get(out);

  const job = (async () => {
    await run(SYNTH_SCRIPT, { IFLY_TTS_TEXT: clean, IFLY_TTS_VOICE: voice || '', IFLY_TTS_OUT: out });
    const buf = fs.readFileSync(out);
    pruneCache();
    return buf;
  })().finally(() => inFlight.delete(out));

  inFlight.set(out, job);
  return job;
}

module.exports = { synth, listVoices };
