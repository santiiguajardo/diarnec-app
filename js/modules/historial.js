import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money, dateTime } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';
import { mountItemsEditor } from '../shared/items-editor.js';
import { abrirResumenVenta } from '../shared/venta-resumen.js';

let movimientos = [];
let filtroTipo = '';
let filtroTexto = '';
let edicion = null; // { tipo, refId, editor? } mientras el modal de edición está abierto

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const TIPO_LABEL = {
  venta: 'Venta',
  devolucion: 'Devolución',
  devolucion_stock: 'Devolución de stock',
  bonificacion: 'Bonificación',
  pago_vendedor: 'Pago de vendedor',
  pago_cliente: 'Pago de cliente',
  pago_proveedor: 'Pago a proveedor',
  gasto: 'Gasto',
  stock: 'Movimiento de stock'
};

const FILTROS = [
  { key: '', label: 'Todos', cls: 'btn-f-todos' },
  { key: 'venta', label: 'Ventas', cls: 'btn-f-venta' },
  { key: 'devolucion', label: 'Devoluciones', cls: 'btn-f-devolucion' },
  { key: 'devolucion_stock', label: 'Devol. de stock', cls: 'btn-f-devolucion_stock' },
  { key: 'bonificacion', label: 'Bonificaciones', cls: 'btn-f-bonificacion' },
  { key: 'pago_vendedor', label: 'Pagos de vendedores', cls: 'btn-f-pago_vendedor' },
  { key: 'pago_cliente', label: 'Pagos de clientes', cls: 'btn-f-pago_cliente' },
  { key: 'pago_proveedor', label: 'Pagos a proveedores', cls: 'btn-f-pago_proveedor' },
  { key: 'gasto', label: 'Gastos', cls: 'btn-f-gasto' },
  { key: 'stock', label: 'Stock', cls: 'btn-f-stock' },
];

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('historial', 'Historial');

  content.innerHTML = `
    <div class="admin-section">
      <div class="hist-toolbar">
        <div class="hist-filters" id="hist-filters">
          ${FILTROS.map(f => `<button class="${f.cls} ${f.key === '' ? 'active' : ''}" data-key="${f.key}">${f.label}</button>`).join('')}
        </div>
        <input type="text" class="hist-search" id="f-texto" placeholder="Buscar cliente, vendedor o proveedor...">
        <button class="btn-sm btn-blue" id="btn-csv">⬇ Exportar CSV</button>
      </div>
      <table>
        <thead><tr><th>Fecha</th><th>Tipo</th><th>Detalle</th><th>Usuario</th><th>Importe</th><th></th></tr></thead>
        <tbody id="hist-body"></tbody>
      </table>
      <p class="hist-note">Cada movimiento se puede modificar o anular desde su fila; lo anulado queda en el historial pero no cuenta en las cuentas corrientes ni en la caja. Los movimientos de stock se generan solos: para corregir el stock de un producto usá "Ajuste" en Inventario.</p>
    </div>
  `;

  document.getElementById('hist-filters').addEventListener('click', e => {
    const btn = e.target.closest('button[data-key]');
    if(!btn) return;
    filtroTipo = btn.dataset.key;
    document.querySelectorAll('#hist-filters button').forEach(b => b.classList.toggle('active', b === btn));
    render();
  });
  document.getElementById('f-texto').addEventListener('input', e => { filtroTexto = e.target.value.trim().toLowerCase(); render(); });
  document.getElementById('btn-csv').addEventListener('click', exportarCSV);

  document.getElementById('hist-body').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if(!btn) return;
    const id = Number(btn.dataset.id);
    if(btn.dataset.act === 'factura') abrirResumenVenta(id);
    else if(btn.dataset.act === 'anular') anular(btn.dataset.tipo, id);
    else if(btn.dataset.act === 'editar') abrirEdicion(btn.dataset.tipo, id);
  });

  document.getElementById('ed-cancel').addEventListener('click', cerrarEdicion);
  document.getElementById('ed-save').addEventListener('click', guardarEdicion);

  await cargarTodo();
})();

