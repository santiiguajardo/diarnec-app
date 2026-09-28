import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money } from '../shared/format.js';
import { promptDialog } from '../shared/dialogs.js';
import { normalizarTelefono } from '../shared/remito.js';

// Cobranzas: quién te debe (vendedores, clientes directos y la tienda online), de mayor a menor deuda,
// con un botón para reclamar el pago por WhatsApp con el mensaje ya armado.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KEY_MSG = 'diarnec_msg_cobranza';
const MSG_DEFECTO = 'Hola {nombre}, te escribimos de DIARNEC. Tu saldo pendiente al {fecha} es de {saldo}. ¿Cuándo podemos coordinar el pago? ¡Gracias!';
const TIPO_LABEL = { vendedor: 'Vendedor', cliente: 'Cliente', online: 'Tienda online' };

let filas = [];
let verTodas = false;

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('cobranzas', 'Cobranzas');

  content.innerHTML = `
    <div class="admin-section">
      <h3>¿Quién me debe?</h3>
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px;">
        Son los saldos de las cuentas corrientes (lo retirado o comprado, menos devoluciones, bonificaciones y pagos). Tocá <b>Cobrar por WhatsApp</b> y se abre la conversación con el mensaje listo para enviar.
      </p>
      <div class="cb-resumen" id="cb-resumen"></div>
      <label class="cb-check"><input type="checkbox" id="cb-todas"> Mostrar también las cuentas sin deuda</label>
      <table class="cb-tabla">
        <thead><tr><th>Cuenta</th><th>Tipo</th><th class="num">Debe</th><th></th></tr></thead>
        <tbody id="cb-body"><tr><td colspan="4" class="empty-row">Cargando...</td></tr></tbody>
      </table>
    </div>

    <div class="admin-section">
      <h3>Mensaje de cobranza</h3>
      <p style="color:var(--muted);font-size:13px;margin-bottom:8px;">Podés cambiarlo. Se reemplaza <b>{nombre}</b>, <b>{saldo}</b> y <b>{fecha}</b>. Queda guardado en este navegador.</p>
      <textarea id="cb-msg" rows="3" maxlength="500"></textarea>
      <div class="cb-msg-acc"><button class="btn-sm" id="cb-msg-restaurar">Volver al mensaje original</button><span id="cb-msg-vista" class="cb-vista"></span></div>
    </div>
  `;

  const ta = document.getElementById('cb-msg');
  ta.value = leerPlantilla();
  ta.addEventListener('input', () => { guardarPlantilla(ta.value); vistaPrevia(); });
  document.getElementById('cb-msg-restaurar').addEventListener('click', () => { ta.value = MSG_DEFECTO; guardarPlantilla(MSG_DEFECTO); vistaPrevia(); });
  document.getElementById('cb-todas').addEventListener('change', e => { verTodas = e.target.checked; render(); });
  document.getElementById('cb-body').addEventListener('click', onClick);

  await cargar();
  vistaPrevia();
})();

function leerPlantilla(){
  try { const v = localStorage.getItem(KEY_MSG); if(v && v.trim()) return v.slice(0, 500); } catch(e){ /* sin storage */ }
  return MSG_DEFECTO;
}
function guardarPlantilla(v){ try { localStorage.setItem(KEY_MSG, v); } catch(e){ /* sin storage */ } }

