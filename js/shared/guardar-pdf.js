// Guardar un PDF armado con jsPDF.
//  · Computadora: se descarga directo.
//  · Celular: el navegador suele abrir el PDF en su visor (sin opción de descargar). Por eso se muestra un cuadro
//    "PDF listo" con botones propios: Descargar (baja el archivo), Compartir (menú del celular: WhatsApp, Drive,
//    "Guardar en Archivos"...) y Abrir (verlo).

const esCelular = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)
  || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)); // iPad que se hace pasar por Mac

// Navegadores que se abren DENTRO de otra app (WhatsApp, Instagram, Facebook, Gmail...) suelen bloquear las descargas
const enOtraApp = () => /FBAN|FBAV|Instagram|WhatsApp|Line\/|Snapchat|Twitter|GSA\/|; wv\)|Messenger/i.test(navigator.userAgent);

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function guardarPDF(doc, nombre){
  if(!esCelular()){ doc.save(nombre); return; }

  const blob = doc.output('blob');
  const url = URL.createObjectURL(blob);
  const file = new File([blob], nombre, { type: 'application/pdf' });
  const puedeCompartir = !!(navigator.canShare && navigator.canShare({ files: [file] }));

  const overlay = document.createElement('div');
  overlay.className = 'app-confirm-overlay';
  overlay.innerHTML = `
    <div class="app-confirm-box pdf-listo">
      <p style="margin-bottom:4px;"><b>📄 Tu PDF está listo</b></p>
      <p class="pdf-nombre">${esc(nombre)}</p>
      <div class="pdf-botones">
        <a class="pdf-btn pdf-descargar" href="${url}" download="${esc(nombre)}">⬇ Descargar</a>
        ${puedeCompartir ? '<button type="button" class="pdf-btn pdf-compartir">📤 Compartir / Guardar en…</button>' : ''}
        <a class="pdf-btn pdf-abrir" href="${url}" target="_blank" rel="noopener">👁 Abrir para verlo</a>
        <button type="button" class="pdf-btn pdf-cerrar">Cerrar</button>
      </div>
      ${enOtraApp() ? '<p class="pdf-aviso">⚠️ Estás viendo la página dentro de otra aplicación y ahí no siempre se puede descargar. Si no se baja, abrí esta página en <b>Chrome</b> o <b>Safari</b> (menú ⋮ → "Abrir en el navegador").</p>' : ''}
    </div>`;
  document.body.appendChild(overlay);

  const cerrar = () => { overlay.remove(); setTimeout(() => URL.revokeObjectURL(url), 60000); };
  overlay.querySelector('.pdf-cerrar').addEventListener('click', cerrar);
  overlay.addEventListener('click', e => { if(e.target === overlay) cerrar(); });
  // Después de tocar Descargar se deja el cuadro un momento y se cierra solo
  overlay.querySelector('.pdf-descargar').addEventListener('click', () => setTimeout(cerrar, 1500));
  const bc = overlay.querySelector('.pdf-compartir');
  if(bc) bc.addEventListener('click', async () => {
    try { await navigator.share({ files: [file], title: nombre }); cerrar(); }
    catch(e){ /* canceló el menú: el cuadro queda para elegir otra opción */ }
  });
}