// uid -> nombre a mostrar. Los pedidos de la tienda online no los carga nadie logueado (created_by
// queda null): se distinguen del resto de los movimientos sin usuario (datos viejos, de antes de esta
// función) mostrando "Tienda online" en vez de "—".
async function usuariosMap(){
  const { data } = await sb.from('staff_usuarios').select('auth_user_id, username');
  return new Map((data || []).map(u => [u.auth_user_id, u.username]));
}
const nombreUsuario = (usuarios, raw, tipo) => {
  if(raw.created_by) return usuarios.get(raw.created_by) || 'usuario eliminado';
  return tipo === 'venta' && raw.canal === 'online' ? 'Tienda online' : '—';
};

async function cargarTodo(){
  const [{ data: ventas }, { data: devoluciones }, { data: pagosProv }, { data: gastos }, { data: pagosVend }, { data: pagosCli }, { data: bonis }, { data: stock }, usuarios] = await Promise.all([
    // Las ventas que un vendedor se registra solo (desde su cartera, canal 'vendedor') son su propia
    // cuenta con ese cliente: se ven en "Mis movimientos" de él, no acá.
    sb.from('ventas').select('id, fecha, created_at, canal, cliente_id, cliente_nombre, total_neto, estado, vendedor_id, created_by, vendedores(nombre)').neq('canal', 'vendedor').order('created_at', { ascending: false }).limit(200),
    sb.from('devoluciones_cab').select('id, venta_id, fecha, created_at, motivo, total, con_stock, anulado, vendedor_id, created_by, vendedores(nombre)').order('created_at', { ascending: false }).limit(200),
    sb.from('pagos_proveedores').select('id, fecha, created_at, proveedor_id, medio_pago, monto_bruto, comision_pct, monto_neto, descripcion, anulado, created_by, proveedores(nombre)').order('created_at', { ascending: false }).limit(200),
    sb.from('gastos').select('id, fecha, created_at, descripcion, monto, anulado, created_by').order('created_at', { ascending: false }).limit(200),
    sb.from('pagos_vendedores').select('id, fecha, created_at, vendedor_id, medio_pago, monto, descripcion, anulado, created_by, vendedores(nombre)').order('created_at', { ascending: false }).limit(200),
    sb.from('pagos_clientes').select('id, fecha, created_at, cliente_id, medio_pago, monto, descripcion, anulado, created_by, clientes(nombre)').order('created_at', { ascending: false }).limit(200),
    sb.from('bonificaciones').select('id, fecha, created_at, vendedor_id, monto, descripcion, anulado, created_by, vendedores(nombre)').order('created_at', { ascending: false }).limit(200),
    sb.from('movimientos_stock').select('id, fecha, created_at, tipo, cantidad, motivo, created_by, productos(nombre)').order('created_at', { ascending: false }).limit(200),
    usuariosMap()
  ]);

  const rows = [];
  // anulado: queda en la lista con la marca [ANULADO] y sin signo (no suma ni resta)
  const marca = a => a ? ' [ANULADO]' : '';
  (ventas||[]).forEach(v => rows.push({
    tipo: 'venta', refId: v.id, fecha: v.created_at, raw: v, anulado: v.estado === 'anulada',
    usuario: nombreUsuario(usuarios, v, 'venta'),
    cuenta: v.cliente_nombre || (v.vendedores ? v.vendedores.nombre : ''),
    detalle: `Venta #${v.id} (${v.canal === 'online' ? 'tienda online' : 'manual'}) — ${v.cliente_nombre || (v.vendedores ? v.vendedores.nombre : '')}${marca(v.estado === 'anulada')}${v.estado === 'pendiente' ? ' [PENDIENTE]' : ''}`,
    importe: Number(v.total_neto), signo: v.estado === 'confirmada' ? 1 : 0
  }));
  (devoluciones||[]).forEach(d => rows.push({
    tipo: d.con_stock ? 'devolucion_stock' : 'devolucion', refId: d.id, fecha: d.created_at, raw: d, anulado: d.anulado,
    usuario: nombreUsuario(usuarios, d, 'devolucion'),
    cuenta: d.vendedores ? d.vendedores.nombre : '',
    detalle: `${d.con_stock ? 'Devolución de stock' : 'Devolución'} #${d.id}${d.venta_id ? ' (de venta #' + d.venta_id + ')' : ''} — ${d.vendedores ? d.vendedores.nombre : ''}${d.motivo ? ' — ' + d.motivo : ''}${marca(d.anulado)}`,
    importe: Number(d.total), signo: d.anulado ? 0 : -1
  }));
  (pagosProv||[]).forEach(p => rows.push({
    tipo: 'pago_proveedor', refId: p.id, fecha: p.created_at, raw: p, anulado: p.anulado,
    usuario: nombreUsuario(usuarios, p, 'pago_proveedor'),
    cuenta: p.proveedores ? p.proveedores.nombre : '',
    detalle: `Pago a ${p.proveedores ? p.proveedores.nombre : 'proveedor'} (${p.medio_pago}${p.medio_pago === 'cheque' && Number(p.comision_pct) > 0 ? ', ganancia ' + Number(p.comision_pct) + '%' : ''})${p.descripcion ? ' — ' + p.descripcion : ''}${marca(p.anulado)}`,
    importe: Number(p.monto_neto), signo: p.anulado ? 0 : -1
  }));
  (gastos||[]).forEach(g => rows.push({
    tipo: 'gasto', refId: g.id, fecha: g.created_at, raw: g, anulado: g.anulado,
    usuario: nombreUsuario(usuarios, g, 'gasto'),
    cuenta: '', detalle: g.descripcion + marca(g.anulado), importe: Number(g.monto), signo: g.anulado ? 0 : -1
  }));
  (pagosVend||[]).forEach(p => rows.push({
    tipo: 'pago_vendedor', refId: p.id, fecha: p.created_at, raw: p, anulado: p.anulado,
    usuario: nombreUsuario(usuarios, p, 'pago_vendedor'),
    cuenta: p.vendedores ? p.vendedores.nombre : '',
    detalle: `Pago de ${p.vendedores ? p.vendedores.nombre : 'vendedor'}${p.descripcion ? ' — ' + p.descripcion : ''}${marca(p.anulado)}`,
    importe: Number(p.monto), signo: p.anulado ? 0 : -1
  }));
  (pagosCli||[]).forEach(p => rows.push({
    tipo: 'pago_cliente', refId: p.id, fecha: p.created_at, raw: p, anulado: p.anulado,
    usuario: nombreUsuario(usuarios, p, 'pago_cliente'),
    cuenta: p.clientes ? p.clientes.nombre : '',
    detalle: `Pago de ${p.clientes ? p.clientes.nombre : 'cliente'}${p.descripcion ? ' — ' + p.descripcion : ''}${marca(p.anulado)}`,
    importe: Number(p.monto), signo: p.anulado ? 0 : 1
  }));
  (bonis||[]).forEach(b => rows.push({
    tipo: 'bonificacion', refId: b.id, fecha: b.created_at, raw: b, anulado: b.anulado,
    usuario: nombreUsuario(usuarios, b, 'bonificacion'),
    cuenta: b.vendedores ? b.vendedores.nombre : '',
    detalle: `Bonificación a ${b.vendedores ? b.vendedores.nombre : 'vendedor'}${b.descripcion ? ' — ' + b.descripcion : ''}${marca(b.anulado)}`,
    importe: Number(b.monto), signo: b.anulado ? 0 : -1
  }));
  (stock||[]).forEach(m => rows.push({
    tipo: 'stock', refId: m.id, fecha: m.created_at, raw: m, anulado: false,
    usuario: nombreUsuario(usuarios, m, 'stock'),
    cuenta: m.productos ? m.productos.nombre : '',
    detalle: `${m.tipo} — ${m.productos ? m.productos.nombre : ''} (${m.cantidad > 0 ? '+' : ''}${Number(m.cantidad)})${m.motivo ? ' — ' + m.motivo : ''}`,
    importe: null, signo: 0
  }));

  rows.sort((a,b) => new Date(b.fecha) - new Date(a.fecha));
  movimientos = rows;
  render();
}

