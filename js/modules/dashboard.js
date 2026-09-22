import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money, dateTime } from '../shared/format.js';

// Paleta: Black russian / Alucard night / Palatinate blue / Grey placidity / Baby grey.
const BLACK = '#000029', ALUCARD = '#000051', BLUE = '#173DED', GREY = '#BABABA', ROJO = '#C0392B', VERDE = '#17A06B';
const DIAS = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const SEMANAS = 12;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = x => Number(x) || 0;
const $ = id => document.getElementById(id);

let tend = [];          // últimas semanas, la actual primero
let selIdx = 0;         // semana elegida
let cmpOn = false;      // ¿comparando?
let cmpIdx = 1;         // semana con la que se compara
let A = null, B = null; // datos de la semana elegida / comparada
let productosStock = null;
let charts = {};

// ---------- utilidades de fechas ----------

const fmtDia = iso => { const [, m, d] = iso.split('-'); return `${d}/${m}`; };
const etiqueta = (w, i) => `${fmtDia(w.desde)} al ${fmtDia(w.hasta)}${i === 0 ? ' (esta semana)' : ''}`;
const inicioIso = iso => `${iso}T00:00:00-03:00`; // el negocio opera en hora de Argentina
const finIso = iso => { const d = new Date(`${iso}T00:00:00-03:00`); d.setDate(d.getDate() + 1); return d.toISOString(); };

// ---------- arranque ----------

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('dashboard', 'Dashboard');

  content.innerHTML = `
    <div class="dash-bar">
      <div class="dash-week">
        <button id="w-prev" title="Semana anterior">‹</button>
        <select id="w-sel" title="Elegir semana"></select>
        <button id="w-next" title="Semana siguiente">›</button>
      </div>
      <button class="btn-cmp" id="w-cmp">⇄ Comparar semana</button>
      <div class="dash-cmp-box" id="w-cmp-box">comparar con <select id="w-cmp-sel"></select></div>
    </div>
    <div id="dash-body"><div class="rk-vacio">Cargando…</div></div>
  `;

  $('w-sel').addEventListener('change', e => elegirSemana(Number(e.target.value)));
  $('w-prev').addEventListener('click', () => elegirSemana(selIdx + 1));
  $('w-next').addEventListener('click', () => elegirSemana(selIdx - 1));
  $('w-cmp').addEventListener('click', alternarComparacion);
  $('w-cmp-sel').addEventListener('change', e => { cmpIdx = Number(e.target.value); cargarSemana(); });

  const { data, error } = await sb.rpc('dash_tendencia', { p_semanas: SEMANAS });
  if(error){ $('dash-body').innerHTML = `<div class="admin-section rk-vacio">No se pudo cargar el dashboard: ${esc(error.message)}</div>`; return; }
  tend = data || [];
  pintarControles();
  await cargarSemana();
})();

function pintarControles(){
  $('w-sel').innerHTML = tend.map((w, i) => `<option value="${i}" ${i === selIdx ? 'selected' : ''}>${etiqueta(w, i)}</option>`).join('');
  $('w-prev').disabled = selIdx >= tend.length - 1;
  $('w-next').disabled = selIdx <= 0;
  $('w-cmp').classList.toggle('on', cmpOn);
  $('w-cmp').textContent = cmpOn ? '✕ Dejar de comparar' : '⇄ Comparar semana';
  $('w-cmp-box').classList.toggle('open', cmpOn);
  $('w-cmp-sel').innerHTML = tend.map((w, i) => i === selIdx ? '' : `<option value="${i}" ${i === cmpIdx ? 'selected' : ''}>${etiqueta(w, i)}</option>`).join('');
}

function cmpPorDefecto(){
  cmpIdx = selIdx + 1 < tend.length ? selIdx + 1 : (selIdx > 0 ? selIdx - 1 : selIdx);
}

function elegirSemana(i){
  if(i < 0 || i >= tend.length) return;
  selIdx = i;
  if(cmpOn && cmpIdx === selIdx) cmpPorDefecto();
  pintarControles();
  cargarSemana();
}

function alternarComparacion(){
  cmpOn = !cmpOn;
  if(cmpOn && (cmpIdx === selIdx || cmpIdx >= tend.length)) cmpPorDefecto();
  pintarControles();
  cargarSemana();
}

