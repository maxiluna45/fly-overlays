const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const OVERLAY_DEFAULT_SETTINGS = {
  delta: {
    barHeight: 12,         // alto de la barra horizontal (en pixels)
    barWidthPercent: 92,    // % del ancho del overlay que ocupa la barra
    valueFontSize: 28,      // tamaño del número debajo de la barra
    valueMinWidth: 110,     // ancho mínimo del contenedor del número
    valuePaddingX: 16,      // padding horizontal del número
    valuePaddingY: 6,       // padding vertical del número
    gap: 12,                // espacio entre la barra y el número
    showNumber: true,       // mostrar/ocultar el número
    showBar: true,          // mostrar/ocultar la barra
    showTrend: true,        // indicador de tendencia ▲/▼
    showPrediction: true,   // tiempo de vuelta proyectado
    range: 5,               // rango de la barra en segundos (±)
    deltaReference: "sessionBest", // sessionBest | fieldBest | lastLap | personalBest | optimal
    cycleButton: null,      // botón de volante/joystick para ciclar: { pad, btn }
    // OPT-IN: leer el volante vía Gamepad API de Chromium. APAGADO por defecto
    // porque en algunos volantes DirectInput (G29/G27) el fetcher de gamepad de
    // Chromium pisa la adquisición del volante de iRacing y CORTA el force
    // feedback. Con esto en false, getGamepads() no se llama nunca. Alternativa
    // sin riesgo: mapear el botón a una tecla en G HUB y usar el atajo de teclado.
    wheelInputEnabled: false,
  },
  sectors: {
    headerFontSize: 10,     // tamaño de "CURRENT" / "BEST" / etc.
    valueFontSize: 15,      // tamaño de los tiempos (1:30.234)
    timeColumnWidth: 64,     // ancho de la columna de label
    subBarHeight: 28,       // alto de cada sub-barra de micro-sector
    showHeader: true,        // mostrar/ocultar el header de tiempos
    showSubBars: true,       // mostrar/ocultar los cuadritos de sub-sectores
    showSectorDelta: true,   // delta numérico por sector
  },
  relative: {
    showIRating: true,       // mostrar iRating al final de la fila
    showLicense: true,       // mostrar el badge de licencia (LicLevel)
    showCarNumber: true,     // mostrar número del auto
    showFlag: true,          // mostrar bandera del país del club
    playerCountry: "ar",     // ISO2 de tu bandera (tu fila; el club no distingue país)
    showLaps: true,          // mostrar la caja de last lap
    nameFormat: "full",      // full | short | initials
    rowsAbove: 3,            // competidores arriba del player
    rowsBelow: 3,            // competidores abajo del player
    borderRadius: 8,         // radio del contenedor
    rowHeight: 26,           // alto de cada fila
    fontSize: 11,            // tamaño de fuente base
  },
  radar: {
    range: 60,               // alcance del radar en metros (adelante/atrás)
    showClassColors: true,   // colorear puntos por clase (multiclase)
    showDistance: true,      // mostrar la distancia (m) del más cercano
    fontSize: 12,            // tamaño de fuente
  },
  standings: {
    showLicense: true,       // badge de licencia
    showIRating: true,       // columna de iRating
    showCarNumber: true,     // número del auto
    showFlag: true,          // bandera del país del club
    playerCountry: "ar",     // ISO2 de tu bandera (tu fila; el club no distingue país)
    showBestLap: true,       // columna de best lap
    showLastLap: false,      // columna de last lap
    showPositionChange: true,// ▲/▼ posiciones ganadas vs qualy (solo carrera)
    nameFormat: "full",      // full | short | initials
    gapMode: "leader",       // 'leader' (gap al líder) | 'interval' (al de adelante)
    maxRows: 24,             // máximo de filas
    rowHeight: 24,           // alto de fila
    fontSize: 11,            // tamaño de fuente
    borderRadius: 8,         // radio del contenedor
  },
};

// Visibilidad por tipo de sesión. true = el overlay se muestra en ese grupo.
// race = Race · qualify = Lone/Open Qualify · practice = Practice/Warmup/Testing.
const SESSION_DEFAULTS = { race: true, qualify: true, practice: true };

