import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';

// Hoja de reparto: de los pedidos de la tienda que todavía no se entregaron se eligen los que salen y se arma
//   1) el CONSOLIDADO para cargar el camión (total de cada producto sumando todos los clientes), y
//   2) la hoja de ENTREGA POR CLIENTE (qué lleva cada uno, a dónde y cuánto cobrar).
// Entran los pedidos "Pasados a venta" sin entregar (ya descontaron stock) y, si se tildan, los pendientes.
// Lo que se imprime es el consolidado y las hojas por cliente. Al volver del reparto cada pedido se marca como entregado.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
const num = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 3 });

let pedidos = [];            // pedidos online sin entregar
let vendedores = {};         // id -> nombre
let marcados = new Set();    // ids de pedidos que salen en este reparto
let orden = 'direccion';

const donde = p => p.cliente_direccion || p.cliente_localidad || '';
const nombreProd = it => it.productos ? it.productos.nombre : '(producto borrado)';
const marcaProd = it => (it.productos && it.productos.marcas && it.productos.marcas.nombre) || '';

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('reparto', 'Hoja de reparto');

  content.innerHTML = `
    <div class="rp-error" id="rp-error" hidden><span></span><button class="btn-sm" id="rp-reintentar" type="button">↻ Reintentar</button></div>

    <div class="admin-section no-print" id="rp-seleccion">
      <div class="rp-head">
        <div>
          <h3 style="margin:0;">🚚 Pedidos para repartir</h3>
          <p class="rp-sub">Tildá los que salen en este reparto. Los <b>pasados a venta</b> ya descontaron stock; los <b>pendientes</b> todavía no.</p>
        </div>
        <div class="rp-btns">
          <button type="button" class="btn-sm" id="rp-todos">Tildar todos</button>
          <button type="button" class="btn-sm" id="rp-ninguno">Destildar todos</button>
          <label class="rp-orden">Ordenar por
            <select id="rp-orden"><option value="direccion">Dirección (A–Z)</option><option value="cliente">Cliente (A–Z)</option><option value="numero">N° de pedido</option></select>
          </label>
        </div>
      </div>
      <div id="rp-lista"><div class="empty-row">Cargando…</div></div>
    </div>

    <div id="rp-hoja"></div>
  `;

  $('rp-todos').addEventListener('click', () => { marcados = new Set(pedidos.map(p => p.id)); pintar(); });
  $('rp-ninguno').addEventListener('click', () => { marcados = new Set(); pintar(); });
  $('rp-orden').addEventListener('change', e => { orden = e.target.value; pintar(); });
  $('rp-reintentar').addEventListener('click', cargar);
  $('rp-lista').addEventListener('change', e => {
    const c = e.target.closest('input[data-id]');
    if(!c) return;
    c.checked ? marcados.add(Number(c.dataset.id)) : marcados.delete(Number(c.dataset.id));
    pintarHoja();
    pintarContador();
  });
  $('rp-lista').addEventListener('click', onClickLista);
  $('rp-hoja').addEventListener('click', e => {
    if(e.target.closest('#rp-imprimir')) window.print();
    else if(e.target.closest('#rp-copiar')) copiarConsolidado(e.target.closest('#rp-copiar'));
  });

  await cargar();
})();

async function cargar(){
  const [rP, rV] = await Promise.all([
    sb.from('ventas')
      .select('id, created_at, estado, total_neto, cliente_nombre, cliente_tipo, cliente_cuit, cliente_direccion, cliente_localidad, vendedor_preferido_id, ventas_items(cantidad, precio_unitario, subtotal, productos(nombre, unidad, stock_actual, marcas(nombre)))')
      .eq('canal', 'online').in('estado', ['pendiente', 'confirmada']).is('entregado_at', null)
      .order('created_at', { ascending: true }).limit(200),
    sb.from('vendedores').select('id, nombre')
  ]);
  const fallo = rP.error || rV.error;
  if(fallo){
    // Si falla algo no se muestra "no hay pedidos": se avisa, para no salir a repartir con una hoja incompleta.
    $('rp-error').hidden = false;
    $('rp-error').querySelector('span').textContent = 'No se pudieron cargar los pedidos (no se tocó nada): ' + fallo.message;
    return;
  }
  $('rp-error').hidden = true;
  pedidos = rP.data || [];
  vendedores = Object.fromEntries((rV.data || []).map(v => [v.id, v.nombre]));
  // Se conserva lo que ya estaba tildado; en la primera carga se tildan los pasados a venta
  if(!cargado) marcados = new Set(pedidos.filter(p => p.estado === 'confirmada').map(p => p.id));
  else marcados = new Set([...marcados].filter(id => pedidos.some(p => p.id === id)));
  cargado = true;
  pintar();
}
let cargado = false;

