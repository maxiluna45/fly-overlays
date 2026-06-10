const { IRacingSDK } = require('irsdk-node');

const TIMEOUT = Math.floor((1 / 60) * 1000); // 60fps
const MOCK_MODE = process.env.FLY_MOCK === '1';

class IrsdkClient {
  constructor() {
    this.sdk = null;
    this._connected = false;
    this._loopRunning = false;
    this._listeners = new Set();
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
    // 3 × 8 = 24 micro-sectores totales
    // Splits distribuidos cada 1/25 de la vuelta (4% cada uno)
    // El último split (24/25 = 96%) marca el fin del micro-sector 23.
    // S1: 4% al 28% (8 sub-secs)
    // S2: 32% al 60% (8 sub-secs)
    // S3: 64% al 96% (8 sub-secs)
    this._splitPcts = Array.from({ length: 24 }, (_, i) => (i + 1) / 25);
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
    this._emit(); // emitir connected=false para que la UI se entere
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
        // Si cambió el número de vuelta, reiniciamos el _lastLapPct para que el primer split se detecte
        if (lap !== this._mockLap) {
          this._mockLap = lap;
          this._lastLapPct = 0;
          this._lastSplitTime = 0;
          this._currentMicroSectors = new Array(24).fill(null);
        }
        // "Empujamos" el currentLap bastante para que haya variabilidad entre
        // micro-sectores y se vean distintos colores
        const jitteredCurrentLap = currentLap + Math.sin(t * 3.5) * 0.5 + Math.cos(t * 7) * 0.3;
        this._updateSectors({
          lap,
          lapDistPct,
          currentLap: jitteredCurrentLap,
          sessionTime: t,
        });
      }

