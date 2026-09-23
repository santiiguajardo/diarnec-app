// Panel del vendedor: ve solo lo suyo (cuenta corriente por semana, movimientos, cartera de clientes con
// ranking, ventas con remito por WhatsApp) y la lista de precios en vivo.
// Todo llega por funciones mi_* de la base, que devuelven/modifican únicamente lo del vendedor logueado.

import { sb } from '../shared/supabase-client.js';
import { requireVendedor, logout } from '../shared/auth-guard.js';
import { USERNAME_EMAIL_DOMAIN } from '../shared/supabase-config.js';
import { money, dateTime } from '../shared/format.js';
import { confirmDialog, instalarAvisos } from '../shared/dialogs.js';
import { createProductPicker } from '../shared/product-picker.js';
import { ajustarInputCantidad, cantidadEsValida, mensajeCantidad } from '../shared/cantidad.js';
import { descargarRemito, compartirRemitoWhatsApp, normalizarTelefono } from '../shared/remito.js';

instalarAvisos();

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const $ = id => document.getElementById(id);

const TIPO_LABEL = {
  venta: 'Retiro / venta', devolucion: 'Devolución', devolucion_stock: 'Devolución de stock',
  bonificacion: 'Bonificación', pago: 'Pago'
};
const CHIPS = [
  ['', 'Todos'], ['venta', 'Ventas'], ['devolucion', 'Devoluciones'], ['bonificacion', 'Bonificaciones'], ['pago', 'Pagos']
];
const PERIODOS = [['mes', 'Este mes'], ['30', 'Últimos 30 días'], ['todo', 'Todo el tiempo']];
const REFRESCO_PRECIOS_MS = 15000;
const DIAS_DORMIDO = 30;

let movimientos = [];
let cartera = [];
let precios = [];
let filtroMov = '';
let tabActual = 'resumen';
let periodo = 'mes';

// semana elegida y semana con la que se compara (índices en `semanas`, 0 = semana actual; -1 = sin comparar)
let semanas = [];
let semSel = 0;
let semCmp = -1;
let panelGlobal = null;

let clienteEditando = null;
let ventaCliente = null;
let remitoActual = null;

// ---------- utilidades ----------

const pad = n => String(n).padStart(2, '0');
const isoLocal = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function desdePeriodo(p){
  const h = new Date();
  if(p === 'mes') return isoLocal(new Date(h.getFullYear(), h.getMonth(), 1));
  if(p === '30'){ const d = new Date(h); d.setDate(d.getDate() - 29); return isoLocal(d); }
  return null;
}
const fmtDia = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
const etiquetaSemana = s => `${fmtDia(s.desde)} al ${fmtDia(s.hasta)}`;
const fmtSaldo = n => n > 0.005 ? `${money(n)} a pagar` : (n < -0.005 ? `${money(-n)} a favor` : money(0));

