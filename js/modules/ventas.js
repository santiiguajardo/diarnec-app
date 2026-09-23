import { sb } from '../shared/supabase-client.js';
import { requireAuth, getPerfil } from '../shared/auth-guard.js';
import { abrirDetalleCuenta } from '../shared/cuenta-detalle.js';
import { mountLayout } from '../shared/layout.js';
import { money } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';
import { createProductPicker } from '../shared/product-picker.js';
import { abrirResumenVenta } from '../shared/venta-resumen.js';
import { ajustarInputCantidad, cantidadEsValida, mensajeCantidad } from '../shared/cantidad.js';

let vendedores = [];
let vendedorOnline = null; // vendedor fijo "Tienda Online" (es_canal_online)
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let pedidoEnCurso = null; // pedido online que se está pasando a venta en el modal de retiro
let clientes = [];
let marcas = [];
let productos = [];
let productosMap = {};
let comisionesMap = {}; // "vendedorId:marcaId" -> %

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('ventas', 'Ventas');

  content.innerHTML = `
    <div class="ventas-top">
      <div class="ventas-side">
        <div class="admin-section">
          <h3>Gestión de cuentas</h3>
          <div class="side-btns">
            <button class="side-btn btn-vendedores" id="btn-vendedores"><span class="side-ico">🧑‍💼</span>Gestionar vendedores</button>
            <button class="side-btn btn-comisiones" id="btn-comisiones"><span class="side-ico">%</span>Administrar comisiones</button>
            <button class="side-btn btn-clientes" id="btn-clientes"><span class="side-ico">🏪</span>Gestionar clientes</button>
          </div>
        </div>
        <div class="admin-section">
          <h3>Operaciones diarias</h3>
          <div class="side-btns">
            <button class="side-btn btn-op1" id="btn-retiro"><span class="side-ico">📦</span>1. Cargar retiro / venta</button>
            <button class="side-btn btn-op2" id="btn-devolucion"><span class="side-ico">↩️</span>2. Devoluciones</button>
            <button class="side-btn btn-op3" id="btn-bonificacion"><span class="side-ico">🎁</span>3. Cargar bonificación</button>
            <button class="side-btn btn-op4" id="btn-pago"><span class="side-ico">💵</span>4. Registrar pago</button>
            <button class="side-btn btn-op5" id="btn-devstock"><span class="side-ico">🔄</span>5. Devolución de stock</button>
          </div>
        </div>
      </div>
      <div class="ventas-main">
        <div class="admin-section">
          <div class="cta-head"><h3>Cuentas corrientes — Vendedores</h3><button class="btn-limpiar" id="btn-limpiar-v" title="Deja las cuentas en $0 desde ahora, sin borrar el historial">🧹 Limpiar cuentas corrientes</button></div>
          <p class="cta-hint">Tocá una cuenta para ver el detalle de sus movimientos.</p>
          <table>
            <thead><tr><th>Nombre</th><th>Retirado</th><th>Devol.</th><th>Dev. stock</th><th>Bonif.</th><th>Pagos</th><th>Debe</th></tr></thead>
            <tbody id="tabla-vendedores"></tbody>
          </table>
        </div>
        <div class="admin-section">
          <div class="cta-head"><h3>Cuentas corrientes — Clientes</h3><button class="btn-limpiar" id="btn-limpiar-c" title="Deja las cuentas en $0 desde ahora, sin borrar el historial">🧹 Limpiar cuentas corrientes</button></div>
          <p class="cta-hint">Tocá una cuenta para ver el detalle de sus movimientos.</p>
          <p style="font-size:12px;color:var(--muted);margin:-6px 0 12px;">Solo tus clientes directos (los de la cartera de cada vendedor los maneja el desde su panel).</p>
          <table>
            <thead><tr><th>Nombre</th><th>Comprado</th><th>Devol.</th><th>Pagos</th><th>Debe</th></tr></thead>
            <tbody id="tabla-clientes"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  wireBotones();

  // Administrar comisiones: solo el admin. La base ya lo hace cumplir (RLS); esto además evita
  // que el encargado vea un botón que le va a tirar error si lo toca.
  const perfil = await getPerfil();
  if(!perfil || perfil.rol !== 'admin') document.getElementById('btn-comisiones').remove();

  await cargarBase();
  await cargarSaldos();
  await abrirPedidoDesdeUrl();
})();

// ===== Carga inicial de catálogos usados en los selects =====

async function cargarBase(){
  const [{ data: vd }, { data: cl }, { data: mc }, { data: pr }, { data: cm }] = await Promise.all([
    sb.from('vendedores').select('id, nombre, telefono, activo, es_canal_online').order('nombre'),
    sb.from('clientes').select('id, nombre, localidad, cuit, activo, vendedor_id').is('vendedor_id', null).order('nombre'),
    sb.from('marcas').select('id, nombre').order('nombre'),
    sb.from('productos').select('id, nombre, unidad, precio_venta, marca_id, marcas(nombre, color), categorias(por_peso)').eq('activo', true).order('nombre'),
    sb.from('comisiones_vendedor_marca').select('vendedor_id, marca_id, comision_pct')
  ]);
  vendedores = (vd || []).filter(v => !v.es_canal_online);
  vendedorOnline = (vd || []).find(v => v.es_canal_online) || null;
  clientes = cl || [];
  marcas = mc || [];
  productos = pr || [];
  productosMap = Object.fromEntries(productos.map(p => [p.id, p]));
  comisionesMap = Object.fromEntries((cm || []).map(c => [`${c.vendedor_id}:${c.marca_id}`, Number(c.comision_pct)]));

  const vendedoresActivos = vendedores.filter(v => v.activo);
  const clientesActivos = clientes.filter(c => c.activo);

  // "Tienda Online" solo aparece en el retiro/venta (ahí se elige sola al pasar un pedido a venta);
  // no tiene cuenta corriente ni comisión, así que no está en el resto de las operaciones.
  populateSelect('rt-vendedor', vendedorOnline ? [...vendedoresActivos, vendedorOnline] : vendedoresActivos, 'id', 'nombre');
  populateSelect('dv-vendedor', vendedoresActivos, 'id', 'nombre');
  populateSelect('bf-vendedor', vendedoresActivos, 'id', 'nombre');
  populateSelect('ds-vendedor', vendedoresActivos, 'id', 'nombre');
  populateSelect('cm-vendedor', vendedoresActivos, 'id', 'nombre', 'Elegí un vendedor');

  const rtCliente = document.getElementById('rt-cliente');
  rtCliente.innerHTML = '<option value="">Sin cliente asignado</option>' +
    clientesActivos.map(c => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('');

  renderVendedoresList();
  renderClientesList();
}

function populateSelect(id, items, valueKey, labelKey, placeholder){
  const el = document.getElementById(id);
  const ph = placeholder ? `<option value="">${placeholder}</option>` : '';
  el.innerHTML = ph + items.map(it => `<option value="${esc(it[valueKey])}">${esc(it[labelKey])}</option>`).join('');
}

// ===== Cuentas corrientes =====

async function cargarSaldos(){
  const [{ data: sv }, { data: sc }] = await Promise.all([
    sb.from('vendedores_saldo').select('*'),
    sb.from('clientes_saldo').select('*')
  ]);

  // Las cuentas corrientes muestran solo a quienes están en actividad: los dados de baja
  // (y el vendedor interno "Tienda online") no aparecen, aunque sigan en la base con su historial.
  const vendedoresVisibles = new Set(vendedores.filter(v => v.activo).map(v => v.id));
  const clientesVisibles = new Set(clientes.filter(c => c.activo).map(c => c.id));

  const tv = document.getElementById('tabla-vendedores');
  const filasV = (sv || []).filter(r => vendedoresVisibles.has(r.vendedor_id));
  tv.innerHTML = filasV.length === 0
    ? `<tr><td colspan="7" class="empty-row">No hay vendedores cargados.</td></tr>`
    : filasV.map(r => {
        // r.devuelto ya suma devolucion comun + devolucion de stock; r.devuelto_stock es solo para
        // mostrarla aparte, asi que la columna "Devol." muestra el resto (la comun).
        const debe = Number(r.retirado) - Number(r.devuelto) - Number(r.pagado) - Number(r.bonificado);
        return `<tr class="cta-row" data-tipo="vendedor" data-id="${r.vendedor_id}" title="Tocá para ver el detalle de la cuenta">
          <td>${esc(r.nombre)}</td><td>${money(r.retirado)}</td><td>${money(Number(r.devuelto) - Number(r.devuelto_stock))}</td>
          <td>${money(r.devuelto_stock)}</td><td>${money(r.bonificado)}</td><td>${money(r.pagado)}</td>
          <td class="debe ${debe > 0.005 ? 'pos' : (debe < -0.005 ? '' : 'zero')}">${money(debe)}</td>
        </tr>`;
      }).join('');

  const tc = document.getElementById('tabla-clientes');
  const filasC = (sc || []).filter(r => clientesVisibles.has(r.cliente_id));
  tc.innerHTML = filasC.length === 0
    ? `<tr><td colspan="5" class="empty-row">No hay clientes cargados.</td></tr>`
    : filasC.map(r => {
        const debe = Number(r.comprado) - Number(r.devuelto) - Number(r.pagado);
        return `<tr class="cta-row" data-tipo="cliente" data-id="${r.cliente_id}" title="Tocá para ver el detalle de la cuenta">
          <td>${esc(r.nombre)}</td><td>${money(r.comprado)}</td><td>${money(r.devuelto)}</td>
          <td>${money(r.pagado)}</td>
          <td class="debe ${debe > 0.005 ? 'pos' : (debe < -0.005 ? '' : 'zero')}">${money(debe)}</td>
        </tr>`;
      }).join('');
}

// ===== Botones y modales =====

function wireBotones(){
  document.getElementById('btn-vendedores').addEventListener('click', () => abrirModal('modal-vendedores'));
  document.getElementById('btn-comisiones').addEventListener('click', () => abrirModal('modal-comisiones'));
  document.getElementById('btn-clientes').addEventListener('click', () => abrirModal('modal-clientes'));
  document.getElementById('btn-retiro').addEventListener('click', () => abrirModalRetiro());
  document.getElementById('btn-devolucion').addEventListener('click', () => abrirModalDevolucion());
  document.getElementById('btn-bonificacion').addEventListener('click', () => abrirModalBonificacion());
  document.getElementById('btn-pago').addEventListener('click', () => abrirModalPago());
  document.getElementById('btn-devstock').addEventListener('click', () => abrirModalDevolucionStock());

  document.getElementById('vd-cerrar').addEventListener('click', () => cerrarModal('modal-vendedores'));
  document.getElementById('vd-agregar').addEventListener('click', agregarVendedor);

  document.getElementById('cm-cerrar').addEventListener('click', () => cerrarModal('modal-comisiones'));
  document.getElementById('cm-vendedor').addEventListener('change', cargarComisionesVendedor);

  document.getElementById('cl-cerrar').addEventListener('click', () => cerrarModal('modal-clientes'));
  document.getElementById('cl-agregar').addEventListener('click', agregarCliente);

  document.getElementById('rt-cerrar').addEventListener('click', cerrarRetiro);
  // Al cambiar de vendedor cambian las comisiones de todas las filas (en las cuatro operaciones)
  for(const pfx of ['rt', 'dv', 'bf', 'ds'])
    document.getElementById(`${pfx}-vendedor`).addEventListener('change', () => recalcularTodasLasFilas(`${pfx}-items`, `${pfx}-total`));
  document.getElementById('rt-add').addEventListener('click', () => agregarFilaItem('rt-items', 'rt-total'));
  document.getElementById('rt-confirmar').addEventListener('click', confirmarRetiro);

  document.getElementById('dv-cerrar').addEventListener('click', () => cerrarModal('modal-devolucion'));
  document.getElementById('dv-add').addEventListener('click', () => agregarFilaItem('dv-items', 'dv-total'));
  document.getElementById('dv-confirmar').addEventListener('click', confirmarDevolucion);

  document.getElementById('bf-cerrar').addEventListener('click', () => cerrarModal('modal-bonificacion'));
  document.getElementById('bf-add').addEventListener('click', () => agregarFilaItem('bf-items', 'bf-total'));
  document.getElementById('bf-confirmar').addEventListener('click', confirmarBonificacion);

  document.getElementById('ds-cerrar').addEventListener('click', () => cerrarModal('modal-devstock'));
  document.getElementById('ds-add').addEventListener('click', () => agregarFilaItem('ds-items', 'ds-total'));
  document.getElementById('ds-confirmar').addEventListener('click', confirmarDevolucionStock);

  document.getElementById('pg-cerrar').addEventListener('click', () => cerrarModal('modal-pago'));
  document.getElementById('pg-tipo').addEventListener('change', actualizarEntidadPago);
  document.getElementById('pg-confirmar').addEventListener('click', confirmarPago);

  // Tocar una cuenta corriente abre su detalle (movimientos, productos y saldo)
  ['tabla-vendedores', 'tabla-clientes'].forEach(id => document.getElementById(id).addEventListener('click', e => {
    const tr = e.target.closest('tr.cta-row');
    if(!tr) return;
    abrirDetalleCuenta({ tipo: tr.dataset.tipo, id: Number(tr.dataset.id), nombre: tr.firstElementChild.textContent.trim() });
  }));
  document.getElementById('btn-limpiar-v').addEventListener('click', limpiarCuentasCorrientes);
  document.getElementById('btn-limpiar-c').addEventListener('click', limpiarCuentasCorrientes);
}

function abrirModal(id){ document.getElementById(id).classList.add('open'); }
function cerrarModal(id){ document.getElementById(id).classList.remove('open'); }

// ===== Gestionar vendedores =====

function renderVendedoresList(){
  const tbody = document.getElementById('vd-body');
  const fijo = vendedorOnline
    ? `<tr><td>${esc(vendedorOnline.nombre)}<span class="tag-fijo">fijo · sin comisión</span></td><td></td><td></td></tr>`
    : '';
  tbody.innerHTML = fijo + vendedores.map(v => `
    <tr class="${v.activo ? '' : 'inactive-row'}">
      <td>${esc(v.nombre)}</td>
      <td><input class="cell-tel" type="tel" placeholder="Sin cargar" value="${esc(v.telefono || '')}"
           onchange="window.vdTelefono(${v.id},this)"></td>
      <td><div class="row-actions">
        <button class="btn-sm ${v.activo ? 'btn-grey' : 'btn-add'}" onclick="window.vdToggle(${v.id},${v.activo})">${v.activo ? 'Baja' : 'Alta'}</button>
        <button class="btn-sm btn-del" onclick="window.vdBorrar(${v.id})">Borrar</button>
      </div></td>
    </tr>`).join('');
}

async function agregarVendedor(){
  const nombre = document.getElementById('vd-nombre').value.trim();
  if(!nombre){ alert('Ingresá el nombre del vendedor.'); return; }
  const telefono = document.getElementById('vd-tel').value.trim();
  const { error } = await sb.from('vendedores').insert({ nombre, telefono });
  if(error){ alert('No se pudo agregar: ' + error.message); return; }
  document.getElementById('vd-nombre').value = '';
  document.getElementById('vd-tel').value = '';
  await cargarBase();
  await cargarSaldos();
}

// Borrar de verdad: solo se puede si el vendedor no tiene movimientos (ventas, pagos,
// devoluciones...). Si tiene historia, la base lo impide y se sugiere darlo de baja.
async function vdBorrar(id){
  const v = vendedores.find(v => v.id === id);
  if(!(await confirmDialog(`¿Borrar a ${v ? v.nombre : 'este vendedor'}? Se borran también sus comisiones por marca.`, { confirmLabel: 'Borrar' }))) return;
  const { error } = await sb.from('vendedores').delete().eq('id', id);
  if(error){
    alert(error.code === '23503'
      ? 'No se puede borrar: este vendedor tiene movimientos (ventas, pagos, etc.) o un usuario de acceso. Usá "Baja" para sacarlo de las listas sin perder su historial, o eliminá primero su usuario en Usuarios.'
      : 'No se pudo borrar: ' + error.message);
    return;
  }
  await cargarBase();
  await cargarSaldos();
}

// WhatsApp del vendedor: es el número al que le llega el pedido cuando un cliente lo elige en la tienda.
async function vdTelefono(id, input){
  const telefono = input.value.trim();
  const solo = telefono.replace(/\D/g, '');
  if(telefono && solo.length < 10){ alert('Ingresá el número con código de área, sin 0 ni 15 (ej: 2262357262).'); return; }
  const { error } = await sb.from('vendedores').update({ telefono }).eq('id', id);
  if(error){ alert('No se pudo guardar: ' + error.message); return; }
  const v = vendedores.find(v => v.id === id);
  if(v) v.telefono = telefono;
  input.classList.add('saved');
  setTimeout(() => input.classList.remove('saved'), 1200);
}

async function vdToggle(id, estabaActivo){
  const { error } = await sb.from('vendedores').update({ activo: !estabaActivo }).eq('id', id);
  if(error){ alert('No se pudo actualizar: ' + error.message); return; }
  await cargarBase();
  await cargarSaldos();
}

// ===== Administrar comisiones =====

async function cargarComisionesVendedor(){
  const vendedorId = document.getElementById('cm-vendedor').value;
  const detalle = document.getElementById('cm-detalle');
  if(!vendedorId){ detalle.style.display = 'none'; return; }
  detalle.style.display = 'block';

  // No hay comisión "base": la comisión de un vendedor se define marca por marca
  // (sin valor = 0%). Se listan todas las marcas para cargarlas de una.
  const { data } = await sb.from('comisiones_vendedor_marca').select('marca_id, comision_pct').eq('vendedor_id', vendedorId);
  const porMarca = Object.fromEntries((data || []).map(o => [o.marca_id, Number(o.comision_pct)]));

  document.getElementById('cm-body').innerHTML = marcas.length === 0
    ? `<tr><td colspan="2" class="empty-row">No hay marcas cargadas.</td></tr>`
    : marcas.map(m => `
      <tr>
        <td>${esc(m.nombre)}</td>
        <td><input class="cell-pct" type="number" step="0.1" min="0" placeholder="0"
             value="${porMarca[m.id] !== undefined ? porMarca[m.id] : ''}"
             onchange="window.cmGuardar(${vendedorId},${m.id},this)"></td>
      </tr>`).join('');
}

// Guarda al salir del campo. Vacío o 0 = sin comisión (se borra la fila).
async function cmGuardar(vendedorId, marcaId, input){
  const raw = input.value.trim();
  const pct = raw === '' ? 0 : parseFloat(raw);
  if(isNaN(pct) || pct < 0){ alert('Ingresá un porcentaje válido (0 o más).'); await cargarComisionesVendedor(); return; }

  const { error } = pct === 0
    ? await sb.from('comisiones_vendedor_marca').delete().eq('vendedor_id', vendedorId).eq('marca_id', marcaId)
    : await sb.from('comisiones_vendedor_marca').upsert(
        { vendedor_id: vendedorId, marca_id: marcaId, comision_pct: pct },
        { onConflict: 'vendedor_id,marca_id' });
  if(error){ alert('No se pudo guardar: ' + error.message); return; }

  const clave = `${vendedorId}:${marcaId}`;
  if(pct === 0) delete comisionesMap[clave]; else comisionesMap[clave] = pct;

  input.classList.add('saved');
  setTimeout(() => input.classList.remove('saved'), 1200);
}

// ===== Gestionar clientes =====

function renderClientesList(){
  const tbody = document.getElementById('cl-body');
  tbody.innerHTML = clientes.map(c => `
    <tr class="${c.activo ? '' : 'inactive-row'}">
      <td>${esc(c.nombre)}</td><td>${esc(c.cuit || '')}</td><td>${esc(c.localidad || '')}</td>
      <td><div class="row-actions">
        <button class="btn-sm ${c.activo ? 'btn-grey' : 'btn-add'}" onclick="window.clToggle(${c.id},${c.activo})">${c.activo ? 'Baja' : 'Alta'}</button>
        <button class="btn-sm btn-del" onclick="window.clBorrar(${c.id})">Borrar</button>
      </div></td>
    </tr>`).join('');
}

async function clBorrar(id){
  const c = clientes.find(c => c.id === id);
  if(!(await confirmDialog(`¿Borrar a ${c ? c.nombre : 'este cliente'}?`, { confirmLabel: 'Borrar' }))) return;
  const { error } = await sb.from('clientes').delete().eq('id', id);
  if(error){
    alert(error.code === '23503'
      ? 'No se puede borrar: este cliente ya tiene ventas o pagos. Usá "Baja" para sacarlo de las listas sin perder su historial.'
      : 'No se pudo borrar: ' + error.message);
    return;
  }
  await cargarBase();
  await cargarSaldos();
}

// Los clientes que carga aca el dueno son siempre suyos (sin vendedor asignado). Un cliente que
// pertenece a la cartera de un vendedor lo carga y administra ese vendedor desde su panel.
async function agregarCliente(){
  const nombre = document.getElementById('cl-nombre').value.trim();
  const localidad = document.getElementById('cl-localidad').value.trim();
  if(!nombre){ alert('Ingresá el nombre del cliente.'); return; }
  const cuit = document.getElementById('cl-cuit').value.replace(/\D/g, '');
  if(cuit && cuit.length !== 11){ alert('El CUIT o CUIL tiene 11 números.'); return; }
  const { error } = await sb.from('clientes').insert({ nombre, localidad, cuit: cuit || null, vendedor_id: null });
  if(error){ alert('No se pudo agregar: ' + error.message); return; }
  document.getElementById('cl-nombre').value = '';
  document.getElementById('cl-localidad').value = '';
  document.getElementById('cl-cuit').value = '';
  await cargarBase();
  await cargarSaldos();
}

async function clToggle(id, estabaActivo){
  const { error } = await sb.from('clientes').update({ activo: !estabaActivo }).eq('id', id);
  if(error){ alert('No se pudo actualizar: ' + error.message); return; }
  await cargarBase();
  await cargarSaldos();
}

// ===== Filas de items (retiro/venta y devolución comparten esta lógica) =====

// Las cuatro operaciones (retiro/venta, devolución, bonificación y devolución de stock) muestran
// el neto después de la comisión del vendedor: el vendedor siempre "compra" a precio menos su
// comisión, así que lo que se le acredita también va con la comisión restada.
// tbodyId 'xx-items' -> prefijo 'xx' de los campos del modal (xx-vendedor, xx-comision, xx-neto).
const prefijo = tbodyId => tbodyId.replace('-items', '');
const vendedorDe = tbodyId => document.getElementById(`${prefijo(tbodyId)}-vendedor`).value;

function resetTotales(pfx){
  for(const campo of ['total', 'comision', 'neto']) document.getElementById(`${pfx}-${campo}`).textContent = '$0,00';
}

function comisionPct(vendedorId, productoId){
  const p = productosMap[productoId];
  return (p && comisionesMap[`${vendedorId}:${p.marca_id}`]) || 0;
}

// item (opcional): { producto_id, cantidad, precio_unitario } para dejar la fila ya cargada
function agregarFilaItem(tbodyId, totalId, item = null){
  const tbody = document.getElementById(tbodyId);
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="pp-cell"></td>
    <td><input type="number" step="1" min="1" class="item-cantidad" value="${item ? Number(item.cantidad) : 1}" style="width:60px;"></td>
    <td><input type="number" step="0.01" class="item-precio" value="${item ? Number(item.precio_unitario).toFixed(2) : ''}" style="width:80px;"></td>
    <td class="item-subtotal">$0,00</td>
    <td class="item-neto">$0,00</td>
    <td><button class="item-del">×</button></td>
  `;
  tbody.appendChild(tr);

  // Buscador de producto (se comporta como un <select>: .value y evento "change")
  const select = createProductPicker(productos);
  tr.querySelector('.pp-cell').appendChild(select);
  const precioInput = tr.querySelector('.item-precio');
  const cantInput = tr.querySelector('.item-cantidad');
  const recalc = () => recalcularFila(tr, tbodyId, totalId);
  if(item){ select.value = item.producto_id; ajustarInputCantidad(cantInput, productosMap[select.value]); }

  // Al elegir producto se carga su precio de venta (editable después).
  const setPrecioDefault = () => {
    const p = productosMap[select.value];
    if(p) precioInput.value = Number(p.precio_venta).toFixed(2);
    ajustarInputCantidad(cantInput, p); // enteros, salvo fiambres y quesos (por peso)
    recalc();
  };
  select.addEventListener('change', () => { setPrecioDefault(); tr.querySelector('.item-cantidad').select(); });
  tr.querySelector('.item-cantidad').addEventListener('input', recalc);
  precioInput.addEventListener('input', recalc);
  tr.querySelector('.item-del').addEventListener('click', () => { tr.remove(); recalcularTotal(tbodyId, totalId); });

  recalc();
  // Una fila vacía arranca con el buscador enfocado para empezar a escribir.
  if(!item) setTimeout(() => select.focusInput(), 60);
}

