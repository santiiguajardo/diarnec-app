import { sb } from '../shared/supabase-client.js';
import { requireAuth, getPerfil } from '../shared/auth-guard.js';
import { mountLayout, refrescarAvisoPedidos } from '../shared/layout.js';
import { money, dateTime } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';
import { createProductPicker } from '../shared/product-picker.js';
import { ajustarInputCantidad, cantidadEsValida, mensajeCantidad } from '../shared/cantidad.js';

const STORE_URL = 'https://santiiguajardo.github.io/diarnec-app/';
const ESTADO_LABEL = { pendiente: 'Pendiente', confirmada: 'Venta confirmada', anulada: 'Cancelado' };
const ESTADOS = [
  { key: 'pendiente', label: 'Pendiente' },
  { key: 'confirmada', label: 'Pasar a venta' },
  { key: 'anulada', label: 'Cancelado' }
];

let pedidos = [];
let productos = [];
let editarPedidoId = null;
let vendedoresMap = {};
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const TIPO_LABEL = { comercio: 'Comercio', particular: 'Particular' };

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('tienda', 'Tienda online');

  content.innerHTML = `
    <div class="tienda-banner">
      <div>
        <h2>Tienda pública</h2>
        <p>Publicada gratis en GitHub Pages, conectada al mismo inventario y stock.</p>
      </div>
      <a href="${STORE_URL}" target="_blank" rel="noopener">↗ Abrir tienda online</a>
    </div>

    <div class="admin-section" id="config-section" style="display:none;">
      <h3>Precios de la tienda</h3>
      <p style="color:var(--muted);font-size:13px;margin-bottom:12px;">
        El precio de <b>comercio</b> es el precio de venta de cada producto. Al <b>particular</b> se le suma un porcentaje y se le pide una compra mínima
        (para que valga la pena el envío). El cambio se aplica al instante en la tienda.
      </p>
      <div class="cfg-row">
        <label>Recargo particulares (%) <input type="number" id="cfg-recargo" min="0" max="500" step="0.5"></label>
        <label>Compra mínima particulares ($) <input type="number" id="cfg-minimo" min="0" step="1000"></label>
        <button class="btn-sm btn-add" id="cfg-guardar">Guardar</button>
        <span id="cfg-msg" class="cfg-msg"></span>
      </div>
    </div>

    <div class="admin-section">
      <h3>Pedidos online</h3>
      <div class="pedidos-list" id="pedidos-list"></div>
    </div>
  `;

  document.getElementById('pedidos-list').addEventListener('click', onClickPedidos);
  document.getElementById('editar-cancelar').addEventListener('click', () => toggleModal('modal-editar', false));
  document.getElementById('editar-guardar').addEventListener('click', guardarEdicion);
  document.getElementById('editar-add').addEventListener('click', () => agregarFilaItem());

  const perfil = await getPerfil();
  if(perfil && perfil.rol === 'admin') await iniciarConfig();

  const { data: vend } = await sb.from('vendedores').select('id, nombre');
  vendedoresMap = Object.fromEntries((vend || []).map(v => [v.id, v.nombre]));

  const { data: prod } = await sb.from('productos').select('id, nombre, unidad, precio_venta, marcas(nombre, color), categorias(por_peso)').eq('activo', true).order('nombre');
  productos = prod || [];

  await cargarPedidos();
})();

function toggleModal(id, open){
  document.getElementById(id).classList.toggle('open', open);
}

