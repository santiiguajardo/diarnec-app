// Alerta para admin/encargado: los vendedores informan sus pagos desde su panel y acá se verifican.
// Confirmar crea el pago real (pagos_vendedores) y pasa directo a la cuenta corriente; rechazar lo descarta con un motivo.
// Cada minuto (y al volver a la pestaña) se buscan los pagos pendientes: se muestra una barra arriba de la página y,
// si llega uno nuevo con el panel abierto, un cartel.

import { sb } from './supabase-client.js';
import { money, dateTime } from './format.js';
import { confirmDialog, promptDialog } from './dialogs.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MEDIO = { efectivo: 'Efectivo', transferencia: 'Transferencia' };

let lista = [];
let cantidadAnterior = null;
let modal = null;
let iniciado = false;

// Las páginas que muestran saldos (Movimientos) escuchan esto para recargarse apenas se confirma un pago.
export const EVENTO_PAGO_CONFIRMADO = 'diarnec:pago-confirmado';

export async function refrescarPagosPorVerificar(){
  const { data, error } = await sb.from('pagos_informados')
    .select('id, monto, medio_pago, nota, created_at, vendedores(nombre)')
    .eq('estado', 'pendiente').order('created_at', { ascending: true });
  if(error) return; // sin conexión o sin la tabla: no se toca lo que ya se mostraba
  lista = data || [];
  pintarBarra();
  if(modal) pintarModal();
  if(cantidadAnterior !== null && lista.length > cantidadAnterior){
    const n = lista.length - cantidadAnterior;
    cartel(n === 1 ? '💵 Un vendedor informó un pago para verificar' : `💵 Los vendedores informaron ${n} pagos para verificar`);
  }
  cantidadAnterior = lista.length;
}

function pintarBarra(){
  let barra = document.getElementById('alerta-pagos');
  if(lista.length === 0){ if(barra) barra.remove(); return; }
  if(!barra){
    const topbar = document.querySelector('.admin-topbar');
    if(!topbar) return;
    barra = document.createElement('div');
    barra.id = 'alerta-pagos';
    barra.className = 'alerta-pagos';
    topbar.insertAdjacentElement('afterend', barra);
  }
  const total = lista.reduce((s, p) => s + Number(p.monto), 0);
  barra.innerHTML = `
    <span>💵 <b>${lista.length} pago${lista.length === 1 ? '' : 's'} informado${lista.length === 1 ? '' : 's'} por vendedores</b> esperando que verifiques si entraron (${money(total)} en total).</span>
    <button type="button" id="alerta-pagos-ver">Verificar ahora</button>`;
  document.getElementById('alerta-pagos-ver').addEventListener('click', abrirModal);
}

function cartel(texto){
  document.querySelectorAll('[data-cartel-pago]').forEach(x => x.remove());
  const t = document.createElement('button');
  t.type = 'button';
  t.dataset.cartelPago = '1';
  t.textContent = texto;
  t.className = 'cartel-pago';
  t.addEventListener('click', () => { t.remove(); abrirModal(); });
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 9000);
}

// ---------- verificación ----------

function abrirModal(){
  if(modal) return;
  modal = document.createElement('div');
  modal.className = 'app-confirm-overlay';
  modal.innerHTML = '<div class="app-confirm-box pagos-box"></div>';
  modal.addEventListener('click', e => { if(e.target === modal) cerrarModal(); });
  document.body.appendChild(modal);
  modal.addEventListener('click', onClick);
  pintarModal();
}

function cerrarModal(){
  if(!modal) return;
  modal.remove();
  modal = null;
}

function pintarModal(){
  const box = modal.querySelector('.pagos-box');
  box.innerHTML = `
    <h3>💵 Pagos por verificar</h3>
    <p class="pagos-ayuda">Mirá en tu cuenta o en la caja si el pago entró. Al <b>confirmar</b> pasa a la cuenta corriente del vendedor; si no llegó, <b>rechazalo</b>.</p>
    ${lista.length === 0
      ? '<div class="pagos-vacio">No hay pagos esperando verificación. 👌</div>'
      : lista.map(p => `
        <div class="pago-fila" data-id="${p.id}">
          <div class="pago-info">
            <b>${esc(p.vendedores ? p.vendedores.nombre : 'Vendedor')}</b> informó
            <span class="pago-monto">${money(p.monto)}</span> · ${esc(MEDIO[p.medio_pago] || p.medio_pago)}
            <small>${dateTime(p.created_at)}${p.nota ? ' — ' + esc(p.nota) : ''}</small>
          </div>
          <div class="pago-botones">
            <button type="button" class="pago-ok" data-act="confirmar">✔ Confirmar</button>
            <button type="button" class="pago-no" data-act="rechazar">✖ Rechazar</button>
          </div>
        </div>`).join('')}
    <div id="pagos-err" class="pagos-err"></div>
    <div class="app-confirm-actions"><button type="button" class="app-confirm-cancel" data-act="cerrar">Cerrar</button></div>`;
}

async function onClick(e){
  const b = e.target.closest('button[data-act]');
  if(!b) return;
  if(b.dataset.act === 'cerrar'){ cerrarModal(); return; }
  const fila = b.closest('.pago-fila');
  const p = fila && lista.find(x => x.id === Number(fila.dataset.id));
  if(!p) return;
  const err = modal.querySelector('#pagos-err');
  err.textContent = '';
  const quien = p.vendedores ? p.vendedores.nombre : 'el vendedor';

  let confirmar = b.dataset.act === 'confirmar';
  let motivo = '';
  if(confirmar){
    if(!(await confirmDialog(`¿Confirmás que entró el pago de ${money(p.monto)} (${MEDIO[p.medio_pago] || p.medio_pago}) de ${quien}?\nPasa directo a su cuenta corriente.`, { confirmLabel: 'Sí, entró' }))) return;
  } else {
    const r = await promptDialog(`Rechazar el pago de ${money(p.monto)} de ${quien}.\nMotivo (se lo mostramos al vendedor):`, 'No lo vi entrar');
    if(r === null) return;
    motivo = r.trim();
  }

  fila.querySelectorAll('button').forEach(x => { x.disabled = true; });
  const { error } = await sb.rpc('resolver_pago_informado', { p_id: p.id, p_confirmar: confirmar, p_motivo: motivo });
  if(error){
    fila.querySelectorAll('button').forEach(x => { x.disabled = false; });
    if(modal) modal.querySelector('#pagos-err').textContent = error.message;
    await refrescarPagosPorVerificar(); // por si lo resolvió otra persona mientras tanto
    return;
  }
  if(confirmar) window.dispatchEvent(new CustomEvent(EVENTO_PAGO_CONFIRMADO));
  await refrescarPagosPorVerificar();
}

export function iniciarPagosPorVerificar(){
  if(iniciado) return;
  iniciado = true;
  refrescarPagosPorVerificar();
  setInterval(refrescarPagosPorVerificar, 60000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) refrescarPagosPorVerificar(); });
}
