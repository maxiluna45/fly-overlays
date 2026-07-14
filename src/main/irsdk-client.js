const { IRacingSDK } = require('irsdk-node');
const { getSectorPoints, getTrackInfo } = require('./session-parser');
const { ReferenceLapStore } = require('./reference-lap-store');

const TIMEOUT = Math.floor((1 / 60) * 1000); // 60fps
const MOCK_MODE = process.env.FLY_MOCK === '1';

const TOTAL_SUBS = 24; // 3 sectores × 8 micro-sectores

// Arregla mojibake: nombres de iRacing en UTF-8 que llegaron leídos como Latin-1
// (ej. "José" → "José", "Müller" → "MÃ¼ller"). Detectamos el patrón típico
// (bytes de continuación UTF-8 mostrados como Â/Ã…) y re-decodificamos. Si no hay
// indicios de mojibake, devolvemos el string tal cual (no rompe nombres correctos).
function fixMojibake(s) {
  if (!s || typeof s !== 'string') return s;
  // Delator: byte lider UTF-8 (U+00C2-U+00EF) seguido de uno de continuacion
  // (U+0080-U+00BF). Code points explicitos para no depender de la codificacion.
  if (!/[Â-ï][-¿]/.test(s)) return s;
  try {
    const fixed = Buffer.from(s, 'latin1').toString('utf8');
    if (!fixed.includes('�')) return fixed; // sin caracter de reemplazo -> OK
  } catch (_) {}
  return s;
}

// Predicción del cambio de iRating al final de una carrera (algoritmo de
// iRacing, port de irating-rs vía irdashies). `entries` = [{carIdx, rank, rating}]
// con rank = posición de clase (1 = primero). Devuelve { carIdx: cambioRedondeado }.
function predictIratingChanges(entries) {
  const starters = entries.filter((e) => e.rating > 0 && e.rank > 0);
  const N = starters.length;
  if (N < 2) return {};
  const BR = 1600 / Math.LN2; // ≈ 2308.09
  const chance = (a, b) => {
    const ea = Math.exp(-a / BR), eb = Math.exp(-b / BR);
    const den = (1 - eb) * ea + (1 - ea) * eb;
    return den > 0 ? ((1 - ea) * eb) / den : 0.5;
  };
  const out = {};
  for (const e of starters) {
    // expected = Σ chance(e, o) sobre todos (incluye self=0.5) menos 0.5.
    let expected = -0.5;
    for (const o of starters) expected += chance(e.rating, o.rating);
    const fudge = (N / 2 - e.rank) / 100;
    // actualScore = N - rank (a cuántos les ganaste). change ∝ actual - expected.
    out[e.carIdx] = Math.round(((N - e.rank - expected - fudge) * 200) / N);
  }
  return out;
}

class IrsdkClient {
  constructor() {
    this.sdk = null;
    this._connected = false;
    this._loopRunning = false;
    this._lightListeners = new Set();
    this._heavyListeners = new Set();
    this._mockTimer = null;
    this._mockStart = 0;
    this._previewMode = false; // preview mode = datos sintéticos sin iRacing
    this._cachedData = {
      delta: 0,
      lap: 0,
      speed: 0,
      onTrack: false,
    };

    // === Sector tracking ===
    // 3 sectores principales, cada uno dividido en 8 micro-sectores
    // 3 × 8 = 24 micro-sectores totales que cubren la vuelta COMPLETA (0-100%).
    // El micro-sector i ocupa el tramo [i/24, (i+1)/24).
    //   - Los micro-sectores 0..22 se cierran al cruzar los splits interiores
    //     (1/24, 2/24, …, 23/24) → por eso _splitPcts tiene 23 entradas.
    //   - El micro-sector 23 (23/24 → meta) se cierra en el cruce de meta,
    //     usando LapLastLapTime (ver _updateSectors). Así ya no perdemos el
    //     tramo final ~4% que la versión vieja (splits a i/25, tope 96%) dejaba
    //     sin cronometrar y que hacía que la suma de vuelta quedara corta.
    // S1: micro 0-7 (0%-33%) · S2: micro 8-15 (33%-66%) · S3: micro 16-23 (66%-100%)
    this._splitPcts = Array.from({ length: 23 }, (_, i) => (i + 1) / 24);
    this._lastLapPct = 0;        // LapDistPct del frame anterior (para detectar cruces)
    this._lastSplitTime = 0;     // currentLap al cruzar el último split
    this._currentMicroSectors = new Array(24).fill(null); // 3 micro × 3 sectores
    this._lastLapMicroSectors = new Array(24).fill(null);
    this._bestLapMicroSectors = new Array(24).fill(null);
    this._lastLapComplete = -1;
    this._lastLapNumberForSectors = null;
    // Estado para el cálculo de delta en vivo
    this._lastSplitDelta = null;
    this._lastDeltaCurrentLap = 0;
    // _splitPcts ya fue inicializado arriba (24 splits cada 1/25)

    // === Tyre cache para smoothing ===
    // iRacing publica tyre temps con muy baja frecuencia (1 Hz aprox) y a
    // veces con saltos grandes. Para que el overlay se sienta "vivo",
    // interpolamos linealmente entre el último valor conocido y el nuevo
    // durante una ventana de tiempo. Cada celda guarda { value, lastUpdate }.
    // freshness: 1.0 = recién actualizado, 0.0 = muy viejo (>10s sin update).
    this._tyreCache = this._initTyreCache();

    // === Throttling de getters pesados ===
    // getLapTimes/getTyres/getRelative hacen muchas llamadas al SDK nativo
    // y trabajo de CPU. No necesitan correr a 60 Hz. Los throttlamos para
    // no saturar el main process ni el IPC.
    this._lastLapTimesUpdate = 0;
    this._lastTyresUpdate = 0;
    this._lastRelativeUpdate = 0;

    // === Grabación de sesión ===
    // Sink al que enviamos un frame de telemetría por tick (solo con SDK real).
    this._frameSink = null;
    this._recPrevLap = null;   // para detectar cruce de meta (vuelta completada)
    this._trackName = null;    // cacheado del SessionInfo (display, para título)
    this._trackKey = null;     // nombre interno con config (para mapa)
    this._trackIdIr = null;    // TrackID de iRacing (para mapear a Garage 61)
    this._carIdIr = null;      // CarID de iRacing (para mapear a Garage 61)
    this._carName = null;      // cacheado del DriverInfo
    // Etiquetas de pilotos (se setean desde main al cambiar la config).
    this._driverTags = [];
    // Reference-lap store (gaps relativos precisos por interpolación de tiempo).
    this._refStore = null;
    this._refTrackId = null;
    this._refCarId = null;
    this._refPrevLap = null;
    this._trackLengthM = null;  // largo de pista en metros (para el radar)
    this._sectorPcts = null;   // límites de sectores reales (SplitTimeInfo)
    this._trackLength = null;  // largo de pista en km
  }

  // Registra un consumidor de frames crudos (el SessionRecorder). Se llama con
  // un objeto por tick mientras haya SDK real; nunca en preview.
  setFrameSink(fn) {
    this._frameSink = fn;
  }

  _initTyreCache() {
    const mk = () => ({
      tempL: { value: null, lastUpdate: 0 },
      tempM: { value: null, lastUpdate: 0 },
      tempR: { value: null, lastUpdate: 0 },
      press: { value: null, lastUpdate: 0 },
      wearL: { value: null, lastUpdate: 0 },
      wearM: { value: null, lastUpdate: 0 },
      wearR: { value: null, lastUpdate: 0 },
    });
    return { LF: mk(), RF: mk(), LR: mk(), RR: mk() };
  }

  async start() {
    if (this._loopRunning) return;
    this._loopRunning = true;

    if (MOCK_MODE) {
      this._startMock();
      return;
    }

    this._connect();
  }

  enablePreview() {
    if (this._previewMode) return;
    console.log('[irsdk] PREVIEW MODE ON');
    this._previewMode = true;
    // Si estamos conectados al SDK real, lo desconectamos limpiamente
    this._teardownSdk();
    this._startMock();
  }

  disablePreview() {
    if (!this._previewMode) return;
    console.log('[irsdk] PREVIEW MODE OFF');
    this._previewMode = false;
    this._stopMock();
    // Resetear los datos de sectores para que no contaminen iRacing real
    this._lastLapMicroSectors = new Array(24).fill(null);
    this._bestLapMicroSectors = new Array(24).fill(null);
    this._currentMicroSectors = new Array(24).fill(null);
    this._lastLapPct = 0;
    this._lastSplitTime = 0;
    this._cachedData = {};
    this._emitLight(); // emitir connected=false y resetear heavy
    this._emitHeavy();
    // Volver a conectar al iRacing real
    if (this._loopRunning) this._connect();
  }

  togglePreview() {
    if (this._previewMode) this.disablePreview();
    else this.enablePreview();
    return this._previewMode;
  }

  isPreview() {
    return this._previewMode;
  }