function listaFiltrada(){
  let list = movimientos;
  if(filtroTipo) list = list.filter(m => m.tipo === filtroTipo);
  if(filtroTexto) list = list.filter(m => (m.cuenta || '').toLowerCase().includes(filtroTexto) || (m.detalle || '').toLowerCase().includes(filtroTexto));
  return list;
}

function accionesHtml(m){
  const btn = (act, cls, label, title) =>
    `<button class="btn-sm ${cls}" data-act="${act}" data-tipo="${m.tipo}" data-id="${m.refId}" title="${title}">${label}</button>`;
  if(m.tipo === 'stock') return '';
  const out = [];
  if(m.tipo === 'venta') out.push(btn('factura', 'btn-blue', '🧾 Factura', 'Ver el resumen y descargar la factura'));
  if(!m.anulado){
    out.push(btn('editar', 'btn-edit', '✎ Modificar', 'Modificar este movimiento'));
    out.push(btn('anular', 'btn-del', '✕ Anular', 'Anular este movimiento'));
  }
  return out.length ? `<div class="row-btns">${out.join('')}</div>` : '';
}

function render(){
  const tbody = document.getElementById('hist-body');
  const list = listaFiltrada();

  if(list.length === 0){
    tbody.innerHTML = `<tr><td colspan="6" class="empty-row">No hay movimientos.</td></tr>`;
    return;
  }
  tbody.innerHTML = list.map(m => {
    const importeTxt = m.importe === null ? '—' : money(m.importe);
    const importeClass = m.signo > 0 ? 'importe-pos' : m.signo < 0 ? 'importe-neg' : '';
    return `
      <tr class="${m.anulado ? 'anulado' : ''}">
        <td>${dateTime(m.fecha)}</td>
        <td><span class="tag tag-${m.tipo}">${TIPO_LABEL[m.tipo]}</span></td>
        <td>${esc(m.detalle)}</td>
        <td class="hist-usuario">${esc(m.usuario)}</td>
        <td class="${importeClass}">${m.signo < 0 && m.importe !== null ? '-' : ''}${importeTxt}</td>
        <td>${accionesHtml(m)}</td>
      </tr>`;
  }).join('');
}

