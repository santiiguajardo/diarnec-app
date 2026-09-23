import { sb } from '../shared/supabase-client.js';
import { requireAuth, getPerfil } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money, dateTime } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';

let gastos = [];
let soloAdmin = false;
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let editando = null; // id del gasto que se está modificando (null = cargando uno nuevo)

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('caja', 'Caja');

  content.innerHTML = `
    <div class="caja-resumen">
      <div class="caja-card"><span>Ingresos del mes</span><b id="stat-ing-mes" class="pos">$0</b></div>
      <div class="caja-card"><span>Gastos del mes</span><b id="stat-gas-mes" class="neg">$0</b></div>
      <div class="caja-card" id="card-bal-mes"><span>Balance del mes</span><b id="stat-bal-mes">$0</b></div>
      <div class="caja-card destacada" id="card-bal-hist"><span>Balance histórico</span><b id="stat-bal-hist">$0</b></div>
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

  // Los balances (mes e histórico) los ve solo el admin; el encargado ve ingresos y gastos del mes.
  const perfil = await getPerfil();
  soloAdmin = !!perfil && perfil.rol === 'admin';
  if(!soloAdmin){
    document.getElementById('card-bal-mes').remove();
    document.getElementById('card-bal-hist').remove();
    document.querySelector('.caja-resumen').classList.add('sin-balances');
  }

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

// Primer instante del mes actual en Argentina (UTC-3, sin horario de verano).
function inicioMesAR(){
  const [y, m] = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }).split('-');
  return new Date(`${y}-${m}-01T00:00:00-03:00`);
}

async function cargarTodo(){
  const [{ data: gs }, { data: pagosVend }, { data: pagosCli }, { data: pagosProv }] = await Promise.all([
    sb.from('gastos').select('id, fecha, created_at, descripcion, monto').eq('anulado', false).order('created_at', { ascending: false }),
    sb.from('pagos_vendedores').select('created_at, monto').eq('anulado', false),
    sb.from('pagos_clientes').select('created_at, monto').eq('anulado', false),
    sb.from('pagos_proveedores').select('created_at, monto_neto').eq('anulado', false)
  ]);
  gastos = gs || [];

  // Misma cuenta que el Dashboard. La plata entra cuando se REGISTRA UN PAGO (de un vendedor o de un cliente):
  // un retiro de mercadería o una venta todavía no es un ingreso, es una deuda a cobrar.
  // Egresos = gastos cargados + pagos a proveedores. Las bonificaciones y devoluciones son créditos, no salen de la caja.
  // "Del mes" es el mes calendario actual (hora de Argentina); el histórico es todo desde el principio.
  const desdeMes = inicioMesAR();
  const suma = (filas, campo, soloMes) => (filas || []).reduce((s, f) =>
    (!soloMes || new Date(f.created_at) >= desdeMes) ? s + Number(f[campo]) : s, 0);

  const ingHist = suma(pagosVend, 'monto', false) + suma(pagosCli, 'monto', false);
  const gasHist = suma(gastos, 'monto', false) + suma(pagosProv, 'monto_neto', false);
  const ingMes = suma(pagosVend, 'monto', true) + suma(pagosCli, 'monto', true);
  const gasMes = suma(gastos, 'monto', true) + suma(pagosProv, 'monto_neto', true);

  const pintar = (id, valor, conColor) => {
    const el = document.getElementById(id);
    el.textContent = money(valor);
    if(conColor) el.className = valor >= 0 ? 'pos' : 'neg';
  };
  pintar('stat-ing-mes', ingMes, false);
  pintar('stat-gas-mes', gasMes, false);
  if(soloAdmin){
    pintar('stat-bal-mes', ingMes - gasMes, true);
    pintar('stat-bal-hist', ingHist - gasHist, true);
  }

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
      <td class="wrap">${esc(g.descripcion)}</td>
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