const DEFAULTS = {
  overlays: {
    delta: {
      enabled: true,
      x: null,
      y: null,
      width: 600,
      height: 120,
      opacity: 0.8,
      sessions: { ...SESSION_DEFAULTS },
      settings: { ...OVERLAY_DEFAULT_SETTINGS.delta },
    },
    sectors: {
      enabled: false,
      x: null,
      y: null,
      width: 600,
      height: 160,
      opacity: 0.8,
      sessions: { ...SESSION_DEFAULTS },
      settings: { ...OVERLAY_DEFAULT_SETTINGS.sectors },
    },
    relative: {
      enabled: false,
      x: null,
      y: null,
      width: 420,
      height: 400,
      opacity: 0.9,
      sessions: { ...SESSION_DEFAULTS },
      settings: { ...OVERLAY_DEFAULT_SETTINGS.relative },
    },
    standings: {
      enabled: false,
      x: null,
      y: null,
      width: 460,
      height: 520,
      opacity: 0.9,
      sessions: { ...SESSION_DEFAULTS },
      settings: { ...OVERLAY_DEFAULT_SETTINGS.standings },
    },
    radar: {
      enabled: false,
      x: null,
      y: null,
      width: 240,
      height: 300,
      opacity: 0.85,
      sessions: { ...SESSION_DEFAULTS },
      settings: { ...OVERLAY_DEFAULT_SETTINGS.radar },
    },
  },
  // Atajos globales. Se administran desde el apartado Hotkeys del dashboard.
  hotkeys: {
    toggleLock: 'F7',     // mover overlays (edit mode)
    openPanel: 'F8',      // abrir/cerrar el panel
    forceShow: 'F6',      // forzar aparición de overlays (recovery)
    preview: 'F9',        // modo preview (datos sintéticos)
    // Cicla la referencia del DeltaBar (tu mejor de sesión → mejor de la
    // sesión → tu vuelta anterior). Mapeable a un botón del volante desde el
    // software del volante (tecla) o bindeando el botón en el dashboard.
    cycleDeltaRef: 'F10',
  },
  // Carpeta de telemetría .ibt de iRacing. null = usar la ruta por defecto
  // (Documentos/iRacing/telemetry). El usuario puede sobreescribirla.
  telemetryDir: null,
  // Títulos personalizados por sesión de análisis, keyed por id de sesión.
  sessionLabels: {},
  // Auth de iRacing Data API: { email, enc } (password cifrado con safeStorage).
  iracingAuth: null,
  // Etiquetas de pilotos (amigos/peligrosos/streamers). Cada una:
  // { id, name, label, color }. Se muestran en Relative/Standings junto al nombre.
  driverTags: [],
  // Grabación de sesiones en vivo por iFly. Si el usuario ya loguea telemetría
  // desde iRacing (.ibt), puede apagar esto para no generar duplicados.
  recordingEnabled: true,
  // Modo diagnóstico: sube el logging a nivel DEBUG y activa snapshots de salud
  // muestreados. Off por defecto (solo se prende para reproducir un bug).
  diagnosticMode: false,
};

class ConfigStore {
  constructor() {
    this.path = path.join(app.getPath('userData'), 'config.json');
    this.data = this._load();
    this._listeners = new Set();
  }