function recalcularFila(tr, tbodyId, totalId){
  const cant = parseFloat(tr.querySelector('.item-cantidad').value) || 0;
  const precio = parseFloat(tr.querySelector('.item-precio').value) || 0;
  const subtotal = cant * precio;
  tr.querySelector('.item-subtotal').textContent = money(subtotal);

  const pct = comisionPct(vendedorDe(tbodyId), tr.querySelector('.item-producto').value);
  tr.querySelector('.item-neto').innerHTML = `${money(subtotal - subtotal * pct / 100)}<small>comisión ${pct}%</small>`;
  recalcularTotal(tbodyId, totalId);
}

function recalcularTotal(tbodyId, totalId){
  const filas = document.querySelectorAll(`#${tbodyId} tr`);
  let total = 0, comision = 0;
  filas.forEach(tr => {
    const cant = parseFloat(tr.querySelector('.item-cantidad').value) || 0;
    const precio = parseFloat(tr.querySelector('.item-precio').value) || 0;
    total += cant * precio;
    const pct = comisionPct(vendedorDe(tbodyId), tr.querySelector('.item-producto').value);
    comision += cant * precio * pct / 100;
  });
  const pfx = prefijo(tbodyId);
  document.getElementById(totalId).textContent = money(total);
  document.getElementById(`${pfx}-comision`).textContent = money(comision);
  document.getElementById(`${pfx}-neto`).textContent = money(total - comision);
}

