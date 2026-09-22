import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money, dateTime } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';

let proveedores = [];
let pagos = [];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MEDIOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque' };

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('proveedores', 'Pago a proveedores');

  content.innerHTML = `
    <section class="pv-card pv-prov">
      <header class="pv-head">
        <span class="pv-ico">🏭</span>
        <div><h3>Proveedores</h3><p>A quién le comprás. Acá los das de alta, de baja o los borrás.</p></div>
      </header>
      <div class="pv-form pv-form-prov">
        <label>Nombre<input type="text" id="pr-nombre" placeholder="Ej: Deviano SA"></label>
        <label>Contacto <small>(opcional)</small><input type="text" id="pr-contacto" placeholder="Persona de contacto"></label>
        <label>Teléfono <small>(opcional)</small><input type="text" id="pr-telefono" placeholder="Teléfono"></label>
        <button class="pv-btn pv-btn-navy" id="pr-submit">+ Agregar proveedor</button>
      </div>
      <div class="pv-aviso" id="pr-aviso" role="status"></div>
      <table>
        <thead><tr><th>Nombre</th><th>Contacto</th><th>Teléfono</th><th>Estado</th><th></th></tr></thead>
        <tbody id="prov-body"></tbody>
      </table>
    </section>

    <section class="pv-card pv-pago">
      <header class="pv-head">
        <span class="pv-ico">💸</span>
        <div><h3>Registrar un pago</h3><p>Cargá lo que le pagaste a un proveedor.</p></div>
      </header>
      <div class="pv-form pv-form-pago">
        <label>Proveedor<select id="pg-proveedor"></select></label>
        <label>Monto<input type="number" step="0.01" min="0" id="pg-monto" placeholder="$ 0,00"></label>
        <label>Medio de pago
          <select id="pg-medio">
            <option value="efectivo">Efectivo</option>
            <option value="transferencia">Transferencia</option>
            <option value="cheque">Cheque</option>
          </select>
        </label>
        <button class="pv-btn pv-btn-green" id="pg-submit">💸 Registrar pago</button>
      </div>
      <!-- Solo con cheque: se compra el cheque de un tercero con descuento, y esa diferencia es ganancia -->
      <div class="cheque-row" id="pg-cheque">
        <label for="pg-ganancia">% de ganancia del cheque</label>
        <input type="number" step="0.1" min="0" max="99.9" id="pg-ganancia" value="0">
        <span class="cheque-info" id="pg-cheque-info"></span>
      </div>
      <div class="pv-aviso" id="pg-aviso" role="status"></div>
    </section>

    <section class="pv-card pv-hist">
      <header class="pv-head">
        <span class="pv-ico">🧾</span>
        <div><h3>Pagos registrados</h3><p>Todo lo que ya pagaste, del más nuevo al más viejo.</p></div>
      </header>
      <div class="pv-resumen" id="pagos-resumen"></div>
      <div class="pv-aviso" id="pagos-aviso" role="status"></div>
      <table>
        <thead><tr><th>Fecha</th><th>Proveedor</th><th>Monto</th><th>Medio</th><th>Ganancia cheque</th><th>Pagaste (real)</th><th></th></tr></thead>
        <tbody id="pagos-body"></tbody>
      </table>
    </section>
  `;

  document.getElementById('pr-submit').addEventListener('click', agregarProveedor);
  document.getElementById('pg-submit').addEventListener('click', registrarPago);
  for(const id of ['pg-medio', 'pg-monto', 'pg-ganancia'])
    document.getElementById(id).addEventListener(id === 'pg-medio' ? 'change' : 'input', actualizarCheque);

  await cargarTodo();
})();

// Avisos visibles dentro de cada bloque (los alert() nativos pasaban desapercibidos)
function aviso(id, texto, tipo = 'error'){
  const el = document.getElementById(id);
  el.textContent = texto || '';
  el.className = 'pv-aviso' + (texto ? ' ' + tipo : '');
}

async function cargarTodo(){
  const [{ data: prov }, { data: pg }] = await Promise.all([
    sb.from('proveedores').select('id, nombre, contacto, telefono, activo').order('nombre'),
    sb.from('pagos_proveedores').select('id, created_at, monto_bruto, comision_pct, monto_neto, medio_pago, proveedores(nombre)').eq('anulado', false).order('created_at', { ascending: false })
  ]);
  proveedores = prov || [];
  pagos = pg || [];

  const activos = proveedores.filter(p => p.activo);
  document.getElementById('pg-proveedor').innerHTML = activos.length
    ? activos.map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')
    : '<option value="">— cargá un proveedor primero —</option>';
  renderProveedores();
  renderPagos();
}

