import { sb } from '../shared/supabase-client.js';
import { requireAuth, getPerfil } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money } from '../shared/format.js';

// Cierre del día: un resumen de todo lo que pasó en un día (ventas, cobros por medio de pago, gastos, pedidos online,
// devoluciones, stock) y un control de efectivo. Solo lectura: no modifica nada.
// Los números de cobros y gastos se calculan igual que en la Caja: ingreso = pagos de vendedores y clientes;
// gasto = gastos + pagos a proveedores. Un movimiento cuenta en el día en que se cargó (hora de Argentina).

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
const TZ = 'America/Argentina/Buenos_Aires';
const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MEDIOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque' };
const sum = (arr, f) => arr.reduce((s, x) => s + (Number(f(x)) || 0), 0);
const num = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 2 });

const hoyAR = () => new Date().toLocaleDateString('en-CA', { timeZone: TZ });
const sumarDias = (iso, n) => { const d = new Date(iso + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const ventana = iso => ({ desde: new Date(iso + 'T00:00:00-03:00').toISOString(), hasta: new Date(sumarDias(iso, 1) + 'T00:00:00-03:00').toISOString() });
const fmtFecha = iso => { const [y, m, d] = iso.split('-'); return `${DIAS[new Date(iso + 'T12:00:00Z').getUTCDay()]} ${d}/${m}/${y}`; };
const mayus = t => t.charAt(0).toUpperCase() + t.slice(1);

let dia = hoyAR();
let esAdmin = false;
let datos = null;   // lo calculado para el día elegido
let cargando = 0;   // evita que una respuesta lenta pise a una más nueva

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('cierre', 'Cierre del día');
  const perfil = await getPerfil();
  esAdmin = !!perfil && perfil.rol === 'admin';

  content.innerHTML = `
    <div class="cd-bar">
      <div class="cd-fecha">
        <button type="button" id="cd-prev" title="Día anterior">‹</button>
        <input type="date" id="cd-dia" title="Elegir día">
        <button type="button" id="cd-next" title="Día siguiente">›</button>
        <button type="button" id="cd-hoy" class="cd-hoy">Hoy</button>
      </div>
      <div class="cd-acciones">
        <button type="button" class="btn-sm btn-add" id="cd-copiar">📋 Copiar resumen para WhatsApp</button>
        <button type="button" class="btn-sm btn-grey" id="cd-imprimir">🖨 Imprimir</button>
      </div>
    </div>
    <h2 class="cd-titulo" id="cd-titulo"></h2>
    <div class="cd-error" id="cd-error" hidden><span></span><button class="btn-sm" id="cd-reintentar" type="button">↻ Reintentar</button></div>
    <div id="cd-body"><div class="empty-row">Cargando…</div></div>
  `;

  $('cd-dia').max = hoyAR();
  $('cd-prev').addEventListener('click', () => ir(sumarDias(dia, -1)));
  $('cd-next').addEventListener('click', () => ir(sumarDias(dia, 1)));
  $('cd-hoy').addEventListener('click', () => ir(hoyAR()));
  $('cd-dia').addEventListener('change', e => { if(e.target.value) ir(e.target.value); });
  $('cd-reintentar').addEventListener('click', () => cargar());
  $('cd-copiar').addEventListener('click', copiarResumen);
  $('cd-imprimir').addEventListener('click', () => window.print());
  $('cd-body').addEventListener('input', e => { if(e.target.id === 'cd-contado') pintarControl(); });

  await ir(dia);
})();

async function ir(iso){
  if(iso > hoyAR()) iso = hoyAR(); // no hay cierre de días que todavía no pasaron
  dia = iso;
  $('cd-dia').value = dia;
  $('cd-next').disabled = dia >= hoyAR();
  $('cd-titulo').textContent = 'Cierre del ' + fmtFecha(dia) + (dia === hoyAR() ? ' (hoy, hasta ahora)' : '');
  await cargar();
}