function avisar(texto){
  const t = document.createElement('div');
  t.textContent = texto;
  t.style.cssText = 'position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#122436;color:#fff;padding:11px 18px;border-radius:10px;font-size:13px;z-index:500;box-shadow:0 8px 24px rgba(0,0,0,.25);max-width:90vw;';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

const abrirModal = id => $(id).classList.add('open');
const cerrarModal = id => $(id).classList.remove('open');

// ---------- arranque ----------

(async function init(){
  const session = await requireVendedor();
  if(!session) return;
  $('mp-usuario').textContent = session.user.email.replace(USERNAME_EMAIL_DOMAIN, '');
  $('mp-salir').addEventListener('click', logout);

  $('mp-tabs').addEventListener('click', e => {
    const b = e.target.closest('button[data-tab]');
    if(b) abrirTab(b.dataset.tab);
  });
  $('mov-chips').innerHTML = CHIPS.map(([k, l]) => `<button data-k="${k}" class="${k === '' ? 'active' : ''}">${l}</button>`).join('');
  $('mov-chips').addEventListener('click', e => {
    const b = e.target.closest('button[data-k]');
    if(!b) return;
    filtroMov = b.dataset.k;
    document.querySelectorAll('#mov-chips button').forEach(x => x.classList.toggle('active', x === b));
    $('mov-lista').innerHTML = htmlMovimientos(movimientos.filter(filtrarMov));
  });
  $('cartera-buscar').addEventListener('input', renderCartera);
  $('precios-buscar').addEventListener('input', renderPrecios);
  $('precios-pdf').addEventListener('click', descargarPDF);

  // Cartera: ranking, tabla, modales
  $('ranking').addEventListener('click', onClickRanking);
  $('cartera-body').addEventListener('click', onClickCartera);
  $('cliente-nuevo').addEventListener('click', () => abrirCliente(null));
  $('cl-cancelar').addEventListener('click', () => cerrarModal('modal-cliente'));
  $('cl-guardar').addEventListener('click', guardarCliente);
  $('vt-add').addEventListener('click', () => agregarFilaVenta());
  $('vt-cancelar').addEventListener('click', () => cerrarModal('modal-venta'));
  $('vt-confirmar').addEventListener('click', confirmarVenta);
  $('rm-cerrar').addEventListener('click', () => cerrarModal('modal-remito'));
  $('rm-pdf').addEventListener('click', () => accionRemito('pdf'));
  $('rm-wa').addEventListener('click', () => accionRemito('wa'));
  $('rh-cerrar').addEventListener('click', () => cerrarModal('modal-remitos'));
  $('rh-lista').addEventListener('click', onClickHistorial);

  // La lista de precios se mantiene al día sola mientras se mira (y al volver a la pestaña)
  setInterval(() => { if(tabActual === 'precios' && !document.hidden) cargarPrecios(); }, REFRESCO_PRECIOS_MS);
  document.addEventListener('visibilitychange', () => { if(!document.hidden && tabActual === 'precios') cargarPrecios(); });

  await abrirTab('resumen');
})();

async function abrirTab(tab){
  tabActual = tab;
  document.querySelectorAll('#mp-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.mp-sec').forEach(s => s.classList.toggle('active', s.id === `sec-${tab}`));
  if(tab === 'resumen') await cargarResumen();
  else if(tab === 'movimientos') await cargarMovimientos();
  else if(tab === 'cartera') await cargarCartera();
  else if(tab === 'precios') await cargarPrecios();
}

// ===== Movimientos (lista reutilizada en "Mis movimientos" y en la semana elegida) =====

const filtrarMov = m => !filtroMov || m.tipo === filtroMov || (filtroMov === 'devolucion' && m.tipo === 'devolucion_stock');

function htmlMovimientos(list){
  if(list.length === 0) return '<div class="empty">No hay movimientos para mostrar.</div>';
  return list.map(m => {
    // ventas suman a lo que le corresponde pagar; devoluciones, bonificaciones y pagos lo restan
    const suma = m.tipo === 'venta';
    const detalle = m.tipo === 'venta'
      ? `Venta #${m.id}${m.cliente ? ' — ' + esc(m.cliente) : ''}`
      : `${TIPO_LABEL[m.tipo]} #${m.id}${m.motivo ? ' — ' + esc(m.motivo) : ''}${m.medio ? ' (' + esc(m.medio) + ')' : ''}`;
    const items = (m.items || []).length ? `
      <table>
        <thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Precio</th><th class="r">Subtotal</th></tr></thead>
        <tbody>${m.items.map(i => `<tr><td><b>${esc(i.marca || '')}</b> ${esc(i.producto)}${i.unidad ? ' <small>' + esc(i.unidad) + '</small>' : ''}</td>
          <td class="r">${Number(i.cantidad)}</td><td class="r">${money(i.precio)}</td><td class="r">${money(i.subtotal)}</td></tr>`).join('')}</tbody>
      </table>` : '';
    const pie = m.tipo === 'venta'
      ? `<div style="text-align:right;margin-top:6px;">Total ${money(m.bruto)} · comisión <b class="neg">${money(m.comision)}</b> · a pagar <b>${money(m.importe)}</b></div>` : '';
    return `
      <details class="mov ${m.anulado ? 'anulado' : ''}">
        <summary>
          <span class="f">${dateTime(m.fecha)}</span>
          <span><span class="tag tag-${m.tipo}">${TIPO_LABEL[m.tipo]}</span></span>
          <span>${detalle}${m.anulado ? ' <small>[anulado]</small>' : ''}</span>
          <span class="imp ${m.anulado || suma ? '' : 'mas'}">${suma ? '' : '−'}${money(m.importe)}</span>
        </summary>
        <div class="mov-detalle">${items || '<span style="color:var(--muted);">Sin detalle de productos.</span>'}${pie}</div>
      </details>`;
  }).join('');
}

async function cargarMovimientos(){
  $('mov-lista').innerHTML = '<div class="empty">Cargando…</div>';
  const { data, error } = await sb.rpc('mis_movimientos');
  if(error){ $('mov-lista').innerHTML = `<div class="empty">No se pudieron cargar tus movimientos: ${esc(error.message)}</div>`; return; }
  movimientos = data || [];
  $('mov-lista').innerHTML = htmlMovimientos(movimientos.filter(filtrarMov));
}

// ===== Resumen: tu cuenta, la semana día por día y las semanas anteriores =====

const NOMBRE_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const enAR = d => new Date(d).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' }); // yyyy-mm-dd
const hoyAR = () => enAR(Date.now());

async function cargarResumen(){
  const [{ data: p, error }, { data: sem, error: errSem }] = await Promise.all([
    sb.rpc('mi_panel'), sb.rpc('mi_semanas', { p_cantidad: 12 })
  ]);
  if(error || !p){
    $('res-kpis').innerHTML = `<div class="mp-card empty">No se pudo cargar tu resumen: ${esc(error ? error.message : 'sin datos')}</div>`;
    $('res-semana').innerHTML = '';
    return;
  }
  panelGlobal = p;
  $('res-kpis').innerHTML = htmlCuenta(p);
  if(errSem){ $('res-semana').innerHTML = `<div class="mp-card empty">No se pudo cargar la cuenta por semana: ${esc(errSem.message)}</div>`; return; }
  semanas = sem || [];
  if(semSel >= semanas.length) semSel = 0;
  renderSemana();
}

// Tu cuenta hoy: lo esencial arriba, el detalle de siempre plegado
function htmlCuenta(p){
  const ganancia = Number(p.comision_ventas) - Number(p.comision_devoluciones);
  const debe = Number(p.debe);
  const estado = debe > 0.005 ? 'a pagar' : (debe < -0.005 ? 'a tu favor' : 'estás al día');
  return `
    <div class="res-cuenta">
      <div class="cta-tile">
        <span>Tu saldo hoy</span>
        <b class="${debe > 0.005 ? 'pos' : (debe < -0.005 ? 'neg' : '')}">${money(Math.abs(debe))}</b>
        <small>${estado} · retirado − devoluciones − bonificaciones − pagos</small>
      </div>
      <div class="cta-tile ganancia">
        <span>Tu ganancia total</span>
        <b>${money(ganancia)}</b>
        <small>Comisión por ventas ${money(p.comision_ventas)}${Number(p.comision_devoluciones) > 0 ? ` − ${money(p.comision_devoluciones)} de devoluciones y bonificaciones` : ''}</small>
      </div>
      <details class="cta-detalle">
        <summary>Ver totales de siempre</summary>
        <div class="grid">
          <div>Retirado<b>${money(p.retirado)}</b></div>
          <div>Devoluciones<b>${money(p.devuelto)}</b></div>
          <div>Bonificaciones<b>${money(p.bonificado)}</b></div>
          <div>Pagos realizados<b>${money(p.pagado)}</b></div>
          <div>Devolución de stock<small style="display:block;font-weight:400;color:var(--muted);">incluida en Devoluciones</small><b>${money(p.devuelto_stock)}</b></div>
        </div>
      </details>
    </div>`;
}

const valorSem = (s, k) => k === 'creditos' ? num(s.devuelto) + num(s.bonificado) : num(s[k]);

const TARJETAS = [
  { k: 'retirado', t: '📦 Retirado', cls: 'c-ret', sube: 'neutro' },
  { k: 'creditos', t: '↩ Devoluciones y bonificaciones', cls: 'c-dev', sube: 'neutro' },
  { k: 'pagado', t: '💵 Pagos realizados', cls: 'c-pag', sube: 'bueno' },
  { k: 'ganancia', t: '⭐ Tu ganancia', cls: 'c-gan', sube: 'bueno' }
];

function chipVs(a, b, sube){
  const d = a - b;
  if(Math.abs(d) < 0.005) return '<span class="vs igual">= igual</span>';
  const arriba = d > 0;
  const clase = sube === 'neutro' ? 'igual' : ((arriba === (sube === 'bueno')) ? 'sube' : 'baja');
  return `<span class="vs ${clase}">${arriba ? '▲' : '▼'} ${money(Math.abs(d))}</span>`;
}

function num(x){ return Number(x) || 0; }

function renderSemana(){
  const box = $('res-semana');
  if(semanas.length === 0){ box.innerHTML = ''; return; }
  const s = semanas[semSel];
  const c = semCmp >= 0 ? semanas[semCmp] : null;
  const nombre = (x, i) => `${etiquetaSemana(x)}${i === 0 ? ' (esta semana)' : ''}`;

  box.innerHTML = `
    <div class="mp-card">
      <div class="sem-head">
        <div class="sem-nav">
          <button id="sem-prev" title="Semana anterior" ${semSel >= semanas.length - 1 ? 'disabled' : ''}>‹</button>
          <select id="sem-sel" title="Elegir semana">${semanas.map((x, i) => `<option value="${i}" ${i === semSel ? 'selected' : ''}>${nombre(x, i)}</option>`).join('')}</select>
          <button id="sem-next" title="Semana siguiente" ${semSel <= 0 ? 'disabled' : ''}>›</button>
        </div>
        <div class="sem-cmp">
          ${c ? `Comparando con <select id="sem-cmp">${semanas.map((x, i) => i === semSel ? '' : `<option value="${i}" ${i === semCmp ? 'selected' : ''}>${nombre(x, i)}</option>`).join('')}</select>
                 <button class="link-btn" id="sem-cmp-off">quitar</button>`
              : '<button class="link-btn" id="sem-cmp-on">⇄ Comparar con otra semana</button>'}
        </div>
      </div>
      <div class="sem-tarjetas">
        ${TARJETAS.map(t => {
          const a = valorSem(s, t.k);
          return `<div class="tk ${t.cls}"><span>${t.t}</span><b>${money(a)}</b>${c ? `<em>vs ${money(valorSem(c, t.k))} ${chipVs(a, valorSem(c, t.k), t.sube)}</em>` : ''}</div>`;
        }).join('')}
      </div>
      <div class="sem-saldo">
        <div><small>Saldo al empezar la semana</small><b>${fmtSaldo(num(s.saldo_inicial))}</b></div>
        <span class="flecha-s">→</span>
        <div><small>Saldo al cierre</small><b>${fmtSaldo(num(s.saldo_final))}</b></div>
      </div>
    </div>

    <div class="mp-card">
      <h3>Día por día <small>${etiquetaSemana(s)} · tocá un día para ver sus movimientos</small></h3>
      <div id="dia-por-dia"><div class="empty">Cargando…</div></div>
    </div>

    <div class="mp-card otras">
      <h3>Otras semanas <small>tocá una para verla</small></h3>
      ${htmlOtrasSemanas()}
    </div>`;

  $('sem-prev').addEventListener('click', () => seleccionarSemana(semSel + 1));
  $('sem-next').addEventListener('click', () => seleccionarSemana(semSel - 1));
  $('sem-sel').addEventListener('change', e => seleccionarSemana(Number(e.target.value)));
  const on = $('sem-cmp-on'), off = $('sem-cmp-off'), cmp = $('sem-cmp');
  if(on) on.addEventListener('click', () => { semCmp = semSel + 1 < semanas.length ? semSel + 1 : semSel - 1; renderSemana(); });
  if(off) off.addEventListener('click', () => { semCmp = -1; renderSemana(); });
  if(cmp) cmp.addEventListener('change', e => { semCmp = Number(e.target.value); renderSemana(); });
  box.querySelectorAll('.otras .fila[data-i]').forEach(f => f.addEventListener('click', () => {
    seleccionarSemana(Number(f.dataset.i));
    $('sec-resumen').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }));

  cargarDias(s);
}

function seleccionarSemana(i){
  if(i < 0 || i >= semanas.length) return;
  semSel = i;
  if(semCmp === i || semCmp >= semanas.length) semCmp = -1;
  renderSemana();
}

// Lista compacta de las últimas semanas, con una barrita de lo retirado
function htmlOtrasSemanas(){
  const max = Math.max(...semanas.map(x => num(x.retirado)), 1);
  return `
    <div class="fila cab"><span>Semana</span><span></span><span class="n">Retirado</span><span class="n">Pagos</span><span class="n">Ganancia</span><span class="n">Saldo al cierre</span></div>
    ${semanas.map((x, i) => `
      <button class="fila ${i === semSel ? 'sel' : ''} ${num(x.movimientos) === 0 ? 'sin' : ''}" data-i="${i}">
        <span><b>${etiquetaSemana(x)}</b>${i === 0 ? ' <small>(esta semana)</small>' : ''}${num(x.movimientos) === 0 ? '<br><small>sin movimientos</small>' : ''}</span>
        <span class="barra"><i style="width:${num(x.retirado) / max * 100}%"></i></span>
        <span class="n">${money(x.retirado)}</span>
        <span class="n">${money(x.pagado)}</span>
        <span class="n ${num(x.ganancia) < 0 ? 'gan-neg' : 'gan-pos'}">${money(x.ganancia)}</span>
        <span class="n">${fmtSaldo(num(x.saldo_final))}</span>
      </button>`).join('')}`;
}

// ---- día por día: se arma con los movimientos de la semana ----

async function cargarDias(s){
  const { data, error } = await sb.rpc('mis_movimientos', { p_desde: s.desde, p_hasta: s.hasta });
  const caja = $('dia-por-dia');
  if(!caja || semanas[semSel] !== s) return; // ya eligió otra semana
  if(error){ caja.innerHTML = `<div class="empty">No se pudieron cargar los movimientos: ${esc(error.message)}</div>`; return; }
  caja.innerHTML = htmlDias(s, data || []);
}

function htmlDias(s, movs){
  const hoy = hoyAR();
  const dias = [];
  for(let k = 0; k < 7; k++){
    const d = new Date(`${s.desde}T12:00:00`);
    d.setDate(d.getDate() + k);
    dias.push({ fecha: isoLocal(d), nombre: NOMBRE_DIA[k], retirado: 0, creditos: 0, pagos: 0, ganancia: 0, movs: [] });
  }
  const porFecha = Object.fromEntries(dias.map(d => [d.fecha, d]));

  for(const m of movs){
    const dia = porFecha[enAR(m.fecha)];
    if(!dia) continue;
    dia.movs.push(m);
    if(m.anulado) continue; // se muestra tachado pero no suma
    const imp = num(m.importe);
    if(m.tipo === 'venta'){ dia.retirado += imp; dia.ganancia += num(m.comision); }
    else if(m.tipo === 'pago'){ dia.pagos += imp; }
    else { // devolución / bonificación: se acredita neto de comisión, que el vendedor deja de ganar
      dia.creditos += imp;
      dia.ganancia -= Math.max(0, (m.items || []).reduce((t, i) => t + num(i.subtotal), 0) - imp);
    }
  }

  let saldo = num(s.saldo_inicial);
  const filas = dias.map(d => {
    saldo += d.retirado - d.creditos - d.pagos;
    const futuro = d.fecha > hoy;
    const vacio = d.movs.length === 0;
    const cab = `
      <div class="nom"><b>${d.nombre} ${fmtDia(d.fecha)}</b>${d.fecha === hoy ? '<span class="badge-hoy">Hoy</span>' : ''}${vacio && !futuro ? '<small>sin movimientos</small>' : ''}${futuro ? '<small>todavía no llegó</small>' : ''}</div>
      <div class="n"><small>Retirado</small>${vacio ? '—' : money(d.retirado)}</div>
      <div class="n"><small>Devol. y bonif.</small>${vacio ? '—' : money(d.creditos)}</div>
      <div class="n"><small>Pagos</small>${vacio ? '—' : money(d.pagos)}</div>
      <div class="n ${d.ganancia < 0 ? 'gan-neg' : (d.ganancia > 0 ? 'gan-pos' : '')}"><small>Ganancia</small>${vacio ? '—' : money(d.ganancia)}</div>
      <div class="n"><small>Saldo al cierre</small>${futuro ? '—' : fmtSaldo(saldo)}</div>`;
    if(vacio) return `<div class="dia vacio ${futuro ? 'futuro' : ''} ${d.fecha === hoy ? 'hoy' : ''}"><summary style="display:grid">${cab}</summary></div>`;
    return `<details class="dia ${d.fecha === hoy ? 'hoy' : ''}" ${d.fecha === hoy ? 'open' : ''}><summary>${cab}</summary><div class="dia-movs">${htmlMovimientos(d.movs)}</div></details>`;
  });

  return `
    <div class="dia-head"><span>Día</span><span>Retirado</span><span>Devol. y bonif.</span><span>Pagos</span><span>Ganancia</span><span>Saldo al cierre</span></div>
    ${filas.join('')}
    <div class="dia-total"><span>Total de la semana</span><span>${money(s.retirado)}</span><span>${money(num(s.devuelto) + num(s.bonificado))}</span><span>${money(s.pagado)}</span><span class="${num(s.ganancia) < 0 ? 'gan-neg' : 'gan-pos'}">${money(s.ganancia)}</span><span>${fmtSaldo(num(s.saldo_final))}</span></div>`;
}

// ===== Cartera de clientes =====

async function cargarCartera(){
  $('cartera-body').innerHTML = '<tr><td colspan="7" class="empty">Cargando…</td></tr>';
  const { data, error } = await sb.rpc('mi_cartera', { p_desde: desdePeriodo(periodo) });
  if(error){ $('cartera-body').innerHTML = `<tr><td colspan="7" class="empty">No se pudo cargar tu cartera: ${esc(error.message)}</td></tr>`; return; }
  cartera = data || [];
  renderRanking();
  renderCartera();
}

const diasDesde = iso => Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);

