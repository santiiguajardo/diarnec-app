import { sb } from '../shared/supabase-client.js';
import { requireAuth, getPerfil } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';
import { esPorPeso } from '../shared/cantidad.js';

// Conteo de inventario: se cuenta lo que hay en el depósito, se carga al lado de lo que dice el sistema y se ven las
// diferencias. Recién al tocar "Ajustar el stock a lo contado" se modifica el stock (todo junto o nada).
//  · Lo que se va contando se guarda en este navegador, así se puede seguir otro día o después de recargar.
//  · Un producto sin contar (casillero vacío) no se toca.
//  · Si mientras se contaba hubo ventas, al ajustar se avisa y se muestran las diferencias ya actualizadas.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
const num = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 3 });
const KEY = 'diarnec_conteo';
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

let productos = [];          // activos, con su stock actual
let visto = new Map();       // id -> stock que se le mostró al usuario (para detectar cambios mientras contaba)
let contado = new Map();     // id -> texto escrito en el casillero
let desde = null;            // fecha en que se empezó a contar
let esAdmin = false;
let filtro = { marca: '', cat: '', texto: '', soloFaltan: false };
let aplicando = false;

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('conteo', 'Conteo de inventario');
  const perfil = await getPerfil();
  esAdmin = !!perfil && perfil.rol === 'admin';

  content.innerHTML = `
    <div class="cn-error" id="cn-error" hidden><span></span><button class="btn-sm" id="cn-reintentar" type="button">↻ Reintentar</button></div>
    <div class="admin-section">
      <h3 style="margin:0 0 4px;">📋 Conteo de inventario</h3>
      <p class="cn-sub">Contá lo que hay en el depósito y cargalo en <b>Contado</b>. Ves la diferencia contra el sistema al instante, y <b>recién al tocar “Ajustar”</b> se modifica el stock.
        Lo que dejes <b>vacío</b> no se toca. Podés ir contando por marca, y lo cargado queda guardado en este navegador.</p>
      <div class="cn-aviso" id="cn-retomado" hidden></div>
      <div class="cn-filtros">
        <label>Marca <select id="cn-marca"><option value="">Todas</option></select></label>
        <label>Categoría <select id="cn-cat"><option value="">Todas</option></select></label>
        <label class="cn-buscar">Buscar <input type="search" id="cn-texto" placeholder="Artículo…" autocomplete="off"></label>
        <label class="cn-chk"><input type="checkbox" id="cn-faltan"> Solo los que faltan contar</label>
        <button type="button" class="btn-sm" id="cn-refrescar" title="Vuelve a leer el stock del sistema (conserva lo que contaste)">↻ Actualizar stock del sistema</button>
      </div>
      <div class="cn-progreso" id="cn-progreso"></div>
      <div class="cn-tabla-wrap"><table class="cn-tabla">
        <thead><tr><th>Marca</th><th>Artículo</th><th class="num">Sistema</th><th class="num">Contado</th><th class="num">Diferencia</th></tr></thead>
        <tbody id="cn-body"><tr><td colspan="5" class="empty-row">Cargando…</td></tr></tbody>
      </table></div>
    </div>
    <div class="cn-pie" id="cn-pie">
      <div class="cn-resumen" id="cn-resumen"></div>
      <input type="text" id="cn-nota" maxlength="120" placeholder="Nota (opcional, ej: conteo de octubre)">
      <button type="button" class="btn-sm btn-add cn-aplicar" id="cn-aplicar">Ajustar el stock a lo contado</button>
      <button type="button" class="btn-sm" id="cn-limpiar">Empezar de cero</button>
    </div>
    <div id="cn-resultado"></div>
  `;

  $('cn-marca').addEventListener('change', e => { filtro.marca = e.target.value; pintarFilas(); });
  $('cn-cat').addEventListener('change', e => { filtro.cat = e.target.value; pintarFilas(); });
  $('cn-texto').addEventListener('input', e => { filtro.texto = norm(e.target.value.trim()); pintarFilas(); });
  $('cn-faltan').addEventListener('change', e => { filtro.soloFaltan = e.target.checked; pintarFilas(); });
  $('cn-refrescar').addEventListener('click', async () => { await cargar(); avisoRetomado('Stock del sistema actualizado.'); });
  $('cn-reintentar').addEventListener('click', () => cargar());
  $('cn-aplicar').addEventListener('click', aplicar);
  $('cn-limpiar').addEventListener('click', empezarDeCero);
  $('cn-body').addEventListener('input', onInput);
  $('cn-body').addEventListener('keydown', onTecla);

  leerBorrador();
  await cargar();
  if(contado.size) avisoRetomado(`Retomaste un conteo guardado${desde ? ' del ' + desde : ''}: ${contado.size} producto${contado.size === 1 ? '' : 's'} ya contado${contado.size === 1 ? '' : 's'}.`);
})();