async function cargar(){
  const mio = ++cargando;
  const { desde, hasta } = ventana(dia);
  const rango = q => q.gte('created_at', desde).lt('created_at', hasta);
  const [rV, rPV, rPC, rPP, rG, rD, rB, rM, rPend, rProd] = await Promise.all([
    rango(sb.from('ventas').select('id, canal, estado, total_neto, entregado_at, vendedores(nombre)').neq('canal', 'vendedor')),
    rango(sb.from('pagos_vendedores').select('id, monto, medio_pago, anulado, vendedores(nombre)')),
    rango(sb.from('pagos_clientes').select('id, monto, medio_pago, anulado, clientes(nombre)')),
    rango(sb.from('pagos_proveedores').select('id, monto_neto, medio_pago, anulado, proveedores(nombre)')),
    rango(sb.from('gastos').select('id, monto, descripcion, anulado')),
    rango(sb.from('devoluciones_cab').select('id, total, con_stock, anulado, vendedores(nombre)')),
    rango(sb.from('bonificaciones').select('id, monto, anulado, vendedores(nombre)')),
    rango(sb.from('movimientos_stock').select('id, tipo, cantidad, motivo, productos(nombre)')),
    sb.from('ventas').select('id', { count: 'exact', head: true }).eq('canal', 'online').eq('estado', 'pendiente'),
    sb.from('productos').select('nombre, stock_actual, stock_minimo').eq('activo', true)
  ]);
  if(mio !== cargando) return; // llegó una respuesta más nueva

  const fallo = [rV, rPV, rPC, rPP, rG, rD, rB, rM, rProd].find(r => r.error) || (rPend.error ? rPend : null);
  if(fallo){
    // Si falla algo no se muestra un día "en cero": se avisa, para no dar un cierre incompleto como si fuera el real.
    $('cd-error').hidden = false;
    $('cd-error').querySelector('span').textContent = 'No se pudo armar el cierre (no se tocó nada): ' + fallo.error.message;
    $('cd-body').innerHTML = '';
    datos = null;
    return;
  }
  $('cd-error').hidden = true;
  datos = calcular({ ventas: rV.data || [], pv: rPV.data || [], pc: rPC.data || [], pp: rPP.data || [], gastos: rG.data || [],
    dev: rD.data || [], bonif: rB.data || [], mov: rM.data || [], pendientesOnline: rPend.count ?? 0, productos: rProd.data || [] });
  pintar();
}

function calcular(d){
  const ok = x => !x.anulado;
  const ventasOk = d.ventas.filter(v => v.estado === 'confirmada');
  const porVend = new Map();
  ventasOk.forEach(v => {
    const n = (v.vendedores && v.vendedores.nombre) || 'Sin vendedor';
    const g = porVend.get(n) || { nombre: n, cant: 0, total: 0 };
    g.cant++; g.total += Number(v.total_neto) || 0; porVend.set(n, g);
  });
  const cobros = [
    ...d.pv.filter(ok).map(p => ({ quien: (p.vendedores && p.vendedores.nombre) || 'Vendedor', tipo: 'Vendedor', monto: Number(p.monto) || 0, medio: p.medio_pago })),
    ...d.pc.filter(ok).map(p => ({ quien: (p.clientes && p.clientes.nombre) || 'Cliente', tipo: 'Cliente', monto: Number(p.monto) || 0, medio: p.medio_pago }))
  ];
  const egresos = [
    ...d.gastos.filter(ok).map(g => ({ que: g.descripcion || 'Gasto', tipo: 'Gasto', monto: Number(g.monto) || 0, medio: null })),
    ...d.pp.filter(ok).map(p => ({ que: (p.proveedores && p.proveedores.nombre) || 'Proveedor', tipo: 'Pago a proveedor', monto: Number(p.monto_neto) || 0, medio: p.medio_pago }))
  ];
  const online = d.ventas.filter(v => v.canal === 'online');
  const porMedio = {};
  cobros.forEach(c => { porMedio[c.medio] = (porMedio[c.medio] || 0) + c.monto; });
  const efectivoCobrado = porMedio.efectivo || 0;
  const provEfectivo = sum(egresos.filter(e => e.tipo === 'Pago a proveedor' && e.medio === 'efectivo'), e => e.monto);
  const gastosTotal = sum(egresos.filter(e => e.tipo === 'Gasto'), e => e.monto);
  const stockMov = d.mov.filter(m => m.tipo === 'entrada');
  const bajas = d.mov.filter(m => m.tipo === 'merma' || m.tipo === 'ajuste');
  const sinStock = d.productos.filter(p => Number(p.stock_actual) <= 0).map(p => p.nombre).sort((a, b) => a.localeCompare(b, 'es'));
  const bajoMinimo = d.productos.filter(p => Number(p.stock_minimo) > 0 && Number(p.stock_actual) > 0 && Number(p.stock_actual) <= Number(p.stock_minimo)).length;
  return {
    ventas: { cant: ventasOk.length, total: sum(ventasOk, v => v.total_neto), porVendedor: [...porVend.values()].sort((a, b) => b.total - a.total) },
    cobros, cobrosTotal: sum(cobros, c => c.monto), porMedio,
    egresos, egresosTotal: sum(egresos, e => e.monto),
    efectivo: { cobrado: efectivoCobrado, provEfectivo, gastos: gastosTotal, esperado: efectivoCobrado - provEfectivo - gastosTotal },
    online: { total: online.length, pendientes: online.filter(v => v.estado === 'pendiente').length, aVenta: online.filter(v => v.estado === 'confirmada').length,
      entregados: online.filter(v => v.estado === 'confirmada' && v.entregado_at).length, cancelados: online.filter(v => v.estado === 'anulada').length, pendientesTotal: d.pendientesOnline },
    dev: { lista: d.dev.filter(ok), total: sum(d.dev.filter(ok), x => x.total) },
    bonif: { lista: d.bonif.filter(ok), total: sum(d.bonif.filter(ok), x => x.monto) },
    anulados: d.ventas.filter(v => v.estado === 'anulada').length + [d.pv, d.pc, d.pp, d.gastos, d.dev, d.bonif].reduce((s, l) => s + l.filter(x => x.anulado).length, 0),
    stock: { entradasCant: stockMov.length, entradasUnid: sum(stockMov, m => m.cantidad), bajas, sinStock, bajoMinimo }
  };
}