function renderRanking(){
  const conVentas = cartera.filter(c => Number(c.comprado) > 0).sort((a, b) => Number(b.comprado) - Number(a.comprado));
  const total = conVentas.reduce((s, c) => s + Number(c.comprado), 0);
  const top = conVentas.slice(0, 10);
  const medallas = ['🥇', '🥈', '🥉'];
  const pct = c => total > 0 ? Math.round(Number(c.comprado) / total * 100) : 0;

  const col = (c, pos) => c ? `
    <div class="podio-col p${pos + 1}">
      <div class="medalla">${medallas[pos]}</div>
      <div class="rk-nombre">${esc(c.nombre)}</div>
      <div class="rk-monto">${money(c.comprado)}</div>
      <div class="rk-sub">${c.compras} compra${c.compras === 1 ? '' : 's'} · ${pct(c)}% del total</div>
      <div class="podio-bar">${pos + 1}</div>
    </div>` : '';
  const podio = top.length ? `<div class="podio">${col(top[1], 1)}${col(top[0], 0)}${col(top[2], 2)}</div>` : '';

  const resto = top.slice(3).map((c, i) => `
    <div class="rank-fila">
      <span class="pos">${i + 4}</span>
      <span>${esc(c.nombre)}</span>
      <div class="barra"><i style="width:${Math.max(4, Number(c.comprado) / Number(top[0].comprado) * 100)}%"></i></div>
      <span class="monto">${money(c.comprado)}</span>
      <span class="pct">${pct(c)}%</span>
    </div>`).join('');

  const dormidos = cartera
    .map(c => ({ c, dias: c.ultima_compra ? diasDesde(c.ultima_compra) : null }))
    .filter(x => x.dias === null || x.dias >= DIAS_DORMIDO)
    .sort((a, b) => (b.dias ?? 9999) - (a.dias ?? 9999)).slice(0, 8);
  const dorm = dormidos.length ? `
    <div class="dormidos">
      <h4>💤 Para reactivar — sin comprar hace más de ${DIAS_DORMIDO} días</h4>
      ${dormidos.map(({ c, dias }) => {
        const tel = normalizarTelefono(c.telefono);
        const msg = encodeURIComponent(`Hola ${c.nombre}! ¿Cómo andás? Hace un tiempo que no hacemos pedido, ¿necesitás mercadería? — DIARNEC`);
        return `<span class="dorm-chip">${esc(c.nombre)} <small style="color:var(--muted);">${dias === null ? 'nunca compró' : dias + ' días'}</small>
          ${tel ? `<a href="https://wa.me/${tel}?text=${msg}" target="_blank" rel="noopener">💬</a>` : ''}</span>`;
      }).join('')}
    </div>` : '';

  $('ranking').innerHTML = `
    <div class="rank-head">
      <h3 style="margin:0;">🏆 Mejores clientes</h3>
      <div class="chips" id="rank-periodos">${PERIODOS.map(([k, l]) => `<button data-p="${k}" class="${k === periodo ? 'active' : ''}">${l}</button>`).join('')}</div>
    </div>
    <div class="rank-resumen">
      <span>Vendido en el período <b>${money(total)}</b></span>
      <span>Clientes que compraron <b>${conVentas.length}</b> de ${cartera.length}</span>
    </div>
    ${conVentas.length ? podio + resto : '<div class="empty">Todavía no hay ventas en este período. Registrale una venta a un cliente y acá aparece tu ranking.</div>'}
    ${dorm}`;
}