  _startMock() {
    if (this._mockTimer) return;
    this._connected = true;
    this._mockStart = Date.now();
    this._mockLapTime = 0;
    this._mockLapDistPct = 0;
    this._mockLap = 1;

    // Pre-poblamos best/last con vueltas "fantasma" para que el sector
    // overlay tenga con qué comparar desde el primer frame
    this._seedMockHistory();

    // Truco: arrancamos con tInLap en un valor que ya haya cruzado al menos
    // un split, así el primer micro-sector se llena en el primer frame.
    // _mockStart se ajusta para que el primer tInLap sea ~0.5s (después del split 0).
    this._mockStart = Date.now() - 500; // tInLap inicial = 0.5s (después del primer split)
    this._lastLapPct = 0; // _lastLapPct=0 permite que el primer frame detecte split 0
    this._lastSplitTime = 0; // _lastSplitTime=0 da microTime = currentLap (1.5s) para S1.1
    this._currentMicroSectors = new Array(24).fill(null);
    // Evita un lapChanged espurio en el primer tick (que copiaría un array
    // vacío sobre el historial recién sembrado por _seedMockHistory).
    this._lastLapNumberForSectors = null;

    this._mockTimer = setInterval(() => {
      const t = (Date.now() - this._mockStart) / 1000;
      const LAP_DURATION = 12; // 12s por vuelta (preview rápido)
      const tInLap = t % LAP_DURATION;
      const lap = Math.floor(t / LAP_DURATION) + 1;

      // Simulamos progreso de vuelta + tiempo
      const currentLap = tInLap;
      const lapDistPct = tInLap / LAP_DURATION;

      // Simulamos delta: oscila entre -2 y +2, con mejora gradual
      const baseDelta = Math.sin(t * 0.15) * 1.8;
      const noise = (Math.random() - 0.5) * 0.3;
      const delta = baseDelta + noise;

      // Simulamos velocidad
      const inLap = lapDistPct < 0.97;
      const speed = inLap ? 180 + Math.sin(t * 1.3) * 50 : 0;

      this._cachedData = {
        delta,
        lap,
        speed,
        onTrack: inLap,
        preview: this._previewMode,
      };

      // Simulamos cruce de splits: pasamos los datos al sector tracker
      if (this._previewMode) {
        // Solo bookkeeping del número de vuelta del mock. El reset de estado
        // (currentMicroSectors, _lastSplitTime, _lastLapPct) lo hace ahora
        // _updateSectors en su bloque lapChanged; si lo reseteáramos ACÁ antes,
        // el guard de captura del micro-sector final (_lastSplitTime>0) saltaría
        // y S3 quedaría incompleto en el preview.
        if (lap !== this._mockLap) {
          this._mockLap = lap;
        }
        // "Empujamos" el currentLap bastante para que haya variabilidad entre
        // micro-sectores y se vean distintos colores
        const jitteredCurrentLap = currentLap + Math.sin(t * 3.5) * 0.5 + Math.cos(t * 7) * 0.3;
        this._updateSectors({
          lap,
          lapDistPct,
          currentLap: jitteredCurrentLap,
          sessionTime: t,
          // El micro-sector final (índice 23) se cierra en meta con este valor;
          // sin él, S3 quedaría incompleto en el preview.
          lastLapTime: LAP_DURATION,
        });
      }

      this._cachedData.sectors = this.getSectors();
      // En preview, también generamos relative fake para que el overlay in-game
      // de Relative tenga datos y no quede en "Esperando datos...".
      if (this._previewMode) {
        this._cachedData.relative = this._getMockRelative(t, lap, currentLap);
      }
      this._emitLight();
      // En preview emitimos el heavy también para que llegue el relative mock
      if (this._previewMode) this._emitHeavy();
    }, 50);
  }

  // Genera un payload "relative" fake pero estable para preview mode.
  // 10 pilotos, vos en P6 con gap 0.0, todos con datos coherentes.
  _getMockRelative(t, currentLapNum, currentLapTime) {
    const driverNames = [
      "Tre Blohm", "Max Josten", "Henrique Silva", "Joao Rocha", "Suleiman Himmo",
      "Jose Ferrada", "Maximiliano Luna2", "Anders Krog", "Marc Vidal", "Park Joon",
    ];
    const carNumbers = ["9", "12", "10", "7", "23", "17", "62", "44", "8", "21"];
    const licData = [
      ["A 4.6", 5, 4.6, 5], ["D 3.4", 2, 3.4, 2], ["D 2.7", 2, 2.7, 2],
      ["C 3.9", 3, 3.9, 3], ["R 2.1", 1, 2.1, 1], ["B 4.2", 4, 4.2, 4],
      ["D 2.3", 2, 2.3, 2], ["D 3.7", 2, 3.7, 2], ["R 1.8", 1, 1.8, 1],
      ["D 2.9", 2, 2.9, 2],
    ];
    const iratings = [14500, 1850, 2400, 3200, 1100, 6700, 1500, 2800, 1400, 1700];
    const baseLap = 95 + (t % 7) * 0.2; // varía un poco con el tiempo
    const playerIdx = 6;
    const drivers = driverNames.map((name, i) => {
      const [licString, licLevel, licSub, licColor] = licData[i];
      const isPlayer = i === playerIdx;
      // Gap al player. Convención: gap SIEMPRE positivo; isAhead indica
      // si el auto va adelante (true) o detrás (false) del player. El
      // componente ordena y posiciona según isAhead.
      const baseGap = Math.abs(i - playerIdx) * 1.5;
      const drift = Math.sin(t * 0.2 + i * 0.7) * 0.8;
      // relDelta con la convención nueva: >0 = adelante en pista. Los índices
      // menores al player (i < playerIdx) van adelante.
      const relDelta = isPlayer ? 0 : (i < playerIdx ? (baseGap + drift) : -(baseGap + drift));
      const lastLapTime = baseLap + (i * 0.15) + Math.sin(t + i) * 0.2;
      return {
        carIdx: i,
        classPosition: i + 1,
        position: i + 1,
        name,
        abbrev: null,
        carNumber: carNumbers[i],
        teamName: "",
        irating: iratings[i],
        licString,
        licLevel,
        licSubLevel: licSub,
        licColor,
        carClassId: 0,
        carClassShort: "",
        carClassColor: 1,
        isPlayerClass: true,
        relDelta,
        gapToPlayer: Math.abs(relDelta),
        isAhead: relDelta > 0,
        lapDelta: 0,
        lapCompleted: isPlayer ? currentLapNum - 1 : currentLapNum - 1,
        lapDistPct: isPlayer ? (currentLapTime / 12) : Math.min(1, (currentLapTime + (i - playerIdx) * 0.5) / 12),
        onTrack: true,
        onPit: false,
        offTrack: i === 6, // el player está OFF como en el mock del dashboard
        out: false,
        estLapTime: baseLap,
        f2Time: i * 1.2, // gap creciente al líder (mock)
        lastLapTime,
        bestLapTime: baseLap - 1.5,
        bestLapNum: 1,
        isFastest: i === 0,
        sessionFlags: 0,
      };
    });
    return {
      playerIdx,
      playerCarClass: 0,
      totalInClass: drivers.length,
      totalOverall: drivers.length,
      drivers,
      session: {
        type: "Practice",
        time: t,
        timeRemain: Math.max(0, 3600 - t),
        timeTotal: 3600,
        lapsTotal: 0,
        lapCurrent: currentLapNum,
        lapsMax: 0,
        incidents: Math.floor(t / 30) % 4,
        maxIncidents: 17,
      },
    };
  }

  _seedMockHistory() {
    // Generamos 2 vueltas previas con tiempos random para que el sector
    // overlay tenga con qué comparar desde el primer frame.
    // 24 micro-sectores por vuelta, cada uno ~1.3-1.5s (vuelta ~32-36s)
    for (let lap = 0; lap < 2; lap++) {
      const baseTime = lap === 0 ? 1.5 : 1.3;
      const variance = 0.2;
      const sectors = [];
      for (let i = 0; i < 24; i++) {
        sectors.push(baseTime + (Math.random() - 0.5) * variance);
      }
      this._lastLapMicroSectors = [...sectors];
      for (let i = 0; i < 24; i++) {
        if (this._bestLapMicroSectors[i] == null || sectors[i] < this._bestLapMicroSectors[i]) {
          this._bestLapMicroSectors[i] = sectors[i];
        }
      }
    }
  }

  _stopMock() {
    if (this._mockTimer) {
      clearInterval(this._mockTimer);
      this._mockTimer = null;
    }
    this._connected = false;
  }