const TABLA_ANULABLE = {
  bonificacion: 'bonificaciones', pago_vendedor: 'pagos_vendedores', pago_cliente: 'pagos_clientes',
  pago_proveedor: 'pagos_proveedores', gasto: 'gastos'
};

async function anular(tipo, id){
  const m = movimientos.find(m => m.tipo === tipo && m.refId === id);
  if(!m) return;
  const nombre = `${TIPO_LABEL[tipo].toLowerCase()} #${id}`;
  let aviso = 'Deja de contar en las cuentas corrientes y en la caja.';
  if(tipo === 'venta') aviso = m.raw.estado === 'confirmada' ? 'Se repone el stock vendido.' : 'El pedido pasa a cancelado.';
  if(tipo === 'devolucion_stock') aviso = 'Se retira del stock lo que había reingresado y deja de acreditarse al vendedor.';
  if(tipo === 'devolucion') aviso = 'Deja de acreditarse en la cuenta del vendedor.';
  if(!(await confirmDialog(`¿Anular ${nombre}?\n${aviso}`, { confirmLabel: 'Anular' }))) return;

  let error;
  if(tipo === 'venta'){
    ({ error } = m.raw.estado === 'pendiente'
      ? await sb.rpc('cambiar_estado_pedido_online', { p_venta_id: id, p_nuevo_estado: 'anulada' })
      : await sb.rpc('anular_venta', { p_venta_id: id }));
  } else if(tipo === 'devolucion' || tipo === 'devolucion_stock'){
    ({ error } = await sb.rpc('anular_devolucion', { p_devolucion_id: id }));
  } else {
    ({ error } = await sb.from(TABLA_ANULABLE[tipo]).update({ anulado: true }).eq('id', id));
  }
  if(error){ alert('No se pudo anular: ' + error.message); return; }
  await cargarTodo();
}

