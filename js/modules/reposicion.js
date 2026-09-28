import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { normalizarTelefono } from '../shared/remito.js';

// Reposición sugerida: qué conviene pedir a cada proveedor.
//  · Se sugiere un producto cuando está en su stock mínimo (o por debajo), o cuando, al ritmo de venta reciente,
//    se le acaba en una semana o menos.
//  · La cantidad sugerida lleva el stock hasta lo que hace falta para "cubrir N días" de venta (o el mínimo, lo que sea mayor).
//  · Los pedidos salen agrupados por proveedor (según la marca de cada producto), con las cantidades editables.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 1 }).format(n);

let productos = [];
let proveedores = [];
let vendido = {};      // producto_id -> unidades vendidas en la ventana
let ventana = 30;      // días que se miran hacia atrás
let cobertura = 15;    // días de venta que se quiere tener cubiertos
let sugeridos = [];    // filas calculadas (con la cantidad editable)

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('reposicion', 'Reposición sugerida');

  content.innerHTML = `
    <div class="admin-section">
      <h3>¿Qué tengo que pedir?</h3>
      <p style="color:var(--muted);font-size:13px;margin-bottom:12px;">
        Se sugiere lo que está en su stock mínimo o por debajo, y lo que al ritmo de venta reciente se agota en una semana o menos.
        Las cantidades se pueden ajustar antes de mandar el pedido. Si todavía no cargaste el <b>stock mínimo</b> de tus productos (Inventario), la lista se arma solo con lo que se vende.
      </p>
      <div class="rp-params">
        <label>Mirar las ventas de los últimos
          <select id="rp-ventana"><option value="15">15 días</option><option value="30" selected>30 días</option><option value="60">60 días</option><option value="90">90 días</option></select></label>
        <label>Pedir para cubrir
          <select id="rp-cobertura"><option value="7">7 días</option><option value="15" selected>15 días</option><option value="30">30 días</option><option value="45">45 días</option></select></label>
      </div>
      <div class="rp-resumen" id="rp-resumen"></div>
    </div>
    <div id="rp-grupos"><div class="admin-section"><div class="empty-row">Cargando...</div></div></div>
  `;

  document.getElementById('rp-ventana').addEventListener('change', async e => { ventana = Number(e.target.value); await cargarVentas(); calcular(); });
  document.getElementById('rp-cobertura').addEventListener('change', e => { cobertura = Number(e.target.value); calcular(); });
  document.getElementById('rp-grupos').addEventListener('input', onInput);
  document.getElementById('rp-grupos').addEventListener('click', onClick);

  await cargarBase();
  await cargarVentas();
  calcular();
})();

async function cargarBase(){
  const [{ data: pr, error }, { data: pv }] = await Promise.all([
    sb.from('productos').select('id, nombre, unidad, stock_actual, stock_minimo, marca_id, marcas(nombre, proveedor_id)').eq('activo', true).order('nombre'),
    sb.from('proveedores').select('id, nombre, telefono, activo')
  ]);
  if(error){ document.getElementById('rp-grupos').innerHTML = `<div class="admin-section"><div class="empty-row">No se pudo cargar el inventario: ${esc(error.message)}</div></div>`; return; }
  productos = pr || [];
  proveedores = pv || [];
}

// Unidades vendidas por producto en la ventana. Cuenta ventas confirmadas del negocio (retiros de vendedores, ventas manuales
// y pedidos online); no cuenta lo que un vendedor le vende a sus propios clientes (eso no sale del stock de la empresa).
async function cargarVentas(){
  const desde = new Date(Date.now() - ventana * 86400000).toISOString();
  vendido = {};
  const paso = 1000;
  for(let ini = 0; ini < 20000; ini += paso){
    const { data, error } = await sb.from('ventas_items')
      .select('producto_id, cantidad, ventas!inner(estado, canal, created_at)')
      .eq('ventas.estado', 'confirmada').neq('ventas.canal', 'vendedor').gte('ventas.created_at', desde)
      .range(ini, ini + paso - 1);
    if(error){ console.warn('No se pudieron leer las ventas:', error.message); return; }
    (data || []).forEach(it => { vendido[it.producto_id] = (vendido[it.producto_id] || 0) + Number(it.cantidad); });
    if(!data || data.length < paso) break;
  }
}

function calcular(){
  sugeridos = [];
  for(const p of productos){
    const stock = Number(p.stock_actual) || 0;
    const minimo = Number(p.stock_minimo) || 0;
    const vend = vendido[p.id] || 0;
    const ritmo = vend / ventana; // unidades por día
    const dias = ritmo > 0 ? stock / ritmo : null;
    const bajoMinimo = minimo > 0 && stock <= minimo;
    const seAgota = ritmo > 0 && dias !== null && dias <= 7;
    if(!bajoMinimo && !seAgota) continue;
    const objetivo = Math.max(minimo, Math.ceil(ritmo * cobertura));
    const qty = Math.max(1, Math.ceil(objetivo - stock));
    const m = p.marcas;
    sugeridos.push({
      producto: p, stock, minimo, vend, dias, bajoMinimo, seAgota, qty, incluir: true,
      proveedorId: m && m.proveedor_id ? m.proveedor_id : null, marca: m ? m.nombre : ''
    });
  }
  render();
}

function grupos(){
  const map = new Map();
  for(const s of sugeridos){
    const k = s.proveedorId || 0;
    if(!map.has(k)) map.set(k, []);
    map.get(k).push(s);
  }
  const nombre = id => (proveedores.find(p => p.id === id) || {}).nombre || '';
  // primero los proveedores por nombre; al final los productos sin proveedor
  return [...map.entries()].sort((a, b) => (a[0] === 0) - (b[0] === 0) || nombre(a[0]).localeCompare(nombre(b[0]), 'es'));
}