async function cargarPedidos(){
  const { data, error } = await sb.from('ventas')
    .select('id, fecha, created_at, cliente_nombre, cliente_localidad, cliente_tipo, cliente_cuit, cliente_direccion, vendedor_preferido_id, total_neto, estado, ventas_items(producto_id, cantidad, precio_unitario, subtotal, productos(nombre))')
    .eq('canal', 'online')
    .order('created_at', { ascending: false })
    .limit(100);

  const list = document.getElementById('pedidos-list');
  if(error){
    list.innerHTML = `<div class="empty-row">No se pudieron cargar los pedidos: ${error.message}</div>`;
    return;
  }
  pedidos = data || [];
  refrescarAvisoPedidos();
  if(pedidos.length === 0){
    list.innerHTML = `<div class="empty-row">Todavía no hay pedidos desde la tienda online.</div>`;
    return;
  }

  list.innerHTML = pedidos.map(p => `
    <details class="pedido">
      <summary>
        <span class="num">#${p.id}</span>
        <span class="cliente">${esc(p.cliente_nombre || 'Sin nombre')}${dondeEntregar(p) ? ' — ' + esc(dondeEntregar(p)) : ''}${p.cliente_tipo ? ` <span class="tipo-tag tipo-${p.cliente_tipo}">${TIPO_LABEL[p.cliente_tipo]}</span>` : ''}</span>
        <span class="fecha">${dateTime(p.created_at)}</span>
        <span class="total">${money(p.total_neto)}</span>
        <span class="badge ${p.estado}">${ESTADO_LABEL[p.estado] || p.estado}</span>
      </summary>
      <div class="pedido-items">
        <div class="pedido-datos">
          <div><b>Tipo:</b> ${p.cliente_tipo ? TIPO_LABEL[p.cliente_tipo] : '—'}</div>
          ${p.cliente_cuit ? `<div><b>CUIT/CUIL:</b> ${esc(p.cliente_cuit)}</div>` : ''}
          <div><b>Dirección:</b> ${esc(dondeEntregar(p) || '—')}</div>
          <div><b>Vendedor elegido por el cliente:</b> ${p.vendedor_preferido_id && vendedoresMap[p.vendedor_preferido_id] ? esc(vendedoresMap[p.vendedor_preferido_id]) : 'Ninguno (pedido a DIARNEC)'}</div>
        </div>
        <table>
          <thead><tr><th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th></tr></thead>
          <tbody>
            ${(p.ventas_items || []).map(it => `
              <tr>
                <td>${esc(it.productos ? it.productos.nombre : '')}</td>
                <td>${Number(it.cantidad)}</td>
                <td>${money(it.precio_unitario)}</td>
                <td>${money(it.subtotal)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
        <div class="pedido-acciones">
          <div class="estado-seg" role="group" aria-label="Estado del pedido">
            ${ESTADOS.map(s => `
              <button class="seg seg-${s.key} ${p.estado === s.key ? 'active' : ''}" data-accion="estado" data-estado="${s.key}" data-id="${p.id}">${s.label}</button>`).join('')}
          </div>
          <span class="acciones-sep"></span>
          <button class="btn-sm btn-blue" data-accion="comprobante" data-id="${p.id}">🧾 Comprobante</button>
          <button class="btn-sm btn-grey" data-accion="editar" data-id="${p.id}" ${p.estado === 'pendiente' ? '' : 'disabled title="Pasalo a Pendiente para poder modificarlo"'}>✎ Modificar</button>
          <button class="btn-sm btn-del" data-accion="borrar" data-id="${p.id}">🗑 Borrar</button>
        </div>
      </div>
    </details>`).join('');
}

// Los pedidos viejos guardaban la localidad; los nuevos, la dirección de entrega.
function dondeEntregar(p){ return p.cliente_direccion || p.cliente_localidad || ''; }

async function iniciarConfig(){
  const sec = document.getElementById('config-section');
  const { data } = await sb.from('tienda_config').select('recargo_particular_pct, minimo_particular').maybeSingle();
  if(!data) return;
  sec.style.display = '';
  document.getElementById('cfg-recargo').value = Number(data.recargo_particular_pct);
  document.getElementById('cfg-minimo').value = Number(data.minimo_particular);
  document.getElementById('cfg-guardar').addEventListener('click', async () => {
    const msg = document.getElementById('cfg-msg');
    const recargo = parseFloat(document.getElementById('cfg-recargo').value);
    const minimo = parseFloat(document.getElementById('cfg-minimo').value);
    if(isNaN(recargo) || isNaN(minimo)){ msg.className = 'cfg-msg err'; msg.textContent = 'Completá los dos valores.'; return; }
    const { error } = await sb.rpc('guardar_config_tienda', { p_recargo: recargo, p_minimo: minimo });
    msg.className = 'cfg-msg ' + (error ? 'err' : 'ok');
    msg.textContent = error ? error.message : 'Guardado. Ya se aplica en la tienda.';
  });
}

async function onClickPedidos(e){
  const btn = e.target.closest('button[data-accion]');
  if(!btn) return;
  const id = Number(btn.dataset.id);
  const accion = btn.dataset.accion;

  if(accion === 'estado'){
    const nuevo = btn.dataset.estado;
    const p = pedidos.find(p => p.id === id);
    if(!p || p.estado === nuevo) return;

    // Pasar a venta se hace en el panel de Ventas, con los productos del pedido ya cargados
    // y el vendedor "Tienda Online" elegido; ahí se confirma (y recién ahí se descuenta el stock).
    if(nuevo === 'confirmada'){
      // El número de pedido viaja por sessionStorage: algunos servidores estáticos pierden el ?query al redirigir.
      try { sessionStorage.setItem('diarnec_pedido_a_venta', String(id)); } catch(e){ /* sin storage: queda el ?pedido= */ }
      location.href = `ventas.html?pedido=${id}`;
      return;
    }

    const avisos = {
      anulada: p.estado === 'confirmada'
        ? `¿Cancelar el pedido #${id}? Como ya era venta, se repone el stock.`
        : `¿Cancelar el pedido #${id}?`,
      pendiente: p.estado === 'confirmada'
        ? `¿Volver el pedido #${id} a Pendiente? Se repone el stock.`
        : `¿Volver el pedido #${id} a Pendiente?`
    };
    if(!(await confirmDialog(avisos[nuevo]))) return;

    const { error } = await sb.rpc('cambiar_estado_pedido_online', { p_venta_id: id, p_nuevo_estado: nuevo });
    if(error){ alert('No se pudo cambiar el estado: ' + error.message); return; }
    await cargarPedidos();
  } else if(accion === 'borrar'){
    borrarPedido(id);
  } else if(accion === 'editar'){
    abrirEditar(id);
  } else if(accion === 'comprobante'){
    generarComprobante(id);
  }
}