const kpi = (t, v, sub, cls = '') => `<div class="cd-kpi ${cls}"><small>${t}</small><b>${v}</b>${sub ? `<em>${sub}</em>` : ''}</div>`;
const fila = (a, b, c = '') => `<tr><td>${a}</td><td class="num">${b}</td>${c ? `<td class="num">${c}</td>` : ''}</tr>`;
const vacio = t => `<p class="cd-vacio">${t}</p>`;

function pintar(){
  const d = datos;
  const resultado = d.cobrosTotal - d.egresosTotal;
  const kpis = kpi('Ventas del día', money(d.ventas.total), `${d.ventas.cant} venta${d.ventas.cant === 1 ? '' : 's'} (neto)`) +
    kpi('Cobrado', money(d.cobrosTotal), `${d.cobros.length} cobro${d.cobros.length === 1 ? '' : 's'}`, 'verde') +
    kpi('Gastos y proveedores', money(d.egresosTotal), `${d.egresos.length} pago${d.egresos.length === 1 ? '' : 's'}`, 'naranja') +
    (esAdmin ? kpi('Resultado del día', money(resultado), 'cobrado − gastos', resultado < 0 ? 'rojo' : 'azul') : '');

  const medios = Object.keys(d.porMedio).sort();
  const cobrosHtml = d.cobros.length
    ? `<table class="cd-tabla"><thead><tr><th>Medio de pago</th><th class="num">Total</th></tr></thead><tbody>${medios.map(m => fila(esc(MEDIOS[m] || m || 'Sin medio'), money(d.porMedio[m]))).join('')}</tbody></table>
       <details class="cd-det"><summary>Ver quién pagó (${d.cobros.length})</summary><table class="cd-tabla"><tbody>${d.cobros.map(c => fila(`${esc(c.quien)} <span class="cd-tag">${c.tipo}</span>`, money(c.monto), esc(MEDIOS[c.medio] || c.medio || ''))).join('')}</tbody></table></details>`
    : vacio('No se registraron cobros.');

  const ventasHtml = d.ventas.cant
    ? `<table class="cd-tabla"><thead><tr><th>Vendedor</th><th class="num">Ventas</th><th class="num">Total neto</th></tr></thead><tbody>${d.ventas.porVendedor.map(g => fila(esc(g.nombre), g.cant, money(g.total))).join('')}</tbody></table>`
    : vacio('No hubo ventas confirmadas.');

  const egresosHtml = d.egresos.length
    ? `<table class="cd-tabla"><tbody>${d.egresos.map(e => fila(`${esc(e.que)} <span class="cd-tag">${e.tipo}</span>`, money(e.monto), esc(e.medio ? (MEDIOS[e.medio] || e.medio) : ''))).join('')}</tbody></table>`
    : vacio('No se registraron gastos ni pagos a proveedores.');

  const o = d.online;
  const onlineHtml = `<div class="cd-chips">
      <span class="cd-chip">Pedidos de hoy: <b>${o.total}</b></span>
      <span class="cd-chip">Pasados a venta: <b>${o.aVenta}</b></span>
      <span class="cd-chip">Entregados: <b>${o.entregados}</b></span>
      <span class="cd-chip">Cancelados: <b>${o.cancelados}</b></span>
    </div>
    ${o.pendientesTotal ? `<p class="cd-alerta">⚠️ Hay <b>${o.pendientesTotal}</b> pedido${o.pendientesTotal === 1 ? '' : 's'} online <b>sin atender</b> (de cualquier día). <a href="tienda-online.html">Ir a Tienda online</a></p>` : '<p class="cd-ok">✅ No hay pedidos online pendientes.</p>'}`;

  const devHtml = (d.dev.lista.length || d.bonif.lista.length)
    ? `<table class="cd-tabla"><tbody>${d.dev.lista.length ? fila(`Devoluciones (${d.dev.lista.length})`, money(d.dev.total)) : ''}${d.bonif.lista.length ? fila(`Bonificaciones (${d.bonif.lista.length})`, money(d.bonif.total)) : ''}</tbody></table>`
    : vacio('No hubo devoluciones ni bonificaciones.');

  const s = d.stock;
  const stockHtml = `<div class="cd-chips">
      <span class="cd-chip">Ingresos de mercadería: <b>${s.entradasCant}</b>${s.entradasCant ? ` (${num(s.entradasUnid)} unidades)` : ''}</span>
      <span class="cd-chip ${s.sinStock.length ? 'rojo' : ''}">Sin stock: <b>${s.sinStock.length}</b></span>
      <span class="cd-chip ${s.bajoMinimo ? 'naranja' : ''}">En el mínimo: <b>${s.bajoMinimo}</b></span>
    </div>
    ${s.bajas.length ? `<table class="cd-tabla"><thead><tr><th>Mermas y ajustes del día</th><th class="num">Cant.</th></tr></thead><tbody>${s.bajas.map(m => fila(`${esc(m.productos ? m.productos.nombre : '')}<div class="cd-sub">${esc(m.motivo || '')}</div>`, num(m.cantidad))).join('')}</tbody></table>` : ''}
    ${s.sinStock.length ? `<p class="cd-sinstock"><b>Sin stock:</b> ${s.sinStock.slice(0, 12).map(esc).join(', ')}${s.sinStock.length > 12 ? ` y ${s.sinStock.length - 12} más` : ''}.</p>` : ''}`;

  const e = d.efectivo;
  const controlHtml = `
    <table class="cd-tabla">
      <tbody>
        ${fila('Efectivo cobrado en el día', money(e.cobrado))}
        ${fila('− Pagos a proveedores en efectivo', money(e.provEfectivo))}
        ${fila('− Gastos <span class="cd-tag">se cuentan como pagados en efectivo</span>', money(e.gastos))}
        <tr class="cd-total"><td>Efectivo que debería haber</td><td class="num">${money(e.esperado)}</td></tr>
      </tbody>
    </table>
    <div class="cd-contado">
      <label>Efectivo contado en caja <input type="number" step="0.01" min="0" id="cd-contado" placeholder="$"></label>
      <div id="cd-dif" class="cd-dif"></div>
    </div>
    <p class="cd-nota">Es un control del movimiento del día. No incluye el efectivo con el que se abrió la caja.</p>`;

  $('cd-body').innerHTML = `
    <div class="cd-kpis">${kpis}</div>
    ${d.anulados ? `<p class="cd-nota">ℹ️ Hay ${d.anulados} movimiento${d.anulados === 1 ? '' : 's'} anulado${d.anulados === 1 ? '' : 's'} cargado${d.anulados === 1 ? '' : 's'} este día: no suman en ningún total.</p>` : ''}
    <div class="cd-grid">
      <section class="admin-section"><h3>💰 Cobros por medio de pago</h3>${cobrosHtml}</section>
      <section class="admin-section"><h3>🧾 Ventas por vendedor</h3>${ventasHtml}</section>
      <section class="admin-section"><h3>💸 Gastos y pagos a proveedores</h3>${egresosHtml}</section>
      <section class="admin-section"><h3>🛒 Pedidos de la tienda online</h3>${onlineHtml}</section>
      <section class="admin-section"><h3>↩️ Devoluciones y bonificaciones</h3>${devHtml}</section>
      <section class="admin-section"><h3>📦 Stock</h3>${stockHtml}</section>
      <section class="admin-section cd-ancho"><h3>💵 Control de efectivo</h3>${controlHtml}</section>
    </div>`;

  try { const g = localStorage.getItem('diarnec_contado_' + dia); if(g !== null) $('cd-contado').value = g; } catch(err){ /* sin storage */ }
  pintarControl();
}