// Al cambiar de vendedor cambian las comisiones de todas las filas.
function recalcularTodasLasFilas(tbodyId, totalId){
  document.querySelectorAll(`#${tbodyId} tr`).forEach(tr => recalcularFila(tr, tbodyId, totalId));
  recalcularTotal(tbodyId, totalId);
}

// Lee las filas de items. Si algo está mal, escribe el motivo en `err` y devuelve null.
function leerItems(tbodyId, err){
  const generico = 'Cargá al menos un producto con cantidad y precio válidos.';
  const filas = document.querySelectorAll(`#${tbodyId} tr`);
  if(filas.length === 0){ err.textContent = generico; return null; }
  const items = [];
  for(const tr of filas){
    const producto_id = Number(tr.querySelector('.item-producto').value);
    const cantidad = parseFloat(tr.querySelector('.item-cantidad').value);
    const precio_unitario = parseFloat(tr.querySelector('.item-precio').value);
    if(!producto_id || !cantidad || cantidad <= 0 || isNaN(precio_unitario) || precio_unitario < 0){ err.textContent = generico; return null; }
    const p = productosMap[producto_id];
    if(!cantidadEsValida(p, cantidad)){ err.textContent = mensajeCantidad(p); return null; }
    items.push({ producto_id, cantidad, precio_unitario });
  }
  return items;
}