// ---------- borrador local ----------
function leerBorrador(){
  try {
    const d = JSON.parse(localStorage.getItem(KEY) || 'null');
    if(d && d.items && typeof d.items === 'object'){
      desde = d.desde || null;
      Object.entries(d.items).forEach(([id, v]) => { if(v !== '' && v !== null) contado.set(Number(id), String(v)); });
    }
  } catch(e){ /* sin borrador */ }
}
function guardarBorrador(){
  try {
    if(!contado.size){ localStorage.removeItem(KEY); return; }
    if(!desde) desde = new Date().toLocaleDateString('es-AR', { day: '2-digit', month: '2-digit' });
    localStorage.setItem(KEY, JSON.stringify({ desde, items: Object.fromEntries(contado) }));
  } catch(e){ /* sin storage: se sigue igual */ }
}
function avisoRetomado(t){
  const el = $('cn-retomado');
  el.textContent = t; el.hidden = !t;
}

// ---------- carga ----------
async function cargar(){
  const { data, error } = await sb.from('productos')
    .select('id, nombre, unidad, stock_actual, precio_compra, marca_id, categoria_id, marcas(nombre), categorias(nombre, por_peso)')
    .eq('activo', true).order('nombre');
  if(error){
    // Si falla no se muestra una lista vacía: se avisa y se conserva lo que ya estaba.
    $('cn-error').hidden = false;
    $('cn-error').querySelector('span').textContent = 'No se pudo cargar el inventario (no se tocó nada): ' + error.message;
    return;
  }
  $('cn-error').hidden = true;
  productos = data || [];
  visto = new Map(productos.map(p => [p.id, Number(p.stock_actual)]));
  // los productos que ya no existen o se dieron de baja se sacan del conteo guardado
  [...contado.keys()].forEach(id => { if(!visto.has(id)) contado.delete(id); });
  llenarFiltros();
  pintarFilas();
}

