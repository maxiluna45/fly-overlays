const { IRacingSDK } = require('irsdk-node');

const TIMEOUT = Math.floor((1 / 60) * 1000); // 60fps
const MOCK_MODE = process.env.FLY_MOCK === '1';

const TOTAL_SUBS = 24; // 3 sectores × 8 micro-sectores

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
      // Gap al player (negativo = adelante, positivo = detrás, player = 0).
      // Lo hacemos variar con t y con la posición relativa del piloto,
      // simulando que cada uno corre a un ritmo distinto (algunos acercan,
      // otros se alejan) para que el delta se vea vivo en preview.
      const baseGap = (i - playerIdx) * 1.5;
      const drift = Math.sin(t * 0.2 + i * 0.7) * 0.8;
      const gapToPlayer = isPlayer ? 0 : baseGap + drift;
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
        gapToPlayer,
        lapCompleted: isPlayer ? currentLapNum - 1 : currentLapNum - 1,
        lapDistPct: isPlayer ? (currentLapTime / 12) : Math.min(1, (currentLapTime + (i - playerIdx) * 0.5) / 12),
        onTrack: true,
        onPit: false,
        offTrack: i === 6, // el player está OFF como en el mock del dashboard
        out: false,
        estLapTime: baseLap,
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
    this._emitLight();
    this._emitHeavy();
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
    this._updateSectors({ lap, lapDistPct, currentLap, sessionTime });

    this._cachedData = {
      // Preservamos los campos pesados seteados por ticks anteriores
      ...this._cachedData,
      delta: this._computeDelta({ lap, bestLap, currentLap, lapDeltaToBest, deltaRate: lapDeltaRate, speed, lapDistPct, sessionType, isRace, isQual, isPractice }),
      lap,
      speed,
      onTrack: typeof speed === 'number' && speed > 0.5,
      session: session?.SessionNum,
      sessionType,
    };

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
    if (now - this._lastRelativeUpdate > 1000) {
      this._lastRelativeUpdate = now;
      this._cachedData.relative = this.getRelative();
      heavyChanged = true;
    }
    if (heavyChanged) this._emitHeavy();
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

  _buildLightPayload() {
    return {
      connected: this._connected,
      delta: this._cachedData.delta ?? 0,
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
      session: { type: "Practice", time: 0, timeRemain: 0, timeTotal: 0, lapsTotal: 0, lapCurrent: 0, lapsMax: 0, incidents: 0, maxIncidents: 0 },
    });

    if (this.sdk && this._connected) {
      try {
        this.sdk.waitForData(0);
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

          // Construir lista de drivers de la clase del player.
          // Filtro: solo mostrar drivers activos según CarIdxTrackSurface.
          //   surface === -1 → slot inactivo (no mostrar, salvo player)
          //   surface === 0  → not in world / disconnected (no mostrar, salvo player)
          //   surface === 1  → in pit stall (mostrar con tag PIT)
          //   surface === 2  → on track (mostrar normal)
          //   surface === 3  → off track (mostrar con tag OFF)
          // Sin esto, el SDK reporta 25+ posiciones > 0 pero solo 3 autos
          // están realmente en pista; el resto son "fantasmas" de slots viejos.
          const drivers = [];
          for (let i = 0; i < n; i++) {
            const d = driverInfo.Drivers[i];
            if (d.CarClassID !== playerRealClass) continue;
            if (d.CarIsPaceCar === 1) continue;
            const pos = positions[i] ?? 0;
            const cpos = classPositions[i] ?? 0;
            const surface = trackSurface[i] ?? -1;
            const onPit = !!onPitRoad[i];
            const isPlayer = i === playerIdx;
            // Filtrar slots inactivos o "not in world" (fantasmas).
            // El player se muestra siempre (puede tener surface=-1 transitorio).
            if (!isPlayer && (surface === -1 || surface === 0)) continue;

            // Estados
            const onTrack = surface === 2;
            const inPitStall = surface === 1;
            const offTrack = surface === 3;
            const out = surface === -1 || surface === 0;

            // Gap al player (en segundos).
            // Convención (igual a iRacing): negativo = adelante, positivo = atrás.
            //   Adelante tuyo → fila arriba, gap con número absoluto
            //   Atrás tuyo   → fila abajo, gap con número absoluto
            //
            // Fuente 1: CarIdxF2Time (tiempo detrás del leader). El wrapper
            //   irsdk-node a veces lo expone como escalar (solo el del player),
            //   en cuyo caso NO podemos sacar gaps de otros pilotos — caemos
            //   a estTime.
            // Fuente 2: CarIdxEstTime (tiempo estimado de cruce de meta). La
            //   diferencia directa entre dos pilotos da el gap en segundos.
            const f2 = this._read(telemetry, 'CarIdxF2Time') ?? null;
            const f2IsRealArray =
              Array.isArray(f2) &&
              f2.length > 1 &&
              f2.some((v, idx) => idx !== playerIdx && v > 0);
            const estRaw = this._read(telemetry, 'CarIdxEstTime') ?? null;
            const estIsRealArray =
              Array.isArray(estRaw) &&
              estRaw.length > 1 &&
              estRaw.some((v, idx) => idx !== playerIdx && v > 0);

            let gapToPlayer = null;
            if (f2IsRealArray && f2[playerIdx] != null && f2[playerIdx] >= 0) {
              // Camino A: array real de F2Time
              gapToPlayer = f2[i] - f2[playerIdx];
            } else if (estIsRealArray && estRaw[playerIdx] != null && estRaw[playerIdx] > 0) {
              // Camino B: array real de EstTime
              gapToPlayer = estRaw[i] - estRaw[playerIdx];
            } else {
              // Camino C: re-normalizar a arrays aunque hayan venido escalares,
              //   pero descartar si el resultado es degenerado (todos ceros
              //   salvo el índice del player).
              const f2Arr = this._readCarIdxArray(telemetry, 'CarIdxF2Time', n, playerIdx);
              const estArr = this._readCarIdxArray(telemetry, 'CarIdxEstTime', n, playerIdx);
              const f2HasOthers = f2Arr.some((v, idx) => idx !== playerIdx && v > 0);
              const estHasOthers = estArr.some((v, idx) => idx !== playerIdx && v > 0);
              if (f2HasOthers && f2Arr[playerIdx] != null && f2Arr[playerIdx] >= 0) {
                gapToPlayer = f2Arr[i] - f2Arr[playerIdx];
              } else if (estHasOthers && estArr[playerIdx] != null && estArr[playerIdx] > 0) {
                gapToPlayer = estArr[i] - estArr[playerIdx];
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
              offTrack,
              out,
              estLapTime: estTime[i] || 0,
              lastLapTime: lastLapTime[i] || 0,
              bestLapTime: bestLapTime[i] || 0,
              bestLapNum: bestLapNum[i] || 0,
              isFastest: bestLapTime[i] > 0 && Math.abs(bestLapTime[i] - bestLapInClass) < 0.001,
              sessionFlags: sessionFlagsArr[i] || 0,
            });
          }

          // Total overall (solo slots con trackSurface válido)
          let totalOverall = 0;
          for (let i = 0; i < n; i++) {
            const s = trackSurface[i] ?? -1;
            if (s !== -1 && s !== 0) totalOverall++;
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
      try {
        this.sdk.waitForData(0);
        const tel = this.sdk.getTelemetry();
        if (tel) {
          session.time = this._read(tel, 'SessionTime') || 0;
          session.timeRemain = this._read(tel, 'SessionTimeRemain') || 0;
          session.lapCurrent = this._read(tel, 'Lap') || 0;
          session.incidents = this._read(tel, 'PlayerCarMyIncidentCount') || 0;
        }
      } catch (_) {}
      // SessionData puede tirar excepción por YAML malformado;
      // lo aíslamos en su propio try para que la telemetría siga funcionando.
      try {
        const sd = this.sdk.getSessionData();
        if (sd) {
          session.type = sd.SessionType || "Practice";
          session.lapsTotal = parseInt(sd.SessionLapsTotal || "0", 10) || 0;
          // MaxIncidents puede venir como "17", "unlimited", 0, etc.
          if (sd.MaxIncidents != null) {
            const m = parseInt(sd.MaxIncidents, 10);
            if (!Number.isNaN(m) && m > 0) session.maxIncidents = m;
          } else if (sd.SessionMaxIncidentCount != null) {
            const m = parseInt(sd.SessionMaxIncidentCount, 10);
            if (!Number.isNaN(m) && m > 0) session.maxIncidents = m;
          }
          if (sd.SessionTimeLimit) {
            const t = parseFloat(sd.SessionTimeLimit);
            if (t > 0) {
              session.timeRemain = Math.max(0, t - session.time);
              session.timeTotal = t;
            }
          }
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
