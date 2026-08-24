import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Upload, Volume2, VolumeX, Compass, Crosshair, MapPin, Play } from "lucide-react";
import { resampleSamples } from "../lib/coach.js";
import { detectCorners, lapFacts, cornerFacts, compareCorner, bestAdvice, announcePct, isWithinLead, anchorPct, fillTrackGaps, posAtPct, isLapCrossing } from "../lib/coach-live.js";
import { findLovelyTrack, lovelyCorners, labelForRange } from "../lib/lovely-tracks.js";
import * as voice from "../lib/voice.js";
import { sameTrackAny } from "../lib/session-match.js";

// Coach en vivo: mapa que sigue al auto (estilo Google Maps) sobre la foto
// satelital, con la referencia dibujada adelante y tu recorrido pintándose
// atrás, más avisos determinísticos curva por curva.
//
// De dónde salen los datos: el main manda un frame a ~30 Hz por 'coach:frame'
// mientras esta vista está suscripta (canales que NO viajan en el payload de
// los overlays: pedales, marcha, volante, lat/lon). La referencia es una vuelta
// cualquiera del análisis — típicamente un CSV de Garage 61 importado.

const BINS = 800;                 // misma resolución que el resto del análisis
const TRAIL_KEEP = BINS;          // el recorrido se borra al cruzar meta
const LEAD_SECONDS = 2.5;         // cuánto antes de la curva avisar
const ADVICE_MIN_MS = 2600;       // un aviso no pisa a otro antes de esto
const ADVICE_HOLD_MS = 7000;      // y se borra solo pasado esto
const VOICE_MIN_MS = 3500;        // y no se habla encima de otro aviso
const M_PER_DEG_LAT = 111320;     // metros por grado de latitud
// Cuánto de la vuelta hace falta haber recorrido para fijar el desfase. Un
// tercio alcanza: con ~250 muestras repartidas por el trazado el ruido de
// bineado ya se cancela, y exigir más hacía que una vuelta con un tramo perdido
// (un paso por boxes) no calibrara nunca.
const OFFSET_MIN_COVERAGE = 1 / 3;
// La trazada reconstruida se muestra sólo cuando el desfase contra la
// referencia se midió con una vuelta ENTERA. Con media vuelta (la de salida de
// boxes) el desfase queda sesgado: medido sobre .ibt reales daba más de 100 m de
// error. Hasta entonces el auto se ubica por distancia de vuelta, que es exacta
// a lo largo del trazado, y la trazada propia va en banda paralela.
const TRAIL_OFFSET_M = 6;         // separación de tu trazada respecto de la referencia
const HEADING_SMOOTH = 0.15;      // suavizado del rumbo (0..1, más = más nervioso)
const SPAN_OPTIONS = [120, 220, 400, 800]; // metros de pista visibles

// ── Proyección Web Mercator ───────────────────────────────────────────────
// Los tiles satelitales viven en este espacio, así que usarlo como sistema de
// coordenadas del mapa evita cualquier transformación entre la trazada y la
// foto: caen encima sin ajustar nada.
const worldPx = (z) => 256 * 2 ** z;
const lonToX = (lon, z) => ((lon + 180) / 360) * worldPx(z);
const latToY = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * worldPx(z);
};
const metersPerPixel = (lat, z) => (156543.03392 * Math.cos((lat * Math.PI) / 180)) / 2 ** z;

// Zoom que hace entrar `spanM` metros en ~1200 px de viewBox, acotado a lo que
// Esri sirve con detalle.
function zoomForSpan(lat, spanM) {
  const target = spanM / 1200; // m/px deseados
  const z = Math.log2((156543.03392 * Math.cos((lat * Math.PI) / 180)) / target);
  return Math.max(14, Math.min(19, Math.round(z)));
}

const TILE_URL = (z, x, y) => `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`;