function llenarFiltros(){
  const marcas = [...new Map(productos.filter(p => p.marcas).map(p => [p.marca_id, p.marcas.nombre])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  const cats = [...new Map(productos.filter(p => p.categorias).map(p => [p.categoria_id, p.categorias.nombre])).entries()].sort((a, b) => a[1].localeCompare(b[1], 'es'));
  $('cn-marca').innerHTML = '<option value="">Todas</option>' + marcas.map(([id, n]) => `<option value="${id}" ${String(id) === filtro.marca ? 'selected' : ''}>${esc(n)}</option>`).join('');
  $('cn-cat').innerHTML = '<option value="">Todas</option>' + cats.map(([id, n]) => `<option value="${id}" ${String(id) === filtro.cat ? 'selected' : ''}>${esc(n)}</option>`).join('');
}

// ---------- cálculo ----------
const valorDe = id => { const t = contado.get(id); if(t === undefined || t === '') return null; const n = parseFloat(String(t).replace(',', '.')); return Number.isFinite(n) ? n : NaN; };
const valido = (p, n) => Number.isFinite(n) && n >= 0 && (esPorPeso(p) || Number.isInteger(n));

function lista(){
  return productos.filter(p => {
    if(filtro.marca && String(p.marca_id) !== filtro.marca) return false;
    if(filtro.cat && String(p.categoria_id) !== filtro.cat) return false;
    if(filtro.texto && !norm(`${p.nombre} ${p.unidad} ${p.marcas ? p.marcas.nombre : ''}`).includes(filtro.texto)) return false;
    if(filtro.soloFaltan && valorDe(p.id) !== null) return false;
    return true;
  }).sort((a, b) => ((a.marcas ? a.marcas.nombre : '').localeCompare(b.marcas ? b.marcas.nombre : '', 'es')) || a.nombre.localeCompare(b.nombre, 'es'));
}

function difTexto(p){
  const v = valorDe(p.id);
  if(v === null) return { txt: '', cls: '' };
  if(!valido(p, v)) return { txt: esPorPeso(p) ? 'Número inválido' : 'Tiene que ser entero', cls: 'mal' };
  const d = Math.round((v - Number(p.stock_actual)) * 1000) / 1000;
  if(d === 0) return { txt: '✓ coincide', cls: 'ok' };
  return { txt: (d > 0 ? '+' : '') + num(d), cls: d > 0 ? 'sobra' : 'falta' };
}

function pintarFilas(){
  const l = lista();
  $('cn-body').innerHTML = l.length ? l.map(p => {
    const v = contado.get(p.id) ?? '';
    const df = difTexto(p);
    return `<tr data-id="${p.id}">
      <td class="cn-marca">${esc(p.marcas ? p.marcas.nombre : '')}</td>
      <td><b>${esc(p.nombre)}</b>${p.unidad ? ` <span class="cn-un">${esc(p.unidad)}</span>` : ''}</td>
      <td class="num">${num(p.stock_actual)}</td>
      <td class="num"><input type="number" inputmode="decimal" class="cn-in" data-id="${p.id}" min="0" step="${esPorPeso(p) ? '0.001' : '1'}" value="${esc(v)}" placeholder="—"></td>
      <td class="num cn-dif ${df.cls}">${df.txt}</td></tr>`;
  }).join('') : '<tr><td colspan="5" class="empty-row">No hay productos con ese filtro.</td></tr>';
  pintarResumen();
}

function pintarResumen(){
  const contados = productos.filter(p => valorDe(p.id) !== null).length;
  const enFiltro = lista();
  const contadosFiltro = enFiltro.filter(p => valorDe(p.id) !== null).length;
  $('cn-progreso').innerHTML = `Contados: <b>${contados}</b> de ${productos.length} productos` +
    (enFiltro.length !== productos.length ? ` · en este filtro: <b>${contadosFiltro}</b> de ${enFiltro.length}` : '');

  let faltan = 0, sobran = 0, conDif = 0, invalidos = 0, valorFalta = 0, valorSobra = 0;
  for(const p of productos){
    const v = valorDe(p.id);
    if(v === null) continue;
    if(!valido(p, v)){ invalidos++; continue; }
    const d = v - Number(p.stock_actual);
    if(Math.abs(d) < 0.0005) continue;
    conDif++;
    if(d < 0){ faltan += -d; valorFalta += -d * Number(p.precio_compra || 0); } else { sobran += d; valorSobra += d * Number(p.precio_compra || 0); }
  }
  $('cn-resumen').innerHTML = !contados ? 'Todavía no cargaste ningún conteo.' :
    `<b>${conDif}</b> producto${conDif === 1 ? '' : 's'} con diferencia · faltan <b class="falta">${num(faltan)}</b> · sobran <b class="sobra">${num(sobran)}</b> unidades` +
    (esAdmin && conDif ? ` · a costo: faltan ${money(valorFalta)}, sobran ${money(valorSobra)}` : '') +
    (invalidos ? ` · <span class="falta">${invalidos} con número inválido</span>` : '');
  $('cn-aplicar').disabled = aplicando || !contados;
  $('cn-limpiar').disabled = aplicando || !contados;
}

// ---------- edición ----------
function onInput(e){
  const inp = e.target.closest('.cn-in');
  if(!inp) return;
  const id = Number(inp.dataset.id);
  if(inp.value === '') contado.delete(id); else contado.set(id, inp.value);
  guardarBorrador();
  const p = productos.find(x => x.id === id);
  const df = difTexto(p);
  const celda = inp.closest('tr').querySelector('.cn-dif');
  celda.textContent = df.txt; celda.className = 'num cn-dif ' + df.cls;
  pintarResumen();
}

// Enter pasa al casillero de abajo: se puede contar rápido con el teclado
function onTecla(e){
  if(e.key !== 'Enter' || !e.target.classList.contains('cn-in')) return;
  e.preventDefault();
  const ins = [...document.querySelectorAll('#cn-body .cn-in')];
  const i = ins.indexOf(e.target);
  if(ins[i + 1]){ ins[i + 1].focus(); ins[i + 1].select(); }
}

async function empezarDeCero(){
  if(!contado.size) return;
  if(!(await confirmDialog(`¿Borrar lo que cargaste en este conteo (${contado.size} producto${contado.size === 1 ? '' : 's'})?\n\nEl stock del sistema no se toca.`, { confirmLabel: 'Borrar el conteo' }))) return;
  contado = new Map(); desde = null; guardarBorrador(); avisoRetomado(''); pintarFilas();
}

// ---------- ajustar ----------
async function aplicar(){
  if(aplicando) return;
  const cargados = productos.filter(p => valorDe(p.id) !== null);
  const malos = cargados.filter(p => !valido(p, valorDe(p.id)));
  if(malos.length){
    avisoRetomado(`Revisá estos números antes de ajustar: ${malos.slice(0, 5).map(p => p.nombre).join(', ')}${malos.length > 5 ? '…' : ''}.`);
    return;
  }
  if(!cargados.length) return;

  aplicando = true; pintarResumen();
  try {
    // 1) ¿cambió el stock del sistema mientras se contaba (ventas, ingresos...)?
    const { data: frescos, error: eF } = await sb.from('productos').select('id, stock_actual').in('id', cargados.map(p => p.id));
    if(eF){ avisoRetomado('No se pudo verificar el stock actual (no se ajustó nada): ' + eF.message); return; }
    const cambiados = (frescos || []).filter(f => Number(f.stock_actual) !== visto.get(f.id));
    if(cambiados.length){
      (frescos || []).forEach(f => { const p = productos.find(x => x.id === f.id); if(p) p.stock_actual = f.stock_actual; visto.set(f.id, Number(f.stock_actual)); });
      pintarFilas();
      avisoRetomado(`⚠️ El stock del sistema cambió en ${cambiados.length} producto${cambiados.length === 1 ? '' : 's'} mientras contabas (por ventas u otros movimientos). Ya se actualizaron las diferencias: revisalas y tocá “Ajustar” de nuevo.`);
      return;
    }

    // 2) resumen y confirmación
    const dif = cargados.map(p => ({ p, v: valorDe(p.id), d: valorDe(p.id) - Number(p.stock_actual) })).filter(x => Math.abs(x.d) > 0.0005);
    if(!dif.length){
      avisoRetomado('✅ Todo lo que contaste coincide con el sistema: no hay nada que ajustar.');
      return;
    }
    const faltan = dif.filter(x => x.d < 0).reduce((s, x) => s - x.d, 0);
    const sobran = dif.filter(x => x.d > 0).reduce((s, x) => s + x.d, 0);
    const ok = await confirmDialog(
      `Vas a ajustar el stock de ${dif.length} producto${dif.length === 1 ? '' : 's'}: faltan ${num(faltan)} y sobran ${num(sobran)} unidades.\n\n` +
      `Los productos que no contaste no se tocan. Queda registrado en el Historial como "Conteo de inventario".`, { confirmLabel: 'Ajustar el stock' });
    if(!ok) return;

    // 3) se aplica todo junto
    const { data, error } = await sb.rpc('aplicar_conteo_inventario', {
      p_items: cargados.map(p => ({ producto_id: p.id, contado: valorDe(p.id) })),
      p_nota: $('cn-nota').value.trim() || null
    });
    if(error){ avisoRetomado('No se pudo ajustar (no se cambió nada): ' + error.message); return; }

    const ajustados = (data || []).filter(r => Number(r.diferencia) !== 0);
    mostrarResultado(ajustados, cargados.length);
    contado = new Map(); desde = null; guardarBorrador(); avisoRetomado('');
    await cargar();
  } finally {
    aplicando = false; pintarResumen();
  }
}

function mostrarResultado(ajustados, total){
  const f = ajustados.filter(r => Number(r.diferencia) < 0), s = ajustados.filter(r => Number(r.diferencia) > 0);
  const filas = ajustados.map(r => `<tr><td>${esc(r.nombre)}</td><td class="num">${num(r.antes)}</td><td class="num">${num(r.contado)}</td><td class="num ${Number(r.diferencia) < 0 ? 'falta' : 'sobra'}">${Number(r.diferencia) > 0 ? '+' : ''}${num(r.diferencia)}</td></tr>`).join('');
  $('cn-resultado').innerHTML = `<div class="admin-section cn-listo">
    <h3>✅ Stock ajustado</h3>
    <p class="cn-sub">Se contaron ${total} producto${total === 1 ? '' : 's'}; ${ajustados.length} tenía${ajustados.length === 1 ? '' : 'n'} diferencia (${f.length} con faltante, ${s.length} con sobrante). Quedó registrado en el Historial.</p>
    ${ajustados.length ? `<table class="cn-tabla"><thead><tr><th>Producto</th><th class="num">Antes</th><th class="num">Contado</th><th class="num">Ajuste</th></tr></thead><tbody>${filas}</tbody></table>` : ''}
    <button type="button" class="btn-sm btn-add" id="cn-copiar" style="margin-top:12px;">📋 Copiar resumen</button>
  </div>`;
  $('cn-copiar').addEventListener('click', async e => {
    const L = ['*DIARNEC — Conteo de inventario*', `${total} productos contados · ${ajustados.length} con diferencia`, ''];
    ajustados.forEach(r => L.push(`• ${r.nombre}: sistema ${num(r.antes)} → contado ${num(r.contado)} (${Number(r.diferencia) > 0 ? '+' : ''}${num(r.diferencia)})`));
    try { await navigator.clipboard.writeText(L.join('\n')); e.target.textContent = '✅ Copiado'; } catch(err){ window.prompt('Copiá el resumen (Ctrl+C):', L.join('\n')); }
  });
  $('cn-resultado').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
