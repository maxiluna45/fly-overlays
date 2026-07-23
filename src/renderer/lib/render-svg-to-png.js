// Serializa un <svg> del DOM y lo rasteriza a PNG del tamaño (w×h) exacto.
// IMPORTANTE: cualquier <image> dentro del SVG (tiles satelitales) debe estar
// embebido como data URL antes de llamar acá, o el canvas se "contamina"
// (CORS) y toBlob() falla.
export function svgToPngBlob(svgEl, w, h) {
  return new Promise((resolve, reject) => {
    try {
      const xml = new XMLSerializer().serializeToString(svgEl);
      const svg64 = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob devolvió null (¿canvas contaminado?)'))), 'image/png');
      };
      img.onerror = () => reject(new Error('no se pudo cargar el SVG como imagen'));
      img.src = svg64;
    } catch (err) { reject(err); }
  });
}

export function blobToArrayBuffer(blob) {
  return blob.arrayBuffer();
}