function ordenados(lista){
  const cmp = (a, b) => String(a).localeCompare(String(b), 'es', { sensitivity: 'base', numeric: true });
  const f = {
    direccion: (a, b) => cmp(donde(a) || '~', donde(b) || '~') || a.id - b.id,
    cliente: (a, b) => cmp(a.cliente_nombre || '~', b.cliente_nombre || '~') || a.id - b.id,
    numero: (a, b) => a.id - b.id
  }[orden];
  return [...lista].sort(f);
}

function pintar(){
  pintarLista();
  pintarHoja();
}

function pintarContador(){
  const el = $('rp-contador');
  if(el) el.textContent = `${marcados.size} de ${pedidos.length} pedido${pedidos.length === 1 ? '' : 's'} en este reparto`;
}

function pintarLista(){
  const cont = $('rp-lista');
  if(!pedidos.length){
    cont.innerHTML = '<div class="empty-row">🎉 No hay pedidos de la tienda para repartir: todo lo que pasó a venta ya está entregado.</div>';
    return;
  }
  cont.innerHTML = `<div class="rp-contador" id="rp-contador"></div>` + ordenados(pedidos).map(p => {
    const conf = p.estado === 'confirmada';
    return `<div class="rp-ped ${marcados.has(p.id) ? 'on' : ''}">
      <label class="rp-chk"><input type="checkbox" data-id="${p.id}" ${marcados.has(p.id) ? 'checked' : ''}></label>
      <div class="rp-ped-info">
        <b>#${p.id} · ${esc(p.cliente_nombre || 'Sin nombre')}</b>
        ${p.cliente_tipo ? `<span class="rp-tag rp-${p.cliente_tipo}">${p.cliente_tipo === 'comercio' ? 'Comercio' : 'Particular'}</span>` : ''}
        <span class="rp-tag ${conf ? 'rp-venta' : 'rp-pend'}">${conf ? 'Pasado a venta' : 'Pendiente'}</span>
        <div class="rp-dir">📍 ${esc(donde(p) || 'Sin dirección')}</div>
      </div>
      <div class="rp-ped-tot">${money(p.total_neto)}<small>${(p.ventas_items || []).length} producto${(p.ventas_items || []).length === 1 ? '' : 's'}</small></div>
      ${conf ? `<button type="button" class="btn-sm btn-blue" data-entregar="${p.id}" title="Ya se entregó: sacarlo de la lista">✔ Entregado</button>` : ''}
    </div>`;
  }).join('');
  pintarContador();
}