async function cargarSemana(){
  const s = tend[selIdx];
  const trabajos = [sb.rpc('dash_periodo', { p_desde: s.desde, p_hasta: s.hasta })];
  if(cmpOn){ const c = tend[cmpIdx]; trabajos.push(sb.rpc('dash_periodo', { p_desde: c.desde, p_hasta: c.hasta })); }
  const [ra, rb] = await Promise.all(trabajos);
  const err = ra.error || (rb && rb.error);
  if(err){ $('dash-body').innerHTML = `<div class="admin-section rk-vacio">No se pudo cargar la semana: ${esc(err.message)}</div>`; return; }
  A = ra.data;
  B = rb ? rb.data : null;

  if(!productosStock){
    const { data } = await sb.from('productos').select('nombre, stock_actual, stock_minimo').eq('activo', true);
    productosStock = data || [];
  }
  const { data: ultimas } = await sb.from('ventas')
    .select('created_at, canal, cliente_nombre, total_neto, vendedores(nombre)')
    .eq('estado', 'confirmada').gte('created_at', inicioIso(s.desde)).lt('created_at', finIso(s.hasta))
    .order('created_at', { ascending: false }).limit(8);
  render(ultimas || []);
}

// ---------- indicadores ----------

function calc(d){
  const k = d.kpis;
  const ventas = num(k.ventas_neto), cantidad = num(k.cantidad_ventas);
  const creditos = num(k.devoluciones) + num(k.bonificaciones);
  const egresos = num(k.gastos) + num(k.pagos_proveedores);
  const cobros = num(k.cobros), costo = num(k.costo_estimado);
  return {
    ventas, cantidad, ticket: cantidad ? ventas / cantidad : 0,
    creditos, cantDev: num(k.cantidad_devoluciones), facturacion: ventas - creditos,
    cobros, egresos, gastos: num(k.gastos), prov: num(k.pagos_proveedores), flujo: cobros - egresos,
    costo, margen: costo > 0 ? ventas - costo : null, unidades: num(k.unidades), comisiones: num(k.comisiones)
  };
}

const KPIS = [
  { k: 'ventas', t: 'Ventas (neto)', ic: '🧾', sub: c => `${c.cantidad} venta${c.cantidad === 1 ? '' : 's'} · ticket ${money(c.ticket)}` },
  { k: 'facturacion', t: 'Facturación neta', ic: '📥', sub: () => 'Ventas − devoluciones y bonificaciones' },
  { k: 'creditos', t: 'Devoluciones y bonificaciones', ic: '↩', invert: true, sub: c => `${c.cantDev} devolución${c.cantDev === 1 ? '' : 'es'} en la semana` },
  { k: 'cobros', t: 'Cobros', ic: '💵', sub: () => 'Pagos de vendedores y clientes' },
  { k: 'egresos', t: 'Egresos', ic: '📤', invert: true, sub: c => `Gastos ${money(c.gastos)} · proveedores ${money(c.prov)}` },
  { k: 'flujo', t: 'Flujo de caja', ic: '💰', sub: () => 'Cobros − egresos' },
  { k: 'margen', t: 'Margen estimado', ic: '📈', sub: c => c.margen === null ? 'Cargá los costos en Inventario para verlo' : 'Ventas − costo actual de lo vendido' },
  { k: 'unidades', t: 'Unidades vendidas', ic: '📦', plano: true, sub: c => `${money(c.comisiones)} en comisiones a vendedores` }
];

function chipDelta(a, b, invert){
  if(a === null || b === null) return '';
  const d = a - b;
  if(Math.abs(d) < 0.005) return '<span class="delta igual">= igual</span>';
  const pct = Math.abs(b) > 0.005 ? ` ${Math.round(Math.abs(d) / Math.abs(b) * 100)}%` : '';
  const sube = d > 0;
  return `<span class="delta ${(invert ? !sube : sube) ? 'bueno' : 'malo'}">${sube ? '▲' : '▼'}${pct}</span>`;
}

// ---------- balance: ingresos (lo que se cobró) vs. egresos (todo lo que salió: gastos y proveedores) ----------