function onClickRanking(e){
  const b = e.target.closest('#rank-periodos button[data-p]');
  if(!b || b.dataset.p === periodo) return;
  periodo = b.dataset.p;
  cargarCartera();
}

function renderCartera(){
  const q = norm($('cartera-buscar').value);
  const list = cartera.filter(c => !q || norm(`${c.nombre} ${c.localidad} ${c.direccion || ''}`).includes(q));
  $('cartera-body').innerHTML = list.length === 0
    ? `<tr><td colspan="7" class="empty">${cartera.length === 0 ? 'Todavía no tenés clientes. Tocá "+ Nuevo cliente" para cargar el primero.' : 'No hay clientes que coincidan.'}</td></tr>`
    : list.map(c => `
      <tr>
        <td><b>${esc(c.nombre)}</b>${c.contacto ? `<br><small style="color:var(--muted);">${esc(c.contacto)}</small>` : ''}</td>
        <td>${esc(c.localidad || '')}${c.direccion ? `<br><small style="color:var(--muted);">${esc(c.direccion)}</small>` : ''}</td>
        <td>${esc(c.telefono || '—')}</td>
        <td class="r">${c.compras}</td>
        <td class="r">${money(c.comprado)}</td>
        <td>${c.ultima_compra ? dateTime(c.ultima_compra) : '—'}</td>
        <td style="white-space:nowrap;">
          <button class="btn-mini venta" data-act="vender" data-id="${c.id}" title="Cargar una venta a este cliente y generar el remito">🧾 Vender</button>
          <button class="btn-mini" data-act="remitos" data-id="${c.id}" title="Remitos de este cliente">📄</button>
          <button class="btn-mini" data-act="editar" data-id="${c.id}" title="Modificar">✎</button>
          <button class="btn-mini del" data-act="borrar" data-id="${c.id}" title="Borrar">🗑</button>
        </td>
      </tr>`).join('');
}