// ===== 1. Cargar retiro / venta =====

// pedido (opcional): pedido online que se pasa a venta. Entra con sus productos ya cargados y con el
// vendedor que el cliente eligió en la tienda (o "Tienda Online" si no eligió ninguno). Se puede cambiar:
// si es un cliente habitual se le asigna un vendedor, y la venta y el cliente pasan a su cuenta.
function abrirModalRetiro(pedido = null){
  if(pedido && !vendedorOnline){ alert('No se encontró el vendedor "Tienda Online".'); return; }
  pedidoEnCurso = pedido;
  const sel = document.getElementById('rt-vendedor');
  sel.disabled = false;
  sel.selectedIndex = 0;
  if(pedido){
    const elegido = pedido.vendedor_preferido_id && vendedores.find(v => v.id === pedido.vendedor_preferido_id && v.activo);
    sel.value = String(elegido ? elegido.id : vendedorOnline.id);
  }

  document.getElementById('rt-items').innerHTML = '';
  resetTotales('rt');
  document.getElementById('rt-err').textContent = '';
  document.getElementById('rt-cliente').value = '';
  document.getElementById('rt-cliente-wrap').style.display = pedido ? 'none' : '';
  document.getElementById('rt-titulo').textContent = pedido ? `Pasar el pedido #${pedido.id} a venta` : '1. Cargar retiro / venta';
  document.getElementById('rt-confirmar').textContent = pedido ? 'Pasar a venta' : 'Confirmar';
  const banner = document.getElementById('rt-pedido');
  banner.style.display = pedido ? '' : 'none';
  if(pedido){
    const dir = pedido.cliente_direccion || pedido.cliente_localidad;
    banner.textContent = `Pedido online de ${pedido.cliente_nombre || 'cliente sin nombre'}` +
      `${pedido.cliente_tipo ? ' (' + (pedido.cliente_tipo === 'comercio' ? 'comercio' : 'particular') + ')' : ''}` +
      `${pedido.cliente_cuit ? ' · CUIT/CUIL ' + pedido.cliente_cuit : ''}${dir ? ' · ' + dir : ''}. ` +
      'Podés ajustar los productos antes de confirmar. Elegí el vendedor: si es un cliente habitual con vendedor, la venta va a su cuenta ' +
      '(con su comisión) y el cliente queda en su cartera. Con "Tienda Online" no lleva comisión y el cliente queda como directo.';
  }

  const items = pedido ? (pedido.ventas_items || []) : [];
  if(items.length) items.forEach(it => agregarFilaItem('rt-items', 'rt-total', it));
  else agregarFilaItem('rt-items', 'rt-total');
  abrirModal('modal-retiro');
}