function fechaHoy(){
  const d = new Date();
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function armarMensaje(f){
  return document.getElementById('cb-msg').value
    .replace(/\{nombre\}/gi, f.nombre).replace(/\{saldo\}/gi, money(f.debe)).replace(/\{fecha\}/gi, fechaHoy());
}

function vistaPrevia(){
  const f = filas.find(x => x.debe > 0.005) || { nombre: 'Juan', debe: 125000 };
  document.getElementById('cb-msg-vista').textContent = 'Así se ve: ' + armarMensaje(f);
}

async function cargar(){
  const [{ data: sv, error: e1 }, { data: vd }, { data: sc, error: e2 }, { data: cl }] = await Promise.all([
    sb.from('vendedores_saldo').select('*'),
    sb.from('vendedores').select('id, nombre, telefono, activo, es_canal_online'),
    sb.from('clientes_saldo').select('*'),
    sb.from('clientes').select('id, nombre, telefono, activo, vendedor_id').is('vendedor_id', null)
  ]);
  if(e1 || e2){
    document.getElementById('cb-body').innerHTML = `<tr><td colspan="4" class="empty-row">No se pudieron cargar las cuentas: ${esc((e1 || e2).message)}</td></tr>`;
    return;
  }
  const vend = new Map((vd || []).map(v => [v.id, v]));
  const cli = new Map((cl || []).map(c => [c.id, c]));

  filas = [];
  (sv || []).forEach(r => {
    const v = vend.get(r.vendedor_id);
    if(!v || (!v.activo && !v.es_canal_online)) return;
    const debe = Number(r.retirado) - Number(r.devuelto) - Number(r.pagado) - Number(r.bonificado);
    filas.push({ tipo: v.es_canal_online ? 'online' : 'vendedor', id: v.id, nombre: v.es_canal_online ? 'Tienda online' : v.nombre, telefono: v.telefono || '', debe });
  });
  (sc || []).forEach(r => {
    const c = cli.get(r.cliente_id);
    if(!c || !c.activo) return;
    filas.push({ tipo: 'cliente', id: c.id, nombre: c.nombre, telefono: c.telefono || '', debe: Number(r.comprado) - Number(r.devuelto) - Number(r.pagado) });
  });
  filas.sort((a, b) => b.debe - a.debe);
  render();
}

function render(){
  const conDeuda = filas.filter(f => f.debe > 0.005);
  const total = conDeuda.reduce((s, f) => s + f.debe, 0);
  document.getElementById('cb-resumen').innerHTML =
    `<div class="cb-card"><small>Por cobrar en total</small><b>${money(total)}</b></div>` +
    `<div class="cb-card"><small>Cuentas con deuda</small><b>${conDeuda.length}</b></div>`;

  const lista = verTodas ? filas : conDeuda;
  const body = document.getElementById('cb-body');
  if(!lista.length){
    body.innerHTML = `<tr><td colspan="4" class="empty-row">${filas.length ? '🎉 Nadie te debe nada en este momento.' : 'Todavía no hay cuentas.'}</td></tr>`;
    return;
  }
  body.innerHTML = lista.map(f => {
    const i = filas.indexOf(f);
    let accion;
    if(f.tipo === 'online') accion = `<a class="btn-sm btn-grey" href="tienda-online.html">Ver la tienda online</a>`;
    else if(f.debe <= 0.005) accion = '';
    else if(normalizarTelefono(f.telefono).length >= 12) accion = `<button class="btn-sm btn-wa" data-a="cobrar" data-i="${i}">💬 Cobrar por WhatsApp</button>`;
    else accion = `<button class="btn-sm" data-a="tel" data-i="${i}">Cargar WhatsApp</button>`;
    return `<tr class="${f.debe > 0.005 ? '' : 'sin-deuda'}">
      <td><b>${esc(f.nombre)}</b>${f.telefono ? `<div class="cb-tel">${esc(f.telefono)}</div>` : ''}</td>
      <td><span class="cb-tag cb-${f.tipo}">${TIPO_LABEL[f.tipo]}</span></td>
      <td class="num ${f.debe > 0.005 ? 'debe' : ''}">${money(f.debe)}</td>
      <td class="acc">${accion}</td>
    </tr>`;
  }).join('');
}

async function onClick(e){
  const btn = e.target.closest('button[data-a]');
  if(!btn) return;
  const f = filas[Number(btn.dataset.i)];
  if(!f) return;

  if(btn.dataset.a === 'cobrar'){
    const url = `https://wa.me/${normalizarTelefono(f.telefono)}?text=${encodeURIComponent(armarMensaje(f))}`;
    window.open(url, '_blank', 'noopener');
    return;
  }

  // Cargar el WhatsApp de esa cuenta y seguir
  const nuevo = await promptDialog(`WhatsApp de ${f.nombre} (con código de área, sin 0 ni 15):`, f.telefono);
  if(nuevo === null) return;
  const tel = nuevo.trim();
  if(tel.replace(/\D/g, '').length < 8){ alert('Ese número no parece válido.'); return; }
  const { error } = await sb.from(f.tipo === 'vendedor' ? 'vendedores' : 'clientes').update({ telefono: tel }).eq('id', f.id);
  if(error){ alert('No se pudo guardar: ' + error.message); return; }
  f.telefono = tel;
  render();
}
