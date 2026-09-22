import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money, dateTime } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';

let gastos = [];
let seleccionado = null; // id del gasto elegido para editar/borrar

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('caja', 'Caja');

  content.innerHTML = `
    <div class="caja-bar">
      <div class="left">
        <div><span>Cobros:</span><b id="stat-cobros">$0.00</b></div>
        <div><span>Salidas:</span><b class="salidas" id="stat-salidas">$0.00</b></div>
      </div>
      <div><span>CAJA REAL:</span><b class="real" id="stat-real">$0.00</b></div>
    </div>

    <div class="admin-section">
      <h3>Gastos</h3>
      <div class="gasto-form">
        <input type="text" id="g-detalle" placeholder="Detalle del gasto...">
        <input type="number" step="0.01" id="g-monto" placeholder="Monto $">
        <button class="btn-sm btn-green" id="g-registrar">+ Registrar</button>
        <button class="btn-sm btn-orange" id="g-guardar" disabled>✏️ Guardar cambios</button>
        <button class="btn-sm btn-del" id="g-borrar" disabled>🗑 Borrar</button>
      </div>
      <p class="hint">* Hacé clic sobre un gasto en la tabla para modificarlo o borrarlo.</p>
      <table>
        <thead><tr><th>ID</th><th>Fecha y hora</th><th>Detalle del gasto</th><th>Monto ($)</th></tr></thead>
        <tbody id="gastos-body"></tbody>
      </table>
    </div>
  `;

  document.getElementById('g-registrar').addEventListener('click', registrar);
  document.getElementById('g-guardar').addEventListener('click', guardarCambios);
  document.getElementById('g-borrar').addEventListener('click', borrar);

  await cargarTodo();
})();

async function cargarTodo(){
  const [{ data: gs }, { data: ventas }, { data: pagosProv }, { data: pagosVend }, { data: bonis }] = await Promise.all([
    sb.from('gastos').select('id, fecha, created_at, descripcion, monto').eq('anulado', false).order('created_at', { ascending: false }),
    sb.from('ventas').select('total_neto').eq('estado', 'confirmada'),
    sb.from('pagos_proveedores').select('monto_neto').eq('anulado', false),
    sb.from('pagos_vendedores').select('monto').eq('anulado', false),
    sb.from('bonificaciones').select('monto').eq('anulado', false)
  ]);
  gastos = gs || [];

  const cobros = (ventas||[]).reduce((s,v) => s + Number(v.total_neto), 0);
  const salidas = (gastos||[]).reduce((s,g) => s + Number(g.monto), 0)
    + (pagosProv||[]).reduce((s,p) => s + Number(p.monto_neto), 0)
    + (pagosVend||[]).reduce((s,p) => s + Number(p.monto), 0)
    + (bonis||[]).reduce((s,b) => s + Number(b.monto), 0);
  const real = cobros - salidas;

  document.getElementById('stat-cobros').textContent = money(cobros);
  document.getElementById('stat-salidas').textContent = money(salidas);
  const realEl = document.getElementById('stat-real');
  realEl.textContent = money(real);
  realEl.className = 'real ' + (real >= 0 ? 'pos' : 'neg');

  render();
}

function render(){
  const tbody = document.getElementById('gastos-body');
  if(gastos.length === 0){
    tbody.innerHTML = `<tr><td colspan="4" class="empty-row">No hay gastos registrados.</td></tr>`;
    return;
  }
  tbody.innerHTML = gastos.map(g => `
    <tr class="${g.id === seleccionado ? 'selected' : ''}" onclick="window.gastoSeleccionar(${g.id})">
      <td>${g.id}</td>
      <td>${dateTime(g.created_at)}</td>
      <td class="wrap">${g.descripcion}</td>
      <td>${money(g.monto)}</td>
    </tr>`).join('');

  const hay = seleccionado !== null;
  document.getElementById('g-guardar').disabled = !hay;
  document.getElementById('g-borrar').disabled = !hay;
}

function gastoSeleccionar(id){
  if(seleccionado === id){
    seleccionado = null;
    document.getElementById('g-detalle').value = '';
    document.getElementById('g-monto').value = '';
  } else {
    seleccionado = id;
    const g = gastos.find(g => g.id === id);
    document.getElementById('g-detalle').value = g.descripcion;
    document.getElementById('g-monto').value = g.monto;
  }
  render();
}

async function registrar(){
  const descripcion = document.getElementById('g-detalle').value.trim();
  const monto = parseFloat(document.getElementById('g-monto').value);
  if(!descripcion || isNaN(monto) || monto <= 0){ alert('Completá el detalle y un monto válido.'); return; }

  const { error } = await sb.from('gastos').insert({ descripcion, monto });
  if(error){ alert('No se pudo registrar: ' + error.message); return; }

  document.getElementById('g-detalle').value = '';
  document.getElementById('g-monto').value = '';
  await cargarTodo();
}

async function guardarCambios(){
  if(seleccionado === null) return;
  const descripcion = document.getElementById('g-detalle').value.trim();
  const monto = parseFloat(document.getElementById('g-monto').value);
  if(!descripcion || isNaN(monto) || monto <= 0){ alert('Completá el detalle y un monto válido.'); return; }

  const { error } = await sb.from('gastos').update({ descripcion, monto }).eq('id', seleccionado);
  if(error){ alert('No se pudo guardar: ' + error.message); return; }

  seleccionado = null;
  document.getElementById('g-detalle').value = '';
  document.getElementById('g-monto').value = '';
  await cargarTodo();
}

async function borrar(){
  if(seleccionado === null) return;
  if(!(await confirmDialog('¿Borrar este gasto?'))) return;

  const { error } = await sb.from('gastos').delete().eq('id', seleccionado);
  if(error){ alert('No se pudo borrar: ' + error.message); return; }

  seleccionado = null;
  document.getElementById('g-detalle').value = '';
  document.getElementById('g-monto').value = '';
  await cargarTodo();
}

Object.assign(window, { gastoSeleccionar });