async function onClickCartera(e){
  const b = e.target.closest('button[data-act]');
  if(!b) return;
  const c = cartera.find(x => x.id === Number(b.dataset.id));
  if(!c) return;
  if(b.dataset.act === 'vender') abrirVenta(c);
  else if(b.dataset.act === 'remitos') abrirHistorial(c);
  else if(b.dataset.act === 'editar') abrirCliente(c);
  else if(b.dataset.act === 'borrar') borrarCliente(c);
}

// ---- alta / modificación / baja ----

function abrirCliente(c){
  clienteEditando = c;
  $('cl-titulo').textContent = c ? `Modificar cliente` : 'Nuevo cliente';
  $('cl-nombre').value = c ? c.nombre : '';
  $('cl-localidad').value = c ? (c.localidad || '') : '';
  $('cl-direccion').value = c ? (c.direccion || '') : '';
  $('cl-contacto').value = c ? (c.contacto || '') : '';
  $('cl-telefono').value = c ? (c.telefono || '') : '';
  $('cl-err').textContent = '';
  abrirModal('modal-cliente');
  setTimeout(() => $('cl-nombre').focus(), 50);
}

async function guardarCliente(){
  const err = $('cl-err');
  err.textContent = '';
  const nombre = $('cl-nombre').value.trim();
  if(!nombre){ err.textContent = 'Ingresá el nombre del cliente.'; return; }
  const btn = $('cl-guardar');
  btn.disabled = true;
  const { error } = await sb.rpc('mi_cliente_guardar', {
    p_id: clienteEditando ? clienteEditando.id : null, p_nombre: nombre,
    p_localidad: $('cl-localidad').value, p_direccion: $('cl-direccion').value, p_contacto: $('cl-contacto').value, p_telefono: $('cl-telefono').value
  });
  btn.disabled = false;
  if(error){ err.textContent = error.message; return; }
  cerrarModal('modal-cliente');
  avisar(clienteEditando ? 'Cliente actualizado' : 'Cliente agregado a tu cartera');
  await cargarCartera();
}