// ===== Modificar un movimiento =====

async function cargarCatalogos(){
  const [{ data: vd }, { data: cl }, { data: pv }, { data: pr }, { data: cm }] = await Promise.all([
    sb.from('vendedores').select('id, nombre, activo, es_canal_online').order('nombre'),
    sb.from('clientes').select('id, nombre, activo').order('nombre'),
    sb.from('proveedores').select('id, nombre, activo').order('nombre'),
    sb.from('productos').select('id, nombre, unidad, precio_venta, marca_id, marcas(nombre, color), categorias(por_peso)').eq('activo', true).order('nombre'),
    sb.from('comisiones_vendedor_marca').select('vendedor_id, marca_id, comision_pct')
  ]);
  return {
    vendedores: (vd || []).filter(v => !v.es_canal_online),
    clientes: cl || [],
    proveedores: pv || [],
    productos: pr || [],
    comisiones: Object.fromEntries((cm || []).map(c => [`${c.vendedor_id}:${c.marca_id}`, Number(c.comision_pct)]))
  };
}

// <option>s con los activos + el que ya tiene el movimiento (aunque esté dado de baja)
function opciones(lista, actualId, vacio){
  const items = lista.filter(x => x.activo !== false || x.id === actualId);
  return (vacio ? `<option value="">${vacio}</option>` : '') +
    items.map(x => `<option value="${x.id}" ${x.id === actualId ? 'selected' : ''}>${esc(x.nombre)}</option>`).join('');
}

const campo = (label, html) => `<label>${label}</label>${html}`;

