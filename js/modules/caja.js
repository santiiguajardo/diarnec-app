import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money, dateTime } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';

let gastos = [];
let editando = null; // id del gasto que se está modificando (null = cargando uno nuevo)

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
      <h3 id="g-titulo">Registrar gasto</h3>
      <div class="gasto-form">
        <input type="text" id="g-detalle" placeholder="Detalle del gasto...">
        <input type="number" step="0.01" id="g-monto" placeholder="Monto $">
        <button class="btn-sm btn-green" id="g-registrar">+ Registrar</button>
        <button class="btn-sm btn-grey" id="g-cancelar" hidden>Cancelar</button>
      </div>
      <table>
        <thead><tr><th>Fecha y hora</th><th>Detalle del gasto</th><th>Monto ($)</th><th></th></tr></thead>
        <tbody id="gastos-body"></tbody>
      </table>
    </div>
  `;

  document.getElementById('g-registrar').addEventListener('click', registrar);
  document.getElementById('g-cancelar').addEventListener('click', cancelarEdicion);
  document.getElementById('gastos-body').addEventListener('click', e => {
    const btn = e.target.closest('button[data-act]');
    if(!btn) return;
    const id = Number(btn.dataset.id);
    if(btn.dataset.act === 'editar') empezarEdicion(id);
    else if(btn.dataset.act === 'borrar') borrar(id);
  });

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

  // Si el gasto que se estaba editando ya no existe (lo borraron en otra pestaña, etc.), se sale del modo edición.
  if(editando !== null && !gastos.some(g => g.id === editando)) cancelarEdicion();
  render();
}

function render(){
  const tbody = document.getElementById('gastos-body');
  if(gastos.length === 0){
    tbody.innerHTML = `<tr><td colspan="4" class="empty-row">No hay gastos registrados.</td></tr>`;
    return;
  }
  tbody.innerHTML = gastos.map(g => `
    <tr class="${g.id === editando ? 'selected' : ''}">
      <td>${dateTime(g.created_at)}</td>
      <td class="wrap">${g.descripcion}</td>
      <td>${money(g.monto)}</td>
      <td class="row-btns">
        <button class="btn-sm btn-edit" data-act="editar" data-id="${g.id}">✏️ Modificar</button>
        <button class="btn-sm btn-del" data-act="borrar" data-id="${g.id}">🗑 Borrar</button>
      </td>
    </tr>`).join('');
}

// El formulario de arriba pasa a modo "editando #N": mismo formulario, título distinto, y el
// botón cambia de "+ Registrar" a "✏️ Guardar cambios" — así queda claro en qué modo se está.
function empezarEdicion(id){
  const g = gastos.find(g => g.id === id);
  if(!g) return;
  editando = id;
  document.getElementById('g-detalle').value = g.descripcion;
  document.getElementById('g-monto').value = g.monto;
  document.getElementById('g-titulo').textContent = `Modificando el gasto del ${dateTime(g.created_at)}`;
  document.getElementById('g-registrar').textContent = '✏️ Guardar cambios';
  document.getElementById('g-cancelar').hidden = false;
  document.getElementById('g-detalle').focus();
  render();
}

function cancelarEdicion(){
  editando = null;
  document.getElementById('g-detalle').value = '';
  document.getElementById('g-monto').value = '';
  document.getElementById('g-titulo').textContent = 'Registrar gasto';
  document.getElementById('g-registrar').textContent = '+ Registrar';
  document.getElementById('g-cancelar').hidden = true;
  render();
}

// Un solo botón hace las dos cosas según el modo (registrar uno nuevo o guardar el que se está editando).
async function registrar(){
  const descripcion = document.getElementById('g-detalle').value.trim();
  const monto = parseFloat(document.getElementById('g-monto').value);
  if(!descripcion || isNaN(monto) || monto <= 0){ alert('Completá el detalle y un monto válido.'); return; }

  const { error } = editando === null
    ? await sb.from('gastos').insert({ descripcion, monto })
    : await sb.from('gastos').update({ descripcion, monto }).eq('id', editando);
  if(error){ alert('No se pudo guardar: ' + error.message); return; }

  cancelarEdicion();
  await cargarTodo();
}

async function borrar(id){
  const g = gastos.find(g => g.id === id);
  if(!(await confirmDialog(`¿Borrar el gasto "${g ? g.descripcion : ''}" de ${g ? money(g.monto) : ''}?\nSe elimina definitivamente.`, { confirmLabel: 'Borrar' }))) return;

  const { error } = await sb.from('gastos').delete().eq('id', id);
  if(error){ alert('No se pudo borrar: ' + error.message); return; }

  if(editando === id) cancelarEdicion();
  await cargarTodo();
}