// Path SVG a partir de puntos {x,y}, cortando en los null.
function pointsPath(pts) {
  let d = "", pen = false;
  for (const p of pts) {
    if (!p) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

// Sub-paths sólo donde `on(i)` es cierto: sirve para pintar las zonas de freno
// y de acelerador a fondo encima de la línea de referencia, sin generar 800
// nodos en el DOM.
function maskedPath(pts, on) {
  let d = "", pen = false;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (!p || !on(i)) { pen = false; continue; }
    d += `${pen ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`;
    pen = true;
  }
  return d;
}

const fmtLapTime = (s) => {
  if (s == null || !isFinite(s) || s <= 0) return "—";
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, "0")}`;
};

// Volumen: 100% ya suena bastante más fuerte que la voz del navegador (el WAV
// se normaliza y se comprime, ver lib/voice.js). El tope de 300% es para
// escucharse por encima del juego con auriculares puestos.
const VOL_MIN = 0, VOL_MAX = 3, VOL_STEP = 0.1;
const VOL_KEY = "ifly.coachVoice";

function loadVoicePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(VOL_KEY) || "{}");
    return {
      on: !!raw.on,
      gain: isFinite(raw.gain) ? Math.min(VOL_MAX, Math.max(VOL_MIN, raw.gain)) : 1.4,
      voiceName: typeof raw.voiceName === "string" ? raw.voiceName : "",
    };
  } catch (_) {
    return { on: false, gain: 1.4, voiceName: "" };
  }
}
function saveVoicePrefs(p) {
  try { localStorage.setItem(VOL_KEY, JSON.stringify(p)); } catch (_) {}
}

export function CoachView() {
  // ── Referencia ──────────────────────────────────────────────────────────
  const [sessions, setSessions] = useState([]);
  const [refInfo, setRefInfo] = useState(null); // { label, track, car, lapTime, samples, trackLength }
  const [loadingRef, setLoadingRef] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);

  // ── Opciones ────────────────────────────────────────────────────────────
  const [spanM, setSpanM] = useState(220);
  const prefs0 = useMemo(() => loadVoicePrefs(), []);
  const [voiceOn, setVoiceOn] = useState(prefs0.on);
  const [gain, setGain] = useState(prefs0.gain);
  const [voiceName, setVoiceName] = useState(prefs0.voiceName);
  const [voices, setVoices] = useState([]);
  const [testing, setTesting] = useState(false);
  const [headingUp, setHeadingUp] = useState(true);
  const [scope, setScope] = useState("all"); // all | s1 | s2 | s3 | c<i>

  // ── Estado en vivo (se re-renderiza a ~30 Hz) ───────────────────────────
  const [tick, setTick] = useState(0);
  const [status, setStatus] = useState({ connected: false, onTrack: false, track: null, trackKey: null, car: null });
  const [advice, setAdvice] = useState(null);      // aviso grande (anticipado)
  const [lastNote, setLastNote] = useState(null);  // qué pasó en la curva que acabás de hacer
  const [shapeVersion, setShapeVersion] = useState(0); // crece al aprender geometría

  const eng = useRef({
    bins: new Array(BINS).fill(null),
    lap: null,
    pct: 0,
    speed: 0,
    lat: null,
    lon: null,
    heading: 0,
    verdicts: [],       // aviso por curva, de la vuelta anterior
    announced: new Set(),
    reacted: new Set(),
    variant: 0,
    adviceAt: 0,
    voiceAt: 0,
    trackLengthM: 0,
    trailVersion: 0,
    // Forma de la pista aprendida manejando: lat/lon por bin. NO se borra al
    // cruzar meta (la trazada sí), porque es la geometría del circuito y sirve
    // para ubicar la referencia cuando la referencia no trae GPS.
    // Posición estimada por el main (metros este/norte, origen arbitrario) y el
    // ancla que la lleva a lat/lon sobre la geometría de la referencia.
    posE: null, posN: null,
    // Traslación (metros este/norte) que lleva la posición estimada al marco de
    // la referencia. Se recalcula al cerrar cada vuelta con TODA la vuelta.
    offE: null, offN: null,
    offLocked: false,         // true = medido con una vuelta entera
    prevPct: null,
    // Acumulador del desfase de la vuelta en curso. Va aparte de los bins a
    // propósito: los bins son para dibujar y se borran en cualquier
    // discontinuidad, y antes eso se llevaba puesta la calibración con ellos.
    accE: 0, accN: 0, accC: 0,
    // Diagnóstico: por qué se perdió la calibración.
    wipes: 0, lastWipe: '',
    shape: new Array(BINS).fill(null),
    shapeFilled: 0,
    frames: 0,
    framesGps: 0,
  });

  // ── Carga de sesiones para elegir referencia ────────────────────────────
  const loadList = useCallback(async () => {
    if (!window.fly?.getRecordings) return;
    const [live, ibt] = await Promise.all([
      window.fly.getRecordings(),
      window.fly.getIbtSessions ? window.fly.getIbtSessions() : Promise.resolve([]),
    ]);
    const merged = [
      ...(live || []).map((s) => ({ ...s, source: "live" })),
      ...(ibt || []),
    ].sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
    setSessions(merged);
  }, []);
  useEffect(() => { loadList(); }, [loadList]);

  const loadReference = useCallback(async (id, label) => {
    const getter = /^(ibt|csv|ifly)/.test(id) ? window.fly?.getIbtSession : window.fly?.getRecording;
    if (!getter) return;
    setLoadingRef(true);
    try {
      const s = await getter(id);
      const laps = (s?.laps || []).filter((l) => l && l.lapTime > 0 && Array.isArray(l.samples));
      if (!laps.length) { setRefInfo(null); return; }
      const lap = laps.slice().sort((a, b) => a.lapTime - b.lapTime)[0];
      setRefInfo({
        id,
        label: label || `${s.track} · ${s.car}`,
        track: s.track,
        trackKey: s.trackKey,
        car: s.car,
        lapTime: lap.lapTime,
        trackLength: (s.trackLength || 0) * 1000, // km → m
        samples: resampleSamples(lap.samples, BINS),
      });
    } finally {
      setLoadingRef(false);
      setPickerOpen(false);
    }
  }, []);

  const importReference = useCallback(async () => {
    if (!window.fly?.importIbt) return;
    const meta = await window.fly.importIbt();
    if (meta && meta.id) {
      await loadList();
      await loadReference(meta.id, `${meta.track} · ${meta.car}`);
    }
  }, [loadList, loadReference]);

  useEffect(() => { saveVoicePrefs({ on: voiceOn, gain, voiceName }); }, [voiceOn, gain, voiceName]);

  // Voces del sistema (las que expone Windows por WinRT).
  useEffect(() => {
    if (!window.fly?.ttsVoices) return;
    window.fly.ttsVoices().then((v) => {
      setVoices(Array.isArray(v) ? v : []);
      // Por defecto, la primera voz en español.
      setVoiceName((cur) => cur || (v || []).find((x) => /^es/i.test(x.lang))?.name || (v || [])[0]?.name || "");
    }).catch(() => {});
  }, []);

  // Sintetiza y deja el audio listo para sonar. Devuelve true si quedó cargado.
  const prime = useCallback(async (text) => {
    if (!text || voice.isLoaded(text)) return voice.isLoaded(text);
    if (!window.fly?.ttsSay) return false;
    try {
      const wav = await window.fly.ttsSay(text, voiceNameRef.current);
      if (!wav) return false;
      return !!(await voice.preload(text, wav));
    } catch (_) { return false; }
  }, []);
  const primeRef = useRef(prime); primeRef.current = prime;

  const sayNow = useCallback(async (text) => {
    if (!text) return;
    if (!voice.isLoaded(text)) await prime(text);
    if (!voice.play(text, { gain: gainRef.current })) {
      // Sin síntesis del sistema queda la voz del navegador, que no puede
      // pasar del 100% de volumen.
      voice.fallbackSpeak(text);
    }
  }, [prime]);
  const sayRef = useRef(sayNow); sayRef.current = sayNow;

  // ── Curvas de la referencia + datos de cada una ─────────────────────────
  const trackData = useMemo(
    () => (refInfo ? findLovelyTrack(refInfo.trackKey, refInfo.track) : null),
    [refInfo]
  );
  const namedCorners = useMemo(() => lovelyCorners(trackData), [trackData]);

  const plan = useMemo(() => {
    if (!refInfo || !refInfo.samples) return null;
    const base = detectCorners(refInfo.samples).map((c) => ({
      ...c,
      label: labelForRange(namedCorners, c.pctStart, c.pctEnd) || `Curva ${c.index + 1}`,
    }));
    const facts = lapFacts(refInfo.samples, base);
    // El aviso se ancla al punto de FRENADA de la referencia, no al inicio de
    // la curva: un "frená 60 m antes" que llega cuando ya estás frenando no
    // sirve de nada. Si la referencia no frena ahí, el ancla es la curva.
    const corners = base.map((c, i) => ({ ...c, anchorPct: anchorPct(c, facts[i]) }));
    return { corners, facts };
  }, [refInfo, namedCorners]);

  // Sectores para el selector de alcance (los reales de Lovely si están).
  const sectorPcts = useMemo(() => {
    if (trackData && Array.isArray(trackData.sectors) && trackData.sectors.length) {
      const p = trackData.sectors.map((s) => s.m).filter((m) => m > 0 && m < 1);
      if (p.length) return p;
    }
    return [1 / 3, 2 / 3];
  }, [trackData]);

  // ¿Esta curva entra en el alcance elegido?
  const inScope = useCallback((corner) => {
    if (scope === "all") return true;
    if (scope.startsWith("c")) return corner.index === parseInt(scope.slice(1), 10);
    const i = parseInt(scope.slice(1), 10) - 1; // s1 → 0
    const lo = i === 0 ? 0 : sectorPcts[i - 1];
    const hi = i >= sectorPcts.length ? 1 : sectorPcts[i];
    return corner.pctStart >= lo && corner.pctStart < hi;
  }, [scope, sectorPcts]);

  // ── Suscripción al stream del main ──────────────────────────────────────
  const planRef = useRef(null); planRef.current = plan;
  const refRef = useRef(null); refRef.current = refInfo;
  const inScopeRef = useRef(inScope); inScopeRef.current = inScope;
  const voiceRef = useRef(voiceOn); voiceRef.current = voiceOn;
  const gainRef = useRef(gain); gainRef.current = gain;
  const voiceNameRef = useRef(voiceName); voiceNameRef.current = voiceName;

  useEffect(() => {
    if (!window.fly?.onCoachFrame) return;
    window.fly.subscribeCoach?.(true);
    const unsub = window.fly.onCoachFrame((f) => {
      const e = eng.current;

      // Cruce de meta: cerramos la vuelta, sacamos las conclusiones y borramos
      // el recorrido dibujado.
      // Cruce de meta. Se detecta por el salto de LapDistPct y no por el
      // `completedLap` del SDK: ese evento exige una vuelta anterior
      // cronometrada, así que saliendo de boxes la primera pasada por meta no
      // lo dispara — y sin él no se borraba la trazada ni se reajustaba la
      // posición, que es justo lo que se veía mal.
      if (isLapCrossing(e.prevPct, f.lapDistPct)) {
        const p = planRef.current, r = refRef.current;
        if (p && r) {
          const mine = lapFacts(e.bins, p.corners);
          const L = r.trackLength || e.trackLengthM || 0;
          e.verdicts = p.corners.map((c, i) =>
            bestAdvice(compareCorner(mine[i], p.facts[i], { trackLength: L }), {
              variant: e.variant + i,
              cornerLabel: c.label,
            })
          );
        }
        // Sintetizar por adelantado las frases de la vuelta: cuesta ~450 ms cada
        // una, y llegando a una curva eso es tarde. Acá ya se sabe todo lo que
        // se va a decir en la vuelta que arranca, así que cuando toque decirlo
        // el audio va a estar listo.
        if (voiceRef.current) {
          for (const v of e.verdicts) {
            if (v) primeRef.current(`${v.cornerLabel}. ${v.text}`);
          }
        }

        // Fijar el desfase con el promedio de TODA la vuelta. Anclar en un solo
        // punto hereda el error de ese bin de la referencia (con 800 bins, en
        // Spa cada bin son ~9 m) y desplaza la vuelta entera; promediando sobre
        // miles de muestras ese ruido se cancela.
        if (e.accC >= BINS * OFFSET_MIN_COVERAGE) {
          e.offE = e.accE / e.accC;
          e.offN = e.accN / e.accC;
          e.offLocked = true;
        }
        e.accE = 0; e.accN = 0; e.accC = 0;
        e.bins = new Array(BINS).fill(null);
        e.announced = new Set();
        e.reacted = new Set();
        e.variant++;
        e.trailVersion++;
        setShapeVersion((v) => v + 1); // la forma de la pista ya está completa
      }
      e.prevPct = f.lapDistPct;

      e.frames++;
      if (f.posE != null) e.framesGps++;

      // Volver a boxes, un reset o un tow teletransportan el auto, y la
      // navegación a estima no puede ver un salto sin velocidad de por medio:
      // de ahí en adelante la posición queda corrida por la distancia del
      // salto. Las muestras de antes y de después no son comparables, así que
      // se descartan y la calibración se mide de nuevo.
      //
      // No hay ninguna heurística por distancia acá a propósito: el desfase se
      // remide en CADA cruce de meta, así que un salto que no venga marcado se
      // corrige solo en la vuelta siguiente. Intentar detectarlo por "la
      // posición se fue lejos" invalidaba calibraciones que estaban bien.
      if (!f.onTrack || f.onPitRoad) {
        if (e.offE != null || e.accC > 0) {
          e.offE = null; e.offN = null; e.offLocked = false;
          e.accE = 0; e.accN = 0; e.accC = 0;
          e.bins = new Array(BINS).fill(null);
          e.trailVersion++;
          e.wipes++;
          e.lastWipe = !f.onTrack ? 'fuera de pista' : 'boxes';
        }
      }
      if (f.posE != null && f.posN != null) { e.posE = f.posE; e.posN = f.posN; }
      // En boxes el LapDistPct va sobre el recorrido del pit lane, no sobre el
      // trazado, así que esas muestras no se guardan: contaminaban el desfase
      // (medido: 350 m de error saliendo de boxes en Oschersleben) y dibujaban
      // una trazada que cruzaba la pista.
      if (f.onTrack && !f.onPitRoad && f.lapDistPct >= 0 && f.lapDistPct <= 1) {
        const b = Math.min(BINS - 1, Math.max(0, Math.floor(f.lapDistPct * BINS)));
        e.bins[b] = { th: f.throttle, br: f.brake, st: f.steer, sp: f.speed, g: f.gear, lat: f.lat, lon: f.lon, pe: f.posE, pn: f.posN };
        // Desfase contra la referencia en este punto, acumulado para la vuelta.
        if (f.posE != null && refMRef.current) {
          const rp = refMRef.current.pts[b];
          if (rp) { e.accE += rp.e - f.posE; e.accN += rp.n - f.posN; e.accC++; }
        }
        if (f.lat != null && f.lon != null && e.shape[b] == null) {
          e.shape[b] = { lat: f.lat, lon: f.lon };
          e.shapeFilled++;
          // Rearmamos la capa de referencia cada tanto mientras se completa la
          // forma, no en cada bin: son 800 puntos a rearmar.
          if (e.shapeFilled % 80 === 0) setShapeVersion((v) => v + 1);
        }
      }
      e.pct = f.lapDistPct ?? e.pct;
      e.speed = f.speed ?? 0;
      // El CSV de Garage 61 no trae el largo de pista; el frame en vivo sí, y
      // sin metros las reglas de frenada y aceleración no se pueden evaluar.
      if (f.trackLength > 0) e.trackLengthM = f.trackLength * 1000;
      e.lap = f.lap ?? e.lap;
      if (f.lat != null && f.lon != null) {
        // Rumbo desde el propio movimiento (no hace falta un canal de yaw), con
        // suavizado circular para que el mapa no tiemble en las rectas.
        if (e.lat != null) {
          const dLon = (f.lon - e.lon) * Math.cos((f.lat * Math.PI) / 180);
          const dLat = f.lat - e.lat;
          if (Math.hypot(dLon, dLat) > 2e-6) {
            const raw = ((Math.atan2(dLon, dLat) * 180) / Math.PI + 360) % 360;
            let d = raw - e.heading;
            while (d > 180) d -= 360;
            while (d < -180) d += 360;
            e.heading = (e.heading + d * HEADING_SMOOTH + 360) % 360;
          }
        }
        e.lat = f.lat; e.lon = f.lon;
      }

      const p = planRef.current, r = refRef.current;
      const now = Date.now();
      if (p && r) {
        // 1) Aviso ANTICIPADO: lo que hiciste mal acá la vuelta pasada, dicho
        //    antes de llegar. Es la única forma de que sirva: un consejo que
        //    llega saliendo de la curva ya no se puede aplicar.
        for (const c of p.corners) {
          if (e.announced.has(c.index)) continue;
          if (!inScopeRef.current(c)) continue;
          const v = e.verdicts[c.index];
          if (!v) continue;
          const trigger = announcePct(c.anchorPct, e.speed, { trackLength: r.trackLength || e.trackLengthM, seconds: LEAD_SECONDS });
          if (!isWithinLead(e.pct, trigger, c.anchorPct)) continue;
          if (now - e.adviceAt < ADVICE_MIN_MS) continue;
          e.announced.add(c.index);
          e.adviceAt = now;
          setAdvice({ ...v, at: now });
          if (voiceRef.current && now - e.voiceAt > VOICE_MIN_MS) {
            e.voiceAt = now;
            sayRef.current(`${v.cornerLabel}. ${v.text}`);
          }
        }

        // 2) Nota REACTIVA de la curva que acabás de hacer. No se habla (llega
        //    tarde por definición), pero deja ver el efecto de la corrección
        //    sin esperar a la vuelta siguiente.
        for (const c of p.corners) {
          if (e.reacted.has(c.index)) continue;
          if (e.pct <= c.pctEnd + 0.01 || e.pct > c.pctEnd + 0.06) continue;
          e.reacted.add(c.index);
          const mine = cornerFacts(e.bins, c);
          const a = bestAdvice(compareCorner(mine, p.facts[c.index], { trackLength: r.trackLength || e.trackLengthM }), {
            variant: e.variant + c.index,
            cornerLabel: c.label,
          });
          setLastNote(a ? { ...a, at: now } : { cornerLabel: c.label, text: "Bien ahí", kind: "ok", at: now });
        }
      }

      // El aviso grande se apaga solo: dejarlo puesto media vuelta después
      // haría creer que sigue vigente.
      if (e.adviceAt && now - e.adviceAt > ADVICE_HOLD_MS) {
        e.adviceAt = 0;
        setAdvice(null);
      }

      setStatus((prev) => (
        prev.connected === true && prev.onTrack === !!f.onTrack && prev.track === f.track
          ? prev
          : { connected: true, onTrack: !!f.onTrack, track: f.track, trackKey: f.trackKey, car: f.car }
      ));
      setTick((t) => (t + 1) % 1e6);
    });
    return () => {
      unsub && unsub();
      window.fly.subscribeCoach?.(false);
      try { window.speechSynthesis && window.speechSynthesis.cancel(); } catch (_) {}
    };
  }, []);

  // ── Mapa ────────────────────────────────────────────────────────────────
  // Zoom y proyección se fijan a partir de la referencia: si dependieran de la
  // posición del auto cambiarían en cada frame y los tiles se recargarían.
  // Geometría del circuito por bin: la de la referencia si trae GPS (un CSV de
  // Garage 61 sí, y encima es la línea que hay que copiar), y si no la que
  // aprendimos manejando. Tener las dos permite que el mapa funcione aunque a
  // una de las dos fuentes le falte la posición.
  const trackShape = useMemo(() => {
    const fromRef = (refInfo?.samples || []).map((s) => (s && s.lat != null && s.lon != null ? { lat: s.lat, lon: s.lon } : null));
    const refCount = fromRef.filter(Boolean).length;
    const live = eng.current.shape;
    const out = new Array(BINS).fill(null);
    for (let i = 0; i < BINS; i++) out[i] = (refCount >= 20 ? fromRef[i] : null) || live[i] || null;
    return { pts: out, count: out.filter(Boolean).length, refHasGps: refCount >= 20 };
  }, [refInfo, shapeVersion]);

  // Geometría sin huecos, para poder ubicar el auto en cualquier fracción de
  // vuelta y no sólo en los 800 bins.
  const smooth = useMemo(() => fillTrackGaps(trackShape.pts), [trackShape]);

  // La misma geometría en metros (este/norte) desde su primer punto: es el
  // marco donde se compara contra la posición estimada, que también viene en
  // metros. Trabajar en metros evita mezclar grados con distancias.
  const refM = useMemo(() => {
    if (!smooth || !smooth[0]) return null;
    const lat0 = smooth[0].lat, lon0 = smooth[0].lon;
    const mLon = M_PER_DEG_LAT * Math.cos((lat0 * Math.PI) / 180);
    return {
      lat0, lon0, mLon,
      pts: smooth.map((p) => (p ? { e: (p.lon - lon0) * mLon, n: (p.lat - lat0) * M_PER_DEG_LAT } : null)),
    };
  }, [smooth]);
  const refMRef = useRef(null); refMRef.current = refM;

  // Proyección: se ancla al primer punto conocido y NO cambia con el auto, para
  // que los tiles no se recarguen en cada frame.
  const geo = useMemo(() => {
    const anchor = trackShape.pts.find(Boolean);
    if (!anchor) return null;
    const z = zoomForSpan(anchor.lat, spanM);
    const ox = lonToX(anchor.lon, z), oy = latToY(anchor.lat, z);
    const proj = (la, lo) => ({ x: lonToX(lo, z) - ox, y: latToY(la, z) - oy });
    return { z, ox, oy, proj, mpp: metersPerPixel(anchor.lat, z) };
  }, [trackShape, spanM]);

  // Trazada de la referencia en coordenadas del mapa (una vez por referencia).
  const refPath = useMemo(() => {
    if (!geo || !refInfo) return null;
    const pts = refInfo.samples.map((s, i) => {
      const g = (s && s.lat != null && s.lon != null) ? s : trackShape.pts[i];
      return g ? { ...geo.proj(g.lat, g.lon), br: s ? s.br : null, th: s ? s.th : null } : null;
    });
    return {
      line: pointsPath(pts),
      brake: maskedPath(pts, (i) => (pts[i]?.br ?? 0) > 0.15),
      throttle: maskedPath(pts, (i) => (pts[i]?.th ?? 0) > 0.95),
      pts,
    };
  }, [geo, refInfo, trackShape]);

  // Posición del auto y recorrido hecho (se recalculan en cada frame; el trail
  // es un solo path de ≤800 puntos, barato de rearmar).
  const e = eng.current;

  // La posición estimada viene en metros con origen arbitrario; el desfase
  // hasta el marco de la referencia lo mide el handler (progresivo mientras no
  // haya una vuelta entera, y con la vuelta entera en cada cruce de meta).
  const toLatLon = (pe, pn) => {
    if (!refM || e.offE == null || pe == null || pn == null) return null;
    return {
      lat: refM.lat0 + (pn + e.offN) / M_PER_DEG_LAT,
      lon: refM.lon0 + (pe + e.offE) / refM.mLon,
    };
  };

  // Posición del auto: la estimada (que es la trazada REAL) y, si por lo que
  // fuera no hubiera, el punto de la referencia en tu distancia de vuelta.
  const hasRealLine = e.offLocked && e.offE != null && e.posE != null;
  const carGeo = (hasRealLine ? toLatLon(e.posE, e.posN) : null) || (smooth ? posAtPct(smooth, e.pct) : null);
  const car = geo && carGeo ? geo.proj(carGeo.lat, carGeo.lon) : null;

  // Tu recorrido. Con la posición estimada es la trazada REAL, en su lugar
  // real: se ve si vas por afuera o por adentro de la referencia. Si no la
  // hubiera, se cae a una banda paralela a la referencia (no se puede saber la
  // posición lateral, y superponerla haría creer que la estás calcando).
  const trail = useMemo(() => {
    if (!geo) return null;
    const pts = new Array(BINS).fill(null);
    if (hasRealLine) {
      for (let i = 0; i < BINS; i++) {
        const b = e.bins[i];
        if (!b || b.pe == null) continue;
        const ll = toLatLon(b.pe, b.pn);
        if (ll) pts[i] = geo.proj(ll.lat, ll.lon);
      }
    } else if (smooth) {
      const off = TRAIL_OFFSET_M / geo.mpp;
      const n = smooth.length;
      const pt = (i) => geo.proj(smooth[i].lat, smooth[i].lon);
      for (let i = 0; i < BINS; i++) {
        if (!e.bins[i]) continue;
        const a = pt((i - 1 + n) % n), b = pt((i + 1) % n), c = pt(i % n);
        const dx = b.x - a.x, dy = b.y - a.y;
        const len = Math.hypot(dx, dy) || 1;
        pts[i] = { x: c.x - (dy / len) * off, y: c.y + (dx / len) * off };
      }
    } else return null;
    return {
      line: pointsPath(pts),
      brake: maskedPath(pts, (i) => (e.bins[i]?.br ?? 0) > 0.15),
      throttle: maskedPath(pts, (i) => (e.bins[i]?.th ?? 0) > 0.95),
    };
  }, [geo, smooth, hasRealLine, tick]);

  // Rumbo: con GPS sale del movimiento; sin GPS, de la tangente de la pista en
  // el punto donde estás.
  const headingDeg = useMemo(() => {
    // Con posición estimada el rumbo sale del movimiento real.
    if (hasRealLine) {
      const b = Math.floor(e.pct * BINS);
      for (let back = 3; back <= 25; back++) {
        const s0 = e.bins[(b - back + BINS) % BINS];
        if (!s0 || s0.pe == null) continue;
        const dE = e.posE - s0.pe, dN = e.posN - s0.pn;
        if (Math.hypot(dE, dN) < 3) continue;
        const raw = ((Math.atan2(dE, dN) * 180) / Math.PI + 360) % 360;
        let d = raw - e.heading;
        while (d > 180) d -= 360;
        while (d < -180) d += 360;
        e.heading = (e.heading + d * HEADING_SMOOTH + 360) % 360;
        return e.heading;
      }
      return e.heading;
    }
    if (e.lat != null) return e.heading;
    if (!smooth) return 0;
    const a = posAtPct(smooth, e.pct - 0.002), b = posAtPct(smooth, e.pct + 0.002);
    if (!a || !b) return 0;
    const dLon = (b.lon - a.lon) * Math.cos((b.lat * Math.PI) / 180);
    return ((Math.atan2(dLon, b.lat - a.lat) * 180) / Math.PI + 360) % 360;
  }, [smooth, hasRealLine, tick]);

  // Tiles alrededor del auto: sólo los que se ven, y se agregan a medida que
  // avanzás. Bajar el mosaico entero de la pista a este zoom serían cientos.
  const [tiles, setTiles] = useState([]);
  const tileKeys = useRef(new Set());
  useEffect(() => { tileKeys.current = new Set(); setTiles([]); }, [geo?.z]);
  useEffect(() => {
    if (!geo || !car) return;
    const spanPx = spanM / geo.mpp;
    const half = spanPx * 0.85; // margen para cubrir cualquier rotación
    const tx0 = Math.floor((car.x + geo.ox - half) / 256), tx1 = Math.floor((car.x + geo.ox + half) / 256);
    const ty0 = Math.floor((car.y + geo.oy - half) / 256), ty1 = Math.floor((car.y + geo.oy + half) / 256);
    const add = [];
    for (let tx = tx0; tx <= tx1; tx++) {
      for (let ty = ty0; ty <= ty1; ty++) {
        const k = `${tx}/${ty}`;
        if (tileKeys.current.has(k)) continue;
        tileKeys.current.add(k);
        add.push({ k, px: tx * 256 - geo.ox, py: ty * 256 - geo.oy, url: TILE_URL(geo.z, tx, ty) });
      }
    }
    if (add.length) setTiles((prev) => [...prev, ...add].slice(-120));
  }, [geo, car?.x, car?.y, spanM]);

  const view = useMemo(() => {
    if (!geo || !car) return null;
    const w = spanM / geo.mpp;
    const h = w * 0.62;
    return { x: car.x - w / 2, y: car.y - h / 2, w, h };
  }, [geo, car?.x, car?.y, spanM]);

  // ¿La referencia es de otra pista? Se compara con la misma regla tolerante
  // que usa el Análisis para decidir si una vuelta sirve de referencia: iRacing
  // nombra el mismo circuito de varias formas ("Virginia International Raceway"
  // vs "Virginia International Raceway (Full Course)" vs "virginia 2022 full"),
  // y comparar los strings tal cual daba una falsa alarma.
  const wrongTrack = !!(refInfo && status.track && !sameTrackAny(refInfo, status));

  // Muestras propias acumuladas en la vuelta: es lo que se necesita para
  // recalibrar en la meta, así que verlo explica por qué falta la trazada.
  const binCount = e.bins.reduce((a, b) => a + (b && b.pe != null ? 1 : 0), 0);

  // Cuántas curvas tienen algo para avisar con lo de la vuelta pasada.
  const readyCount = e.verdicts.filter(Boolean).length;

  const rot = headingUp ? -headingDeg : 0;
  const k = view ? view.w / 900 : 1; // grosor de trazos ~constante en pantalla

  // ── Render ──────────────────────────────────────────────────────────────
  const waiting = !status.connected || !car;

  return (
    <div className="flex-1 flex flex-col min-h-0 p-4 gap-3 overflow-hidden">
      {/* Barra de control */}
      <div className="flex items-center gap-2 flex-wrap shrink-0">
        <button
          onClick={() => setPickerOpen((v) => !v)}
          className="px-3 py-1.5 rounded-md text-xs font-semibold bg-card border border-border hover:bg-accent/50 flex items-center gap-1.5"
        >
          <MapPin className="size-3.5" />
          {refInfo ? refInfo.label : "Elegir referencia"}
        </button>
        <button
          onClick={importReference}
          title="Importar una vuelta de Garage 61 (.csv), un .ibt o un .iflylap"
          className="px-2.5 py-1.5 rounded-md text-xs font-semibold bg-card border border-border hover:bg-accent/50 flex items-center gap-1.5"
        >
          <Upload className="size-3.5" /> Importar
        </button>
        {refInfo && (
          <span className="text-[11px] text-muted-foreground font-mono">
            {fmtLapTime(refInfo.lapTime)} · {plan ? `${plan.corners.length} curvas` : "…"}
          </span>
        )}

        <div className="flex-1" />

        {plan && (
          <select
            value={scope}
            onChange={(ev) => setScope(ev.target.value)}
            className="bg-card border border-border rounded-md text-xs px-2 py-1.5"
            title="Sobre qué parte de la pista querés que te avise"
          >
            <option value="all">Pista completa</option>
            <option value="s1">Sector 1</option>
            <option value="s2">Sector 2</option>
            <option value="s3">Sector 3</option>
            {plan.corners.map((c) => (
              <option key={c.index} value={`c${c.index}`}>{c.label}</option>
            ))}
          </select>
        )}

        <div className="flex border border-border rounded-md overflow-hidden">
          {SPAN_OPTIONS.map((m) => (
            <button
              key={m}
              onClick={() => setSpanM(m)}
              className="px-2 py-1 text-[10px] font-mono font-bold hover:bg-white/5"
              style={{ background: spanM === m ? "rgba(125,211,252,0.15)" : "transparent", color: spanM === m ? "rgb(125,211,252)" : "rgba(255,255,255,0.5)" }}
            >
              {m}m
            </button>
          ))}
        </div>

        <button
          onClick={() => setHeadingUp((v) => !v)}
          title={headingUp ? "El mapa gira con el auto" : "Norte arriba, gira el auto"}
          className="px-2 py-1.5 rounded-md text-xs bg-card border border-border hover:bg-accent/50"
        >
          {headingUp ? <Crosshair className="size-3.5" /> : <Compass className="size-3.5" />}
        </button>
        <div className="flex items-center gap-1.5 border border-border rounded-md px-1.5 py-1 bg-card">
          <button
            onClick={() => setVoiceOn((v) => !v)}
            title={voiceOn ? "Avisos por voz activados" : "Avisos por voz desactivados"}
            className="p-0.5 rounded hover:bg-white/10"
            style={{ color: voiceOn ? "rgb(52,211,153)" : "rgba(255,255,255,0.45)" }}
          >
            {voiceOn ? <Volume2 className="size-3.5" /> : <VolumeX className="size-3.5" />}
          </button>
          <input
            type="range"
            min={VOL_MIN}
            max={VOL_MAX}
            step={VOL_STEP}
            value={gain}
            onChange={(ev) => setGain(parseFloat(ev.target.value))}
            disabled={!voiceOn}
            className="w-20 accent-emerald-400"
            title="Volumen de los avisos. Al 100% ya suena más fuerte que la voz del navegador; se puede llegar al 300%."
          />
          <span className="text-[10px] font-mono tabular-nums w-8 text-right text-muted-foreground">
            {Math.round(gain * 100)}%
          </span>
          {voices.length > 0 && (
            <select
              value={voiceName}
              onChange={(ev) => { setVoiceName(ev.target.value); voice.clearCache(); }}
              disabled={!voiceOn}
              className="bg-transparent text-[10px] max-w-[110px] border-l border-border pl-1.5"
              title="Voz del sistema"
            >
              {voices.map((v) => (
                <option key={v.name} value={v.name}>{v.name.replace(/^Microsoft /, "")}</option>
              ))}
            </select>
          )}
          <button
            onClick={async () => {
              setTesting(true);
              voice.clearCache();
              await sayNow("Frená veinte metros más tarde y tomala más abierta");
              setTesting(false);
            }}
            disabled={testing}
            title="Escuchar una prueba con el volumen y la voz elegidos"
            className="p-0.5 rounded hover:bg-white/10 text-muted-foreground"
          >
            <Play className="size-3" />
          </button>
        </div>
      </div>

      {/* Selector de referencia */}
      {pickerOpen && (
        <div className="rounded-lg border border-border bg-card/60 p-2 max-h-52 overflow-y-auto shrink-0">
          {sessions.length === 0 && <div className="text-xs text-muted-foreground p-2">No hay sesiones. Importá un CSV de Garage 61.</div>}
          {sessions.map((s) => (
            <button
              key={s.id}
              onClick={() => loadReference(s.id, `${s.track} · ${s.car}`)}
              className="w-full text-left px-2 py-1.5 rounded-md text-xs hover:bg-accent/50 flex items-center gap-2"
            >
              <span className="font-semibold truncate">{s.track}</span>
              <span className="text-muted-foreground truncate">{s.car}</span>
              <span className="ml-auto font-mono text-muted-foreground">{fmtLapTime(s.bestLap)}</span>
              {s.source && s.source !== "live" && (
                <span className="text-[9px] uppercase tracking-widest text-muted-foreground/60">{s.source}</span>
              )}
            </button>
          ))}
        </div>
      )}

      {wrongTrack && (
        <div className="shrink-0 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">
          La referencia es de <b>{refInfo.track}</b> y estás en <b>{status.track}</b>. Los avisos no van a tener sentido hasta que elijas una referencia de esta pista.
        </div>
      )}

      {/* Aviso grande */}
      <div className="shrink-0 rounded-lg border border-border bg-card/40 px-4 py-3 min-h-[72px] flex items-center gap-4">
        {advice ? (
          <>
            <div className="text-[10px] uppercase tracking-widest text-sky-300 shrink-0 w-32 truncate">{advice.cornerLabel}</div>
            <div className="text-2xl font-bold leading-tight">{advice.text}</div>
            {advice.others > 0 && (
              <div className="ml-auto text-[10px] text-muted-foreground/60 shrink-0">+{advice.others} cosa{advice.others > 1 ? "s" : ""} más en esta curva</div>
            )}
          </>
        ) : (
          <div className="text-sm text-muted-foreground">
            {!refInfo
              ? "Elegí una referencia para empezar. Una vuelta de Garage 61 exportada en CSV sirve directo."
              : !status.connected
              ? "Esperando telemetría de iRacing…"
              : readyCount > 0
              ? `Listo: ${readyCount} curva${readyCount > 1 ? "s" : ""} con algo para corregir. Te aviso al llegar a cada una.`
              : "Completá una vuelta: los avisos de cada curva salen de comparar la vuelta anterior contra la referencia."}
          </div>
        )}
      </div>

      {/* Mapa */}
      <div className="flex-1 min-h-0 rounded-lg border border-border overflow-hidden relative bg-black">
        {view ? (
          <svg viewBox={`${view.x} ${view.y} ${view.w} ${view.h}`} preserveAspectRatio="xMidYMid slice" className="w-full h-full block">
            <g transform={`rotate(${rot} ${car.x} ${car.y})`}>
              {tiles.map((t) => (
                <image key={t.k} href={t.url} x={t.px} y={t.py} width="256" height="256" preserveAspectRatio="none" />
              ))}
              <rect x={view.x - view.w} y={view.y - view.h} width={view.w * 3} height={view.h * 3} fill="rgba(0,0,0,0.35)" />

              {/* Referencia: línea base + zonas de freno (rojo) y de acelerador
                  a fondo (verde), que es lo que hay que copiar. */}
              {refPath && <>
              <path d={refPath.line} fill="none" stroke="rgba(255,255,255,0.65)" strokeWidth={2.4 * k} strokeLinecap="round" strokeDasharray={`${7 * k} ${5 * k}`} />
              <path d={refPath.brake} fill="none" stroke="rgb(239,68,68)" strokeWidth={5 * k} strokeLinecap="round" opacity="0.9" />
              <path d={refPath.throttle} fill="none" stroke="rgb(52,211,153)" strokeWidth={5 * k} strokeLinecap="round" opacity="0.9" />
              </>}

              {/* Tu vuelta, en paralelo: amarillo de base, rojo donde frenás
                  vos y verde donde vas a fondo. Comparar tu banda contra la de
                  la referencia muestra quién frena antes y quién abre antes. */}
              {trail && <>
                <path d={trail.line} fill="none" stroke="rgba(234,179,8,0.75)" strokeWidth={2.6 * k} strokeLinecap="round" strokeLinejoin="round" />
                <path d={trail.brake} fill="none" stroke="rgb(239,68,68)" strokeWidth={4.4 * k} strokeLinecap="round" />
                <path d={trail.throttle} fill="none" stroke="rgb(52,211,153)" strokeWidth={4.4 * k} strokeLinecap="round" />
              </>}

              {/* El auto */}
              <circle cx={car.x} cy={car.y} r={5 * k} fill="rgb(234,179,8)" stroke="black" strokeWidth={1.5 * k} />
            </g>
          </svg>
        ) : (
          <div className="w-full h-full flex items-center justify-center text-sm text-muted-foreground text-center px-6">
            {loadingRef
              ? "Cargando referencia…"
              : !refInfo
              ? "Sin referencia cargada"
              : e.frames === 0
              ? "No llegan datos de iRacing. Entrá a pista con la sesión abierta."
              : "La referencia no trae posición, así que no hay geometría para dibujar el mapa. Con un CSV de Garage 61 o un .ibt sí la hay. Los avisos por curva funcionan igual."}
          </div>
        )}

        {/* Última curva + estado, sobre el mapa */}
        {/* Leyenda: sin esto las dos bandas paralelas no se entienden. */}
        <div className="absolute left-3 top-3 flex items-center gap-3 text-[10px] bg-black/60 rounded-md px-2.5 py-1.5 backdrop-blur-sm">
          <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5 bg-white/70" />Referencia</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5" style={{ background: "rgb(234,179,8)" }} />Vos</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5" style={{ background: "rgb(239,68,68)" }} />Freno</span>
          <span className="flex items-center gap-1.5"><span className="inline-block w-4 h-0.5" style={{ background: "rgb(52,211,153)" }} />A fondo</span>
          <span className="text-white/40" title={hasRealLine
            ? "iRacing no publica la posición del auto, así que se reconstruye integrando la velocidad y el rumbo. Verificado contra el GPS de los .ibt: menos de 1 m de error por vuelta."
            : "La trazada real se calibra con una vuelta entera. Hasta que cruces meta, tu línea va en paralelo a la de la referencia, no en su lugar real."}>
            {hasRealLine ? "trazada reconstruida" : "calibrando: cruzá meta una vez"}
          </span>
        </div>

        <div className="absolute left-3 bottom-3 flex items-center gap-3 text-[11px] bg-black/60 rounded-md px-2.5 py-1.5 backdrop-blur-sm">
          <span className="text-muted-foreground">Última curva:</span>
          {lastNote ? (
            <span style={{ color: lastNote.kind === "ok" ? "rgb(52,211,153)" : "rgb(234,179,8)" }}>
              <b>{lastNote.cornerLabel}</b> — {lastNote.text}
            </span>
          ) : (
            <span className="text-muted-foreground/60">—</span>
          )}
        </div>
        <div className="absolute right-3 bottom-3 flex items-center gap-3 text-[9px] text-white/50">
          {/* Diagnóstico chico pero visible: si algo no aparece, acá se ve por qué. */}
          <span className="font-mono">
            {e.frames > 0
              ? `${e.frames} frames · pista ${Math.round((trackShape.count / BINS) * 100)}% · muestras ${binCount}/${BINS} · calib ${e.accC}/${Math.round(BINS * OFFSET_MIN_COVERAGE)} · ${hasRealLine ? "trazada real" : "calibrando"}${e.wipes ? ` · ${e.wipes} reinicios (${e.lastWipe})` : ""}`
              : "sin frames"}
            {plan && ` · ${readyCount} avisos listos`}
          </span>
          <span>Imágenes: Esri, Maxar, Earthstar Geographics</span>
        </div>
      </div>
    </div>
  );
}