function cerrarRetiro(){
  cerrarModal('modal-retiro');
  pedidoEnCurso = null;
  document.getElementById('rt-vendedor').disabled = false;
}

// Tienda online -> "Pasar a venta" abre esta pantalla con ?pedido=<id>
async function abrirPedidoDesdeUrl(){
  let guardado = null;
  try { guardado = sessionStorage.getItem('diarnec_pedido_a_venta'); sessionStorage.removeItem('diarnec_pedido_a_venta'); } catch(e){ /* sin storage */ }
  const id = Number(guardado || new URLSearchParams(location.search).get('pedido'));
  if(!id) return;
  history.replaceState(null, '', location.pathname); // que al recargar no se reabra solo
  const { data: p, error } = await sb.from('ventas')
    .select('id, estado, cliente_nombre, cliente_localidad, cliente_tipo, cliente_cuit, cliente_direccion, vendedor_preferido_id, ventas_items(id, producto_id, cantidad, precio_unitario)')
    .eq('id', id).eq('canal', 'online').maybeSingle();
  if(error || !p){ alert(`No se encontró el pedido online #${id}.`); return; }
  if(p.estado === 'confirmada'){ alert(`El pedido #${id} ya está registrado como venta.`); return; }
  p.ventas_items.sort((a, b) => a.id - b.id);
  abrirModalRetiro(p);
}