function htmlBalance(){
  const a = calc(A);
  const ing = a.cobros, egr = a.egresos;
  const max = Math.max(ing, egr, 1);
  const pctIng = Math.max(ing > 0 ? 4 : 0, Math.round(ing / max * 100));
  const pctEgr = Math.max(egr > 0 ? 4 : 0, Math.round(egr / max * 100));
  const diff = ing - egr;

  return `
    <div class="admin-section balance-card">
      <div class="dash-head"><h3>⚖️ Balance: ingresos vs. egresos</h3><span class="dash-sub">${esc(etiqueta(tend[selIdx], selIdx))}</span></div>
      <div class="balance-nums">
        <div class="balance-num">
          <span class="balance-dot" style="background:${VERDE}"></span>
          <span class="balance-lbl">Ingresos (cobros)</span>
          <b style="color:${VERDE}">${money(ing)}</b>
        </div>
        <div class="balance-num">
          <span class="balance-dot" style="background:${ROJO}"></span>
          <span class="balance-lbl">Egresos (gastos y proveedores)</span>
          <b style="color:${ROJO}">${money(egr)}</b>
        </div>
      </div>
      <div class="balance-bars">
        <div class="balance-bar-row">
          <span class="balance-bar-lbl">Ingresos</span>
          <div class="balance-bar-track"><div class="balance-bar-fill" style="width:${pctIng}%;background:${VERDE}"></div></div>
          <span class="balance-bar-val">${money(ing)}</span>
        </div>
        <div class="balance-bar-row">
          <span class="balance-bar-lbl">Egresos</span>
          <div class="balance-bar-track"><div class="balance-bar-fill" style="width:${pctEgr}%;background:${ROJO}"></div></div>
          <span class="balance-bar-val">${money(egr)}</span>
        </div>
      </div>
      <div class="balance-foot">
        ${diff >= 0
          ? `Entró <b style="color:${VERDE}">${money(diff)}</b> más de lo que salió esta semana (gastos + proveedores).`
          : `Salió <b style="color:${ROJO}">${money(-diff)}</b> más de lo que entró esta semana (gastos + proveedores).`}
      </div>
      <div class="chart-box balance-chart"><canvas id="chart-balance"></canvas></div>
    </div>`;
}

function htmlKpis(){
  const a = calc(A), b = B ? calc(B) : null;
  const fmt = (k, v) => v === null ? '—' : (k.plano ? String(Math.round(v * 1000) / 1000) : money(v));
  // La ganancia (margen) va en verde, igual que en el Balance de arriba; negativa sigue con el
  // color "neg" de siempre.
  const colorValor = k => k.k === 'margen' && a[k.k] !== null ? (a[k.k] < 0 ? '' : `color:${VERDE};`) : '';
  return `<div class="kpi-row">${KPIS.map(k => `
    <div class="kpi-card">
      <div class="kpi-top"><span>${k.t}</span><div class="kpi-icon">${k.ic}</div></div>
      <b class="${a[k.k] !== null && a[k.k] < 0 ? 'neg' : ''}" style="${colorValor(k)}">${fmt(k, a[k.k])}</b>
      <div class="kpi-sub">${k.sub(a)}</div>
      ${b ? `<div class="kpi-cmp"><span>Comparada: ${fmt(k, b[k.k])}</span>${chipDelta(a[k.k], b[k.k], k.invert)}</div>` : ''}
    </div>`).join('')}</div>`;
}

// ---------- rankings ----------

// lista: filas de la semana elegida; cmpLista: filas de la comparada (para mostrar movimientos y diferencias)
function rankingHtml(lista, cmpLista, cfg){
  const top = lista.slice(0, cfg.top || 10);
  if(top.length === 0) return `<div class="rk-vacio">${cfg.vacio}</div>`;
  const max = Math.max(...top.map(cfg.valor), 0.0001);
  const otro = new Map((cmpLista || []).map((x, i) => [x.id ?? x.nombre, { pos: i + 1, x }]));
  return top.map((x, i) => {
    const previo = B ? otro.get(x.id ?? x.nombre) : null;
    let mov = '';
    if(B){
      if(!previo) mov = '<span class="rk-mov sube">NUEVO</span>';
      else if(previo.pos !== i + 1) mov = `<span class="rk-mov ${previo.pos > i + 1 ? 'sube' : 'baja'}">${previo.pos > i + 1 ? '▲' : '▼'}${Math.abs(previo.pos - (i + 1))}</span>`;
    }
    return `
      <div class="rk-row ${i < 3 ? 'top' + (i + 1) : ''}">
        <div class="rk-pos">${i < 3 ? ['🥇', '🥈', '🥉'][i] : i + 1}</div>
        <div class="rk-nom"><b>${esc(cfg.nombre(x))}</b>${mov}<small>${cfg.sub(x)}</small>
          <div class="rk-barra ${cfg.rojo ? 'rojo' : ''}"><i style="width:${Math.max(3, cfg.valor(x) / max * 100)}%"></i></div></div>
        <div class="rk-val">${cfg.valorTxt(x)}<small>${B ? (previo ? 'antes: ' + cfg.valorTxt(previo.x) : 'no estaba') : (cfg.valorSub ? cfg.valorSub(x) : '')}</small></div>
      </div>`;
  }).join('');
}