async function borrarPedido(id){
  const p = pedidos.find(p => p.id === id);
  if(!p) return;
  const aviso = p.estado === 'confirmada'
    ? `¿Borrar el pedido #${id}?
Como ya era venta, se repone el stock. Se elimina definitivamente.`
    : `¿Borrar el pedido #${id}?
Se elimina definitivamente.`;
  if(!(await confirmDialog(aviso, { confirmLabel: 'Borrar' }))) return;

  const { error } = await sb.rpc('borrar_pedido_online', { p_venta_id: id });
  if(error){ alert('No se pudo borrar: ' + error.message); return; }
  await cargarPedidos();
}

// ===== Editar pedido (solo mientras está pendiente) =====

function abrirEditar(id){
  const p = pedidos.find(p => p.id === id);
  if(!p) return;
  editarPedidoId = id;
  document.getElementById('editar-num').textContent = `#${id} — ${p.cliente_nombre || 'Sin nombre'}`;
  document.getElementById('editar-items').innerHTML = '';
  document.getElementById('editar-err').textContent = '';

  (p.ventas_items || []).forEach(it => {
    agregarFilaItem(it.producto_id, Number(it.cantidad), Number(it.precio_unitario));
  });
  if((p.ventas_items || []).length === 0) agregarFilaItem();

  recalcularTotal();
  toggleModal('modal-editar', true);
}

