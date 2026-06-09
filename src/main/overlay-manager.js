const { BrowserWindow, screen } = require('electron');
const path = require('path');

const isDev = process.env.NODE_ENV === 'development';

const MIN_WIDTH = 320;
const MIN_HEIGHT = 80;

// Registry de overlays disponibles. Cada uno define su entry HTML y bounds default.
const REGISTRY = {
  delta: {
    name: 'Delta Bar',
    description: 'Diferencia vs best lap',
    entry: 'delta.html',
    minWidth: 320,
    minHeight: 80,
  },
  sectors: {
    name: 'Sector Times',
    description: 'Comparativa de sectores vs best',
    entry: 'sectors.html',
    minWidth: 320,
    minHeight: 140,
  },
};

class OverlayManager {
  constructor(configStore) {
    this.config = configStore;
    this.windows = new Map(); // id -> BrowserWindow
    this.unlockedState = new Map(); // id -> bool
  }

  createAll() {
    const data = this.config.get();
    for (const [id, ov] of Object.entries(data.overlays)) {
      if (ov.enabled) {
        this._create(id);
      }
    }
  }

  destroyAll() {
    for (const win of this.windows.values()) {
      if (!win.isDestroyed()) win.destroy();
    }
    this.windows.clear();
  }

  show(id) {
    if (this.windows.has(id)) {
      this.windows.get(id).show();
    } else {
      this._create(id);
    }
  }

  hide(id) {
    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) {
      win.hide();
    }
  }

  toggle(id) {
    const enabled = this.config.toggleOverlay(id);
    if (enabled) {
      this.show(id);
    } else {
      this.hide(id);
    }
    return enabled;
  }

  isUnlocked(id) {
    return !!this.unlockedState.get(id);
  }

  setUnlocked(id, value) {
    this.unlockedState.set(id, value);
    this._applyLockState(id);
  }

  toggleUnlocked(id) {
    const next = !this.isUnlocked(id);
    this.setUnlocked(id, next);
    return next;
  }

  // Aplica updates a un overlay: actualiza config + ventana correspondiente
  applyOverlayUpdate(id, updates) {
    const ov = this.config.getOverlay(id);
    if (!ov) return null;
    this.config.setOverlay(id, updates);

    const win = this.windows.get(id);
    if (win && !win.isDestroyed()) {
      if (typeof updates.opacity === "number") {
        win.setOpacity(updates.opacity);
      }
      if (typeof updates.x === "number" && typeof updates.y === "number") {
        win.setBounds({
          x: updates.x,
          y: updates.y,
          width: updates.width ?? win.getBounds().width,
          height: updates.height ?? win.getBounds().height,
        });
      }
    }
    return this.config.getOverlay(id);
  }

  getWindow(id) {
    return this.windows.get(id);
  }

  _create(id) {
    if (this.windows.has(id)) {
      const w = this.windows.get(id);
      if (!w.isDestroyed()) return w;
    }

    const meta = REGISTRY[id];
    if (!meta) {
      console.error(`[overlay] id desconocido: ${id}`);
      return null;
    }

    const ov = this.config.getOverlay(id);
    if (!ov) return null;

    const display = screen.getPrimaryDisplay();
    const { width: dw, height: dh } = display.workAreaSize;
    const x = ov.x ?? Math.floor((dw - ov.width) / 2);
    const y = ov.y ?? dh - ov.height - 60;

    const win = new BrowserWindow({
      width: ov.width,
      height: ov.height,
      x,
      y,
      transparent: true,
      frame: false,
      alwaysOnTop: true,
      resizable: true,
      minWidth: MIN_WIDTH,
      minHeight: MIN_HEIGHT,
      skipTaskbar: true,
      focusable: false,
      hasShadow: false,
      opacity: ov.opacity ?? 1,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        additionalArguments: [`--overlay-id=${id}`],
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    this._applyLockStateFor(id, win);

    if (isDev) {
      win.loadURL(`http://localhost:5173/${meta.entry}`);
    } else {
      win.loadFile(path.join(__dirname, `../../dist/${meta.entry}`));
    }

    // Persistir bounds en cada move/resize (debounced)
    let saveTimer = null;
    const saveBounds = () => {
      if (saveTimer) clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        if (win.isDestroyed()) return;
        const b = win.getBounds();
        this.config.setBounds(id, {
          x: b.x, y: b.y, width: b.width, height: b.height,
        });
      }, 300);
    };
    win.on('move', saveBounds);
    win.on('resize', saveBounds);
    win.on('closed', () => this.windows.delete(id));

    this.windows.set(id, win);
    return win;
  }

  _applyLockState(id) {
    const win = this.windows.get(id);
    if (!win || win.isDestroyed()) return;
    this._applyLockStateFor(id, win);
  }

  _applyLockStateFor(id, win) {
    if (!win || win.isDestroyed()) return;
    const unlocked = this.isUnlocked(id);
    if (unlocked) {
      win.setIgnoreMouseEvents(false);
      win.setResizable(true);
      win.focus();
    } else {
      win.setIgnoreMouseEvents(true, { forward: true });
      win.setResizable(false);
    }
    win.webContents.send('overlay:lock-state', { unlocked, overlayId: id });
  }
}

module.exports = { OverlayManager, REGISTRY };
