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
    // Splits distribuidos cada 1/24 de la vuelta (~4.17% cada uno)
    // S1: 4.17% al 29.17% (8 sub-secs)
    // S2: 33.33% al 62.50% (8 sub-secs)
    // S3: 66.67% al 95.83% (8 sub-secs)
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
    this._lastSplitTime = 0;
    this._lastDeltaCurrentLap = 0;
    // 24 splits para dividir la vuelta en 24 micro-sectores
    // Distribuidos: 7 en S1 (0-33%), 8 en S2 (33-66%), 8 en S3 (66-100%)
    // ...es decir, 7 splits intermedios, uno cada 1/8 de la vuelta
    this._splitPcts = Array.from({ length: 23 }, (_, i) => (i + 1) / 24);
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
    const lapDeltaToBest = this._read(telemetry, 'LapDeltaToBestLap') || 0;
    const lapDeltaRate = this._read(telemetry, 'LapDeltaToBestLap_DD') || 0;
    const lapDistPct = this._read(telemetry, 'LapDistPct') || 0;
    const sessionTime = this._read(telemetry, 'SessionTime') || 0;

    // Detectar cruces de splits y meta
    this._updateSectors({ lap, lapDistPct, currentLap, sessionTime });

    this._cachedData = {
      delta: this._computeDelta({ lap, bestLap, currentLap, lapDeltaToBest, deltaRate: lapDeltaRate, speed, lapDistPct }),
      lap,
      speed,
      onTrack: typeof speed === 'number' && speed > 0.5,
      session: session?.SessionNum,
    };
  }

  _updateSectors({ lap, lapDistPct, currentLap, sessionTime }) {
    // Detección de cruce de meta por cambio en número de vuelta
    // (más robusto que detectar el wrap de LapDistPct que puede fallar en
    // circuitos con geometría irregular)
    const lapChanged = this._lastLapNumberForSectors != null && lap !== this._lastLapNumberForSectors;
    this._lastLapNumberForSectors = lap;

    if (lapChanged) {
      // El micro-sector 8 es el último (entre el split 88.8% y la meta)
      // Lo llenamos siempre que tengamos un valor razonable
      const lastMicroTime = currentLap - this._lastSplitTime;
      if (lastMicroTime > 0 && lastMicroTime < 300) {
        this._currentMicroSectors[8] = lastMicroTime;
      }

      // Guardamos la última vuelta completa
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

    // Detección de cruce de splits (6 intermedios)
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
    // Sin best lap válido → no podemos calcular delta
    if (!bestLap || bestLap <= 0) return 0;

    // ESTRATEGIA: usamos LapDeltaToBestLap_DD (rate of change, s/s) que se
    // actualiza en cada frame con telemetría. Combinado con la velocidad
    // del auto (m/s), podemos extrapolar el delta "live" en cualquier
    // punto de la vuelta.
    //
    // Cuando el delta DD es -0.5 (s/s) y vamos a 50 m/s, estamos perdiendo
    // 25 m de delta por segundo. Traducido a tiempo:
    //   delta_actual = deltaReportado + (velocidad_normalizada * -DD)
    //
    // bo2 official hace exactamente esto: `Speed * -delta`.

    if (deltaRate == null || speed == null) {
      return lapDeltaToBest;
    }

    // Normalizar: bo2 multiplica por SpeedLocal, que está en m/s.
    // El factor de escala no es crítico si mantenemos la convención:
    // un delta DD de -1 s/s con speed alto = perdiendo tiempo rápido.
    // Para hacerlo similar a bo2, multiplicamos por la velocidad normalizada.
    const refSpeed = 30; // m/s (~108 km/h, velocidad típica de curva)
    const speedFactor = (speed || 0) / refSpeed;

    // El rate (s/s) es el cambio del delta por segundo.
    // Aproximación: el delta "futuro" a este ritmo es deltaRate * distancia_recorrida_desde_punto_de_referencia
    // Pero como no tenemos el punto de referencia, usamos la fórmula de bo2:
    return (lapDeltaToBest || 0) + (deltaRate * speedFactor);
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

  // Devuelve los tiempos oficiales de iRacing (no la suma de micro-sectores)
  // que se actualizan en vivo y son exactos.
  getLapTimes() {
    if (this.sdk && this._connected) {
      try {
        const telemetry = this.sdk.getTelemetry();
        if (telemetry) {
          return {
            currentLap: this._read(telemetry, 'LapCurrentLapTime') || 0,
            bestLap: this._read(telemetry, 'LapBestLapTime') || 0,
            lastLap: this._read(telemetry, 'LapLastLapTime') || 0,
          };
        }
      } catch (_) {}
    }
    return { currentLap: 0, bestLap: 0, lastLap: 0 };
  }

  getDeltaBest() {
    // Lee directo de la memoria compartida para tener el delta en vivo
    // aunque el SDK no haya emitido nuevos frames (ej. auto frenado).
    if (this.sdk && this._connected) {
      try {
        const telemetry = this.sdk.getTelemetry();
        if (telemetry) {
          const lap = this._read(telemetry, 'Lap') || 0;
          const bestLap = this._read(telemetry, 'LapBestLapTime') || 0;
          const currentLap = this._read(telemetry, 'LapCurrentLapTime') || 0;
          const lapDeltaToBest = this._read(telemetry, 'LapDeltaToBestLap') || 0;
          const lapDeltaRate = this._read(telemetry, 'LapDeltaToBestLap_DD') || 0;
          const speed = this._read(telemetry, 'Speed') || 0;
          const lapDistPct = this._read(telemetry, 'LapDistPct') || 0;

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