      this._emit();
    }, 50);
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
      this._emit();
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
          this._emit();
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
    this._emit();
    this._scheduleReconnect();
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
    const lap = this._read(telemetry, 'Lap') || 0;
    const bestLap = this._read(telemetry, 'LapBestLapTime') || 0;
    const currentLap = this._read(telemetry, 'LapCurrentLapTime') || 0;
    const lapDistPct = this._read(telemetry, 'LapDistPct') || 0;
    const sessionTime = this._read(telemetry, 'SessionTime') || 0;

    // Detectar tipo de sesión del SessionInfo
    // iRacing expone SessionType como string. Valores comunes:
    //   "Practice", "Qualify", "Race"
    const sessionType = (session && typeof session === 'object' && (session.SessionType || session.SessionName)) || 'Practice';
    const isRace = /race/i.test(sessionType);
    const isQual = /qual/i.test(sessionType);
    const isPractice = !isRace && !isQual;

    // Cascada de deltas como FALLBACK. El cálculo principal (en _computeDelta)
    // es nuestro: currentLap - bestLap * lapDistPct, siempre vs tu best real.
    // Esta cascada solo se usa en la primera vuelta (cuando bestLap == -1)
    // para mostrar un delta vs vuelta óptima en lo que completás la primera.
    let lapDeltaToBest = 0;
    let lapDeltaRate = 0;
    if (isQual || isRace || isPractice) {
      if (this._read(telemetry, 'LapDeltaToBestLap_OK')) {
        lapDeltaToBest = this._read(telemetry, 'LapDeltaToBestLap') || 0;
        lapDeltaRate = this._read(telemetry, 'LapDeltaToBestLap_DD') || 0;
      } else if (this._read(telemetry, 'LapDeltaToSessionBestLap_OK')) {
        lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionBestLap') || 0;
        lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionBestLap_DD') || 0;
      } else if (this._read(telemetry, 'LapDeltaToOptimalLap_OK')) {
        lapDeltaToBest = this._read(telemetry, 'LapDeltaToOptimalLap') || 0;
        lapDeltaRate = this._read(telemetry, 'LapDeltaToOptimalLap_DD') || 0;
      }
    }

    // Detectar cruces de splits y meta
    this._updateSectors({ lap, lapDistPct, currentLap, sessionTime });

    this._cachedData = {
      delta: this._computeDelta({ lap, bestLap, currentLap, lapDeltaToBest, deltaRate: lapDeltaRate, speed, lapDistPct }),
      lap,
      speed,
      onTrack: typeof speed === 'number' && speed > 0.5,
      session: session?.SessionNum,
      sessionType,
    };
  }

  _updateSectors({ lap, lapDistPct, currentLap, sessionTime }) {
    // Detección de cruce de meta por cambio en número de vuelta
    // (más robusto que detectar el wrap de LapDistPct que puede fallar en
    // circuitos con geometría irregular)
    const lapChanged = this._lastLapNumberForSectors != null && lap !== this._lastLapNumberForSectors;
    this._lastLapNumberForSectors = lap;

    if (lapChanged) {
      // Guardamos la última vuelta completa (los 24 micro-sectores ya se
      // llenaron por cruce de splits; el último se llena al cruzar 24/25)
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
      const out = new Array(9);
      for (let i = 0; i < 24; i++) out[i] = v[i] != null ? v[i] : null;
      return out;
    };
    return {
      current: fill(this._currentMicroSectors),
      last: fill(this._lastLapMicroSectors),
      best: fill(this._bestLapMicroSectors),
    };
  }

  _computeDelta({ lap, bestLap, currentLap, lapDeltaToBest, deltaRate, speed, lapDistPct }) {
    // ESTRATEGIA PRINCIPAL: calcular el delta nosotros mismos contra tu best
    // personal. Fórmula exacta en cualquier punto de la vuelta:
    //   delta = currentLap - (bestLap * lapDistPct)
    //
    // ¿Por qué? iRacing reporta LapDeltaToBestLap intermitente en multi-
    // jugador y a veces lo confunde con el delta vs vuelta óptima. Calculando
    // nosotros mismos siempre comparamos contra tu mejor vuelta real,
    // desde la primera hasta la última, sin depender de flags _OK.
    if (
      bestLap != null && bestLap > 0 &&
      currentLap != null && currentLap > 0 &&
      lapDistPct != null && lapDistPct > 0
    ) {
      return currentLap - (bestLap * lapDistPct);
    }

    // FALLBACK (primera vuelta, sin best personal): usar el delta del sim
    // (cascada Best → SessionBest → Optimal, ya armada por el caller).
    // Si el sim tampoco tiene nada válido, devolvemos 0.
    if (lapDeltaToBest == null) return 0;
    return lapDeltaToBest;
  }

  _read(telemetry, key) {
    if (!telemetry) return null;
    const entry = telemetry[key];
    if (entry === undefined || entry === null) return null;
    const raw = entry.value;
    if (raw === undefined || raw === null) return null;
    if (Array.isArray(raw)) {
      return raw.length === 1 ? raw[0] : raw[0];
    }
    return raw;
  }

  _emit() {
    const payload = { ...this._cachedData, connected: this._connected };
    for (const cb of this._listeners) cb(payload);
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
  // Estructura: { LF: { tempL, tempM, tempR, press, wearL, wearM, wearR }, RF, LR, RR }
  // L/M/R = zonas inner/center/outer de la banda de rodamiento
  // Nota: las keys nativas de iRacing son LFtempCL/CM/CR (no LFtempL) y la
  // presión es LFcoldPressure (en kPa, valor actual en vivo).
  getTyres() {
    const empty = (t = 75, p = 165, w = 0.1) => ({
      tempL: t, tempM: t, tempR: t, press: p,
      wearL: w, wearM: w, wearR: w,
    });
    if (this.sdk && this._connected) {
      try {
        const telemetry = this.sdk.getTelemetry();
        if (telemetry) {
          return {
            LF: {
              tempL: this._read(telemetry, 'LFtempCL') ?? null,
              tempM: this._read(telemetry, 'LFtempCM') ?? null,
              tempR: this._read(telemetry, 'LFtempCR') ?? null,
              press: this._read(telemetry, 'LFcoldPressure') ?? null,
              wearL: this._read(telemetry, 'LFwearL') ?? null,
              wearM: this._read(telemetry, 'LFwearM') ?? null,
              wearR: this._read(telemetry, 'LFwearR') ?? null,
            },
            RF: {
              tempL: this._read(telemetry, 'RFtempCL') ?? null,
              tempM: this._read(telemetry, 'RFtempCM') ?? null,
              tempR: this._read(telemetry, 'RFtempCR') ?? null,
              press: this._read(telemetry, 'RFcoldPressure') ?? null,
              wearL: this._read(telemetry, 'RFwearL') ?? null,
              wearM: this._read(telemetry, 'RFwearM') ?? null,
              wearR: this._read(telemetry, 'RFwearR') ?? null,
            },
            LR: {
              tempL: this._read(telemetry, 'LRtempCL') ?? null,
              tempM: this._read(telemetry, 'LRtempCM') ?? null,
              tempR: this._read(telemetry, 'LRtempCR') ?? null,
              press: this._read(telemetry, 'LRcoldPressure') ?? null,
              wearL: this._read(telemetry, 'LRwearL') ?? null,
              wearM: this._read(telemetry, 'LRwearM') ?? null,
              wearR: this._read(telemetry, 'LRwearR') ?? null,
            },
            RR: {
              tempL: this._read(telemetry, 'RRtempCL') ?? null,
              tempM: this._read(telemetry, 'RRtempCM') ?? null,
              tempR: this._read(telemetry, 'RRtempCR') ?? null,
              press: this._read(telemetry, 'RRcoldPressure') ?? null,
              wearL: this._read(telemetry, 'RRwearL') ?? null,
              wearM: this._read(telemetry, 'RRwearM') ?? null,
              wearR: this._read(telemetry, 'RRwearR') ?? null,
            },
          };
        }
      } catch (_) {}
    }
    return {
      LF: empty(70, 160, 0.05),
      RF: empty(72, 162, 0.05),
      LR: empty(80, 170, 0.05),
      RR: empty(82, 172, 0.05),
    };
  }

  // Devuelve el relative (leaderboard) con todos los pilotos de la clase del player.
  // Estructura:
  //   {
  //     playerIdx, playerCarClass, totalInClass, totalOverall,
  //     drivers: [
  //       { carIdx, position, classPosition, name, abbrev,
  //         carNumber, irating, licString, licColor, licSubLevel,
  //         carClassId, carClassShort, carClassColor,
  //         gapToPlayer, lapCompleted, lapDistPct, onTrack, onPit, out,
  //         estLapTime, lastLapTime, bestLapTime, isPlayer, isLeader,
  //         isFastest, sessionFlags
  //       }, ...
  //     ],
  //     session: { type, time, timeRemain, lapsTotal, lapCurrent, lapsMax }
  //   }
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
      session: { type: "Practice", time: 0, timeRemain: 0, lapsTotal: 0, lapCurrent: 0, lapsMax: 0 },
    });

    if (this.sdk && this._connected) {
      try {
        const telemetry = this.sdk.getTelemetry();
        const driverInfo = this.sdk.getDriverInfo();
        if (telemetry && driverInfo && driverInfo.Drivers && driverInfo.Drivers.length > 0) {
          const n = driverInfo.Drivers.length;
          const playerIdx = this._read(telemetry, 'PlayerCarIdx') ?? 0;
          // Si por alguna razón el array viene vacío, fallback
          const playerDriver = driverInfo.Drivers.find((d) => d.CarIdx === playerIdx) || driverInfo.Drivers[0];
          const playerRealClass = playerDriver ? playerDriver.CarClassID : 0;

          // Arrays CarIdx* (normalizados a tamaño n)
          const positions = this._readCarIdxArray(telemetry, 'CarIdxPosition', n, playerIdx);
          const classPositions = this._readCarIdxArray(telemetry, 'CarIdxClassPosition', n, playerIdx);
          const lapCompleted = this._readCarIdxArray(telemetry, 'CarIdxLapCompleted', n, playerIdx);
          const lapDistPct = this._readCarIdxArray(telemetry, 'CarIdxLapDistPct', n, playerIdx);
          const trackSurface = this._readCarIdxArray(telemetry, 'CarIdxTrackSurface', n, playerIdx);
          const onPitRoad = this._readCarIdxArray(telemetry, 'CarIdxOnPitRoad', n, playerIdx);
          const estTime = this._readCarIdxArray(telemetry, 'CarIdxEstTime', n, playerIdx);
          const lastLapTime = this._readCarIdxArray(telemetry, 'CarIdxLastLapTime', n, playerIdx);
          const bestLapTime = this._readCarIdxArray(telemetry, 'CarIdxBestLapTime', n, playerIdx);
          const bestLapNum = this._readCarIdxArray(telemetry, 'CarIdxBestLapNum', n, playerIdx);
          const sessionFlagsArr = this._readCarIdxArray(telemetry, 'CarIdxSessionFlags', n, playerIdx);

          // Best lap del player (clase) para detectar "fastest"
          let bestLapInClass = Infinity;
          for (let i = 0; i < n; i++) {
            const d = driverInfo.Drivers[i];
            if (d.CarClassID !== playerRealClass) continue;
            const bl = bestLapTime[i];
            if (bl > 0 && bl < bestLapInClass) bestLapInClass = bl;
          }

          // Construir lista de drivers de la clase del player
          const drivers = [];
          for (let i = 0; i < n; i++) {
            const d = driverInfo.Drivers[i];
            if (d.CarClassID !== playerRealClass) continue;
            if (d.CarIsPaceCar === 1) continue;
            const pos = positions[i] ?? 0;
            const cpos = classPositions[i] ?? 0;
            // Sin posición válida → no está en el mundo. No lo mostramos.
            // Excepción: el player siempre se muestra aunque no tenga pos aún.
            if (pos <= 0 && i !== playerIdx) continue;
            const surface = trackSurface[i] ?? 0;
            const onPit = !!onPitRoad[i];
            const onTrack = surface === 2;
            const inPitStall = surface === 1;
            const out = surface === 0 || (pos > 0 && lapCompleted[i] === lapCompleted[playerIdx] - 10);

            // Gap al player. F2Time es tiempo al leader; si no está,
            // proyectamos desde estTime + lapCompleted.
            const f2 = this._read(telemetry, 'CarIdxF2Time') ?? null;
            const f2Arr = this._readCarIdxArray(telemetry, 'CarIdxF2Time', n, playerIdx);
            let gapToPlayer = null;
            if (Array.isArray(f2) && f2.length > 1 && f2[playerIdx] != null && f2[playerIdx] > 0) {
              gapToPlayer = f2[i] - f2[playerIdx];
            } else if (f2Arr[playerIdx] != null && f2Arr[playerIdx] > 0) {
              gapToPlayer = f2Arr[i] - f2Arr[playerIdx];
            } else {
              const myEst = estTime[playerIdx] || 0;
              const otherEst = estTime[i] || 0;
              if (myEst > 0 && otherEst > 0) {
                const myTotal = lapCompleted[playerIdx] * myEst + lapDistPct[playerIdx] * myEst;
                const otherTotal = lapCompleted[i] * otherEst + lapDistPct[i] * otherEst;
                gapToPlayer = otherTotal - myTotal;
              }
            }

            drivers.push({
              carIdx: i,
              position: pos,
              classPosition: cpos,
              name: d.UserName || d.CarScreenName || "Driver",
              abbrev: d.AbbrevName || null,
              initials: d.Initials || null,
              carNumber: d.CarNumber || "",
              teamName: d.TeamName || "",
              irating: d.IRating || 0,
              licString: d.LicString || "",
              licColor: d.LicColor || 0,
              licLevel: d.LicLevel || 0,
              licSubLevel: d.LicSubLevel || 0,
              carClassId: d.CarClassID,
              carClassShort: d.CarClassShortName || "",
              carClassColor: d.CarClassColor || 0,
              gapToPlayer,
              lapCompleted: lapCompleted[i] || 0,
              lapDistPct: lapDistPct[i] || 0,
              onTrack,
              onPit: onPit || inPitStall,
              out,
              estLapTime: estTime[i] || 0,
              lastLapTime: lastLapTime[i] || 0,
              bestLapTime: bestLapTime[i] || 0,
              bestLapNum: bestLapNum[i] || 0,
              isFastest: bestLapTime[i] > 0 && Math.abs(bestLapTime[i] - bestLapInClass) < 0.001,
              sessionFlags: sessionFlagsArr[i] || 0,
            });
          }

          // Total overall (todos los drivers con pos > 0)
          let totalOverall = 0;
          for (let i = 0; i < n; i++) {
            if (positions[i] > 0) totalOverall++;
          }
          const totalInClass = drivers.length;

          // Ordenar por classPosition ascendente
          drivers.sort((a, b) => (a.classPosition || 99) - (b.classPosition || 99));

          // Asignar classPosition correlativa dentro de los drivers visibles
          // (porque a veces iRacing no la publica en practice)
          for (let k = 0; k < drivers.length; k++) {
            if (!drivers[k].classPosition) drivers[k].classPosition = k + 1;
          }

          // Info de sesión
          const session = this._getSessionInfo();

          return {
            playerIdx,
            playerCarClass: playerRealClass,
            totalInClass,
            totalOverall,
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

          // Construir lista de drivers de la clase del player
          const drivers = [];
          for (let i = 0; i < driverInfo.Drivers.length; i++) {
            const d = driverInfo.Drivers[i];
            if (d.CarClassID !== playerRealClass) continue;
            if (d.CarIsPaceCar === 1) continue;
            // Filter out AI pace car / ghost cars
            const pos = positions[i] ?? 0;
            const cpos = classPositions[i] ?? 0;
            if (pos <= 0) continue;
            const surface = trackSurface[i] ?? 0;
            const onPit = !!onPitRoad[i];
            // En iRacing surface: 0 = not in world, 1 = in pit stall, 2 = on track, 3 = off track
            const onTrack = surface === 2;
            const inPitStall = surface === 1;
            const out = surface === 0 || (pos > 0 && lapCompleted[i] === lapCompleted[playerIdx] - 10); // heurística OUT

            // Delta al player. Usamos CarIdxF2Time si está disponible (tiempo al leader),
            // si no, proyectamos desde LapDistPct + estTime.
            const f2 = this._read(telemetry, 'CarIdxF2Time') || [];
            let gapToPlayer = null;
            if (f2[i] != null && f2[playerIdx] != null && f2[playerIdx] > 0) {
              // F2Time es tiempo al leader. Gap al player = F2Time[i] - F2Time[playerIdx].
              // Si F2Time[i] < F2Time[playerIdx] => está adelante (gap negativo).
              gapToPlayer = f2[i] - f2[playerIdx];
            } else {
              // Fallback: proyección. Estimar el tiempo de cada piloto al
              // completar la vuelta = estTime (si está), o bestLapTime.
              // gap = (estTime - playerEstTime) si están en la misma vuelta
              // Si no, ajustar por la diferencia de vueltas.
              const myEst = estTime[playerIdx] || 0;
              const otherEst = estTime[i] || 0;
              if (myEst > 0 && otherEst > 0) {
                // Estimar posición por "tiempo total": laps * est + pct * est
                const myTotal = lapCompleted[playerIdx] * myEst + lapDistPct[playerIdx] * myEst;
                const otherTotal = lapCompleted[i] * otherEst + lapDistPct[i] * otherEst;
                gapToPlayer = otherTotal - myTotal;
              }
            }

            drivers.push({
              carIdx: i,
              position: pos,
              classPosition: cpos,
              name: d.UserName || d.CarScreenName || "Driver",
              abbrev: d.AbbrevName || null,
              initials: d.Initials || null,
              carNumber: d.CarNumber || "",
              teamName: d.TeamName || "",
              irating: d.IRating || 0,
              licString: d.LicString || "",
              licColor: d.LicColor || 0,
              licLevel: d.LicLevel || 0,
              licSubLevel: d.LicSubLevel || 0,
              carClassId: d.CarClassID,
              carClassShort: d.CarClassShortName || "",
              carClassColor: d.CarClassColor || 0,
              gapToPlayer,
              lapCompleted: lapCompleted[i] || 0,
              lapDistPct: lapDistPct[i] || 0,
              onTrack,
              onPit: onPit || inPitStall,
              out,
              estLapTime: estTime[i] || 0,
              lastLapTime: lastLapTime[i] || 0,
              bestLapTime: bestLapTime[i] || 0,
              bestLapNum: bestLapNum[i] || 0,
              isFastest: bestLapTime[i] > 0 && Math.abs(bestLapTime[i] - bestLapInClass) < 0.001,
              sessionFlags: sessionFlagsArr[i] || 0,
            });
          }

          // Total overall
          let totalOverall = 0;
          for (let i = 0; i < positions.length; i++) {
            if (positions[i] > 0) totalOverall++;
          }
          const totalInClass = drivers.length;

          // Info de sesión
          const session = this._getSessionInfo();

          return {
            playerIdx,
            playerCarClass: playerRealClass,
            totalInClass,
            totalOverall,
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

  _getSessionInfo() {
    const session = {
      type: "Practice",
      time: 0,
      timeRemain: 0,
      lapsTotal: 0,
      lapCurrent: 0,
      lapsMax: 0,
    };
    if (this.sdk && this._connected) {
      // Telemetría (no falla por YAML)
      try {
        const tel = this.sdk.getTelemetry();
        if (tel) {
          session.time = this._read(tel, 'SessionTime') || 0;
          session.timeRemain = this._read(tel, 'SessionTimeRemain') || 0;
          session.lapCurrent = this._read(tel, 'Lap') || 0;
        }
      } catch (_) {}
      // SessionData puede tirar excepción por YAML malformado;
      // lo aíslamos en su propio try para que la telemetría siga funcionando.
      try {
        const sd = this.sdk.getSessionData();
        if (sd) {
          session.type = sd.SessionType || "Practice";
          session.lapsTotal = parseInt(sd.SessionLapsTotal || "0", 10) || 0;
          if (sd.SessionTimeLimit) {
            const t = parseFloat(sd.SessionTimeLimit);
            if (t > 0) session.timeRemain = Math.max(0, t - session.time);
          }
        }
      } catch (_) {}
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
    // LapDeltaToBestLap / LapDeltaToBestLap_DD vienen de la telemetría
    // y son vs tu mejor vuelta personal — funciona en Practice, Qual y Race.
    if (this.sdk && this._connected) {
      try {
        const telemetry = this.sdk.getTelemetry();
        if (telemetry) {
          const lap = this._read(telemetry, 'Lap') || 0;
          const bestLap = this._read(telemetry, 'LapBestLapTime') || 0;
          const currentLap = this._read(telemetry, 'LapCurrentLapTime') || 0;
          const speed = this._read(telemetry, 'Speed') || 0;
          const lapDistPct = this._read(telemetry, 'LapDistPct') || 0;

          // Misma cascada que en _updateCache: Best → SessionBest → Optimal
          let lapDeltaToBest = 0;
          let lapDeltaRate = 0;
          if (this._read(telemetry, 'LapDeltaToBestLap_OK')) {
            lapDeltaToBest = this._read(telemetry, 'LapDeltaToBestLap') || 0;
            lapDeltaRate = this._read(telemetry, 'LapDeltaToBestLap_DD') || 0;
          } else if (this._read(telemetry, 'LapDeltaToSessionBestLap_OK')) {
            lapDeltaToBest = this._read(telemetry, 'LapDeltaToSessionBestLap') || 0;
            lapDeltaRate = this._read(telemetry, 'LapDeltaToSessionBestLap_DD') || 0;
          } else if (this._read(telemetry, 'LapDeltaToOptimalLap_OK')) {
            lapDeltaToBest = this._read(telemetry, 'LapDeltaToOptimalLap') || 0;
            lapDeltaRate = this._read(telemetry, 'LapDeltaToOptimalLap_DD') || 0;
          }

          const delta = this._computeDelta({ lap, bestLap, currentLap, lapDeltaToBest, deltaRate: lapDeltaRate, speed, lapDistPct });
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
    this._listeners.add(cb);
    cb({ ...this._cachedData, connected: this._connected });
    return () => this._listeners.delete(cb);
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