function pintarHoja(){
  const cont = $('rp-hoja');
  const sel = ordenados(pedidos.filter(p => marcados.has(p.id)));
  if(!sel.length){
    cont.innerHTML = pedidos.length ? '<div class="admin-section"><div class="empty-row">Tildá al menos un pedido para armar la hoja de reparto.</div></div>' : '';
    return;
  }

  // Consolidado: suma de cada producto en todos los pedidos tildados
  const mapa = new Map();
  let totalCobrar = 0;
  for(const p of sel){
    totalCobrar += Number(p.total_neto) || 0;
    for(const it of (p.ventas_items || [])){
      const k = it.productos ? `${marcaProd(it)}|${it.productos.nombre}|${it.productos.unidad || ''}` : 'borrado';
      const g = mapa.get(k) || { marca: marcaProd(it), nombre: nombreProd(it), unidad: (it.productos && it.productos.unidad) || '', cant: 0, clientes: new Set(), pendiente: 0, stock: it.productos ? Number(it.productos.stock_actual) : null };
      g.cant += Number(it.cantidad) || 0;
      g.clientes.add(p.id);
      if(p.estado === 'pendiente') g.pendiente += Number(it.cantidad) || 0;
      mapa.set(k, g);
    }
  }
  const filas = [...mapa.values()].sort((a, b) => a.marca.localeCompare(b.marca, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
  const unidades = filas.reduce((s, g) => s + g.cant, 0);
  const faltantes = filas.filter(g => g.pendiente > 0 && g.stock !== null && g.pendiente > g.stock);
  const hayPend = sel.some(p => p.estado === 'pendiente');

  cont.innerHTML = `
    <div class="admin-section rp-consol">
      <div class="rp-head">
        <div>
          <h3 style="margin:0;">📦 Consolidado para cargar el camión</h3>
          <p class="rp-sub">${sel.length} cliente${sel.length === 1 ? '' : 's'} · ${filas.length} producto${filas.length === 1 ? '' : 's'} distintos · ${num(unidades)} unidades en total · a cobrar ${money(totalCobrar)}</p>
        </div>
        <div class="rp-btns no-print">
          <button type="button" class="btn-sm btn-add" id="rp-copiar">📋 Copiar consolidado</button>
          <button type="button" class="btn-sm btn-grey" id="rp-imprimir">🖨 Imprimir hoja</button>
        </div>
      </div>
      ${faltantes.length ? `<div class="rp-alerta">⚠️ <b>Falta stock</b> para los pedidos pendientes de: ${faltantes.map(g => `${esc(g.nombre)} (piden ${num(g.pendiente)}, hay ${num(g.stock)})`).join('; ')}.</div>` : ''}
      ${hayPend ? '<p class="rp-nota no-print">Los pedidos <b>pendientes</b> todavía no descontaron stock: se descuenta cuando los pasás a venta.</p>' : ''}
      <table class="rp-tabla">
        <thead><tr><th>Producto</th><th class="num">A cargar</th><th class="num">En cuántos pedidos</th><th class="rp-check">Cargado</th></tr></thead>
        <tbody>${filas.map(g => `<tr>
          <td>${g.marca ? `<span class="rp-marca">${esc(g.marca)}</span> ` : ''}<b>${esc(g.nombre)}</b>${g.unidad ? ` <span class="rp-un">${esc(g.unidad)}</span>` : ''}</td>
          <td class="num rp-cant">${num(g.cant)}</td>
          <td class="num">${g.clientes.size}</td>
          <td class="rp-check">☐</td></tr>`).join('')}</tbody>
      </table>
    </div>

    <h3 class="rp-h-cli">🏠 Entrega por cliente</h3>
    <div class="rp-clientes">${sel.map((p, i) => `
      <section class="rp-cli">
        <header>
          <span class="rp-orden-n">${i + 1}</span>
          <div class="rp-cli-t"><b>${esc(p.cliente_nombre || 'Sin nombre')}</b> <small>pedido #${p.id}${p.cliente_tipo ? ' · ' + (p.cliente_tipo === 'comercio' ? 'Comercio' : 'Particular') : ''}${p.cliente_cuit ? ' · CUIT ' + esc(p.cliente_cuit) : ''}</small>
            <div class="rp-dir">📍 ${esc(donde(p) || 'Sin dirección')}</div>
            ${p.vendedor_preferido_id && vendedores[p.vendedor_preferido_id] ? `<div class="rp-vend">Vendedor elegido: ${esc(vendedores[p.vendedor_preferido_id])}</div>` : ''}
          </div>
          ${p.estado === 'pendiente' ? '<span class="rp-tag rp-pend">Pendiente</span>' : ''}
        </header>
        <table class="rp-tabla rp-mini"><tbody>${(p.ventas_items || []).map(it => `<tr>
          <td><b>${num(it.cantidad)}</b> × ${esc(nombreProd(it))}${it.productos && it.productos.unidad ? ` <span class="rp-un">${esc(it.productos.unidad)}</span>` : ''}</td>
          <td class="num">${money(it.subtotal)}</td></tr>`).join('')}</tbody></table>
        <footer><span>A cobrar: <b>${money(p.total_neto)}</b></span><span class="rp-firma">☐ Entregado &nbsp;&nbsp; ☐ Cobrado $ ________</span></footer>
      </section>`).join('')}</div>`;
}

async function onClickLista(e){
  const b = e.target.closest('button[data-entregar]');
  if(!b) return;
  const id = Number(b.dataset.entregar);
  const p = pedidos.find(x => x.id === id);
  if(!p) return;
  if(!(await confirmDialog(`¿Marcar como entregado el pedido #${id} de ${p.cliente_nombre || 'este cliente'}?\n\nSale de la lista de reparto.`, { confirmLabel: 'Marcar entregado' }))) return;
  b.disabled = true;
  const { error } = await sb.rpc('marcar_pedido_entregado', { p_venta_id: id, p_entregado: true });
  if(error){ b.disabled = false; alert('No se pudo marcar como entregado: ' + error.message); return; }
  marcados.delete(id);
  await cargar();
}

async function copiarConsolidado(btn){
  const sel = ordenados(pedidos.filter(p => marcados.has(p.id)));
  if(!sel.length) return;
  const mapa = new Map();
  sel.forEach(p => (p.ventas_items || []).forEach(it => {
    const k = `${marcaProd(it)} ${nombreProd(it)}${it.productos && it.productos.unidad ? ' (' + it.productos.unidad + ')' : ''}`.trim();
    mapa.set(k, (mapa.get(k) || 0) + (Number(it.cantidad) || 0));
  }));
  const L = ['*DIARNEC — Hoja de reparto*', '', '*A cargar:*', ...[...mapa.entries()].sort((a, b) => a[0].localeCompare(b[0], 'es')).map(([k, c]) => `• ${num(c)} × ${k}`), '', '*Entregas:*'];
  sel.forEach((p, i) => L.push(`${i + 1}. ${p.cliente_nombre || 'Sin nombre'} — ${donde(p) || 'sin dirección'} — ${money(p.total_neto)}`));
  const texto = L.join('\n');
  try {
    await navigator.clipboard.writeText(texto);
    const antes = btn.textContent; btn.textContent = '✅ Copiado'; setTimeout(() => { btn.textContent = antes; }, 1800);
  } catch(err){
    window.prompt('Copiá el consolidado (Ctrl+C):', texto);
  }
}
