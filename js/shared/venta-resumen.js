// Resumen de una venta + descarga de la factura en PDF. Lo usan Ventas (se abre solo al
// registrar una venta) e Historial (botón "Factura"). Necesita jsPDF + autotable cargados
// en la página (window.jspdf).

import { sb } from './supabase-client.js';
import { money } from './format.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const SELECT_VENTA = `
  id, canal, estado, created_at, cliente_nombre, cliente_localidad,
  total_bruto, total_descuento_comision, total_neto,
  vendedores(nombre),
  ventas_items(id, cantidad, precio_unitario, comision_pct, subtotal, productos(nombre, unidad, marcas(nombre)))`;

export async function cargarVenta(ventaId){
  const { data, error } = await sb.from('ventas').select(SELECT_VENTA).eq('id', ventaId).single();
  if(error) throw error;
  data.ventas_items.sort((a, b) => a.id - b.id);
  return data;
}

// yyyy-mm-dd en hora local (la fecha de la base es UTC y de noche caería en el día siguiente)
function fechaISO(iso){
  const d = new Date(iso);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

const soloAscii = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

// Nombre del archivo: venta-vendedor-fecha.pdf
export function nombreArchivoFactura(venta){
  const vendedor = soloAscii(venta.vendedores ? venta.vendedores.nombre : '') || 'sin-vendedor';
  return `venta-${vendedor}-${fechaISO(venta.created_at)}.pdf`;
}

const nombreProducto = it => {
  const p = it.productos;
  if(!p) return '';
  return `${p.marcas ? p.marcas.nombre + ' - ' : ''}${p.nombre}${p.unidad ? ' (' + p.unidad + ')' : ''}`;
};

function cargarLogo(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      // El logo original es pesado: se achica a 160px de ancho para no inflar el PDF.
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

export async function descargarFacturaVenta(venta){
  if(!window.jspdf) throw new Error('No se pudo cargar el generador de PDF. Revisá tu conexión y recargá la página.');
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  try {
    const logo = await cargarLogo(new URL('../../img/logo.png', import.meta.url).href);
    doc.addImage(logo, 'PNG', 14, 10, 20, 20);
  } catch(e){ /* sin logo seguimos igual */ }

  const vendedor = venta.vendedores ? venta.vendedores.nombre : '-';
  doc.setTextColor(0, 0, 0);
  doc.setFont(undefined, 'bold');
  doc.setFontSize(16);
  doc.text('Factura de venta - DIARNEC', 105, 18, { align: 'center' });
  doc.setFont(undefined, 'normal');
  doc.setFontSize(11);
  doc.text(`Venta #${venta.id}`, 105, 26, { align: 'center' });
  doc.setFontSize(9);
  doc.setTextColor(90, 90, 90);
  doc.text(new Date(venta.created_at).toLocaleString('es-AR'), 105, 32, { align: 'center' });
  if(venta.estado === 'anulada'){
    doc.setTextColor(192, 57, 43);
    doc.setFont(undefined, 'bold');
    doc.text('VENTA ANULADA', 105, 37, { align: 'center' });
    doc.setFont(undefined, 'normal');
  }
  doc.setTextColor(0, 0, 0);

  doc.setFontSize(10);
  doc.text(`Vendedor: ${vendedor}`, 14, 46);
  const cliente = venta.cliente_nombre || 'Sin cliente asignado';
  doc.text(`Cliente: ${cliente}${venta.cliente_localidad ? ' (' + venta.cliente_localidad + ')' : ''}`, 14, 52);

  doc.autoTable({
    startY: 60,
    head: [['Producto', 'Cant.', 'Precio', 'Subtotal']],
    body: venta.ventas_items.map(it => [nombreProducto(it), Number(it.cantidad), money(it.precio_unitario), money(it.subtotal)]),
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [18, 36, 54], textColor: 255 },
    columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' } }
  });

  let y = doc.lastAutoTable.finalY + 10;
  const comision = Number(venta.total_descuento_comision);
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text(`Total: ${money(venta.total_bruto)}`, 196, y, { align: 'right' });
  if(comision > 0){
    y += 7;
    doc.setFont(undefined, 'normal');
    doc.text(`Comisión del vendedor: -${money(comision)}`, 196, y, { align: 'right' });
    y += 8;
    doc.setFont(undefined, 'bold');
    doc.setFontSize(12);
    doc.text(`Neto para la distribuidora: ${money(venta.total_neto)}`, 196, y, { align: 'right' });
  }

  doc.save(nombreArchivoFactura(venta));
}