function renderProveedores(){
  const tbody = document.getElementById('prov-body');
  if(proveedores.length === 0){
    tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No hay proveedores cargados.</td></tr>`;
    return;
  }
  tbody.innerHTML = proveedores.map(p => `
    <tr${p.activo ? '' : ' style="opacity:.55;"'}>
      <td><b>${esc(p.nombre)}</b></td>
      <td>${esc(p.contacto)}</td>
      <td>${esc(p.telefono)}</td>
      <td><span class="pv-pill ${p.activo ? 'pv-pill-on' : 'pv-pill-off'}">${p.activo ? 'Activo' : 'De baja'}</span></td>
      <td class="pv-acciones">
        <button class="pv-mini ${p.activo ? 'pv-mini-grey' : 'pv-mini-green'}" onclick="window.provToggle(${p.id},${p.activo})">${p.activo ? 'Dar de baja' : 'Reactivar'}</button>
        <button class="pv-mini pv-mini-red" onclick="window.provBorrar(${p.id})">🗑 Borrar</button>
      </td>
    </tr>`).join('');
}

async function provBorrar(id){
  const p = proveedores.find(p => p.id === id);
  if(!p) return;
  aviso('pr-aviso', '');

  // Qué tiene asociado, para avisar bien antes de borrar
  const contar = (tabla, extra) => {
    let q = sb.from(tabla).select('id', { count: 'exact', head: true }).eq('proveedor_id', id);
    if(extra) q = extra(q);
    return q;
  };
  const [{ count: vigentes }, { count: marcas }, { count: lotes }] = await Promise.all([
    contar('pagos_proveedores', q => q.eq('anulado', false)),
    contar('marcas'),
    contar('stock_lotes')
  ]);

  if(vigentes > 0){
    aviso('pr-aviso', `No se puede borrar "${p.nombre}": tiene ${vigentes} pago${vigentes === 1 ? '' : 's'} registrado${vigentes === 1 ? '' : 's'}. Borrá esos pagos en "Pagos registrados" o usá "Dar de baja" para conservar el historial.`);
    return;
  }

  const notas = [];
  if(marcas > 0) notas.push(`${marcas} marca${marcas === 1 ? '' : 's'} quedará${marcas === 1 ? '' : 'n'} sin proveedor`);
  if(lotes > 0) notas.push(`${lotes} lote${lotes === 1 ? '' : 's'} de stock quedará${lotes === 1 ? '' : 'n'} sin proveedor`);
  const detalle = notas.length ? `\n\nAl borrarlo: ${notas.join(' y ')}.` : '';
  if(!(await confirmDialog(`¿Borrar a ${p.nombre}?${detalle}`, { confirmLabel: 'Borrar' }))) return;

  const { error } = await sb.rpc('borrar_proveedor', { p_id: id });
  if(error){
    const m = /PAGOS_VIGENTES:(\d+)/.exec(error.message);
    aviso('pr-aviso', m ? `No se puede borrar: tiene ${m[1]} pago(s) registrado(s). Borralos primero.` : 'No se pudo borrar: ' + error.message);
    return;
  }
  aviso('pr-aviso', `"${p.nombre}" se borró.`, 'ok');
  await cargarTodo();
}

function renderPagos(){
  const tbody = document.getElementById('pagos-body');
  const totalPagado = pagos.reduce((s, p) => s + Number(p.monto_neto), 0);
  const ganCheques = pagos.reduce((s, p) => s + (Number(p.monto_bruto) - Number(p.monto_neto)), 0);
  document.getElementById('pagos-resumen').innerHTML = pagos.length ? `
    <div><span>Pagos</span><b>${pagos.length}</b></div>
    <div><span>Pagaste en total (real)</span><b>${money(totalPagado)}</b></div>
    <div><span>Ganancia en cheques</span><b class="pv-verde">${money(ganCheques)}</b></div>` : '';

  if(pagos.length === 0){
    tbody.innerHTML = `<tr><td colspan="7" class="empty-row">Todavía no hay pagos registrados.</td></tr>`;
    return;
  }
  tbody.innerHTML = pagos.map(p => `
    <tr>
      <td>${dateTime(p.created_at)}</td>
      <td>${p.proveedores ? esc(p.proveedores.nombre) : ''}</td>
      <td>${money(p.monto_bruto)}</td>
      <td><span class="pv-pill pv-medio-${esc(p.medio_pago)}">${MEDIOS[p.medio_pago] || esc(p.medio_pago)}</span></td>
      <td>${Number(p.comision_pct) > 0
        ? `${Number(p.comision_pct)}% · <b class="pv-verde">${money(Number(p.monto_bruto) - Number(p.monto_neto))}</b>` : '—'}</td>
      <td><b>${money(p.monto_neto)}</b></td>
      <td class="pv-acciones"><button class="pv-mini pv-mini-red" onclick="window.pagoBorrar(${p.id})">🗑 Borrar</button></td>
    </tr>`).join('');
}

async function agregarProveedor(){
  const nombre = document.getElementById('pr-nombre').value.trim();
  const contacto = document.getElementById('pr-contacto').value.trim();
  const telefono = document.getElementById('pr-telefono').value.trim();
  aviso('pr-aviso', '');
  if(!nombre){ aviso('pr-aviso', 'Ingresá el nombre del proveedor.'); return; }

  const { error } = await sb.from('proveedores').insert({ nombre, contacto, telefono });
  if(error){ aviso('pr-aviso', 'No se pudo agregar: ' + error.message); return; }

  ['pr-nombre','pr-contacto','pr-telefono'].forEach(id => document.getElementById(id).value = '');
  aviso('pr-aviso', `"${nombre}" agregado.`, 'ok');
  await cargarTodo();
}

async function provToggle(id, estabaActivo){
  aviso('pr-aviso', '');
  const { error } = await sb.from('proveedores').update({ activo: !estabaActivo }).eq('id', id);
  if(error){ aviso('pr-aviso', 'No se pudo actualizar: ' + error.message); return; }
  await cargarTodo();
}

async function registrarPago(){
  const proveedor_id = Number(document.getElementById('pg-proveedor').value);
  const monto_bruto = parseFloat(document.getElementById('pg-monto').value);
  const medio_pago = document.getElementById('pg-medio').value;
  // El % solo existe con cheque; con efectivo o transferencia se paga el monto completo.
  const comision_pct = medio_pago === 'cheque' ? (parseFloat(document.getElementById('pg-ganancia').value) || 0) : 0;
  aviso('pg-aviso', '');

  if(!proveedor_id){ aviso('pg-aviso', 'Agregá un proveedor primero.'); return; }
  if(isNaN(monto_bruto) || monto_bruto <= 0){ aviso('pg-aviso', 'Ingresá un monto válido.'); return; }
  if(comision_pct < 0 || comision_pct >= 100){ aviso('pg-aviso', 'El % de ganancia del cheque tiene que estar entre 0 y 100.'); return; }

  const { error } = await sb.from('pagos_proveedores').insert({ proveedor_id, monto_bruto, medio_pago, comision_pct });
  if(error){ aviso('pg-aviso', 'No se pudo registrar el pago: ' + error.message); return; }

  document.getElementById('pg-monto').value = '';
  document.getElementById('pg-ganancia').value = '0';
  actualizarCheque();
  aviso('pg-aviso', `Pago de ${money(monto_bruto)} registrado.`, 'ok');
  await cargarTodo();
}

// Con cheque aparece el % de ganancia y el cálculo: le pagás al dueño del cheque (en efectivo o
// transferencia) el monto menos ese %, y la diferencia es tu ganancia.
function actualizarCheque(){
  const esCheque = document.getElementById('pg-medio').value === 'cheque';
  document.getElementById('pg-cheque').classList.toggle('open', esCheque);
  if(!esCheque) return;
  const monto = parseFloat(document.getElementById('pg-monto').value);
  const pct = parseFloat(document.getElementById('pg-ganancia').value) || 0;
  const info = document.getElementById('pg-cheque-info');
  if(isNaN(monto) || monto <= 0){ info.textContent = 'Cargá el valor del cheque para ver cuánto le pagás al dueño.'; return; }
  const ganancia = monto * pct / 100;
  info.innerHTML = `Al dueño del cheque le pagás <b>${money(monto - ganancia)}</b> · tu ganancia: <b>${money(ganancia)}</b>`;
}

async function pagoBorrar(id){
  const p = pagos.find(p => p.id === id);
  aviso('pagos-aviso', '');
  const detalle = p ? `${money(p.monto_bruto)} a ${p.proveedores ? p.proveedores.nombre : 'el proveedor'} (${MEDIOS[p.medio_pago] || p.medio_pago})` : 'este pago';
  if(!(await confirmDialog(`¿Borrar el pago de ${detalle}?\nSe elimina definitivamente.`, { confirmLabel: 'Borrar' }))) return;
  // .select() para saber cuántas filas se borraron: sin permiso, Supabase no da error, borra 0
  const { data, error } = await sb.from('pagos_proveedores').delete().eq('id', id).select('id');
  if(error){ aviso('pagos-aviso', 'No se pudo borrar: ' + error.message); return; }
  if(!data || data.length === 0){ aviso('pagos-aviso', 'No se pudo borrar el pago (no tenés permiso o ya no existe).'); await cargarTodo(); return; }
  aviso('pagos-aviso', 'Pago borrado.', 'ok');
  await cargarTodo();
}

Object.assign(window, { provToggle, provBorrar, pagoBorrar });