const CFG = {
  productos: {
    vacio: 'Sin ventas de productos en esta semana.',
    nombre: x => x.nombre, valor: x => num(x.monto),
    sub: x => `${num(x.unidades)} un. · ${esc(x.marca || 'sin marca')}${x.unidad ? ' · ' + esc(x.unidad) : ''}`,
    valorTxt: x => money(x.monto)
  },
  vendedores: {
    vacio: 'Sin ventas de vendedores en esta semana.',
    nombre: x => (x.online ? '🌐 ' : '') + x.nombre, valor: x => num(x.neto),
    sub: x => `${x.ventas} venta${x.ventas === 1 ? '' : 's'} · comisión ${money(x.comision)}${num(x.devuelto) > 0 ? ' · devolvió ' + money(x.devuelto) : ''}`,
    valorTxt: x => money(x.neto)
  },
  devueltos: {
    vacio: 'No hubo devoluciones en esta semana. 👌',
    nombre: x => x.nombre, valor: x => num(x.unidades), rojo: true,
    sub: x => `${x.devoluciones} devolución${x.devoluciones === 1 ? '' : 'es'} · ${num(x.vendidas) > 0 ? Math.round(num(x.unidades) / num(x.vendidas) * 100) + '% de lo vendido' : 'sin ventas esa semana'}`,
    valorTxt: x => `${num(x.unidades)} un.`, valorSub: x => money(x.monto)
  },
  marcas: {
    vacio: 'Sin ventas por marca en esta semana.', top: 8,
    nombre: x => x.nombre, valor: x => num(x.monto),
    sub: x => `${num(x.unidades)} un.`,
    valorTxt: x => money(x.monto)
  },
  clientes: {
    vacio: 'Ningún cliente de la cartera compró esta semana.', top: 5,
    nombre: x => x.nombre, valor: x => num(x.monto),
    sub: x => `${x.ventas} compra${x.ventas === 1 ? '' : 's'}`,
    valorTxt: x => money(x.monto)
  }
};

const rk = (lista, cmpLista, nombre) => rankingHtml(lista, cmpLista, CFG[nombre]);

// ---------- pantalla ----------