async function borrarCliente(c){
  if(!(await confirmDialog(`¿Borrar a "${c.nombre}" de tu cartera?\nSi ya le vendiste algo, se da de baja y se conserva su historial.`, { confirmLabel: 'Borrar' }))) return;
  const { data, error } = await sb.rpc('mi_cliente_borrar', { p_id: c.id });
  if(error){ avisar('No se pudo borrar: ' + error.message); return; }
  avisar(data === 'baja' ? `"${c.nombre}" salió de tu cartera (se conserva su historial de ventas)` : `"${c.nombre}" borrado`);
  await cargarCartera();
}

// ---- venta a un cliente ----

let productosVenta = []; // para el buscador
let productoPorId = {}; // id -> fila de mi_lista_precios

async function abrirVenta(c){
  if(precios.length === 0) await cargarPrecios(true);
  if(precios.length === 0){ avisar('No se pudo cargar la lista de precios.'); return; }
  productosVenta = precios.map(p => ({ id: p.id, nombre: p.nombre, unidad: p.unidad, marcas: { nombre: p.marca, color: p.marca_color }, categorias: { por_peso: p.por_peso } }));
  productoPorId = Object.fromEntries(precios.map(p => [String(p.id), p]));
  ventaCliente = c;
  $('vt-titulo').textContent = `Nueva venta — ${c.nombre}`;
  $('vt-items').innerHTML = '';
  $('vt-err').textContent = '';
  agregarFilaVenta();
  recalcVenta();
  abrirModal('modal-venta');
}