async function abrirEdicion(tipo, refId){
  const m = movimientos.find(m => m.tipo === tipo && m.refId === refId);
  if(!m) return;
  const cat = await cargarCatalogos();
  const box = document.getElementById('ed-form');
  document.getElementById('ed-err').textContent = '';
  edicion = { tipo, refId, cat };

  if(tipo === 'venta') await formVenta(box, m.raw, cat);
  else if(tipo === 'devolucion' || tipo === 'devolucion_stock') await formDevolucion(box, m.raw, cat);
  else if(tipo === 'bonificacion') await formBonificacion(box, m.raw, cat);
  else if(tipo === 'pago_vendedor'){
    document.getElementById('ed-titulo').textContent = `Modificar pago a vendedor #${refId}`;
    box.innerHTML =
      campo('Vendedor', `<select id="ed-vendedor">${opciones(cat.vendedores, m.raw.vendedor_id)}</select>`) +
      campo('Monto $', `<input type="number" step="0.01" min="0" id="ed-monto" value="${Number(m.raw.monto)}">`) +
      campo('Medio de pago', `<select id="ed-medio">
        <option value="efectivo" ${m.raw.medio_pago === 'efectivo' ? 'selected' : ''}>Efectivo</option>
        <option value="transferencia" ${m.raw.medio_pago === 'transferencia' ? 'selected' : ''}>Transferencia</option></select>`) +
      campo('Descripción', `<input type="text" id="ed-desc" value="${esc(m.raw.descripcion)}">`);
  } else if(tipo === 'pago_cliente'){
    document.getElementById('ed-titulo').textContent = `Modificar pago de cliente #${refId}`;
    box.innerHTML =
      campo('Cliente', `<select id="ed-cliente">${opciones(cat.clientes, m.raw.cliente_id)}</select>`) +
      campo('Monto $', `<input type="number" step="0.01" min="0" id="ed-monto" value="${Number(m.raw.monto)}">`) +
      campo('Medio de pago', `<select id="ed-medio">
        ${['efectivo', 'transferencia', 'cheque'].map(x => `<option value="${x}" ${m.raw.medio_pago === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select>`) +
      campo('Descripción', `<input type="text" id="ed-desc" value="${esc(m.raw.descripcion)}">`);
  } else if(tipo === 'pago_proveedor'){
    document.getElementById('ed-titulo').textContent = `Modificar pago a proveedor #${refId}`;
    box.innerHTML =
      campo('Proveedor', `<select id="ed-proveedor">${opciones(cat.proveedores, m.raw.proveedor_id)}</select>`) +
      campo('Monto bruto $', `<input type="number" step="0.01" min="0" id="ed-monto" value="${Number(m.raw.monto_bruto)}">`) +
      campo('Medio de pago', `<select id="ed-medio">
        ${['efectivo', 'transferencia', 'cheque'].map(x => `<option value="${x}" ${m.raw.medio_pago === x ? 'selected' : ''}>${x[0].toUpperCase() + x.slice(1)}</option>`).join('')}</select>`) +
      `<div id="ed-cheque-wrap">` +
        campo('% de ganancia del cheque', `<input type="number" step="0.1" min="0" max="99.9" id="ed-comision" value="${Number(m.raw.comision_pct)}">`) +
      `</div>` +
      campo('Descripción', `<input type="text" id="ed-desc" value="${esc(m.raw.descripcion)}">`);
    // El % de ganancia solo existe con cheque
    const medioSel = document.getElementById('ed-medio');
    const mostrarGanancia = () => { document.getElementById('ed-cheque-wrap').style.display = medioSel.value === 'cheque' ? '' : 'none'; };
    medioSel.addEventListener('change', mostrarGanancia);
    mostrarGanancia();
  } else if(tipo === 'gasto'){
    document.getElementById('ed-titulo').textContent = `Modificar gasto #${refId}`;
    box.innerHTML =
      campo('Descripción', `<input type="text" id="ed-desc" value="${esc(m.raw.descripcion)}">`) +
      campo('Monto $', `<input type="number" step="0.01" min="0" id="ed-monto" value="${Number(m.raw.monto)}">`);
  }

  document.getElementById('ed-box').classList.toggle('wide', ['venta', 'devolucion', 'devolucion_stock', 'bonificacion'].includes(tipo));
  document.getElementById('modal-editar').classList.add('open');
}

function cerrarEdicion(){
  document.getElementById('modal-editar').classList.remove('open');
  document.getElementById('ed-form').innerHTML = '';
  edicion = null;
}

async function itemsDe(tabla, columna, id){
  const { data, error } = await sb.from(tabla).select('id, producto_id, cantidad, precio_unitario').eq(columna, id).order('id');
  if(error) throw error;
  return data || [];
}

// Bloque de items + totales. Con comisión muestra el neto según el vendedor elegido en
// #ed-vendedor; etiquetaNeto es el nombre de esa última línea.
const itemsHtml = (conComision, etiquetaNeto) => `
  <div id="ed-items"></div>
  <div class="items-total">Total: <span id="ed-total">$0,00</span></div>
  ${conComision ? `<div class="items-total-sub">Comisión del vendedor: <span id="ed-comision-monto">$0,00</span></div>
  <div class="items-total items-neto">${etiquetaNeto}: <span id="ed-neto">$0,00</span></div>` : ''}`;

function montarEditor(cat, items, conComision){
  const vendedorSel = document.getElementById('ed-vendedor');
  const pctDe = productoId => {
    const p = cat.productos.find(p => String(p.id) === String(productoId));
    return (p && cat.comisiones[`${vendedorSel.value}:${p.marca_id}`]) || 0;
  };
  edicion.editor = mountItemsEditor(document.getElementById('ed-items'), {
    productos: cat.productos,
    comision: conComision ? pctDe : null,
    onChange: ({ total, comision }) => {
      document.getElementById('ed-total').textContent = money(total);
      if(conComision){
        document.getElementById('ed-comision-monto').textContent = money(comision);
        document.getElementById('ed-neto').textContent = money(total - comision);
      }
    }
  });
  items.forEach(it => edicion.editor.addRow(it));
  if(items.length === 0) edicion.editor.addRow();
  if(conComision) vendedorSel.addEventListener('change', () => edicion.editor.recalc());
}

async function formVenta(box, v, cat){
  const manual = v.canal === 'manual';
  document.getElementById('ed-titulo').textContent = `Modificar venta #${v.id}${v.estado === 'pendiente' ? ' (pendiente)' : ''}`;
  const items = await itemsDe('ventas_items', 'venta_id', v.id);

  box.innerHTML = (manual
    ? campo('Vendedor', `<select id="ed-vendedor">${opciones(cat.vendedores, v.vendedor_id)}</select>`) +
      campo('Cliente (opcional)', `<select id="ed-cliente">${opciones(cat.clientes, v.cliente_id, 'Sin cliente asignado')}</select>`)
    : `<p class="ed-note">Pedido de la tienda online${v.cliente_nombre ? ' de <b>' + esc(v.cliente_nombre) + '</b>' : ''}. Acá podés cambiar productos, cantidades y precios.</p>`) +
    itemsHtml(manual, 'Neto para la distribuidora') +
    (v.estado === 'confirmada' ? '<p class="ed-note">Si cambiás las cantidades, el stock se ajusta solo (queda registrado en los movimientos de stock).</p>' : '');
  montarEditor(cat, items, manual);
}

async function formDevolucion(box, d, cat){
  document.getElementById('ed-titulo').textContent = `Modificar ${d.con_stock ? 'devolución de stock' : 'devolución'} #${d.id}`;
  const items = await itemsDe('devoluciones_items', 'devolucion_id', d.id);
  edicion.ventaId = d.venta_id ?? null; // ya no se elige a mano: se conserva el vínculo que tuviera

  box.innerHTML =
    campo('Vendedor', `<select id="ed-vendedor">${opciones(cat.vendedores, d.vendedor_id)}</select>`) +
    campo('Motivo', `<input type="text" id="ed-motivo" value="${esc(d.motivo)}">`) +
    itemsHtml(true, 'Saldo a favor del vendedor') +
    `<p class="ed-note">${d.con_stock
      ? 'La mercadería vuelve al stock: si cambiás las cantidades, el stock se ajusta solo.'
      : 'La mercadería devuelta no vuelve al stock.'} Se acredita con la comisión del vendedor restada.</p>`;
  montarEditor(cat, items, true);
}

async function formBonificacion(box, b, cat){
  document.getElementById('ed-titulo').textContent = `Modificar bonificación #${b.id}`;
  const { data, error } = await sb.from('bonificaciones_items').select('id, producto_id, cantidad, precio_unitario').eq('bonificacion_id', b.id).order('id');
  if(error) throw error;

  box.innerHTML =
    campo('Vendedor', `<select id="ed-vendedor">${opciones(cat.vendedores, b.vendedor_id)}</select>`) +
    campo('Descripción (opcional)', `<input type="text" id="ed-desc" value="${esc(b.descripcion)}">`) +
    itemsHtml(true, 'Saldo a favor del vendedor') +
    `<p class="ed-note">La mercadería bonificada no vuelve al stock. Se acredita con la comisión del vendedor restada.${data.length === 0 ? ' Esta bonificación se cargó solo con un monto (' + money(b.monto) + '): cargá los productos para reemplazarlo.' : ''}</p>`;
  montarEditor(cat, data, true);
}

async function guardarEdicion(){
  if(!edicion) return;
  const { tipo, refId, editor } = edicion;
  const err = document.getElementById('ed-err');
  const val = id => document.getElementById(id).value;
  err.textContent = '';

  let error = null;
  if(tipo === 'venta'){
    const errItems = editor.error();
    if(errItems){ err.textContent = errItems; return; }
    const items = editor.getItems();
    const vendedor = document.getElementById('ed-vendedor');
    const cliente = document.getElementById('ed-cliente');
    ({ error } = await sb.rpc('editar_venta', {
      p_venta_id: refId,
      p_vendedor_id: vendedor ? Number(vendedor.value) : null,
      p_cliente_id: cliente && cliente.value ? Number(cliente.value) : null,
      p_items: items
    }));
  } else if(tipo === 'bonificacion'){
    const errItems = editor.error();
    if(errItems){ err.textContent = errItems; return; }
    const items = editor.getItems();
    ({ error } = await sb.rpc('editar_bonificacion', {
      p_bonificacion_id: refId,
      p_vendedor_id: Number(val('ed-vendedor')),
      p_descripcion: val('ed-desc').trim(),
      p_items: items
    }));
  } else if(tipo === 'devolucion' || tipo === 'devolucion_stock'){
    const errItems = editor.error();
    if(errItems){ err.textContent = errItems; return; }
    const items = editor.getItems();
    ({ error } = await sb.rpc('editar_devolucion', {
      p_devolucion_id: refId,
      p_vendedor_id: Number(val('ed-vendedor')),
      p_venta_id: edicion.ventaId,
      p_motivo: val('ed-motivo').trim(),
      p_items: items
    }));
  } else {
    const monto = parseFloat(val('ed-monto'));
    if(tipo === 'gasto'){
      if(!val('ed-desc').trim()){ err.textContent = 'Ingresá una descripción.'; return; }
      if(isNaN(monto) || monto <= 0){ err.textContent = 'Ingresá un monto válido.'; return; }
      ({ error } = await sb.from('gastos').update({ descripcion: val('ed-desc').trim(), monto }).eq('id', refId));
    } else {
      if(isNaN(monto) || monto <= 0){ err.textContent = 'Ingresá un monto válido.'; return; }
      const descripcion = val('ed-desc').trim();
      if(tipo === 'pago_cliente'){
        ({ error } = await sb.from('pagos_clientes').update({ cliente_id: Number(val('ed-cliente')), monto, medio_pago: val('ed-medio'), descripcion }).eq('id', refId));
      } else if(tipo === 'pago_vendedor'){
        ({ error } = await sb.from('pagos_vendedores').update({ vendedor_id: Number(val('ed-vendedor')), monto, medio_pago: val('ed-medio'), descripcion }).eq('id', refId));
      } else if(tipo === 'pago_proveedor'){
        const comision_pct = val('ed-medio') === 'cheque' ? (parseFloat(val('ed-comision')) || 0) : 0;
        if(comision_pct < 0 || comision_pct >= 100){ err.textContent = 'El % de ganancia del cheque tiene que estar entre 0 y 100.'; return; }
        ({ error } = await sb.from('pagos_proveedores').update({
          proveedor_id: Number(val('ed-proveedor')), monto_bruto: monto, comision_pct, medio_pago: val('ed-medio'), descripcion
        }).eq('id', refId));
      }
    }
  }

  if(error){ err.textContent = error.message; return; }
  cerrarEdicion();
  await cargarTodo();
}

// Un texto que empiece con = + - @ lo toma Excel como fórmula (ej. un nombre de cliente malicioso): se le antepone un apóstrofe.
function celdaCSV(v){
  let t = String(v ?? '');
  if(/^[=+\-@\t\r]/.test(t)) t = "'" + t;
  return '"' + t.replace(/"/g, '""') + '"';
}

function exportarCSV(){
  const list = listaFiltrada();
  const header = ['Fecha','Tipo','Cuenta','Detalle','Usuario','Importe'];
  const lines = [header.join(',')];
  list.forEach(m => {
    const importe = m.importe === null ? '' : (m.signo < 0 ? -m.importe : m.importe);
    const detalle = celdaCSV(m.detalle);
    const cuenta = celdaCSV(m.cuenta);
    const usuario = celdaCSV(m.usuario);
    lines.push([dateTime(m.fecha), TIPO_LABEL[m.tipo], cuenta, detalle, usuario, importe].join(','));
  });
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `historial_diarnec_${new Date().toISOString().slice(0,10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}
