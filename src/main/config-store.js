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
  },
  sectors: {
    headerFontSize: 10,     // tamaño de "CURRENT" / "BEST" / etc.
    valueFontSize: 15,      // tamaño de los tiempos (1:30.234)
    timeColumnWidth: 64,     // ancho de la columna de label
    subBarHeight: 28,       // alto de cada sub-barra de micro-sector
    showHeader: true,        // mostrar/ocultar el header de tiempos
    showSubBars: true,       // mostrar/ocultar los cuadritos de sub-sectores
  },
  tyres: {
    showTemp: true,          // alias de showNumbers (compat)
    showNumbers: true,       // mostrar números de temperatura
    showPressure: true,      // mostrar presión
    showWear: true,          // mostrar indicador de desgaste
    compactMode: false,      // modo compacto: solo colores, sin números
    cellSize: 130,           // tamaño máximo de cada celda de neumático
    cellMaxWidth: 160,       // ancho máximo de cada celda (deja blanco alrededor si sobra)
    gap: 10,                 // espacio entre celdas
    borderRadius: 14,        // radio de las celdas
    tempFontSize: 15,        // tamaño de números de temperatura (en px)
    pressFontSize: 10,       // tamaño del número de presión (en px)
    wearFontSize: 9,         // tamaño del % de desgaste (en px)
    headerFontSize: 10,      // tamaño del header global (AVG/MIN/MAX)
    bandWidth: 14,           // ancho de las bandas laterales (I/O) en px
    primaryBandWidth: 18,    // ancho de la banda central (C) en px
    bandGap: 2,              // separación entre bandas (en px)
    pressureUnit: "kPa",     // "kPa" o "psi"
  },
};

const DEFAULTS = {
  overlays: {
    delta: {
      enabled: true,
      x: null,
      y: null,
      width: 600,
      height: 120,
      opacity: 0.8,
      settings: { ...OVERLAY_DEFAULT_SETTINGS.delta },
    },
    sectors: {
      enabled: false,
      x: null,
      y: null,
      width: 600,
      height: 160,
      opacity: 0.8,
      settings: { ...OVERLAY_DEFAULT_SETTINGS.sectors },
    },
    tyres: {
      enabled: false,
      x: null,
      y: null,
      width: 600,
      height: 320,
      opacity: 0.85,
      settings: { ...OVERLAY_DEFAULT_SETTINGS.tyres },
    },
  },
  hotkeys: {
    toggleLock: 'F7',
    openPanel: 'F8',
  },
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
        // Merge con defaults para agregar overlays nuevos automáticamente
        return {
          overlays: { ...DEFAULTS.overlays, ...(parsed.overlays || {}) },
          hotkeys: { ...DEFAULTS.hotkeys, ...(parsed.hotkeys || {}) },
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