function agregarFilaVenta(){
  const tr = document.createElement('tr');
  tr.innerHTML = `
    <td class="pp-cell"></td>
    <td><input type="number" class="vt-cant" step="1" min="1" value="1"></td>
    <td class="vt-precio">—</td>
    <td class="vt-sub">$0,00</td>
    <td><button type="button" class="del" title="Quitar">×</button></td>`;
  $('vt-items').appendChild(tr);
  const picker = createProductPicker(productosVenta);
  tr.querySelector('.pp-cell').appendChild(picker);
  const cant = tr.querySelector('.vt-cant');

  picker.addEventListener('change', () => {
    const p = productoPorId[picker.value];
    tr.querySelector('.vt-precio').textContent = p ? money(p.precio) : '—';
    ajustarInputCantidad(cant, p ? { categorias: { por_peso: p.por_peso } } : null);
    recalcVenta();
    cant.select();
  });
  cant.addEventListener('input', recalcVenta);
  tr.querySelector('.del').addEventListener('click', () => { tr.remove(); recalcVenta(); });
  setTimeout(() => picker.focusInput(), 60);
}

function recalcVenta(){
  let total = 0, ganancia = 0;
  document.querySelectorAll('#vt-items tr').forEach(tr => {
    const p = productoPorId[tr.querySelector('.item-producto').value];
    const sub = p ? (parseFloat(tr.querySelector('.vt-cant').value) || 0) * Number(p.precio) : 0;
    tr.querySelector('.vt-sub').textContent = money(sub);
    total += sub;
    if(p) ganancia += sub * Number(p.comision_pct) / 100;
  });
  $('vt-total').textContent = money(total);
  $('vt-ganancia').textContent = money(ganancia);
}

async function confirmarVenta(){
  const err = $('vt-err');
  err.textContent = '';
  const items = [];
  for(const tr of document.querySelectorAll('#vt-items tr')){
    const p = productoPorId[tr.querySelector('.item-producto').value];
    const cantidad = parseFloat(tr.querySelector('.vt-cant').value);
    if(!p || !cantidad || cantidad <= 0){ err.textContent = 'Elegí el producto y una cantidad en cada fila (o quitá las filas vacías).'; return; }
    const item = { nombre: p.nombre, categorias: { por_peso: p.por_peso } };
    if(!cantidadEsValida(item, cantidad)){ err.textContent = mensajeCantidad(item); return; }
    items.push({ producto_id: p.id, cantidad });
  }
  if(items.length === 0){ err.textContent = 'Elegí al menos un producto.'; return; }

  const btn = $('vt-confirmar');
  btn.disabled = true;
  const { data: ventaId, error } = await sb.rpc('mi_registrar_venta', { p_cliente_id: ventaCliente.id, p_items: items });
  if(error){ btn.disabled = false; err.textContent = error.message; return; }
  const { data: remito, error: errRem } = await sb.rpc('mi_remito', { p_venta_id: ventaId });
  btn.disabled = false;
  cerrarModal('modal-venta');
  if(errRem){ avisar('La venta se registró, pero no se pudo armar el remito: ' + errRem.message); }
  else abrirRemito(remito);
  cargarCartera(); // el cliente pasa a figurar con la compra nueva
}

// ---- remito ----

function abrirRemito(r){
  remitoActual = r;
  $('rm-titulo').textContent = `Remito N° ${r.id}`;
  $('rm-err').textContent = '';
  $('rm-err').style.color = '';
  $('rm-cuerpo').innerHTML = `
    <div class="remito-meta">
      <div><span>Cliente</span><b>${esc(r.cliente || '—')}${r.localidad ? ' (' + esc(r.localidad) + ')' : ''}</b></div>
      <div><span>Fecha</span><b>${dateTime(r.fecha)}</b></div>
      <div><span>WhatsApp</span><b>${esc(r.telefono || 'sin número cargado')}</b></div>
    </div>
    <table>
      <thead><tr><th>Producto</th><th class="r">Cant.</th><th class="r">Precio</th><th class="r">Subtotal</th></tr></thead>
      <tbody>${r.items.map(i => `<tr><td><b>${esc(i.marca || '')}</b> ${esc(i.producto)}${i.unidad ? ' <small>' + esc(i.unidad) + '</small>' : ''}</td>
        <td class="r">${Number(i.cantidad)}</td><td class="r">${money(i.precio)}</td><td class="r">${money(i.subtotal)}</td></tr>`).join('')}</tbody>
    </table>
    <div class="vt-total">Total: ${money(r.total)}</div>
    ${r.anulado ? '<div class="mp-err">Esta venta fue anulada.</div>' : ''}`;
  abrirModal('modal-remito');
}

async function accionRemito(tipo){
  if(!remitoActual) return;
  const err = $('rm-err');
  err.textContent = '';
  err.style.color = '';
  const btn = tipo === 'pdf' ? $('rm-pdf') : $('rm-wa');
  btn.disabled = true;
  try {
    if(tipo === 'pdf') await descargarRemito(remitoActual);
    else {
      const res = await compartirRemitoWhatsApp(remitoActual);
      if(res === 'descargado'){
        err.style.color = '#1e8e5a';
        err.textContent = 'Se descargó el PDF y se abrió WhatsApp: adjuntalo en el chat del cliente.';
      }
    }
  } catch(e){
    err.textContent = 'No se pudo generar el remito: ' + e.message;
  }
  btn.disabled = false;
}

// ---- remitos de un cliente ----