function render(ultimas){
  const s = tend[selIdx];
  const c = cmpOn ? tend[cmpIdx] : null;
  const sub = c ? `${etiqueta(s, selIdx)} vs ${etiqueta(c, cmpIdx)}` : etiqueta(s, selIdx);
  const cat = A.categorias || [];
  const totalCat = cat.reduce((t, x) => t + num(x.monto), 0);

  $('dash-body').innerHTML = `
    ${htmlBalance()}
    ${htmlKpis()}

    <div class="dash-grid">
      <div class="admin-section">
        <div class="dash-head"><h3>Ventas por día</h3><span class="dash-sub">${c ? 'Semana elegida vs comparada' : 'Ventas netas de la semana'}</span></div>
        <div class="chart-box"><canvas id="chart-dia"></canvas></div>
      </div>
      <div class="admin-section">
        <div class="dash-head"><h3>Últimas ${tend.length} semanas</h3><span class="dash-sub">Tocá una barra para elegir esa semana</span></div>
        <div class="chart-box"><canvas id="chart-tend"></canvas></div>
      </div>
    </div>

    <div class="dash-grid">
      <div class="admin-section">
        <div class="dash-head"><h3>🏆 Productos ganadores</h3><span class="dash-sub">por monto vendido</span></div>
        ${rk(A.productos, B && B.productos, 'productos')}
      </div>
      <div class="admin-section">
        <div class="dash-head"><h3>🥇 Mejores vendedores</h3><span class="dash-sub">por ventas netas</span></div>
        ${rk(A.vendedores, B && B.vendedores, 'vendedores')}
      </div>
    </div>

    <div class="dash-grid">
      <div class="admin-section">
        <div class="dash-head"><h3>↩ Productos más devueltos</h3><span class="dash-sub">por unidades devueltas</span></div>
        ${rk(A.devueltos, B && B.devueltos, 'devueltos')}
      </div>
      <div class="admin-section">
        <div class="dash-head"><h3>🏷 Marcas líderes</h3><span class="dash-sub">por monto vendido</span></div>
        ${rk(A.marcas, B && B.marcas, 'marcas')}
      </div>
    </div>

    <div class="dash-grid">
      <div class="admin-section">
        <div class="dash-head"><h3>Ventas por categoría</h3><span class="dash-sub">${esc(etiqueta(s, selIdx))}</span></div>
        <div class="donut-wrap"><canvas id="chart-donut"></canvas><div class="donut-center"><b>${money(totalCat)}</b><span>Total</span></div></div>
        <div class="legend">${cat.length === 0 ? '<div class="legend-empty">Sin ventas esta semana.</div>' : cat.map(x => `
          <div class="legend-row"><span class="legend-dot" style="background:${esc(x.color || GREY)};"></span><span>${esc(x.nombre)}</span><b>${money(x.monto)}</b></div>`).join('')}</div>
      </div>
      <div class="admin-section">
        <div class="dash-head"><h3>⭐ Mejores clientes</h3><span class="dash-sub">clientes de la cartera</span></div>
        ${rk(A.clientes, B && B.clientes, 'clientes')}
      </div>
    </div>

    <div class="dash-grid">
      <div class="admin-section">
        <div class="dash-head"><h3>Ventas de la semana</h3><span class="dash-sub">las últimas 8</span></div>
        <table>
          <thead><tr><th>Fecha</th><th>Canal</th><th>Comercio / vendedor</th><th>Total</th></tr></thead>
          <tbody>${ultimas.length === 0 ? '<tr><td colspan="4" class="empty-row">No hubo ventas en esta semana.</td></tr>' : ultimas.map(v => `
            <tr><td>${dateTime(v.created_at)}</td><td>${v.canal === 'online' ? 'Tienda online' : 'Manual'}</td>
              <td>${esc(v.cliente_nombre || (v.vendedores ? v.vendedores.nombre : ''))}</td><td>${money(v.total_neto)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="admin-section">
        <div class="dash-head"><h3>Stock bajo</h3><span class="dash-sub">hoy</span></div>
        <div id="stock-bajo-list">${htmlStockBajo(productosStock)}</div>
      </div>
    </div>`;

  dibujarGraficos(cat);
}

function htmlStockBajo(productos){
  const conMinimo = productos.filter(p => num(p.stock_minimo) > 0);
  const base = conMinimo.length > 0 ? conMinimo : productos;
  const ordenados = [...base].sort((a, b) => num(a.stock_actual) - num(b.stock_actual)).slice(0, 6);
  if(ordenados.length === 0) return '<div class="legend-empty">No hay productos cargados.</div>';
  return ordenados.map(p => {
    const actual = num(p.stock_actual), minimo = num(p.stock_minimo);
    const tope = minimo > 0 ? minimo * 2 : 20;
    const pct = Math.max(0, Math.min(100, Math.round((actual / tope) * 100)));
    const bajo = minimo > 0 ? actual <= minimo : actual <= 5;
    // Al revés de un semáforo: el azul vivo (el color que más salta del texto normal,
    // que ya es casi negro) marca lo urgente; lo que está bien queda en el mismo negro del resto.
    const color = actual <= 0 ? BLUE : (bajo ? ALUCARD : BLACK);
    return `
      <div class="stock-item">
        <div class="stock-top"><span class="name">${esc(p.nombre)}</span><b style="color:${color};">${actual}${minimo > 0 ? ' / ' + minimo : ''}</b></div>
        <div class="stock-bar"><div style="width:${pct}%;background:${color};"></div></div>
      </div>`;
  }).join('');
}

// ---------- gráficos ----------

const etiquetaDia = f => { const d = new Date(`${f}T12:00:00`); return `${DIAS[(d.getDay() + 6) % 7]} ${f.slice(8, 10)}`; };
const ejeDinero = { beginAtZero: true, grid: { color: GREY + '55' }, ticks: { font: { size: 10 }, callback: v => '$' + Number(v).toLocaleString('es-AR') } };
const tooltipDinero = { callbacks: { label: c => `${c.dataset.label}: ${money(c.parsed.y ?? c.parsed)}` } };

function dibujarGraficos(cat){
  Object.values(charts).forEach(ch => ch && ch.destroy());
  charts = {};
  if(!window.Chart) return;

  // balance semanal: ingresos (cobros, línea) vs egresos (gastos + proveedores, barra)
  const ascBal = [...tend].reverse();
  const origBal = k => tend.length - 1 - k;
  charts.balance = new Chart($('chart-balance'), {
    data: { labels: ascBal.map(w => fmtDia(w.desde)), datasets: [
      { type: 'bar', label: 'Egresos', data: ascBal.map(w => num(w.egresos)), backgroundColor: ROJO, borderRadius: 4 },
      { type: 'line', label: 'Ingresos', data: ascBal.map(w => num(w.cobros)),
        borderColor: VERDE, backgroundColor: VERDE, tension: .3, pointRadius: 3 }
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 9, boxHeight: 9, font: { size: 11 } } }, tooltip: tooltipDinero },
      scales: { y: ejeDinero, x: { grid: { display: false }, ticks: { font: { size: 10 } } } },
      onClick: (e, els) => { if(els.length) elegirSemana(origBal(els[0].index)); } }
  });

  // ventas por día (semana elegida y, si se compara, la otra en gris)
  const dias = DIAS.map((d, i) => `${d}${A.por_dia[i] ? ' ' + A.por_dia[i].fecha.slice(8, 10) : ''}`);
  const datasets = [{ label: etiqueta(tend[selIdx], selIdx).replace(' (esta semana)', ''), data: A.por_dia.map(x => num(x.ventas_neto)), backgroundColor: BLUE, borderRadius: 4 }];
  if(B) datasets.push({ label: etiqueta(tend[cmpIdx], cmpIdx).replace(' (esta semana)', ''), data: B.por_dia.map(x => num(x.ventas_neto)), backgroundColor: GREY, borderRadius: 4 });
  charts.dia = new Chart($('chart-dia'), {
    type: 'bar', data: { labels: dias, datasets },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: !!B, position: 'bottom', labels: { boxWidth: 9, boxHeight: 9, font: { size: 11 } } }, tooltip: tooltipDinero },
      scales: { y: ejeDinero, x: { grid: { display: false }, ticks: { font: { size: 10 } } } } }
  });

  // evolución de las últimas semanas (de la más vieja a la actual); la elegida y la comparada resaltan
  const asc = [...tend].reverse();
  const orig = k => tend.length - 1 - k;
  const colores = asc.map((_, k) => orig(k) === selIdx ? BLUE : (cmpOn && orig(k) === cmpIdx ? BLACK : GREY));
  charts.tend = new Chart($('chart-tend'), {
    type: 'bar',
    data: { labels: asc.map(w => fmtDia(w.desde)), datasets: [
      { type: 'bar', label: 'Ventas netas', data: asc.map(w => num(w.ventas_neto)), backgroundColor: colores, borderRadius: 4 },
      { type: 'line', label: 'Cobros', data: asc.map(w => num(w.cobros)), borderColor: ALUCARD, backgroundColor: ALUCARD, tension: .3, pointRadius: 3 }
    ] },
    options: { responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 9, boxHeight: 9, font: { size: 11 } } }, tooltip: tooltipDinero },
      scales: { y: ejeDinero, x: { grid: { display: false }, ticks: { font: { size: 10 } } } },
      onClick: (e, els) => { if(els.length) elegirSemana(orig(els[0].index)); } }
  });

  // categorías
  if(cat.length){
    charts.donut = new Chart($('chart-donut'), {
      type: 'doughnut',
      data: { labels: cat.map(x => x.nombre), datasets: [{ data: cat.map(x => num(x.monto)), backgroundColor: cat.map(x => x.color || GREY), borderWidth: 2, borderColor: '#fff' }] },
      options: { cutout: '72%', plugins: { legend: { display: false }, tooltip: { callbacks: { label: c => money(c.parsed) } } } }
    });
  }
}
