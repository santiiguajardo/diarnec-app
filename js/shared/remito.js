// Remito de venta para el cliente final: PDF con precios finales (sin comisión del vendedor) y envío
// por WhatsApp. Necesita jsPDF + autotable cargados en la página (window.jspdf).
//
// r = { id, fecha, vendedor, cliente, localidad, telefono, total, items:[{marca, producto, unidad, cantidad, precio, subtotal}] }
// (es lo que devuelve la función mi_remito de la base)

import { money } from './format.js';

const soloAscii = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

function fechaISO(iso){
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// remito-cliente-fecha.pdf
export const nombreArchivoRemito = r => `remito-${soloAscii(r.cliente) || 'cliente'}-${fechaISO(r.fecha)}.pdf`;

// Número de WhatsApp en formato internacional argentino (549 + área + número, sin 0 ni 15).
// Devuelve '' si no hay teléfono.
export function normalizarTelefono(tel){
  let d = String(tel ?? '').replace(/\D/g, '');
  if(!d) return '';
  if(d.startsWith('54')) return d.startsWith('549') ? d : '549' + d.slice(2);
  d = d.replace(/^0+/, '');
  d = d.replace(/^(\d{2,4})15(\d{6,8})$/, '$1$2');
  return '549' + d;
}

export function mensajeRemito(r){
  const items = r.items.map(i => `• ${Number(i.cantidad)} x ${i.producto}${i.unidad ? ' (' + i.unidad + ')' : ''}`).join('\n');
  return `Hola ${r.cliente || ''}! Te paso el remito N° ${r.id} de tu compra del ${new Date(r.fecha).toLocaleDateString('es-AR')}.\n\n` +
    `${items}\n\nTotal: ${money(r.total)}\n\n¡Gracias! — ${r.vendedor} · DIARNEC`;
}

function cargarLogo(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const escala = Math.min(1, 160 / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * escala); canvas.height = Math.round(img.height * escala);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

export async function armarRemitoPDF(r){
  if(!window.jspdf) throw new Error('No se pudo cargar el generador de PDF. Revisá tu conexión y recargá la página.');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  try {
    const logo = await cargarLogo(new URL('../../img/logo.png', import.meta.url).href);
    doc.addImage(logo, 'PNG', 14, 10, 20, 20);
  } catch(e){ /* sin logo seguimos igual */ }

  doc.setTextColor(0, 0, 0);
  doc.setFont(undefined, 'bold');
  doc.setFontSize(18);
  doc.text('REMITO', 105, 18, { align: 'center' });
  doc.setFont(undefined, 'normal');
  doc.setFontSize(11);
  doc.text(`N° ${r.id}`, 105, 25, { align: 'center' });
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text(new Date(r.fecha).toLocaleString('es-AR'), 105, 31, { align: 'center' });
  doc.setTextColor(0, 0, 0);

  doc.setFontSize(10);
  doc.text(`Cliente: ${r.cliente || '-'}${r.localidad ? ' (' + r.localidad + ')' : ''}`, 14, 44);
  doc.text(`Vendedor: ${r.vendedor || '-'}`, 14, 50);

  doc.autoTable({
    startY: 58,
    head: [['Producto', 'Cant.', 'Precio', 'Subtotal']],
    body: r.items.map(i => [
      `${i.marca ? i.marca + ' - ' : ''}${i.producto}${i.unidad ? ' (' + i.unidad + ')' : ''}`,
      Number(i.cantidad), money(i.precio), money(i.subtotal)
    ]),
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [18, 36, 54], textColor: 255 },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } }
  });

  const y = doc.lastAutoTable.finalY + 10;
  doc.setFont(undefined, 'bold');
  doc.setFontSize(13);
  doc.text(`Total: ${money(r.total)}`, 196, y, { align: 'right' });
  doc.setFont(undefined, 'normal');
  doc.setFontSize(9);
  doc.setTextColor(110, 110, 110);
  doc.text('Gracias por tu compra.', 105, y + 16, { align: 'center' });

  return { doc, filename: nombreArchivoRemito(r) };
}

export async function descargarRemito(r){
  const { doc, filename } = await armarRemitoPDF(r);
  doc.save(filename);
}

// Celular: abre el menú de compartir con el PDF adjunto (se elige WhatsApp y el contacto).
// Computadora: descarga el PDF y abre el chat de WhatsApp del cliente con el mensaje listo, para adjuntarlo.
// Devuelve 'compartido' o 'descargado'.
export async function compartirRemitoWhatsApp(r){
  const { doc, filename } = await armarRemitoPDF(r);
  const texto = mensajeRemito(r);
  const file = new File([doc.output('blob')], filename, { type: 'application/pdf' });

  if(navigator.canShare && navigator.canShare({ files: [file] })){
    try {
      await navigator.share({ files: [file], title: `Remito ${r.id}`, text: texto });
      return 'compartido';
    } catch(e){
      if(e && e.name === 'AbortError') return 'compartido'; // canceló el menú: no es un error
      // otro fallo: seguimos con la descarga
    }
  }
  doc.save(filename);
  const tel = normalizarTelefono(r.telefono);
  window.open(`https://wa.me/${tel}?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
  return 'descargado';
}
