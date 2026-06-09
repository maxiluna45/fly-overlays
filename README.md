# Fly Overlays

Overlays propios para iRacing. Hecho con Electron + React + Vite + Tailwind v4 + shadcn/ui.

## Stack
- **Electron** — ventanas transparentes, always-on-top, click-through
- **React 18 + Vite** — UI (dashboard + overlays)
- **Tailwind v4 + shadcn/ui** — sistema de diseño dark mode
- **irsdk-node** — cliente del SDK oficial de iRacing
- **electron-builder** — empaquetado portable
- **electron-updater** — auto-update desde GitHub Releases

## Estructura
```
src/
├── main/                # Electron main process (Node)
│   ├── main.js          # entry: ventanas, IPC, hotkeys, auto-update
│   ├── preload.js       # bridge seguro entre main y renderer
│   ├── irsdk-client.js  # wrapper sobre irsdk-node
│   ├── config-store.js  # JSON persistence en userData
│   └── overlay-manager.js # crea/elimina ventanas por id
└── renderer/            # React UI
    ├── dashboard.html/jsx  # ventana principal (config)
    ├── delta.html/jsx      # overlay "delta bar"
    ├── components/         # Dashboard, DeltaBar, ui/* (shadcn)
    ├── lib/utils.js        # cn() helper
    └── styles/global.css
```

## Desarrollo
```bash
npm install
npm run dev          # vite + electron con HMR
```

## Build (genera el .exe portable)
```bash
npm run dist
```

El archivo se genera en `release/FlyOverlays-X.X.X-portable.exe`. Es un único `.exe` autocontenido (~180MB) que el usuario solo necesita descargar y ejecutar con doble click.

## Auto-update
Las actualizaciones se descargan automáticamente desde GitHub Releases. El usuario ve una notificación y al cerrar la app se instala la nueva versión.

Para publicar una actualización:
1. Bump la versión en `package.json`
2. `npm run dist` (genera el .exe)
3. Crear un Release en GitHub con el tag `vX.X.X` y subir el `.exe` como asset

## Config persistida
`%APPDATA%\fly-overlays\config.json`
- Posición, tamaño, opacidad y estado enabled de cada overlay
- Hotkeys
- Cualquier propiedad custom

## Atajos
- **F7** — Lock/unlock de overlays (modo edición, permite arrastrar/redimensionar)
- **F8** — Toggle del dashboard
- **F9** — Toggle preview mode (datos sintéticos sin iRacing)

## Agregar un overlay nuevo
1. Crear `src/renderer/<nombre>.html` + `<nombre>.jsx` + componente
2. Agregar entry al `REGISTRY` en `src/main/overlay-manager.js`
3. Agregar default al `DEFAULTS.overlays` en `src/main/config-store.js`
4. Agregar meta al `OVERLAY_META` en `src/renderer/overlay-catalog.js`
5. Agregar a la lista `IMPLEMENTED` en `src/renderer/components/Dashboard.jsx`