async function abrirHistorial(c){
  $('rh-titulo').textContent = `Remitos — ${c.nombre}`;
  $('rh-err').textContent = '';
  $('rh-lista').innerHTML = '<div class="empty">Cargando…</div>';
  abrirModal('modal-remitos');
  const { data, error } = await sb.rpc('mi_historial_cliente', { p_cliente_id: c.id });
  if(error){ $('rh-lista').innerHTML = `<div class="empty">No se pudieron cargar los remitos: ${esc(error.message)}</div>`; return; }
  $('rh-lista').innerHTML = (data || []).length === 0
    ? '<div class="empty">Todavía no le vendiste nada a este cliente.</div>'
    : data.map(v => `
      <div class="rem-hist ${v.anulado ? 'anulado' : ''}">
        <div class="info"><b>N° ${v.id}</b> · ${dateTime(v.fecha)} · ${money(v.total)}${v.anulado ? ' [anulado]' : ''}</div>
        <button class="btn-mini" data-act="ver" data-id="${v.id}">Ver</button>
        <button class="btn-mini" data-act="pdf" data-id="${v.id}">⬇ PDF</button>
        <button class="btn-mini" data-act="wa" data-id="${v.id}" style="background:#25D366;color:#fff;">💬</button>
      </div>`).join('');
}

async function onClickHistorial(e){
  const b = e.target.closest('button[data-act]');
  if(!b) return;
  $('rh-err').textContent = '';
  b.disabled = true;
  const { data: r, error } = await sb.rpc('mi_remito', { p_venta_id: Number(b.dataset.id) });
  try {
    if(error) throw error;
    if(b.dataset.act === 'ver'){ cerrarModal('modal-remitos'); abrirRemito(r); }
    else if(b.dataset.act === 'pdf') await descargarRemito(r);
    else await compartirRemitoWhatsApp(r);
  } catch(ex){ $('rh-err').textContent = 'No se pudo generar el remito: ' + ex.message; }
  b.disabled = false;
}

// ===== Lista de precios =====

async function cargarPrecios(silencioso){
  const { data, error } = await sb.rpc('mi_lista_precios');
  if(error){ if(!silencioso) $('precios-estado').textContent = 'No se pudo actualizar'; return; }
  precios = data || [];
  renderPrecios();
  $('precios-estado').textContent = 'En vivo · actualizado ' + new Date().toLocaleTimeString('es-AR');
}

function preciosFiltrados(){
  const tokens = norm($('precios-buscar').value).split(/\s+/).filter(Boolean);
  return precios.filter(p => { const h = norm(`${p.marca} ${p.nombre} ${p.unidad}`); return tokens.every(t => h.includes(t)); });
}

const precioNeto = p => Number(p.precio) * (1 - Number(p.comision_pct) / 100);

function renderPrecios(){
  const list = preciosFiltrados();
  let marcaPrev = null;
  $('precios-body').innerHTML = list.length === 0
    ? '<tr><td colspan="5" class="empty">No hay productos que coincidan.</td></tr>'
    : list.map(p => {
        const cab = p.marca !== marcaPrev
          ? `<tr><td colspan="5" style="background:var(--paper);"><span class="dot" style="background:${esc(p.marca_color || '#e4e2da')}"></span><b>${esc(p.marca || 'Sin marca')}</b></td></tr>` : '';
        marcaPrev = p.marca;
        return cab + `
        <tr>
          <td>${esc(p.nombre)}</td>
          <td>${esc(p.unidad || '')}</td>
          <td class="r"><b>${money(p.precio)}</b></td>
          <td class="r">${Number(p.comision_pct)}%</td>
          <td class="r">${money(precioNeto(p))}</td>
        </tr>`;
      }).join('');
}

function cargarLogo(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
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

const hexARgb = hex => /^#[0-9a-f]{6}$/i.test(hex || '')
  ? [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)] : [255, 255, 255];

// PDF con la lista de precios de venta (lo que se le cobra al cliente): sin costos ni comisiones.
async function descargarPDF(){
  if(!window.jspdf){ alert('No se pudo cargar el generador de PDF. Revisá tu conexión y recargá la página.'); return; }
  await cargarPrecios(); // siempre con lo último
  const list = precios;
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
  const fecha = new Date().toLocaleDateString('es-AR');

  try {
    const logo = await cargarLogo('../img/logo.png');
    doc.addImage(logo, 'PNG', 14, 8, 22, 22);
  } catch(e){ /* sin logo seguimos igual */ }

  doc.setTextColor(0, 0, 0);
  doc.setFont(undefined, 'bold');
  doc.setFontSize(17);
  doc.text('Lista de Precios - DIARNEC', 105, 16, { align: 'center' });
  doc.setFont(undefined, 'italic');
  doc.setFontSize(10);
  doc.text(`Actualizado al: ${fecha}`, 105, 23, { align: 'center' });
  doc.setFont(undefined, 'normal');

  doc.autoTable({
    startY: 32,
    head: [['MARCA', 'ARTICULO', 'PRESENTACION', 'PRECIO']],
    body: list.map(p => [p.marca || '', p.nombre, p.unidad || '', money(p.precio)]),
    styles: { fontSize: 8, cellPadding: 2.2, fontStyle: 'bold', textColor: [0, 0, 0] },
    headStyles: { fillColor: [18, 36, 54], textColor: 255 },
    columnStyles: { 3: { halign: 'right' } },
    didParseCell: data => {
      if(data.section === 'body') data.cell.styles.fillColor = hexARgb(list[data.row.index].marca_color);
    }
  });

  doc.save(`${fecha.replace(/\//g, '-')}_Lista_DIARNEC.pdf`);
}