  _load() {
    try {
      if (fs.existsSync(this.path)) {
        const raw = fs.readFileSync(this.path, 'utf-8');
        const parsed = JSON.parse(raw);
        // Merge con defaults para agregar overlays nuevos automáticamente.
        // Por overlay es merge de primer nivel: así los configs guardados antes
        // de que existiera `sessions` reciben el default (todo visible).
        const overlays = {};
        const savedOverlays = parsed.overlays || {};
        for (const [id, def] of Object.entries(DEFAULTS.overlays)) {
          const saved = savedOverlays[id] || {};
          overlays[id] = {
            ...def,
            ...saved,
            sessions: { ...SESSION_DEFAULTS, ...(saved.sessions || {}) },
          };
        }
        // Conservar overlays guardados que ya no estén en DEFAULTS (por las dudas)
        for (const [id, saved] of Object.entries(savedOverlays)) {
          if (!overlays[id]) {
            overlays[id] = { ...saved, sessions: { ...SESSION_DEFAULTS, ...(saved.sessions || {}) } };
          }
        }
        return {
          overlays,
          hotkeys: { ...DEFAULTS.hotkeys, ...(parsed.hotkeys || {}) },
          telemetryDir: parsed.telemetryDir ?? DEFAULTS.telemetryDir,
          sessionLabels: parsed.sessionLabels || {},
          iracingAuth: parsed.iracingAuth || null,
          driverTags: Array.isArray(parsed.driverTags) ? parsed.driverTags : [],
          recordingEnabled: parsed.recordingEnabled !== false, // default: true
          diagnosticMode: parsed.diagnosticMode === true,
        };
      }
    } catch (err) {
      console.error('[config] error leyendo:', err.message);
    }
    return JSON.parse(JSON.stringify(DEFAULTS));
  }

  _save() {
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      fs.writeFileSync(this.path, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (err) {
      console.error('[config] error guardando:', err.message);
    }
  }

  get() {
    return this.data;
  }

  getOverlay(id) {
    return this.data.overlays[id] || null;
  }

  setOverlay(id, updates) {
    if (!this.data.overlays[id]) {
      this.data.overlays[id] = { ...DEFAULTS.overlays[id] || {}, ...updates };
    } else {
      this.data.overlays[id] = { ...this.data.overlays[id], ...updates };
    }
    this._save();
    this._emit();
  }

  toggleOverlay(id) {
    const ov = this.getOverlay(id);
    if (!ov) return null;
    this.setOverlay(id, { enabled: !ov.enabled });
    return this.data.overlays[id].enabled;
  }

  setHotkey(name, accelerator) {
    this.data.hotkeys = { ...this.data.hotkeys, [name]: accelerator };
    this._save();
    this._emit();
    return this.data.hotkeys;
  }

  setTelemetryDir(dir) {
    this.data.telemetryDir = dir || null;
    this._save();
    this._emit();
    return this.data.telemetryDir;
  }

  setIracingAuth(auth) {
    this.data.iracingAuth = auth || null;
    this._save();
    return this.data.iracingAuth;
  }

  getDriverTags() {
    return Array.isArray(this.data.driverTags) ? this.data.driverTags : [];
  }

  setDriverTags(tags) {
    this.data.driverTags = Array.isArray(tags) ? tags : [];
    this._save();
    this._emit();
    return this.data.driverTags;
  }

  isRecordingEnabled() {
    return this.data.recordingEnabled !== false;
  }

  setRecordingEnabled(v) {
    this.data.recordingEnabled = !!v;
    this._save();
    this._emit();
    return this.data.recordingEnabled;
  }

  getDiagnosticMode() {
    return this.data.diagnosticMode === true;
  }

  setDiagnosticMode(v) {
    this.data.diagnosticMode = !!v;
    this._save();
    this._emit();
    return this.data.diagnosticMode;
  }

  setSessionLabel(id, label) {
    if (!id) return this.data.sessionLabels;
    if (!this.data.sessionLabels) this.data.sessionLabels = {};
    const clean = (label || '').trim();
    if (clean) this.data.sessionLabels[id] = clean;
    else delete this.data.sessionLabels[id]; // vacío = volver al nombre por defecto
    this._save();
    return this.data.sessionLabels;
  }

  setBounds(id, bounds) {
    if (!this.data.overlays[id]) return;
    this.data.overlays[id] = { ...this.data.overlays[id], ...bounds };
    this._save();
    // No emitimos en cada move (spam) — el renderer no necesita saber
  }

  onChange(cb) {
    this._listeners.add(cb);
    return () => this._listeners.delete(cb);
  }

  _emit() {
    for (const cb of this._listeners) cb(this.data);
    // Notificar a todas las ventanas de renderer
    const { BrowserWindow } = require('electron');
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send('config:changed', this.data);
      }
    }
  }
}

module.exports = { ConfigStore };