function mensajePedido(nombreProv, filas){
  const lineas = filas.filter(s => s.incluir && s.qty > 0).map(s => `• ${s.qty} x ${s.producto.nombre}${s.producto.unidad ? ' (' + s.producto.unidad + ')' : ''}`);
  return `Hola${nombreProv ? ' ' + nombreProv : ''}, quiero hacer el siguiente pedido:\n\n${lineas.join('\n')}\n\nGracias, DIARNEC.`;
}

function render(){
  const cont = document.getElementById('rp-grupos');
  const resumen = document.getElementById('rp-resumen');
  if(!sugeridos.length){
    resumen.innerHTML = '';
    cont.innerHTML = `<div class="admin-section"><div class="empty-row">✅ Por ahora no hace falta pedir nada: ningún producto está en su mínimo ni se agota esta semana.</div></div>`;
    return;
  }
  const urgentes = sugeridos.filter(s => s.stock <= 0).length;
  resumen.innerHTML = `<div class="rp-card"><small>Productos para reponer</small><b>${sugeridos.length}</b></div>` +
    `<div class="rp-card ${urgentes ? 'rojo' : ''}"><small>Sin stock ahora</small><b>${urgentes}</b></div>`;

  cont.innerHTML = grupos().map(([provId, filas]) => {
    const prov = proveedores.find(p => p.id === provId);
    const nombre = prov ? prov.nombre : 'Sin proveedor asignado';
    const tel = prov ? normalizarTelefono(prov.telefono) : '';
    return `
    <div class="admin-section rp-grupo" data-prov="${provId}">
      <div class="rp-head">
        <h3>${esc(nombre)} <span class="rp-cant">${filas.length} producto${filas.length === 1 ? '' : 's'}</span></h3>
        <div class="rp-btns">
          <button class="btn-sm" data-a="copiar" data-prov="${provId}">📋 Copiar pedido</button>
          ${prov ? (tel.length >= 12
            ? `<button class="btn-sm btn-wa" data-a="wa" data-prov="${provId}">💬 Enviar por WhatsApp</button>`
            : `<a class="btn-sm btn-grey" href="proveedores.html" title="Cargá el WhatsApp del proveedor en Pago a proveedores">Falta su WhatsApp</a>`) : ''}
        </div>
      </div>
      ${prov ? '' : '<p class="rp-aviso">Estas marcas no tienen proveedor asignado (se asigna en Inventario → Administrar marcas). Igual podés copiar el pedido.</p>'}
      <table class="rp-tabla">
        <thead><tr><th></th><th>Producto</th><th class="num">Stock</th><th class="num">Mín.</th><th class="num">Vendido</th><th>Estado</th><th class="num">Pedir</th></tr></thead>
        <tbody>
          ${filas.map(s => `
          <tr class="${s.incluir ? '' : 'off'}">
            <td><input type="checkbox" data-i="${sugeridos.indexOf(s)}" data-c="inc" ${s.incluir ? 'checked' : ''}></td>
            <td><b>${esc(s.producto.nombre)}</b><div class="rp-sub">${esc(s.marca)}${s.producto.unidad ? ' · ' + esc(s.producto.unidad) : ''}</div></td>
            <td class="num ${s.stock <= 0 ? 'rojo' : ''}">${num(s.stock)}</td>
            <td class="num">${s.minimo ? num(s.minimo) : '—'}</td>
            <td class="num">${s.vend ? num(s.vend) : '—'}</td>
            <td>${estado(s)}</td>
            <td class="num"><input type="number" min="0" step="1" class="rp-qty" data-i="${sugeridos.indexOf(s)}" data-c="qty" value="${s.qty}"></td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  }).join('');
}

function estado(s){
  if(s.stock <= 0) return '<span class="rp-tag rojo">Sin stock</span>';
  if(s.bajoMinimo) return '<span class="rp-tag naranja">En el mínimo</span>';
  if(s.seAgota) return `<span class="rp-tag amarillo">Se agota en ${s.dias < 1 ? 'menos de 1 día' : Math.round(s.dias) + ' día' + (Math.round(s.dias) === 1 ? '' : 's')}</span>`;
  return '';
}

function onInput(e){
  const t = e.target;
  const s = sugeridos[Number(t.dataset.i)];
  if(!s) return;
  if(t.dataset.c === 'qty'){ s.qty = Math.max(0, Math.floor(Number(t.value) || 0)); }
  else if(t.dataset.c === 'inc'){ s.incluir = t.checked; t.closest('tr').classList.toggle('off', !t.checked); }
}

async function onClick(e){
  const btn = e.target.closest('button[data-a]');
  if(!btn) return;
  const provId = Number(btn.dataset.prov);
  const filas = sugeridos.filter(s => (s.proveedorId || 0) === provId);
  const prov = proveedores.find(p => p.id === provId);
  if(!filas.some(s => s.incluir && s.qty > 0)){ alert('No hay ningún producto tildado con cantidad para pedir.'); return; }
  const texto = mensajePedido(prov ? prov.nombre : '', filas);

  if(btn.dataset.a === 'wa'){
    window.open(`https://wa.me/${normalizarTelefono(prov.telefono)}?text=${encodeURIComponent(texto)}`, '_blank', 'noopener');
    return;
  }
  try {
    await navigator.clipboard.writeText(texto);
    const antes = btn.textContent; btn.textContent = '✅ Copiado'; setTimeout(() => { btn.textContent = antes; }, 1800);
  } catch(err){
    window.prompt('Copiá el pedido (Ctrl+C):', texto);
  }
}