async function confirmarRetiro(){
  const vendedorId = document.getElementById('rt-vendedor').value;
  const clienteId = document.getElementById('rt-cliente').value;
  const err = document.getElementById('rt-err');
  err.textContent = '';

  if(!vendedorId){ err.textContent = 'Elegí un vendedor.'; return; }
  const items = leerItems('rt-items', err);
  if(!items) return;

  // Pedido online: se confirma el pedido existente (no se crea una venta nueva)
  const { data: ventaId, error } = pedidoEnCurso
    ? await sb.rpc('pasar_pedido_a_venta', { p_venta_id: pedidoEnCurso.id, p_items: items, p_vendedor_id: Number(vendedorId) })
    : await sb.rpc('registrar_venta_manual', {
        p_vendedor_id: Number(vendedorId), p_items: items, p_cliente_id: clienteId ? Number(clienteId) : null
      });
  if(error){ err.textContent = error.message; return; }

  cerrarRetiro();
  // Apenas se registra la venta se abre su resumen, con el botón para descargar la factura.
  abrirResumenVenta(ventaId);
  await cargarSaldos();
}

// ===== 2. Devoluciones =====

function abrirModalDevolucion(){
  document.getElementById('dv-items').innerHTML = '';
  resetTotales('dv');
  document.getElementById('dv-err').textContent = '';
  document.getElementById('dv-motivo').value = '';
  agregarFilaItem('dv-items', 'dv-total');
  abrirModal('modal-devolucion');
}