function agregarFilaItem(productoIdInicial, cantidadInicial, precioInicial){
  const tbody = document.getElementById('editar-items');
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="pp-cell"></td>
    <td><input type="number" step="1" min="1" class="item-cantidad" value="${cantidadInicial || 1}"></td>
    <td><input type="number" step="0.01" class="item-precio" value="${precioInicial != null ? precioInicial.toFixed(2) : ''}"></td>
    <td class="item-subtotal">$0,00</td>
    <td><button class="item-del" type="button">×</button></td>
  `;
  tbody.appendChild(tr);

  // Buscador de producto (se comporta como un <select>: .value y evento "change")
  const select = createProductPicker(productos);
  tr.querySelector('.pp-cell').appendChild(select);
  const cantInput = tr.querySelector('.item-cantidad');
  if(productoIdInicial){
    select.value = String(productoIdInicial);
    ajustarInputCantidad(cantInput, productos.find(p => String(p.id) === select.value));
  }
  const precioInput = tr.querySelector('.item-precio');

  const setPrecioDefault = () => {
    const prod = productos.find(p => String(p.id) === select.value);
    if(prod) precioInput.value = Number(prod.precio_venta).toFixed(2);
    ajustarInputCantidad(cantInput, prod); // enteros, salvo fiambres y quesos (por peso)
    recalcularFila(tr);
  };
  select.addEventListener('change', () => { setPrecioDefault(); tr.querySelector('.item-cantidad').select(); });
  tr.querySelector('.item-cantidad').addEventListener('input', () => recalcularFila(tr));
  precioInput.addEventListener('input', () => recalcularFila(tr));
  tr.querySelector('.item-del').addEventListener('click', () => { tr.remove(); recalcularTotal(); });

  recalcularFila(tr);
  // Fila nueva (sin producto): enfoco el buscador para empezar a escribir.
  if(!productoIdInicial) setTimeout(() => select.focusInput(), 60);
}

function recalcularFila(tr){
  const cant = parseFloat(tr.querySelector('.item-cantidad').value) || 0;
  const precio = parseFloat(tr.querySelector('.item-precio').value) || 0;
  tr.querySelector('.item-subtotal').textContent = money(cant * precio);
  recalcularTotal();
}

function recalcularTotal(){
  const filas = document.querySelectorAll('#editar-items tr');
  let total = 0;
  filas.forEach(tr => {
    const cant = parseFloat(tr.querySelector('.item-cantidad').value) || 0;
    const precio = parseFloat(tr.querySelector('.item-precio').value) || 0;
    total += cant * precio;
  });
  document.getElementById('editar-total').textContent = money(total);
}

// Lee las filas del modal. Si algo está mal, escribe el motivo en `err` y devuelve null.
function recolectarItems(err){
  const generico = 'Cargá al menos un producto con cantidad y precio válidos.';
  const filas = document.querySelectorAll('#editar-items tr');
  if(filas.length === 0){ err.textContent = generico; return null; }
  const items = [];
  for(const tr of filas){
    const producto_id = Number(tr.querySelector('.item-producto').value);
    const cantidad = parseFloat(tr.querySelector('.item-cantidad').value);
    const precio_unitario = parseFloat(tr.querySelector('.item-precio').value);
    if(!producto_id || !cantidad || cantidad <= 0 || isNaN(precio_unitario) || precio_unitario < 0){ err.textContent = generico; return null; }
    const prod = productos.find(p => p.id === producto_id);
    if(!cantidadEsValida(prod, cantidad)){ err.textContent = mensajeCantidad(prod); return null; }
    items.push({ producto_id, cantidad, precio_unitario });
  }
  return items;
}

async function guardarEdicion(){
  const err = document.getElementById('editar-err');
  err.textContent = '';
  const items = recolectarItems(err);
  if(!items) return;

  const { error } = await sb.rpc('editar_pedido_online', { p_venta_id: editarPedidoId, p_items: items });
  if(error){ err.textContent = error.message; return; }

  toggleModal('modal-editar', false);
  await cargarPedidos();
}

// ===== Comprobante en PDF =====

function loadImageAsDataURL(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function generarComprobante(id){
  const p = pedidos.find(p => p.id === id);
  if(!p) return;

  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  try {
    const logo = await loadImageAsDataURL('../img/logo.png');
    doc.addImage(logo, 'PNG', 14, 10, 20, 20);
  } catch(e){ /* si no carga el logo, seguimos sin él */ }

  doc.setTextColor(0,0,0);
  doc.setFont(undefined, 'bold');
  doc.setFontSize(16);
  doc.text('Comprobante de pedido - DIARNEC', 105, 18, { align: 'center' });
  doc.setFont(undefined, 'normal');
  doc.setFontSize(11);
  doc.text(`Pedido #${p.id}`, 105, 26, { align: 'center' });
  doc.setFontSize(9);
  doc.setTextColor(90,90,90);
  doc.text(`${ESTADO_LABEL[p.estado] || p.estado} — ${dateTime(p.created_at)}`, 105, 32, { align: 'center' });
  doc.setTextColor(0,0,0);

  doc.setFontSize(10);
  doc.text(`Cliente: ${p.cliente_nombre || 'Sin nombre'}${p.cliente_tipo ? ' (' + TIPO_LABEL[p.cliente_tipo] + ')' : ''}`, 14, 44);
  doc.text(`Dirección: ${dondeEntregar(p) || '-'}`, 14, 50);
  if(p.cliente_cuit) doc.text(`CUIT/CUIL: ${p.cliente_cuit}`, 120, 44);

  const body = (p.ventas_items || []).map(it => [
    it.productos ? it.productos.nombre : '',
    Number(it.cantidad),
    money(it.precio_unitario),
    money(it.subtotal)
  ]);

  doc.autoTable({
    startY: 58,
    head: [['Producto', 'Cant.', 'Precio', 'Subtotal']],
    body,
    styles: { fontSize: 9, cellPadding: 3 },
    headStyles: { fillColor: [18,36,54], textColor: 255 }
  });

  const finalY = doc.lastAutoTable.finalY + 10;
  doc.setFont(undefined, 'bold');
  doc.setFontSize(12);
  doc.text(`Total: ${money(p.total_neto)}`, 196, finalY, { align: 'right' });

  doc.save(`Comprobante_Pedido_${p.id}.pdf`);
}
