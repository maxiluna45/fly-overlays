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
    this._mockTimer = setInterval(() => {
      const t = (Date.now() - this._mockStart) / 1000;
      const LAP_MS = 90000;
      const lapProgress = (t * 1000) % LAP_MS;
      const inLap = lapProgress < LAP_MS * 0.95;
      this._cachedData = {
        delta: Math.sin(t * 0.7) * 2.3 + (Math.random() - 0.5) * 0.4,
        lap: Math.floor(t * 1000 / LAP_MS) + 1,
        speed: inLap ? 180 + Math.sin(t * 2) * 40 : 0,
        onTrack: inLap,
        preview: this._previewMode,
      };
      this._emit();
    }, 50);
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

    this._cachedData = {
      delta: this._computeDelta({ lap, bestLap, currentLap, lapDeltaToBest }),
      lap,
      speed,
      onTrack: typeof speed === 'number' && speed > 0.5,
      session: session?.SessionNum,
    };
  }

  _computeDelta({ lap, bestLap, currentLap, lapDeltaToBest }) {
    // Sin best lap válido → no podemos calcular delta
    if (!bestLap || bestLap <= 0) return 0;

    // Detectar nueva vuelta
    if (lap !== this._lastLapNumber) {
      this._lastLapNumber = lap;
      // iRacing resetea LapDeltaToBestLap al cruzar meta al valor que tenía
      // al final de la vuelta anterior (o el delta de la nueva vuelta si mejoraste)
      this._lapBaseDelta = lapDeltaToBest;
    }

    // Usamos LapDeltaToBestLap directo. iRacing lo actualiza al pasar por
    // cada sector (3 splits en circuitos normales), así que entre sectores
    // el valor puede "saltar" pero el comportamiento es estándar.
    //
    // NOTA: en la primera vuelta sin splits previos, el valor puede mostrar
    // el delta de la mejor vuelta anterior o 0 hasta completar el primer sector.
    return this._lapBaseDelta ?? 0;
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

          const delta = this._computeDelta({ lap, bestLap, currentLap, lapDeltaToBest });
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