async function confirmarDevolucion(){
  const vendedorId = document.getElementById('dv-vendedor').value;
  const motivo = document.getElementById('dv-motivo').value.trim();
  const err = document.getElementById('dv-err');
  err.textContent = '';

  if(!vendedorId){ err.textContent = 'Elegí un vendedor.'; return; }
  const items = leerItems('dv-items', err);
  if(!items) return;

  const { error } = await sb.rpc('registrar_devolucion', {
    p_vendedor_id: Number(vendedorId), p_venta_id: null, p_motivo: motivo, p_items: items
  });
  if(error){ err.textContent = error.message; return; }

  cerrarModal('modal-devolucion');
  await cargarSaldos();
}

// ===== 3. Cargar bonificación =====
// Igual que una devolución: lista de productos con cantidad y precio; el monto es el total.
// No toca el stock (la mercadería bonificada no vuelve): solo baja la deuda del vendedor.

function abrirModalBonificacion(){
  document.getElementById('bf-items').innerHTML = '';
  resetTotales('bf');
  document.getElementById('bf-err').textContent = '';
  document.getElementById('bf-descripcion').value = '';
  agregarFilaItem('bf-items', 'bf-total');
  abrirModal('modal-bonificacion');
}

async function confirmarBonificacion(){
  const vendedorId = document.getElementById('bf-vendedor').value;
  const descripcion = document.getElementById('bf-descripcion').value.trim();
  const err = document.getElementById('bf-err');
  err.textContent = '';

  if(!vendedorId){ err.textContent = 'Elegí un vendedor.'; return; }
  const items = leerItems('bf-items', err);
  if(!items) return;

  const { error } = await sb.rpc('registrar_bonificacion', {
    p_vendedor_id: Number(vendedorId), p_descripcion: descripcion, p_items: items
  });
  if(error){ err.textContent = error.message; return; }

  cerrarModal('modal-bonificacion');
  await cargarSaldos();
}