  _teardownSdk() {
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.sdk) {
      try { this.sdk.stopSDK(); } catch (_) {}
      this.sdk = null;
    }
    this._connected = false;
  }

  _connect() {
    if (this.sdk) return;
    if (this._connecting) return;
    this._connecting = true;

    console.log(`[irsdk][pid:${process.pid}] Conectando al SDK...`);
    try {
      this.sdk = new IRacingSDK({ autoEnableTelemetry: true });
      this.sdk.startSDK();
      console.log(`[irsdk][pid:${process.pid}] SDK iniciado`);
      this._connecting = false;
      this._loop();
    } catch (err) {
      console.error(`[irsdk][pid:${process.pid}] Error al conectar:`, err.message);
      this.sdk = null;
      this._connecting = false;
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect(delay = 2000) {
    if (this._reconnectTimer) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, delay);
  }

  _loop() {
    if (!this.sdk) return;
    let hasData = false;
    try {
      hasData = this.sdk.waitForData(TIMEOUT);
    } catch (err) {
      console.error(`[irsdk][pid:${process.pid}] waitForData error:`, err.message);
      this._disconnect();
      return;
    }

    if (hasData) {
      if (!this._connected) {
        console.log(`[irsdk][pid:${process.pid}] ✓ Conectado — recibiendo datos`);
        this._connected = true;
      }
      this._updateCache();
      // _updateCache ya emite light + heavy (cuando corresponde)
      setImmediate(() => this._loop());
    } else {
      // waitForData=false puede significar dos cosas:
      // 1. iRacing cerrado → IsSimRunning=false → reconectar
      // 2. iRacing abierto pero sin sesión activa (menú) → seguir esperando
      this._checkAndHandleNoData();
    }
  }

  async _checkAndHandleNoData() {
    try {
      const running = await IRacingSDK.IsSimRunning();
      if (!running) {
        console.log(`[irsdk][pid:${process.pid}] iRacing cerrado, reconectando...`);
        this._disconnect();
      } else {
        // iRacing abierto pero sin datos (estás en menú). Seguí esperando.
        if (this._connected) {
          console.log(`[irsdk][pid:${process.pid}] Sin datos (¿en menú?), esperando...`);
          this._connected = false;
          this._emitLight();
        }
        setImmediate(() => this._loop());
      }
    } catch (e) {
      this._scheduleReconnect();
    }
  }

  _disconnect() {
    if (this._connected) {
      console.log(`[irsdk][pid:${process.pid}] ✗ Desconectado`);
    }
    this._connected = false;
    if (this.sdk) {
      try { this.sdk.stopSDK(); } catch (_) {}
      this.sdk = null;
    }
    this._cachedData = {};
    // Reset del estado de grabación: la próxima conexión re-detecta track/car
    // y no arrastra el número de vuelta viejo.
    this._recPrevLap = null;
    this._trackName = null;
    this._trackKey = null;
    this._trackIdIr = null;
    this._carIdIr = null;
    this._carName = null;
    this._refTrackId = null;
    this._refCarId = null;
    this._refPrevLap = null;
    this._trackLengthM = null;
    if (this._refStore) this._refStore.reset();
    this._sectorPcts = null;
    this._trackLength = null;
    this._emitLight();
    this._emitHeavy();
    this._scheduleReconnect();
  }

  _refs() {
    if (!this._refStore) { try { this._refStore = new ReferenceLapStore(); } catch (_) { this._refStore = null; } }
    return this._refStore;
  }

  // Recibe las etiquetas de pilotos desde la config (main) y las precomputa
  // normalizadas para el match por nombre.
  setDriverTags(tags) {
    const list = Array.isArray(tags) ? tags : [];
    this._driverTags = list
      .filter((t) => t && t.name && String(t.name).trim().length >= 3)
      .map((t) => ({ norm: String(t.name).toLowerCase().replace(/[^a-z0-9]/g, ''), label: t.label || '', color: t.color || '#38bdf8' }));
  }

  _tagForName(name) {
    if (!name || !this._driverTags.length) return null;
    const nn = String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!nn) return null;
    for (const t of this._driverTags) {
      if (nn === t.norm || nn.includes(t.norm)) return { label: t.label, color: t.color };
    }
    return null;
  }

  _updateCache() {
    let telemetry, session;
    try {
      telemetry = this.sdk.getTelemetry();
      session = this.sdk.getSessionData();
    } catch (err) {
      console.error('[irsdk] getTelemetry error:', err.message);
      return;
    }

    if (!telemetry) {
      console.warn('[irsdk] getTelemetry devolvió null');
      return;
    }

    const speed = this._read(telemetry, 'Speed') || 0;
    // IsOnTrack de iRacing: true si el player está EN el auto en pista (aunque
    // esté detenido). Antes usábamos speed>0.5, por eso los overlays se ocultaban
    // con el auto quieto. Fallback a velocidad si el SDK no expone el flag.
    const isOnTrackRaw = this._read(telemetry, 'IsOnTrack');
    const isOnTrack = isOnTrackRaw != null ? !!isOnTrackRaw : speed > 0.5;
    const lap = this._read(telemetry, 'Lap') || 0;
    const bestLap = this._read(telemetry, 'LapBestLapTime') || 0;
    const currentLap = this._read(telemetry, 'LapCurrentLapTime') || 0;
    const lapDistPct = this._read(telemetry, 'LapDistPct') || 0;
    const sessionTime = this._read(telemetry, 'SessionTime') || 0;
    const lastLapTime = this._read(telemetry, 'LapLastLapTime') || 0;

    // Inputs y dinámica para la grabación (pedales, volante, marcha, RPM,
    // fuerzas G, yaw y posición GPS para el mapa del circuito).
    const throttle = this._read(telemetry, 'Throttle') || 0;
    const brake = this._read(telemetry, 'Brake') || 0;
    const steer = this._read(telemetry, 'SteeringWheelAngle') || 0;
    const gear = this._read(telemetry, 'Gear') || 0;
    const rpm = this._read(telemetry, 'RPM') || 0;
    const gLat = this._read(telemetry, 'LatAccel') || 0;
    const gLon = this._read(telemetry, 'LongAccel') || 0;
    const yaw = this._read(telemetry, 'YawRate') || 0;
    const lat = this._read(telemetry, 'Lat');
    const lon = this._read(telemetry, 'Lon');

    // Detectar tipo de sesión de la SESIÓN ACTUAL (por SessionNum). El YAML
    // lista todas las sesiones del fin de semana en SessionInfo.Sessions; hay
    // que elegir la del SessionNum actual (antes se leía session.SessionType,
    // que NO existe en la raíz → siempre caía en "Practice").
    const sessionType = this._resolveSessionType(session, this._read(telemetry, 'SessionNum'));
    const isRace = /race/i.test(sessionType);
    const isQual = /qual/i.test(sessionType);
    const isPractice = !isRace && !isQual;

    // Reference-lap store: capturar trackId/carId una vez y alimentar la vuelta
    // en curso del player; al cruzar meta, promover si es la mejor.
    try {
      if (this._refTrackId == null && session) {
        const tid = parseInt(session?.WeekendInfo?.TrackID, 10);
        if (isFinite(tid)) this._refTrackId = tid;
      }
      if (this._refCarId == null) {
        const di = this.sdk.getDriverInfo();
        const pIdx = this._read(telemetry, 'PlayerCarIdx') ?? 0;
        const pd = di && di.Drivers && di.Drivers.find((d) => d.CarIdx === pIdx);
        const cid = pd ? parseInt(pd.CarID, 10) : NaN;
        if (isFinite(cid)) this._refCarId = cid;
      }
      const store = this._refs();
      if (store && this._refTrackId != null && this._refCarId != null) {
        store.feed(this._refTrackId, this._refCarId, lapDistPct, currentLap);
        if (this._refPrevLap != null && lap > this._refPrevLap) {
          store.commit(this._refTrackId, this._refCarId, lastLapTime);
        }
        this._refPrevLap = lap;
      }
    } catch (_) {}

    // Selección de la fuente de delta (mismo criterio que benofficial2 / bo2):
    //   - Qualify:  vs tu all-time best personal (LapDeltaToBestLap)
    //   - Race:     primeras 2 vueltas vs LastLap de la sesión;
    //               después vs SessionBest (best clean de la sesión)
    //   - Practice: vs SessionBest (best clean de la sesión, sector-aware)
    //
    // ¿Por qué? iRacing ya calcula este delta de forma sector-aware (sabe
    // dónde están los splits y en qué sector estás), y lo actualiza a 60 Hz.
    // Eso es lo que da la sensación de "real-time" del bo2. Hacer una
    // proyección nuestra con `currentLap - bestLap * lapDistPct` es preciso
    // matemáticamente, pero asume pace uniforme por sector — al ojo se ve
    // "calculado por sector" en vez de vivo.
    //
    // La única razón por la que la implementación original del bo2 se quedaba
    // en 0.00 en práctica era porque usaba `LapDeltaToBestLap` (best personal,
    // que vale -1 hasta que completes una vuelta) en lugar de
    // `LapDeltaToSessionBestLap` (best de la sesión, disponible apenas vos u
    // otro completa una vuelta limpia).
    //
    // Usamos `null` como sentinel para distinguir "iRacing aún no tiene un
    // delta válido" de "iRacing devolvió exactamente 0 (estás empatando)".
    let lapDeltaToBest = null;
    let lapDeltaRate = 0;
    if (isQual) {
      if (this._read(telemetry, 'LapDeltaToBestLap_OK')) {
        lapDeltaToBest = this._read(telemetry, 'LapDeltaToBestLap');
        lapDeltaRate = this._read(telemetry, 'LapDeltaToBestLap_DD') || 0;
      }
    } else if (isRace) {
      // Carreras: las primeras vueltas (1-2) no suelen tener un SessionBest
      // todavía, así que caemos al LastLap. Después, SessionBest.
      if (lap <= 2) {
        if (this._read(telemetry, 'LapDeltaToSessionLastLap_OK')) {
          lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionLastLap');
          lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionLastLap_DD') || 0;
        } else if (this._read(telemetry, 'LapDeltaToSessionBestLap_OK')) {
          lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionBestLap');
          lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionBestLap_DD') || 0;
        }
      } else if (this._read(telemetry, 'LapDeltaToSessionBestLap_OK')) {
        lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionBestLap');
        lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionBestLap_DD') || 0;
      }
    } else if (isPractice) {
      if (this._read(telemetry, 'LapDeltaToSessionBestLap_OK')) {
        lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionBestLap');
        lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionBestLap_DD') || 0;
      }
    }
    // Último recurso: OptimalLap (best teórico de la suma de mejores sectores).
    if (lapDeltaToBest == null && this._read(telemetry, 'LapDeltaToOptimalLap_OK')) {
      lapDeltaToBest = this._read(telemetry, 'LapDeltaToOptimalLap');
      lapDeltaRate = this._read(telemetry, 'LapDeltaToOptimalLap_DD') || 0;
    }

    // Detectar cruces de splits y meta
    this._updateSectors({ lap, lapDistPct, currentLap, sessionTime, lastLapTime });

    this._cachedData = {
      // Preservamos los campos pesados seteados por ticks anteriores
      ...this._cachedData,
      delta: this._computeDelta({ lap, bestLap, currentLap, lapDeltaToBest, deltaRate: lapDeltaRate, speed, lapDistPct, sessionType, isRace, isQual, isPractice }),
      // Tasa de cambio del delta (segundos/segundo). >0 = perdiendo tiempo,
      // <0 = ganando. La usa el DeltaBar para el indicador de tendencia.
      deltaRate: lapDeltaRate,
      // Referencias alternativas del delta, para que el overlay pueda dejar
      // que el usuario elija contra qué compararse (best de sesión / best
      // histórico personal / óptima). null = iRacing no tiene esa referencia
      // válida todavía. La elección "auto" (según tipo de sesión) sigue en `delta`.
      deltaRefs: {
        sessionBest: this._readDelta(telemetry, 'LapDeltaToSessionBestLap'),
        personalBest: this._readDelta(telemetry, 'LapDeltaToBestLap'),
        optimal: this._readDelta(telemetry, 'LapDeltaToOptimalLap'),
      },
      // Tiempo de vuelta de referencia (best del player en la sesión) para que
      // el DeltaBar pueda proyectar la vuelta actual: predicha = ref + delta.
      refLapTime: bestLap || 0,
      lap,
      speed,
      onTrack: isOnTrack,
      // Spotter propio del juego (auto a izquierda/derecha). Único dato fiable
      // para el lado en el radar. Canal rápido → aviso instantáneo.
      carLeftRight: this._read(telemetry, 'CarLeftRight'),
      session: session?.SessionNum,
      sessionType,
    };
    // Guardamos el sessionType para getDeltaBest (lectura fuera del loop)
    this._cachedSessionType = sessionType;

    // Sectors: barato de armar (sólo copia de arrays), lo actualizamos siempre.
    this._cachedData.sectors = this.getSectors();

    // Canal rápido: emitimos light data a 60 Hz.
    this._emitLight();

    // Getters pesados: throttled. En vez de llamarse a 60 Hz, se llaman
    // cada 500ms / 1000ms. Reducen ~60× las llamadas al SDK nativo y el
    // trabajo de CPU del main process. El canal pesado sólo se emite cuando
    // algún campo pesado efectivamente cambió — no mandamos 60 veces/seg el
    // mismo payload de tyres/relative.
    const now = Date.now();
    let heavyChanged = false;
    if (now - this._lastLapTimesUpdate > 500) {
      this._lastLapTimesUpdate = now;
      this._cachedData.lapTimes = this.getLapTimes();
      heavyChanged = true;
    }
    if (now - this._lastTyresUpdate > 1000) {
      this._lastTyresUpdate = now;
      this._cachedData.tyres = this.getTyres();
      heavyChanged = true;
    }
    if (now - this._lastRelativeUpdate > 100) {
      this._lastRelativeUpdate = now;
      this._cachedData.relative = this.getRelative();
      heavyChanged = true;
    }
    if (heavyChanged) this._emitHeavy();

    // === Grabación: enviar frame al recorder (solo SDK real, nunca preview) ===
    if (this._frameSink && !this._previewMode) {
      // Metadata de track/car cacheada (barata de leer una vez por conexión).
      if (!this._trackName && session && session.WeekendInfo) {
        this._trackName = session.WeekendInfo.TrackDisplayName || session.WeekendInfo.TrackName || null;
        // Nombre interno de iRacing (incluye la config, ej. "snetterton 300")
        // — mejor clave para emparejar la geometría del mapa que el display name.
        this._trackKey = session.WeekendInfo.TrackName
          || [session.WeekendInfo.TrackDisplayName, session.WeekendInfo.TrackConfigName].filter(Boolean).join(' ')
          || null;
        const tid = parseInt(session.WeekendInfo.TrackID, 10);
        this._trackIdIr = isFinite(tid) ? tid : null;
      }
      // Sectores reales + largo de pista (para análisis por sector y metros).
      if (!this._sectorPcts && session) {
        try {
          const pts = getSectorPoints(session);
          if (Array.isArray(pts) && pts.length > 0) this._sectorPcts = pts;
          const ti = getTrackInfo(session);
          if (ti && ti.length > 0) this._trackLength = ti.length; // km
        } catch (_) {}
      }
      if (!this._carName) {
        try {
          const di = this.sdk.getDriverInfo();
          const pIdx = this._read(telemetry, 'PlayerCarIdx') ?? 0;
          const pd = di && di.Drivers && di.Drivers.find((d) => d.CarIdx === pIdx);
          if (pd) {
            this._carName = pd.CarScreenName || pd.CarPath || null;
            const cid = parseInt(pd.CarID, 10);
            this._carIdIr = isFinite(cid) ? cid : null;
          }
        } catch (_) {}
      }

      // Detección de vuelta completada (cruce de meta).
      let completedLap = null;
      if (this._recPrevLap != null && lap > this._recPrevLap && lastLapTime > 0) {
        completedLap = {
          number: this._recPrevLap,
          time: lastLapTime,
          valid: lastLapTime > 0,
          micros: [...this._lastLapMicroSectors],
          at: now,
        };
      }
      this._recPrevLap = lap;

      this._frameSink({
        t: sessionTime,
        at: now,
        lap,
        lapDistPct,
        currentLapTime: currentLap,
        throttle,
        brake,
        steer,
        gear,
        rpm,
        speed,
        gLat,
        gLon,
        yaw,
        lat,
        lon,
        onTrack: this._cachedData.onTrack,
        sessionType,
        track: this._trackName,
        trackKey: this._trackKey || null,
        trackIdIr: this._trackIdIr || null,
        carIdIr: this._carIdIr || null,
        car: this._carName,
        sectorPcts: this._sectorPcts || null,
        trackLength: this._trackLength || null,
        completedLap,
      });
    }
  }

  _updateSectors({ lap, lapDistPct, currentLap, sessionTime, lastLapTime = 0 }) {
    // Detección de cruce de meta por cambio en número de vuelta
    // (más robusto que detectar el wrap de LapDistPct que puede fallar en
    // circuitos con geometría irregular)
    const lapChanged = this._lastLapNumberForSectors != null && lap !== this._lastLapNumberForSectors;
    this._lastLapNumberForSectors = lap;

    if (lapChanged) {
      // Cerrar el micro-sector FINAL (índice 23, tramo 23/24 → meta) que no se
      // detecta por cruce de split porque LapDistPct ya reseteó a ~0.
      // Lo derivamos del tiempo oficial de vuelta: tramo final = LapLastLapTime
      // menos el tiempo acumulado hasta el último split interior (_lastSplitTime).
      // En vueltas inválidas LapLastLapTime viene <=0 → el guard lo descarta y
      // el micro-sector 23 queda null (S3 se muestra incompleto, correcto).
      if (this._currentMicroSectors[23] == null && lastLapTime > 0 && this._lastSplitTime > 0) {
        const finalMicro = lastLapTime - this._lastSplitTime;
        if (finalMicro > 0 && finalMicro < 300) {
          this._currentMicroSectors[23] = finalMicro;
        }
      }

      // Guardamos la última vuelta completa (los 24 micro-sectores ya se
      // llenaron: 0..22 por cruce de splits interiores, 23 por el cruce de meta)
      this._lastLapMicroSectors = [...this._currentMicroSectors];

      // Actualizamos bestLapMicroSectors si alguno es record
      for (let i = 0; i < 24; i++) {
        const cur = this._lastLapMicroSectors[i];
        const best = this._bestLapMicroSectors[i];
        if (cur != null && (best == null || cur < best)) {
          this._bestLapMicroSectors[i] = cur;
        }
      }

      this._lastLapComplete = lap;
      this._lastSplitTime = 0;
      this._currentMicroSectors = new Array(24).fill(null);
    }

    // Detección de cruce de splits (24 intermedios, 1/25, 2/25, …, 24/25)
    for (let i = 0; i < this._splitPcts.length; i++) {
      const splitPct = this._splitPcts[i];
      if (
        this._lastLapPct < splitPct &&
        lapDistPct >= splitPct &&
        this._currentMicroSectors[i] == null
      ) {
        // El micro-sector i es desde el último split (o meta) hasta este
        const microTime = currentLap - this._lastSplitTime;
        if (microTime > 0 && microTime < 300) {
          this._currentMicroSectors[i] = microTime;
        }
        this._lastSplitTime = currentLap;
      }
    }

    this._lastLapPct = lapDistPct;
  }

  /**
   * Devuelve el estado actual de micro-sectores para el overlay.
   * Estructura:
   *   {
   *     current: [m1, ..., m8] × 3 sectores = 24 elementos
   *     last:    [m1, ..., m24]
   *     best:    [m1, ..., m24]
   *   }
   */
  getSectors() {
    const fill = (v) => {
      const out = new Array(TOTAL_SUBS);
      for (let i = 0; i < TOTAL_SUBS; i++) out[i] = v[i] != null ? v[i] : null;
      return out;
    };
    return {
      current: fill(this._currentMicroSectors),
      last: fill(this._lastLapMicroSectors),
      best: fill(this._bestLapMicroSectors),
    };
  }

  _computeDelta({ lap, bestLap, currentLap, lapDeltaToBest, deltaRate, speed, lapDistPct, sessionType, isRace, isQual, isPractice }) {
    // ESTRATEGIA (bo2 official): usar el delta oficial del sim, ya calculado
    // sector-aware y actualizado a 60 Hz. Es lo que muestra el iRacing en la
    // pantalla de timing, así que "se siente" real-time.
    //
    // El caller ya eligió la variable correcta según el modo y solo nos pasa
    // un valor si el flag _OK correspondiente estaba en true:
    //   - Qual:  LapDeltaToBestLap
    //   - Race:  LapDeltaToSessionLastLap (lap 1-2) / LapDeltaToSessionBestLap (lap 3+)
    //   - Pract: LapDeltaToSessionBestLap
    //
    // `null` significa "ninguna fuente dio un valor válido" (todavía no
    // cruzaste el primer split de la primera vuelta). `0` es válido y
    // significa "estás empatando al best en este punto".
    if (
      lapDeltaToBest != null &&
      isFinite(lapDeltaToBest) &&
      Math.abs(lapDeltaToBest) < 1000
    ) {
      return lapDeltaToBest;
    }

    // FALLBACK: el sim no tiene un delta "vivo" todavía (recién saliste a
    // pista, no cruzaste ningún split, etc.). Proyectamos desde la mejor
    // vuelta conocida para tener un número coherente en vez de 0.00.
    // Es menos preciso que el del sim, pero solo se ve en el primer
    // fragmento de la primera vuelta de práctica/carrera.
    if (
      bestLap != null && bestLap > 0 &&
      currentLap != null && currentLap > 0 &&
      lapDistPct != null && lapDistPct > 0
    ) {
      return currentLap - (bestLap * lapDistPct);
    }

    return 0;
  }

  _read(telemetry, key) {
    if (!telemetry) return null;
    const entry = telemetry[key];
    if (entry === undefined || entry === null) return null;
    const raw = entry.value;
    if (raw === undefined || raw === null) return null;
    // iRacing expone escalares como arrays de length 1 (ej: Speed → [40.3],
    // PlayerCarIdx → [48]), y arrays por piloto con length 60+ (CarIdxPosition).
    // El wrapper irsdk-node preserva esto vía copyTelemData.
    // Si es array de length 1, devolvemos el escalar (caso normal: Lap, Speed,
    // PlayerCarIdx, etc). Si es length > 1, devolvemos el array entero.
    if (Array.isArray(raw)) {
      return raw.length <= 1 ? raw[0] : raw;
    }
    return raw;
  }

  // Lee una variable de delta oficial (LapDeltaTo*) solo si su flag _OK está
  // activo y el valor es sano. Devuelve null en caso contrario, para que el
  // overlay distinguga "sin referencia" de "delta exactamente 0".
  _readDelta(telemetry, base) {
    if (this._read(telemetry, base + '_OK')) {
      const v = this._read(telemetry, base);
      if (v != null && isFinite(v) && Math.abs(v) < 1000) return v;
    }
    return null;
  }

  _buildLightPayload() {
    return {
      connected: this._connected,
      delta: this._cachedData.delta ?? 0,
      deltaRate: this._cachedData.deltaRate ?? 0,
      deltaRefs: this._cachedData.deltaRefs ?? { sessionBest: null, personalBest: null, optimal: null },
      refLapTime: this._cachedData.refLapTime ?? 0,
      lap: this._cachedData.lap ?? 0,
      speed: this._cachedData.speed ?? 0,
      onTrack: this._cachedData.onTrack ?? false,
      preview: this._cachedData.preview ?? false,
      session: this._cachedData.session,
      sessionType: this._cachedData.sessionType,
      // Sectors: arrays pequeños (24 floats × 3) que ya se actualizan cada tick.
      // Los mandamos por el canal rápido para que el overlay de sectores vea
      // el cruce de splits al instante.
      sectors: this._cachedData.sectors ?? { current: new Array(TOTAL_SUBS).fill(null), last: new Array(TOTAL_SUBS).fill(null), best: new Array(TOTAL_SUBS).fill(null) },
    };
  }

  _buildHeavyPayload() {
    return {
      lapTimes: this._cachedData.lapTimes ?? { currentLap: 0, bestLap: 0, lastLap: 0, lastLapInvalid: false },
      tyres: this._cachedData.tyres ?? this._emptyTyresPayload(),
      relative: this._cachedData.relative ?? this._emptyRelativePayload(),
    };
  }

  _emitLight() {
    const payload = this._buildLightPayload();
    for (const cb of this._lightListeners) cb(payload);
  }

  _emitHeavy() {
    const payload = this._buildHeavyPayload();
    for (const cb of this._heavyListeners) cb(payload);
  }

  // Mantenido por compatibilidad con código viejo; en desuso.
  _emit() {
    this._emitLight();
    this._emitHeavy();
  }

  _emptyTyresPayload() {
    const mk = () => ({ tempL: null, tempM: null, tempR: null, press: null, wearL: null, wearM: null, wearR: null, freshTemp: null, freshPress: null, freshWear: null });
    return { LF: mk(), RF: mk(), LR: mk(), RR: mk() };
  }

  _emptyRelativePayload() {
    return {
      playerIdx: -1,
      playerCarClass: -1,
      totalInClass: 0,
      totalOverall: 0,
      drivers: [],
      session: { type: "Practice", time: 0, timeRemain: 0, timeTotal: 0, lapsTotal: 0, lapCurrent: 0, lapsMax: 0, incidents: 0, maxIncidents: 0 },
    };
  }

  isConnected() {
    return this._connected;
  }

  isOnTrack() {
    return this._cachedData.onTrack;
  }

  getSession() {
    return { lap: this._cachedData.lap };
  }

  // Devuelve los tiempos oficiales de iRacing.
  // - currentLap y bestLap: vienen directo del sim (siempre disponibles).
  // - lastLap: si iRacing lo publica (LapLastLapTime > 0) lo usamos tal cual.
  //   Si NO lo publica (caso típico: vuelta inválida por off-track/cut donde
  //   el sim desestima el tiempo), lo calculamos sumando los 24 micro-sectores
  //   del último cruce de meta. En ese caso marcamos `lastLapInvalid: true`
  //   para que la UI pueda indicarlo visualmente.
  getLapTimes() {
    const out = { currentLap: 0, bestLap: 0, lastLap: 0, lastLapInvalid: false };
    if (this.sdk && this._connected) {
      try {
        this.sdk.waitForData(0);
        const telemetry = this.sdk.getTelemetry();
        if (telemetry) {
          out.currentLap = this._read(telemetry, 'LapCurrentLapTime') || 0;
          out.bestLap = this._read(telemetry, 'LapBestLapTime') || 0;
          const lastLap = this._read(telemetry, 'LapLastLapTime') || 0;
          if (lastLap > 0) {
            out.lastLap = lastLap;
          } else {
            // iRacing no publicó lastLap (vuelta inválida). Caemos a la suma
            // de los 24 micro-sectores del cruce de meta anterior.
            const sum = this._sumLapFromSectors(this._lastLapMicroSectors);
            if (sum != null && sum > 0) {
              out.lastLap = sum;
              out.lastLapInvalid = true;
            }
          }
        }
      } catch (_) {}
    }
    return out;
  }

  // Suma los 24 micro-sectores de una vuelta completa. Devuelve null si falta
  // algún sector. Solo consideramos válida una vuelta con todos los 24.
  _sumLapFromSectors(arr) {
    if (!arr || arr.length !== 24) return null;
    let sum = 0;
    for (let i = 0; i < 24; i++) {
      const v = arr[i];
      if (v == null || !isFinite(v) || v <= 0) return null;
      sum += v;
    }
    return sum;
  }

  // Devuelve temperatura, presión y desgaste de los 4 neumáticos.
  // Estructura: { LF: { tempL, tempM, tempR, press, wearL, wearM, wearR,
  //                     freshTemp, freshPress, freshWear }, RF, LR, RR }
  // L/M/R = zonas inner/center/outer de la banda de rodamiento.
  //
  // NOTA IMPORTANTE: iRacing publica tyre temps con muy baja frecuencia
  // (1 Hz o menos) y a veces con gaps grandes. La presión (LFcoldPressure)
  // y el wear (LFwear*) son valores "fríos" del garage, no en vivo.
  // Para que el overlay se sienta vivo, esta función:
  //   1. Mantiene un cache del último valor conocido por celda.
  //   2. Cuando el sim publica un valor nuevo, lo guarda con timestamp.
  //   3. Devuelve siempre el último valor + un flag "fresh*" indicando
  //      cuántos segundos pasaron desde la última actualización.
  // La UI puede usar `freshTemp` para mostrar un indicador visual
  // ("LIVE" si <2s, "—" si >10s).
  getTyres() {
    const buildCell = (pos, keys) => {
      const cache = this._tyreCache[pos];
      return {
        tempL: cache.tempL.value,
        tempM: cache.tempM.value,
        tempR: cache.tempR.value,
        press: cache.press.value,
        wearL: cache.wearL.value,
        wearM: cache.wearM.value,
        wearR: cache.wearR.value,
        // Age en segundos (null si nunca hubo dato)
        freshTemp: cache.tempM.lastUpdate ? (Date.now() - cache.tempM.lastUpdate) / 1000 : null,
        freshPress: cache.press.lastUpdate ? (Date.now() - cache.press.lastUpdate) / 1000 : null,
        freshWear: cache.wearM.lastUpdate ? (Date.now() - cache.wearM.lastUpdate) / 1000 : null,
      };
    };

    if (this.sdk && this._connected) {
      try {
        this.sdk.waitForData(0);
        const telemetry = this.sdk.getTelemetry();
        if (telemetry) {
          const now = Date.now();
          // Actualizar cache solo si el sim publicó un valor NUEVO (distinto
          // del último conocido). Esto evita "pisar" el cache con valores
          // idénticos que llegan con cada tick.
          const update = (slot, key, raw) => {
            if (raw == null || !isFinite(raw)) return;
            const cell = this._tyreCache[slot][key];
            // Solo actualizamos si el valor cambió o si pasaron >5s (el sim
            // a veces re-publica el mismo valor, lo tomamos como refresh).
            if (cell.value === null || Math.abs((cell.value ?? 0) - raw) > 0.01 || (now - cell.lastUpdate) > 5000) {
              cell.value = raw;
              cell.lastUpdate = now;
            }
          };

          // Para cada rueda, leer del sim y mergear al cache
          for (const [pos, prefix] of [['LF', 'LF'], ['RF', 'RF'], ['LR', 'LR'], ['RR', 'RR']]) {
            update(pos, 'tempL', this._read(telemetry, `${prefix}tempCL`));
            update(pos, 'tempM', this._read(telemetry, `${prefix}tempCM`));
            update(pos, 'tempR', this._read(telemetry, `${prefix}tempCR`));
            update(pos, 'press', this._read(telemetry, `${prefix}coldPressure`));
            update(pos, 'wearL', this._read(telemetry, `${prefix}wearL`));
            update(pos, 'wearM', this._read(telemetry, `${prefix}wearM`));
            update(pos, 'wearR', this._read(telemetry, `${prefix}wearR`));
          }

          return {
            LF: buildCell('LF'),
            RF: buildCell('RF'),
            LR: buildCell('LR'),
            RR: buildCell('RR'),
          };
        }
      } catch (_) {}
    }
    return {
      LF: buildCell('LF'),
      RF: buildCell('RF'),
      LR: buildCell('LR'),
      RR: buildCell('RR'),
    };
  }

  // Devuelve el relative: los autos físicamente cerca del player EN PISTA, con
  // el tiempo (con signo) que los separa. NO es la tabla de posiciones — es un
  // "relative" al estilo iRon/iRacing: incluye TODAS las clases (multiclase) y
  // el componente centra al player y ordena por cercanía en pista.
  //
  // Estructura por driver:
  //   { carIdx, position, classPosition, name, abbrev, carNumber, irating,
  //     licString, licColor, licSubLevel, carClassId, carClassShort,
  //     carClassColor, relDelta, gapToPlayer, isAhead, lapDelta, isPlayerClass,
  //     lapCompleted, lapDistPct, onTrack, onPit, offTrack, out, estLapTime,
  //     lastLapTime, bestLapTime, bestLapNum, isFastest, sessionFlags }
  //
  //   relDelta   = tiempo con signo respecto al player en pista.
  //                >0 → el auto va ADELANTE tuyo · <0 → DETRÁS. null si no hay datos.
  //   gapToPlayer = |relDelta| (magnitud, para mostrar).
  //   isAhead    = relDelta > 0.
  //   lapDelta   = vueltas de diferencia en carrera (+1 = te está por doblar,
  //                -1 = lo estás por doblar). 0 fuera de carrera o sin datos.
  //
  // ── Algoritmo del gap (referencia: lespalt/iRon, OverlayRelative.h) ──
  //   El wrap por la línea de meta se detecta con LapDistPct (|Δpct| > 0.5),
  //   NO con el signo crudo del EstTime (que es tiempo-dentro-de-la-vuelta y
  //   wrappea). Con EstTime real por-auto usamos la diferencia directa (respeta
  //   el pace no uniforme por la vuelta); si el wrapper solo expone escalares,
  //   caemos a distancia_relativa × tiempo_de_vuelta (asume pace uniforme).
  //
  // IMPORTANTE: en este wrapper (irsdk-node) los arrays CarIdx* a veces vienen
  // como escalares (valor del player) en vez de arrays por piloto. Usamos
  // _readCarIdxArray() que normaliza a array del tamaño de driverInfo.
  getRelative() {
    const empty = () => ({
      playerIdx: -1,
      playerCarClass: -1,
      totalInClass: 0,
      totalOverall: 0,
      drivers: [],
      session: { type: "Practice", time: 0, timeRemain: 0, timeTotal: 0, lapsTotal: 0, lapCurrent: 0, lapsMax: 0, incidents: 0, maxIncidents: 0 },
    });

    if (this.sdk && this._connected) {
      try {
        this.sdk.waitForData(0);
        const telemetry = this.sdk.getTelemetry();
        const driverInfo = this.sdk.getDriverInfo();
        if (telemetry && driverInfo && driverInfo.Drivers && driverInfo.Drivers.length > 0) {
          const n = driverInfo.Drivers.length;
          // Auto de FOCO: el que sigue la cámara (CamCarIdx) si es válido, si no
          // el propio (PlayerCarIdx). Así el relative se centra bien también en
          // repetición / spectate (como irdashies).
          const realPlayerIdx = this._read(telemetry, 'PlayerCarIdx') ?? 0;
          const camIdx = this._read(telemetry, 'CamCarIdx');
          const playerIdx = (typeof camIdx === 'number' && camIdx >= 0) ? camIdx : realPlayerIdx;
          // Si por alguna razón el array viene vacío, fallback
          const playerDriver = driverInfo.Drivers.find((d) => d.CarIdx === playerIdx) || driverInfo.Drivers[0];
          const playerRealClass = playerDriver ? playerDriver.CarClassID : 0;

          // Arrays CarIdx* (normalizados a tamaño n)
            const positions = this._readCarIdxArray(telemetry, 'CarIdxPosition', n, playerIdx);
            const classPositions = this._readCarIdxArray(telemetry, 'CarIdxClassPosition', n, playerIdx);
            const lapCompleted = this._readCarIdxArray(telemetry, 'CarIdxLapCompleted', n, playerIdx);
            const lapDistPct = this._readCarIdxArray(telemetry, 'CarIdxLapDistPct', n, playerIdx);
            const trackSurfaceRaw = this._read(telemetry, 'CarIdxTrackSurface');
            const trackSurface = this._readCarIdxArray(telemetry, 'CarIdxTrackSurface', n, playerIdx);
            // Enum OFICIAL de iRacing (irsdk_TrkLoc): -1 NotInWorld · 0 OffTrack
            // · 1 InPitStall · 2 ApproachingPits · 3 OnTrack.
            // El array es fiable si el wrapper expone valores de OTROS autos
            // (no solo el escalar del player). Si no, no filtramos por surface.
            const trackSurfaceIsReliable =
              Array.isArray(trackSurfaceRaw) &&
              trackSurfaceRaw.length > 1 &&
              trackSurfaceRaw.some((v, idx) => idx !== playerIdx && v > -1);
            const onPitRoad = this._readCarIdxArray(telemetry, 'CarIdxOnPitRoad', n, playerIdx);
            const estTime = this._readCarIdxArray(telemetry, 'CarIdxEstTime', n, playerIdx);
            const lastLapTime = this._readCarIdxArray(telemetry, 'CarIdxLastLapTime', n, playerIdx);
            const bestLapTime = this._readCarIdxArray(telemetry, 'CarIdxBestLapTime', n, playerIdx);
            const bestLapNum = this._readCarIdxArray(telemetry, 'CarIdxBestLapNum', n, playerIdx);
            const sessionFlagsArr = this._readCarIdxArray(telemetry, 'CarIdxSessionFlags', n, playerIdx);

          // Best lap por clase (para marcar el "fastest" de cada clase en multiclase)
          const bestLapByClass = {};
          for (let i = 0; i < n; i++) {
            const d = driverInfo.Drivers[i];
            const bl = bestLapTime[i];
            if (bl > 0) {
              const c = d.CarClassID;
              if (bestLapByClass[c] == null || bl < bestLapByClass[c]) bestLapByClass[c] = bl;
            }
          }

          // ── Referencia de tiempo de vuelta (L) para convertir distancia→tiempo
          // y para el wrap por meta. Preferimos CarClassEstLapTime (lo que usa
          // iRacing internamente); fallback al best/last del player; luego 90s.
          const classEstRaw = this._read(telemetry, 'CarClassEstLapTime');
          let L = 0;
          if (typeof classEstRaw === 'number' && classEstRaw > 0) {
            L = classEstRaw;
          } else if (Array.isArray(classEstRaw)) {
            const v = classEstRaw[playerIdx] > 0 ? classEstRaw[playerIdx] : classEstRaw.find((x) => x > 0);
            if (v > 0) L = v;
          }
          if (!(L > 0)) { const pb = bestLapTime[playerIdx]; if (pb > 0) L = pb; }
          if (!(L > 0)) { const pl = lastLapTime[playerIdx]; if (pl > 0) L = pl; }
          if (!(L > 0)) { const tb = this._read(telemetry, 'LapBestLapTime'); if (tb > 0) L = tb; }
          if (!(L > 0)) L = 90;

          // ── Arrays por-auto para el gap. Detectamos si son arrays "reales"
          // (con valores de otros autos, no solo el escalar del player).
          const estRaw = this._read(telemetry, 'CarIdxEstTime');
          const pctRaw = this._read(telemetry, 'CarIdxLapDistPct');
          const lapRaw = this._read(telemetry, 'CarIdxLap');
          const estReal = Array.isArray(estRaw) && estRaw.length > 1 && estRaw.some((v, idx) => idx !== playerIdx && v > 0);
          const pctReal = Array.isArray(pctRaw) && pctRaw.length > 1 && pctRaw.some((v, idx) => idx !== playerIdx && v !== 0);
          const lapReal = Array.isArray(lapRaw) && lapRaw.length > 1 && lapRaw.some((v, idx) => idx !== playerIdx && v > 0);
          const estA = this._readCarIdxArray(telemetry, 'CarIdxEstTime', n, playerIdx);
          const lapArr = this._readCarIdxArray(telemetry, 'CarIdxLap', n, playerIdx);
          // F2Time = tiempo detrás del líder en carrera (0 = líder). Lo usa el
          // overlay de Standings para el gap al líder / intervalo.
          const f2A = this._readCarIdxArray(telemetry, 'CarIdxF2Time', n, playerIdx);
          const isRace = /race/i.test(this._cachedSessionType || '');

          const pctSelf = lapDistPct[playerIdx];
          const estSelf = estA[playerIdx];

          // Largo de pista (m) para el radar: gap longitudinal = Δpct × largo.
          // Cacheado (no cambia en la sesión). Lo leemos del YAML (WeekendInfo).
          if (this._trackLengthM == null) {
            try {
              const sd = this.sdk.getSessionData();
              const tl = sd && sd.WeekendInfo && sd.WeekendInfo.TrackLength;
              const km = tl != null ? parseFloat(String(tl)) : NaN;
              if (isFinite(km) && km > 0) this._trackLengthM = km * 1000;
            } catch (_) {}
          }
          const trackLengthM = this._trackLengthM || 0;

          // ── Vuelta de referencia para gaps precisos (interpolación de tiempo
          // por posición de pista). Preferida sobre EstTime cuando existe.
          const refStore = this._refs();
          const refReady = refStore && this._refTrackId != null && this._refCarId != null &&
            refStore.has(this._refTrackId, this._refCarId);
          const refLapT = refReady ? refStore.lapTime(this._refTrackId, this._refCarId) : 0;
          const tSelf = refReady ? refStore.interp(this._refTrackId, this._refCarId, pctSelf) : null;
          const playerOnPit = !!onPitRoad[playerIdx];

          // Construir la lista. En multiclase incluimos TODAS las clases: un
          // relative muestra a quien tenés cerca en pista, sea de tu clase o no.
          // Filtro por CarIdxTrackSurface para descartar "fantasmas" de slots viejos.
          //   -1 NotInWorld · 0 OffTrack · 1 InPitStall · 2 ApproachingPits · 3 OnTrack
          const drivers = [];
          for (let i = 0; i < n; i++) {
            const d = driverInfo.Drivers[i];
            if (d.CarIsPaceCar === 1) continue;
            if (d.IsSpectator === 1) continue;
            const pos = positions[i] ?? 0;
            const cpos = classPositions[i] ?? 0;
            const surface = trackSurface[i] ?? -1;
            const onPit = !!onPitRoad[i];
            const isPlayer = i === playerIdx;
            // Solo filtramos los que NO están en el mundo (garage/desconectado).
            // Un auto off-track (0) sigue en pista y debe mostrarse (antes se
            // filtraba por error, y desaparecía al irse largo).
            if (!isPlayer && trackSurfaceIsReliable && surface === -1) continue;

            const onTrack = trackSurfaceIsReliable ? surface === 3 : true;
            const inPitStall = surface === 1;
            const offTrack = trackSurfaceIsReliable ? surface === 0 : false;
            const out = trackSurfaceIsReliable ? surface === -1 : false;

            // ── Gap relativo con signo (algoritmo iRon) ──
            let relDelta = null;
            const pctCar = lapDistPct[i];
            // Distancia relativa en fracción de vuelta, normalizada a (-0.5, 0.5].
            let dPct = pctCar - pctSelf;
            const wrap = Math.abs(dPct) > 0.5;
            if (dPct > 0.5) dPct -= 1;
            else if (dPct < -0.5) dPct += 1;

            let gapSource = null;
            if (isPlayer) {
              relDelta = 0;
            } else if (refReady && tSelf != null && !onPit && !playerOnPit && refLapT > 0) {
              // Vuelta de referencia: t(otro) − t(self), con wrap por meta. Es el
              // método más preciso (respeta el ritmo real punto a punto).
              const tCar = refStore.interp(this._refTrackId, this._refCarId, pctCar);
              if (tCar != null) {
                let dd = tCar - tSelf;
                if (pctCar - pctSelf <= -0.5) dd += refLapT;
                else if (pctCar - pctSelf >= 0.5) dd -= refLapT;
                relDelta = dd;
                gapSource = 'ref';
              }
            }
            if (relDelta == null && !isPlayer && estReal && estSelf > 0) {
              // EstTime real: respeta el pace no uniforme a lo largo de la vuelta.
              const S = estSelf;
              const C = estA[i];
              relDelta = wrap ? (S > C ? (C - S) + L : (C - S) - L) : (C - S);
            } else if (relDelta == null && pctReal) {
              // Fallback robusto: distancia_relativa × tiempo_de_vuelta.
              relDelta = dPct * L;
            }
            const isAhead = relDelta != null && relDelta > 0;

            // ── lapDelta: solo en carrera y con datos reales de vuelta por-auto.
            // Progreso total = vuelta + fracción; la diferencia redondeada son
            // las vueltas que nos separan. +1 = te va a doblar, -1 = lo doblás.
            let lapDelta = 0;
            if (isRace && lapReal && !isPlayer) {
              const progSelf = (lapArr[playerIdx] || 0) + pctSelf;
              const progCar = (lapArr[i] || 0) + pctCar;
              lapDelta = Math.round(progCar - progSelf);
            }

            const uname = fixMojibake(d.UserName || d.CarScreenName || "Driver");
            drivers.push({
              carIdx: i,
              position: pos,
              classPosition: cpos,
              name: uname,
              abbrev: fixMojibake(d.AbbrevName) || null,
              initials: fixMojibake(d.Initials) || null,
              carNumber: d.CarNumber || "",
              teamName: fixMojibake(d.TeamName) || "",
              irating: d.IRating || 0,
              licString: d.LicString || "",
              licColor: d.LicColor || 0,
              licLevel: d.LicLevel || 0,
              licSubLevel: d.LicSubLevel || 0,
              carClassId: d.CarClassID,
              carClassShort: d.CarClassShortName || "",
              carClassColor: d.CarClassColor || 0,
              isPlayerClass: d.CarClassID === playerRealClass,
              relDelta,
              gapToPlayer: relDelta != null ? Math.abs(relDelta) : null,
              // Distancia longitudinal en metros (para el radar): >0 = adelante.
              relMeters: trackLengthM > 0 ? dPct * trackLengthM : null,
              isAhead,
              lapDelta,
              lapCompleted: lapCompleted[i] || 0,
              lapDistPct: pctCar || 0,
              onTrack,
              onPit: onPit || inPitStall,
              offTrack,
              out,
              estLapTime: estTime[i] || 0,
              f2Time: f2A[i] || 0,
              lastLapTime: lastLapTime[i] || 0,
              bestLapTime: bestLapTime[i] || 0,
              bestLapNum: bestLapNum[i] || 0,
              isFastest: bestLapTime[i] > 0 && bestLapByClass[d.CarClassID] != null &&
                Math.abs(bestLapTime[i] - bestLapByClass[d.CarClassID]) < 0.001,
              sessionFlags: sessionFlagsArr[i] || 0,
              tag: this._tagForName(uname),
            });
          }

          // Total overall = autos EN EL MUNDO (surface > -1), si el array es fiable.
          let totalOverall = drivers.length;
          if (trackSurfaceIsReliable) {
            totalOverall = 0;
            for (let i = 0; i < n; i++) { if ((trackSurface[i] ?? -1) > -1) totalOverall++; }
          }
          const totalInClass = drivers.filter((x) => x.isPlayerClass).length;

          // Rellenar classPosition faltante por clase (iRacing no siempre la
          // publica en práctica). Ordenamos cada clase por best lap.
          const byClass = {};
          for (const dr of drivers) (byClass[dr.carClassId] ||= []).push(dr);
          for (const cls of Object.values(byClass)) {
            if (cls.some((d) => !d.classPosition)) {
              cls.slice().sort((a, b) => (a.bestLapTime || 1e9) - (b.bestLapTime || 1e9))
                .forEach((d, k) => { if (!d.classPosition) d.classPosition = k + 1; });
            }
          }

          // ── Live positions: en carrera, recalculamos la posición de CLASE por
          // progreso real (vuelta completada + fracción), así los adelantamientos
          // se ven al instante (la posición oficial de iRacing tarda un poco).
          if (isRace && lapReal) {
            for (const cls of Object.values(byClass)) {
              const prog = (d) => (lapCompleted[d.carIdx] || 0) + (d.lapDistPct || 0);
              cls.slice().sort((a, b) => prog(b) - prog(a)).forEach((d, k) => {
                d.classPosition = k + 1;
                d.livePosition = true;
              });
            }
          }

          // ── Posiciones de clasificación (para el cambio de posición vs qualy)
          // + flag de carrera oficial (para la predicción de iRating).
          let official = false;
          const qualPosByCarIdx = {};
          try {
            const sd = this.sdk.getSessionData();
            official = !!(sd && sd.WeekendInfo && sd.WeekendInfo.Official);
            const qr = sd && sd.QualifyResultsInfo && sd.QualifyResultsInfo.Results;
            if (Array.isArray(qr)) {
              for (const r of qr) {
                if (r && r.CarIdx != null) {
                  const cp = parseInt(r.ClassPosition, 10);
                  qualPosByCarIdx[r.CarIdx] = isFinite(cp) ? cp + 1 : (parseInt(r.Position, 10) || null);
                }
              }
            }
          } catch (_) {}
          for (const dr of drivers) {
            const qp = qualPosByCarIdx[dr.carIdx];
            if (qp != null && qp > 0) dr.qualClassPos = qp;
          }
          if (isRace && official) {
            const byCls2 = {};
            for (const dr of drivers) {
              if (dr.irating > 0 && dr.classPosition > 0) (byCls2[dr.carClassId] ||= []).push(dr);
            }
            for (const list of Object.values(byCls2)) {
              const changes = predictIratingChanges(list.map((d) => ({ carIdx: d.carIdx, rank: d.classPosition, rating: d.irating })));
              for (const dr of list) if (changes[dr.carIdx] != null) dr.iratingChange = changes[dr.carIdx];
            }
          }

          // Orden base por cercanía en pista (relDelta desc: adelante arriba).
          // El componente vuelve a centrar en el player, pero así el payload
          // ya llega coherente.
          drivers.sort((a, b) => (b.relDelta ?? -Infinity) - (a.relDelta ?? -Infinity));

          // Info de sesión
          const session = this._getSessionInfo();

          return {
            playerIdx,
            playerCarClass: playerRealClass,
            totalInClass,
            totalOverall,
            trackLength: trackLengthM,
            drivers,
            session,
          };
        }
      } catch (err) {
        // ignore
      }
    }
    return empty();
  }

  // Normaliza una variable CarIdx* a un array de tamaño n.
  // irsdk-node a veces la expone como escalar (valor del player) en vez de
  // array. En ese caso replicamos el escalar en el índice del player y
  // devolvemos un array con 0/null en el resto.
  _readCarIdxArray(telemetry, key, n, playerIdx = -1) {
    const raw = this._read(telemetry, key);
    if (Array.isArray(raw) && raw.length > 1) {
      // Si el array es más corto que n, lo rellenamos
      if (raw.length < n) {
        const out = new Array(n).fill(0);
        for (let i = 0; i < raw.length; i++) out[i] = raw[i];
        return out;
      }
      return raw;
    }
    // Vino escalar: armamos array con el valor solo en el índice del player
    const out = new Array(n).fill(0);
    if (playerIdx >= 0 && playerIdx < n && raw != null) {
      out[playerIdx] = raw;
    }
    return out;
  }

  // Resuelve el objeto de la sesión actual (por SessionNum) desde el YAML raíz.
  _currentSession(session, sessionNum) {
    const sessions = session && session.SessionInfo && session.SessionInfo.Sessions;
    if (!Array.isArray(sessions) || sessions.length === 0) return null;
    if (sessionNum != null) {
      const s = sessions.find((x) => x.SessionNum === sessionNum);
      if (s) return s;
      if (sessions[sessionNum]) return sessions[sessionNum];
    }
    return sessions[sessions.length - 1];
  }

  _resolveSessionType(session, sessionNum) {
    const s = this._currentSession(session, sessionNum);
    return (s && (s.SessionType || s.SessionName)) || 'Practice';
  }

  _getSessionInfo() {
    const session = {
      type: "Practice",
      time: 0,
      timeRemain: 0,
      timeTotal: 0,
      lapsTotal: 0,
      lapCurrent: 0,
      lapsMax: 0,
      incidents: 0,         // incidentes del player en esta sesión
      maxIncidents: 0,      // máximo permitido (0 si no hay límite)
    };
    if (this.sdk && this._connected) {
      // Telemetría (no falla por YAML)
      let sessionNum = null;
      try {
        this.sdk.waitForData(0);
        const tel = this.sdk.getTelemetry();
        if (tel) {
          session.time = this._read(tel, 'SessionTime') || 0;
          session.timeRemain = this._read(tel, 'SessionTimeRemain') || 0;
          session.lapCurrent = this._read(tel, 'Lap') || 0;
          session.incidents = this._read(tel, 'PlayerCarMyIncidentCount') || 0;
          sessionNum = this._read(tel, 'SessionNum');
        }
      } catch (_) {}
      // SessionData puede tirar excepción por YAML malformado;
      // lo aíslamos en su propio try para que la telemetría siga funcionando.
      try {
        const sd = this.sdk.getSessionData();
        const cur = this._currentSession(sd, sessionNum);
        if (cur) {
          session.type = cur.SessionType || cur.SessionName || "Practice";
          // Vueltas totales: SessionLaps puede ser número o "unlimited".
          const laps = parseInt(cur.SessionLaps, 10);
          if (!Number.isNaN(laps) && laps > 0) session.lapsTotal = laps;
          // Tiempo límite de la sesión: SessionTime en segundos (o "unlimited").
          const tlim = parseFloat(cur.SessionTime);
          if (isFinite(tlim) && tlim > 0) {
            session.timeTotal = tlim;
            session.timeRemain = Math.max(0, tlim - session.time);
          }
        }
        // Límite de incidentes: bajo WeekendInfo.WeekendOptions (o raíz).
        const wo = sd && sd.WeekendInfo && sd.WeekendInfo.WeekendOptions;
        const incRaw = (wo && (wo.IncidentLimit ?? wo.MaxIncidents)) ?? (sd && sd.MaxIncidents);
        if (incRaw != null) {
          const m = parseInt(incRaw, 10);
          if (!Number.isNaN(m) && m > 0) session.maxIncidents = m;
        }
      } catch (_) {}
      // Si el sim no publicó timeRemain pero sí tenemos time + timeTotal, lo derivamos
      if (session.timeTotal > 0 && session.timeRemain === 0) {
        session.timeRemain = Math.max(0, session.timeTotal - session.time);
      }
    }
    return session;
  }

  getDeltaBest() {
    // Lee directo de la memoria compartida para tener el delta en vivo
    // aunque el SDK no haya emitido nuevos frames (ej. auto frenado).
    //
    // Importante: NO usamos getSessionData() porque su YAML puede estar
    // malformado (p.ej. cuando un piloto tiene "Level: 0" sin indentación
    // correcta en un campo de driver) y eso rompe toda la lectura.
    //
    // Misma lógica bo2 que _updateCache: elegimos la variable de delta
    // según tipo de sesión y vuelta actual.
    if (this.sdk && this._connected) {
      try {
        this.sdk.waitForData(0);
        const telemetry = this.sdk.getTelemetry();
        if (telemetry) {
          const lap = this._read(telemetry, 'Lap') || 0;
          const bestLap = this._read(telemetry, 'LapBestLapTime') || 0;
          const currentLap = this._read(telemetry, 'LapCurrentLapTime') || 0;
          const speed = this._read(telemetry, 'Speed') || 0;
          const lapDistPct = this._read(telemetry, 'LapDistPct') || 0;

          const sessionType = this._cachedSessionType || 'Practice';
          const isRace = /race/i.test(sessionType);
          const isQual = /qual/i.test(sessionType);
          const isPractice = !isRace && !isQual;

          let lapDeltaToBest = null;
          let lapDeltaRate = 0;
          if (isQual) {
            if (this._read(telemetry, 'LapDeltaToBestLap_OK')) {
              lapDeltaToBest = this._read(telemetry, 'LapDeltaToBestLap');
              lapDeltaRate = this._read(telemetry, 'LapDeltaToBestLap_DD') || 0;
            }
          } else if (isRace) {
            if (lap <= 2) {
              if (this._read(telemetry, 'LapDeltaToSessionLastLap_OK')) {
                lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionLastLap');
                lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionLastLap_DD') || 0;
              } else if (this._read(telemetry, 'LapDeltaToSessionBestLap_OK')) {
                lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionBestLap');
                lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionBestLap_DD') || 0;
              }
            } else if (this._read(telemetry, 'LapDeltaToSessionBestLap_OK')) {
              lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionBestLap');
              lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionBestLap_DD') || 0;
            }
          } else if (isPractice) {
            if (this._read(telemetry, 'LapDeltaToSessionBestLap_OK')) {
              lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionBestLap');
              lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionBestLap_DD') || 0;
            }
          }
          if (lapDeltaToBest == null && this._read(telemetry, 'LapDeltaToOptimalLap_OK')) {
            lapDeltaToBest = this._read(telemetry, 'LapDeltaToOptimalLap');
            lapDeltaRate = this._read(telemetry, 'LapDeltaToOptimalLap_DD') || 0;
          }

          const delta = this._computeDelta({ lap, bestLap, currentLap, lapDeltaToBest, deltaRate: lapDeltaRate, speed, lapDistPct, sessionType, isRace, isQual, isPractice });
          this._cachedData.delta = delta;
          this._cachedData.lap = lap;
        }
      } catch (_) {}
    }
    return this._cachedData.delta;
  }

  getDeltaToBestLap() {
    return 0;
  }

  onUpdate(cb) {
    this._lightListeners.add(cb);
    cb(this._buildLightPayload());
    return () => this._lightListeners.delete(cb);
  }

  onHeavyUpdate(cb) {
    this._heavyListeners.add(cb);
    cb(this._buildHeavyPayload());
    return () => this._heavyListeners.delete(cb);
  }

  stop() {
    this._loopRunning = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this._mockTimer) {
      clearInterval(this._mockTimer);
      this._mockTimer = null;
    }
    if (this.sdk) {
      try {
        this.sdk.stopSDK();
      } catch (_) {}
      this.sdk = null;
    }
  }
}

module.exports = { IrsdkClient };