// ===== Modal de resumen =====

let overlay = null;

function cerrar(){
  if(overlay){ overlay.remove(); overlay = null; }
  document.removeEventListener('keydown', onKey);
}
function onKey(e){ if(e.key === 'Escape') cerrar(); }

export async function abrirResumenVenta(ventaId){
  cerrar();
  overlay = document.createElement('div');
  overlay.className = 'vr-overlay';
  overlay.innerHTML = `<div class="vr-box"><p class="vr-loading">Cargando resumen…</p></div>`;
  document.body.appendChild(overlay);
  overlay.addEventListener('click', e => { if(e.target === overlay) cerrar(); });
  document.addEventListener('keydown', onKey);

  let venta;
  try { venta = await cargarVenta(ventaId); }
  catch(e){
    overlay.querySelector('.vr-box').innerHTML = `
      <p class="vr-err">No se pudo cargar la venta #${ventaId}: ${esc(e.message)}</p>
      <div class="vr-actions"><button class="vr-close">Cerrar</button></div>`;
    overlay.querySelector('.vr-close').addEventListener('click', cerrar);
    return;
  }

  const comision = Number(venta.total_descuento_comision);
  const estadoTxt = { confirmada: '', pendiente: ' · Pendiente', anulada: ' · ANULADA' }[venta.estado] || '';
  overlay.querySelector('.vr-box').innerHTML = `
    <h3>Resumen de la venta #${venta.id}${estadoTxt}</h3>
    <div class="vr-meta">
      <div><span>Vendedor</span><b>${esc(venta.vendedores ? venta.vendedores.nombre : '-')}</b></div>
      <div><span>Cliente</span><b>${esc(venta.cliente_nombre || 'Sin cliente asignado')}</b></div>
      <div><span>Fecha</span><b>${new Date(venta.created_at).toLocaleString('es-AR')}</b></div>
    </div>
    <table class="vr-table">
      <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr></thead>
      <tbody>
        ${venta.ventas_items.map(it => `
          <tr>
            <td>${esc(nombreProducto(it))}</td>
            <td class="r">${Number(it.cantidad)}</td>
            <td class="r">${money(it.precio_unitario)}</td>
            <td class="r">${money(it.subtotal)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="vr-totals">
      <div class="vr-total">Total: <b>${money(venta.total_bruto)}</b></div>
      ${comision > 0 ? `<div class="vr-sub">Comisión del vendedor: -${money(comision)}</div>
      <div class="vr-neto">Neto para la distribuidora: <b>${money(venta.total_neto)}</b></div>` : ''}
    </div>
    <div class="vr-err" id="vr-err"></div>
    <div class="vr-actions">
      <button class="vr-close">Cerrar</button>
      <button class="vr-download" id="vr-download">⬇ Descargar factura</button>
    </div>`;

  overlay.querySelector('.vr-close').addEventListener('click', cerrar);
  overlay.querySelector('#vr-download').addEventListener('click', async e => {
    const btn = e.currentTarget;
    const err = overlay.querySelector('#vr-err');
    err.textContent = '';
    btn.disabled = true;
    try { await descargarFacturaVenta(venta); }
    catch(ex){ err.textContent = 'No se pudo generar la factura: ' + ex.message; }
    btn.disabled = false;
  });
}