// ===== 5. Devolución de stock =====
// Como una devolución, pero la mercadería sí vuelve a ingresar al stock (mercadería en buen
// estado). Se acredita en la cuenta del vendedor con su comisión restada.

function abrirModalDevolucionStock(){
  document.getElementById('ds-items').innerHTML = '';
  resetTotales('ds');
  document.getElementById('ds-err').textContent = '';
  document.getElementById('ds-motivo').value = '';
  agregarFilaItem('ds-items', 'ds-total');
  abrirModal('modal-devstock');
}

async function confirmarDevolucionStock(){
  const vendedorId = document.getElementById('ds-vendedor').value;
  const motivo = document.getElementById('ds-motivo').value.trim();
  const err = document.getElementById('ds-err');
  err.textContent = '';

  if(!vendedorId){ err.textContent = 'Elegí un vendedor.'; return; }
  const items = leerItems('ds-items', err);
  if(!items) return;

  const { error } = await sb.rpc('registrar_devolucion_stock', {
    p_vendedor_id: Number(vendedorId), p_venta_id: null, p_motivo: motivo, p_items: items
  });
  if(error){ err.textContent = error.message; return; }

  cerrarModal('modal-devstock');
  await cargarSaldos();
}

// ===== 4. Registrar pago =====

function abrirModalPago(){
  document.getElementById('pg-err').textContent = '';
  document.getElementById('pg-monto').value = '';
  document.getElementById('pg-descripcion').value = '';
  document.getElementById('pg-tipo').value = 'vendedor';
  actualizarEntidadPago();
  abrirModal('modal-pago');
}

function actualizarEntidadPago(){
  const tipo = document.getElementById('pg-tipo').value;
  document.getElementById('pg-entidad-label').textContent = tipo === 'vendedor' ? 'Vendedor' : 'Cliente';
  const lista = tipo === 'vendedor' ? vendedores.filter(v => v.activo) : clientes.filter(c => c.activo);
  populateSelect('pg-entidad', lista, 'id', 'nombre');
}

async function confirmarPago(){
  const tipo = document.getElementById('pg-tipo').value;
  const entidadId = document.getElementById('pg-entidad').value;
  const monto = parseFloat(document.getElementById('pg-monto').value);
  const medio_pago = document.getElementById('pg-medio').value;
  const descripcion = document.getElementById('pg-descripcion').value.trim();
  const err = document.getElementById('pg-err');
  err.textContent = '';

  if(!entidadId){ err.textContent = `Elegí ${tipo === 'vendedor' ? 'un vendedor' : 'un cliente'}.`; return; }
  if(isNaN(monto) || monto <= 0){ err.textContent = 'Ingresá un monto válido.'; return; }

  const tabla = tipo === 'vendedor' ? 'pagos_vendedores' : 'pagos_clientes';
  const fila = tipo === 'vendedor'
    ? { vendedor_id: entidadId, monto, medio_pago, descripcion }
    : { cliente_id: entidadId, monto, medio_pago, descripcion };

  const { error } = await sb.from(tabla).insert(fila);
  if(error){ err.textContent = error.message; return; }

  cerrarModal('modal-pago');
  await cargarSaldos();
}

// No borra nada: mueve el punto de corte a "ahora". El Historial, el Dashboard y "Mis movimientos"
// del vendedor siguen mostrando todo; solo cambia lo que suman las cuentas corrientes de aca en
// adelante (y "Tu saldo hoy" / "Ver totales de siempre" del panel del vendedor, que salen de lo mismo).
async function limpiarCuentasCorrientes(){
  if(!(await confirmDialog(
    '¿Limpiar las cuentas corrientes?\n\nNo se borra nada: el Historial y "Mis movimientos" de cada vendedor siguen mostrando todo. Solo se deja el saldo de todos en $0 a partir de ahora, como cuando se cierra la semana.',
    { confirmLabel: 'Limpiar' }
  ))) return;
  const { error } = await sb.rpc('limpiar_cuentas_corrientes');
  if(error){ alert('No se pudo limpiar: ' + error.message); return; }
  await cargarSaldos();
}

Object.assign(window, { vdToggle, vdBorrar, vdTelefono, clToggle, clBorrar, cmGuardar });