function pintarControl(){
  if(!datos) return;
  const inp = $('cd-contado');
  const dif = $('cd-dif');
  if(!inp || !dif) return;
  try { localStorage.setItem('diarnec_contado_' + dia, inp.value); } catch(err){ /* sin storage */ }
  const v = parseFloat(inp.value);
  if(isNaN(v)){ dif.textContent = ''; dif.className = 'cd-dif'; return; }
  const dd = Math.round((v - datos.efectivo.esperado) * 100) / 100;
  if(Math.abs(dd) < 0.005){ dif.className = 'cd-dif ok'; dif.textContent = '✅ Cierra justo: no hay diferencia.'; }
  else if(dd > 0){ dif.className = 'cd-dif sobra'; dif.textContent = `Sobran ${money(dd)} respecto de lo esperado.`; }
  else { dif.className = 'cd-dif falta'; dif.textContent = `Faltan ${money(-dd)} respecto de lo esperado.`; }
}

async function copiarResumen(){
  if(!datos) return;
  const d = datos;
  const L = [];
  L.push(`*DIARNEC — Cierre del ${fmtFecha(dia)}*`, '');
  L.push(`Ventas: ${money(d.ventas.total)} (${d.ventas.cant})`);
  d.ventas.porVendedor.forEach(g => L.push(`  • ${g.nombre}: ${money(g.total)} (${g.cant})`));
  L.push('', `Cobrado: ${money(d.cobrosTotal)}`);
  Object.keys(d.porMedio).sort().forEach(m => L.push(`  • ${MEDIOS[m] || m}: ${money(d.porMedio[m])}`));
  L.push('', `Gastos y proveedores: ${money(d.egresosTotal)}`);
  if(esAdmin) L.push(`Resultado del día: ${money(d.cobrosTotal - d.egresosTotal)}`);
  L.push(`Efectivo que debería haber: ${money(d.efectivo.esperado)}`);
  const c = parseFloat($('cd-contado') && $('cd-contado').value);
  if(!isNaN(c)) L.push(`Efectivo contado: ${money(c)} (${Math.abs(c - d.efectivo.esperado) < 0.005 ? 'sin diferencia' : (c > d.efectivo.esperado ? 'sobran ' : 'faltan ') + money(Math.abs(c - d.efectivo.esperado))})`);
  L.push('', `Pedidos online: ${d.online.total} hoy · ${d.online.pendientesTotal} sin atender`);
  if(d.dev.lista.length || d.bonif.lista.length) L.push(`Devoluciones: ${money(d.dev.total)} · Bonificaciones: ${money(d.bonif.total)}`);
  if(d.stock.sinStock.length) L.push(`Sin stock (${d.stock.sinStock.length}): ${d.stock.sinStock.slice(0, 8).join(', ')}${d.stock.sinStock.length > 8 ? '…' : ''}`);
  const texto = L.join('\n');
  const btn = $('cd-copiar');
  try {
    await navigator.clipboard.writeText(texto);
    const antes = btn.textContent; btn.textContent = '✅ Copiado'; setTimeout(() => { btn.textContent = antes; }, 1800);
  } catch(err){
    window.prompt('Copiá el resumen (Ctrl+C):', texto);
  }
}
