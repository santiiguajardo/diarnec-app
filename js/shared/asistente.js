// Asistente del panel: se le escribe en castellano y responde con los datos reales del negocio.
// Entiende períodos (hoy, ayer, esta semana, la semana pasada, este mes, "semana del 14/09", últimos 7 días...),
// productos, vendedores y clientes por nombre, y comparaciones entre períodos. Corre en el navegador con la
// sesión del usuario (solo staff), así que solo ve lo que ese usuario puede ver.
//
// Los indicadores y rankings salen de dash_periodo (la misma función del Dashboard).

import { sb } from './supabase-client.js';
import { money } from './format.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[¿?¡!.,;:()"]/g, ' ').replace(/\s+/g, ' ').trim();
const num = x => Number(x) || 0;
const pad = n => String(n).padStart(2, '0');
const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmt = isoStr => { const [, m, d] = isoStr.split('-'); return `${d}/${m}`; };
const inicioIso = i => `${i}T00:00:00-03:00`;
const finIso = i => { const d = new Date(`${i}T00:00:00-03:00`); d.setDate(d.getDate() + 1); return d.toISOString(); };
const suma = (arr, f) => arr.reduce((s, x) => s + num(f(x)), 0);

// ===== Períodos =====

function lunesDe(d){ const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; }
const sumarDias = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const periodo = (desde, hasta, nombre) => ({ desde: iso(desde), hasta: iso(hasta), nombre });
const semanaDe = (lunes, nombre) => periodo(lunes, sumarDias(lunes, 6), `${nombre} (${fmt(iso(lunes))} al ${fmt(iso(sumarDias(lunes, 6)))})`);

const PATRONES = [
  { re: /anteayer|antes de ayer/, fn: h => periodo(sumarDias(h, -2), sumarDias(h, -2), 'anteayer') },
  { re: /\bayer\b/, fn: h => periodo(sumarDias(h, -1), sumarDias(h, -1), 'ayer') },
  { re: /\bhoy\b/, fn: h => periodo(h, h, 'hoy') },
  { re: /semana pasada|semana anterior|ultima semana|semana que paso/, fn: h => semanaDe(sumarDias(lunesDe(h), -7), 'la semana pasada') },
  { re: /esta semana|semana actual|semana en curso/, fn: h => semanaDe(lunesDe(h), 'esta semana') },
  { re: /hace (\d+) semanas?/, fn: (h, m) => semanaDe(sumarDias(lunesDe(h), -7 * Number(m[1])), `hace ${m[1]} semanas`) },
  { re: /mes pasado|mes anterior/, fn: h => periodo(new Date(h.getFullYear(), h.getMonth() - 1, 1), new Date(h.getFullYear(), h.getMonth(), 0), 'el mes pasado') },
  { re: /este mes|mes actual|del mes/, fn: h => periodo(new Date(h.getFullYear(), h.getMonth(), 1), h, 'este mes') },
  { re: /ultimos? (\d+) dias/, fn: (h, m) => periodo(sumarDias(h, -(Number(m[1]) - 1)), h, `los últimos ${m[1]} días`) },
  { re: /semana del (\d{1,2})[\/\-](\d{1,2})/, fn: (h, m) => semanaDe(lunesDe(new Date(h.getFullYear(), Number(m[2]) - 1, Number(m[1]))), `la semana del ${m[1]}/${m[2]}`) },
  { re: /(?:del|el|dia) (\d{1,2})[\/\-](\d{1,2})/, fn: (h, m) => { const d = new Date(h.getFullYear(), Number(m[2]) - 1, Number(m[1])); return periodo(d, d, `el ${m[1]}/${m[2]}`); } }
];

// Todos los períodos nombrados en el texto, en el orden en que aparecen
function extraerPeriodos(t){
  const hoy = new Date();
  const halladas = [];
  const usados = [];
  for(const p of PATRONES){
    for(const m of t.matchAll(new RegExp(p.re.source, 'g'))){
      // si un patrón más específico ya tomó esa parte del texto ("la semana del 14/09"), no lo contamos dos veces
      if(usados.some(([a, b]) => m.index < b && m.index + m[0].length > a)) continue;
      usados.push([m.index, m.index + m[0].length]);
      halladas.push({ index: m.index, p: p.fn(hoy, m) });
    }
  }
  return halladas.sort((a, b) => a.index - b.index).map(x => Object.assign(x.p, { _i: x.index }));
}

// El período anterior de la misma duración (para comparar cuando solo se nombra uno)
function periodoAnterior(p){
  const d = new Date(`${p.desde}T12:00:00`), h = new Date(`${p.hasta}T12:00:00`);
  const dias = Math.round((h - d) / 86400000) + 1;
  const nd = sumarDias(d, -dias), nh = sumarDias(d, -1);
  return periodo(nd, nh, dias === 7 ? `la semana anterior (${fmt(iso(nd))} al ${fmt(iso(nh))})` : `los ${dias} días anteriores`);
}

// ===== Datos =====

let catCache = null, catT = 0;
async function catalogo(){
  if(catCache && Date.now() - catT < 120000) return catCache;
  const [pr, vd, cl] = await Promise.all([
    sb.from('productos').select('id, nombre, unidad, precio_venta, precio_compra, stock_actual, stock_minimo, activo, marcas(nombre)'),
    sb.from('vendedores').select('id, nombre, activo, es_canal_online'),
    sb.from('clientes').select('id, nombre, activo')
  ]);
  catCache = { productos: pr.data || [], vendedores: vd.data || [], clientes: cl.data || [] };
  catT = Date.now();
  return catCache;
}

const memo = new Map();
async function datos(p){
  const k = `${p.desde}|${p.hasta}`;
  const hit = memo.get(k);
  if(hit && Date.now() - hit.t < 45000) return hit.d;
  const { data, error } = await sb.rpc('dash_periodo', { p_desde: p.desde, p_hasta: p.hasta });
  if(error) throw error;
  memo.set(k, { t: Date.now(), d: data });
  return data;
}

function calc(d){
  const k = d.kpis;
  const ventas = num(k.ventas_neto), cant = num(k.cantidad_ventas);
  const creditos = num(k.devoluciones) + num(k.bonificaciones);
  const egresos = num(k.gastos) + num(k.pagos_proveedores);
  return { ventas, cant, ticket: cant ? ventas / cant : 0, creditos, facturacion: ventas - creditos, cobros: num(k.cobros),
    egresos, gastos: num(k.gastos), prov: num(k.pagos_proveedores), flujo: num(k.cobros) - egresos, unidades: num(k.unidades),
    comisiones: num(k.comisiones), costo: num(k.costo_estimado), margen: num(k.costo_estimado) > 0 ? ventas - num(k.costo_estimado) : null,
    devs: num(k.cantidad_devoluciones) };
}

// ===== Búsqueda de nombres =====

const PALABRAS_VACIAS = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'por', 'con', 'sin', 'para', 'que', 'una', 'uno', 'kg', 'gr', 'grs', 'x', 'y', 'en', 'al', 'un', 'mis', 'mi', 'tu', 'hay', 'cuanto', 'cuantos', 'cuanta', 'como', 'esta', 'este', 'esa', 'ese']);
const tokens = s => norm(s).split(' ').filter(w => w.length >= 3 && !PALABRAS_VACIAS.has(w));
const coincide = (a, b) => a === b || (Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a)));

function buscar(t, lista, textoDe){
  const q = tokens(t);
  if(q.length === 0) return [];
  return lista.map(x => {
    const et = tokens(textoDe(x));
    const acierto = et.filter(e => q.some(w => coincide(w, e))).length;
    return { x, score: et.length ? acierto : 0, cobertura: et.length ? acierto / et.length : 0 };
  }).filter(r => r.score > 0).sort((a, b) => b.score - a.score || b.cobertura - a.cobertura).map(r => r.x);
}

// ===== Respuestas =====

const li = arr => `<ol class="as-lista">${arr.map(x => `<li>${x}</li>`).join('')}</ol>`;
const N = (t, def) => { const m = /(?:top|los|las|primeros?)\s*(\d+)/.exec(t); return m ? Math.min(Number(m[1]), 30) : def; };
const CHIPS_BASE = ['Ventas de esta semana', 'Comparar con la semana pasada', 'Productos más vendidos', 'Mejores vendedores', 'Productos más devueltos', 'Stock bajo', '¿Quién me debe?'];

function resumen(d, p){
  const c = calc(d);
  if(c.cant === 0 && c.cobros === 0 && c.egresos === 0) return `<b>${esc(p.nombre)}:</b> no hay movimientos.`;
  return `<b>Resumen — ${esc(p.nombre)}</b>
    <ul class="as-ul">
      <li>Ventas netas: <b>${money(c.ventas)}</b> (${c.cant} venta${c.cant === 1 ? '' : 's'}, ticket promedio ${money(c.ticket)})</li>
      <li>Devoluciones y bonificaciones: <b>${money(c.creditos)}</b> → facturación neta <b>${money(c.facturacion)}</b></li>
      <li>Cobros: <b>${money(c.cobros)}</b> · Egresos: <b>${money(c.egresos)}</b> (gastos ${money(c.gastos)}, proveedores ${money(c.prov)})</li>
      <li>Flujo de caja: <b>${money(c.flujo)}</b>${c.margen !== null ? ` · Margen estimado: <b>${money(c.margen)}</b>` : ''}</li>
      <li>Unidades vendidas: <b>${c.unidades}</b> · Comisiones a vendedores: ${money(c.comisiones)}</li>
    </ul>`;
}

function delta(a, b, invert){
  if(Math.abs(a - b) < 0.005) return '<span class="as-igual">=</span>';
  const pct = Math.abs(b) > 0.005 ? ` ${Math.round(Math.abs(a - b) / Math.abs(b) * 100)}%` : '';
  const sube = a > b;
  return `<span class="${(invert ? !sube : sube) ? 'as-bueno' : 'as-malo'}">${sube ? '▲' : '▼'}${pct}</span>`;
}

async function comparar(pA, pB){
  const [dA, dB] = await Promise.all([datos(pA), datos(pB)]);
  const a = calc(dA), b = calc(dB);
  const fila = (t, k, inv, plano) => `<tr><td>${t}</td><td>${plano ? a[k] : money(a[k])}</td><td>${plano ? b[k] : money(b[k])}</td><td>${delta(a[k], b[k], inv)}</td></tr>`;
  let extra = '';
  const top = (nombre, lista, campo) => lista.length ? `<li>${nombre}: <b>${esc(lista[0].nombre)}</b> (${money(lista[0][campo])})</li>` : '';
  extra = `<ul class="as-ul">${top('Producto ganador de ' + esc(pA.nombre), dA.productos, 'monto')}${top('Producto ganador de ' + esc(pB.nombre), dB.productos, 'monto')}${top('Mejor vendedor de ' + esc(pA.nombre), dA.vendedores, 'neto')}${top('Mejor vendedor de ' + esc(pB.nombre), dB.vendedores, 'neto')}</ul>`;
  return `<b>${esc(pA.nombre)}</b> vs <b>${esc(pB.nombre)}</b>
    <table class="as-t"><thead><tr><th></th><th>${esc(pA.nombre.split(' (')[0])}</th><th>${esc(pB.nombre.split(' (')[0])}</th><th>Dif.</th></tr></thead><tbody>
      ${fila('Ventas netas', 'ventas')}${fila('Cantidad de ventas', 'cant', false, true)}${fila('Facturación neta', 'facturacion')}
      ${fila('Devol. y bonif.', 'creditos', true)}${fila('Cobros', 'cobros')}${fila('Egresos', 'egresos', true)}${fila('Flujo de caja', 'flujo')}${fila('Unidades', 'unidades', false, true)}
    </tbody></table>${extra}`;
}

function ranking(titulo, filas, vacio){
  return filas.length ? `<b>${titulo}</b>${li(filas)}` : `${titulo}: ${vacio}`;
}

// ---- motor de preguntas ----

export async function responder(texto){
  const t = norm(texto);
  const cat = await catalogo();
  const periodos = extraerPeriodos(t);
  const hoy = new Date();
  const pDef = periodos[0] || semanaDe(lunesDe(hoy), 'esta semana');
  const limite = N(t, 5);

  const productos = buscar(t, cat.productos.filter(p => p.activo), p => `${p.nombre} ${p.marcas ? p.marcas.nombre : ''}`);
  const vendedores = buscar(t, cat.vendedores, v => v.nombre);
  const pideProducto = productos.length > 0 && productos.length <= 6 && !/(producto|ranking|top|mejores)s?\b/.test(t.replace(/producto x kg/, ''));

  // saludo / ayuda
  if(/^(hola|buenas|buen dia|buenos dias|buenas tardes|buenas noches|que tal|hey)\b/.test(t) && t.split(' ').length <= 4){
    return { html: 'Hola 👋 Soy el asistente de DIARNEC. Preguntame por ventas, productos, vendedores, devoluciones, stock o saldos, de hoy, de esta semana, de otra semana o de un mes.', chips: CHIPS_BASE };
  }
  if(/ayuda|que (podes|sabes|haces)|como (te )?uso|comandos/.test(t)){
    return { html: `Puedo responder cosas como:
      <ul class="as-ul"><li>"¿Cuánto vendimos <b>esta semana</b>?" · "ventas de <b>ayer</b>" · "resumen del <b>mes pasado</b>"</li>
      <li>"<b>Comparar</b> esta semana con la semana pasada"</li>
      <li>"Productos más vendidos" · "mejores vendedores" · "productos más devueltos" · "mejores clientes" · "marcas"</li>
      <li>"¿Cuánto vendimos de <b>palitos</b> esta semana?" · "stock de <b>ravioles</b>" · "precio del <b>queso</b>"</li>
      <li>"¿Cuánto vendió <b>Emiliano</b>?" · "¿Quién me debe?" · "saldo de Emiliano"</li>
      <li>"Stock bajo" · "gastos de la semana" · "flujo de caja" · "margen"</li></ul>`, chips: CHIPS_BASE };
  }

  // comparaciones
  if(/compar|versus|\bvs\b|contra |respecto|diferencia|mejor que|peor que/.test(t) && !/precio/.test(t)){
    let pA, pB;
    if(periodos.length >= 2){ pA = periodos[0]; pB = periodos[1]; }
    else if(periodos.length === 1){
      // "comparar CON la semana pasada": lo nombrado es la referencia y se compara la semana actual contra eso
      if(/\b(con|contra|vs|versus|respecto)\b/.test(t.slice(0, periodos[0]._i))){ pA = semanaDe(lunesDe(hoy), 'esta semana'); pB = periodos[0]; }
      else { pA = periodos[0]; pB = periodoAnterior(pA); }
    } else { pA = semanaDe(lunesDe(hoy), 'esta semana'); pB = periodoAnterior(pA); }
    return { html: await comparar(pA, pB), chips: ['Productos más vendidos', 'Mejores vendedores', 'Productos más devueltos'] };
  }

  // stock bajo
  if(/stock bajo|poco stock|sin stock|faltante|faltan|reponer|se (esta )?acaba|negativo/.test(t)){
    const bajos = cat.productos.filter(p => p.activo && (num(p.stock_actual) <= 0 || (num(p.stock_minimo) > 0 && num(p.stock_actual) <= num(p.stock_minimo))))
      .sort((a, b) => num(a.stock_actual) - num(b.stock_actual));
    return { html: bajos.length
      ? `<b>Stock bajo o sin stock (${bajos.length})</b>${li(bajos.slice(0, 12).map(p => `${esc(p.nombre)}: <b>${num(p.stock_actual)}</b>${num(p.stock_minimo) > 0 ? ' (mínimo ' + num(p.stock_minimo) + ')' : ''}`))}${bajos.length > 12 ? `…y ${bajos.length - 12} más.` : ''}`
      : 'Todos los productos tienen stock por encima del mínimo. 👌', chips: ['Productos más vendidos', 'Ventas de esta semana'] };
  }

  // stock de un producto
  if(/stock|quedan|cuantos hay|existencia|tengo de|hay de/.test(t) && productos.length){
    const lista = productos.slice(0, 6);
    return { html: `<b>Stock</b>${li(lista.map(p => `${esc(p.nombre)}${p.unidad ? ' (' + esc(p.unidad) + ')' : ''}: <b>${num(p.stock_actual)}</b>${num(p.stock_actual) < 0 ? ' ⚠ negativo' : ''}${num(p.stock_minimo) > 0 ? ' · mínimo ' + num(p.stock_minimo) : ''}`))}`, chips: ['Stock bajo', `Cuánto vendimos de ${productos[0].nombre}`] };
  }

  // precio de un producto
  if(/precio|cuesta|cuanto sale|vale/.test(t) && productos.length){
    const lista = productos.slice(0, 6);
    return { html: `<b>Precios</b>${li(lista.map(p => `${esc(p.nombre)}: <b>${money(p.precio_venta)}</b>${num(p.precio_compra) > 0 ? ` (costo ${money(p.precio_compra)}, margen ${Math.round((num(p.precio_venta) - num(p.precio_compra)) / num(p.precio_compra) * 100)}%)` : ''}`))}` };
  }

  // saldos / cuentas corrientes
  if(/debe|deuda|saldo|cuenta corriente|me deben|cobrar|pendiente de pago/.test(t)){
    const { data } = await sb.from('vendedores_saldo').select('*');
    const activos = new Map(cat.vendedores.filter(v => v.activo && !v.es_canal_online).map(v => [v.id, v]));
    const filas = (data || []).filter(r => activos.has(r.vendedor_id)).map(r => ({ nombre: r.nombre, debe: num(r.retirado) - num(r.devuelto) - num(r.pagado) - num(r.bonificado), r }));
    const elegido = vendedores.find(v => activos.has(v.id));
    if(elegido){
      const f = filas.find(x => x.nombre === elegido.nombre);
      return { html: f ? `<b>${esc(f.nombre)}</b>: retirado ${money(f.r.retirado)} − devoluciones ${money(f.r.devuelto)} − bonificaciones ${money(f.r.bonificado)} − pagos ${money(f.r.pagado)} = <b>${f.debe > 0.005 ? 'debe ' + money(f.debe) : (f.debe < -0.005 ? 'saldo a favor ' + money(-f.debe) : 'está al día')}</b>` : 'No encontré su cuenta corriente.' };
    }
    const deudores = filas.filter(f => f.debe > 0.005).sort((a, b) => b.debe - a.debe);
    const favor = filas.filter(f => f.debe < -0.005);
    return { html: (deudores.length ? `<b>Te deben ${money(suma(deudores, x => x.debe))}</b>${li(deudores.map(f => `${esc(f.nombre)}: <b>${money(f.debe)}</b>`))}` : 'Nadie te debe nada en este momento. 👌')
      + (favor.length ? `<br>Con saldo a favor: ${favor.map(f => `${esc(f.nombre)} (${money(-f.debe)})`).join(', ')}.` : ''), chips: ['Ventas de esta semana', 'Mejores vendedores'] };
  }

  // devoluciones
  if(/devuel|devolucion/.test(t)){
    const d = await datos(pDef);
    return { html: ranking(`Productos más devueltos — ${esc(pDef.nombre)}`, d.devueltos.slice(0, limite).map(x => `${esc(x.nombre)}: <b>${num(x.unidades)} un.</b> (${money(x.monto)})${num(x.vendidas) > 0 ? ` — ${Math.round(num(x.unidades) / num(x.vendidas) * 100)}% de lo vendido` : ''}`), 'no hubo devoluciones. 👌')
      + `<br><small>Total en devoluciones: ${money(d.kpis.devoluciones)} · bonificaciones: ${money(d.kpis.bonificaciones)}</small>`, chips: ['Comparar con la semana pasada', 'Productos más vendidos'] };
  }

  // gastos / egresos
  if(/gasto|egreso|pagamos|proveedor/.test(t)){
    const c = calc(await datos(pDef));
    return { html: `<b>Egresos — ${esc(pDef.nombre)}:</b> ${money(c.egresos)}<br>Gastos: ${money(c.gastos)} · Pagos a proveedores: ${money(c.prov)}` };
  }

  // cobros / caja / flujo
  if(/cobr|caja|flujo|entro plata|plata que entro/.test(t)){
    const c = calc(await datos(pDef));
    return { html: `<b>${esc(pDef.nombre)}:</b> cobros ${money(c.cobros)} − egresos ${money(c.egresos)} = flujo de caja <b>${money(c.flujo)}</b>` };
  }

  // margen / ganancia
  if(/margen|ganancia|rentab|gano/.test(t)){
    const c = calc(await datos(pDef));
    return { html: c.margen === null
      ? `Para calcular el margen hace falta cargar el costo de los productos en Inventario (lo vendido — ${esc(pDef.nombre)} — figura con costo $0). Las comisiones a vendedores fueron ${money(c.comisiones)}.`
      : `<b>Margen estimado — ${esc(pDef.nombre)}:</b> ${money(c.margen)} (ventas netas ${money(c.ventas)} − costo actual de lo vendido ${money(c.costo)}). Comisiones a vendedores: ${money(c.comisiones)}.` };
  }

  // ventas de un producto puntual
  if(pideProducto && /vend|venta|salio|movio|facturo|unidades/.test(t)){
    const p = productos[0];
    const { data, error } = await sb.from('ventas_items').select('cantidad, subtotal, ventas!inner(created_at, estado)')
      .eq('producto_id', p.id).eq('ventas.estado', 'confirmada')
      .gte('ventas.created_at', inicioIso(pDef.desde)).lt('ventas.created_at', finIso(pDef.hasta));
    if(error) throw error;
    const u = suma(data || [], x => x.cantidad), m = suma(data || [], x => x.subtotal);
    return { html: u > 0 ? `<b>${esc(p.nombre)}</b> — ${esc(pDef.nombre)}: <b>${u} unidades</b> (${money(m)} a precio final).` : `No se vendió <b>${esc(p.nombre)}</b> — ${esc(pDef.nombre)}.`, chips: ['Stock de ' + p.nombre, 'Productos más vendidos'] };
  }

  // rankings
  if(/vendedor/.test(t) && !vendedores.length || (/mejor(es)? vendedor|ranking.*vendedor|vendedores/.test(t))){
    const d = await datos(pDef);
    return { html: ranking(`Mejores vendedores — ${esc(pDef.nombre)}`, d.vendedores.slice(0, limite).map(x => `${esc(x.nombre)}: <b>${money(x.neto)}</b> (${x.ventas} venta${x.ventas === 1 ? '' : 's'}, comisión ${money(x.comision)})`), 'no hubo ventas.'), chips: ['Comparar con la semana pasada', '¿Quién me debe?'] };
  }
  if(/cliente/.test(t)){
    const d = await datos(pDef);
    return { html: ranking(`Mejores clientes — ${esc(pDef.nombre)}`, d.clientes.slice(0, limite).map(x => `${esc(x.nombre)}: <b>${money(x.monto)}</b> (${x.ventas} compra${x.ventas === 1 ? '' : 's'})`), 'ningún cliente de la cartera compró.') };
  }
  if(/marca/.test(t)){
    const d = await datos(pDef);
    return { html: ranking(`Marcas líderes — ${esc(pDef.nombre)}`, d.marcas.slice(0, limite).map(x => `${esc(x.nombre)}: <b>${money(x.monto)}</b> (${num(x.unidades)} un.)`), 'no hubo ventas.') };
  }
  if(/categoria/.test(t)){
    const d = await datos(pDef);
    const total = suma(d.categorias, x => x.monto);
    return { html: ranking(`Ventas por categoría — ${esc(pDef.nombre)}`, d.categorias.map(x => `${esc(x.nombre)}: <b>${money(x.monto)}</b> (${total ? Math.round(num(x.monto) / total * 100) : 0}%)`), 'no hubo ventas.') };
  }
  if(/producto|articulo|mas vendid|ganador|estrella|que se vende|vende mas|mejores/.test(t) && !pideProducto){
    const d = await datos(pDef);
    return { html: ranking(`Productos ganadores — ${esc(pDef.nombre)}`, d.productos.slice(0, limite).map(x => `${esc(x.nombre)}: <b>${money(x.monto)}</b> (${num(x.unidades)} un.)`), 'no hubo ventas.'), chips: ['Productos más devueltos', 'Mejores vendedores', 'Comparar con la semana pasada'] };
  }

  // ventas de un vendedor
  const vend = vendedores.find(v => v.activo || v.es_canal_online);
  if(vend && /vend|venta|factur|movio|hizo|hace/.test(t)){
    const { data, error } = await sb.from('ventas').select('total_neto, total_bruto, total_descuento_comision')
      .eq('vendedor_id', vend.id).eq('estado', 'confirmada').gte('created_at', inicioIso(pDef.desde)).lt('created_at', finIso(pDef.hasta));
    if(error) throw error;
    const n = (data || []).length;
    return { html: n ? `<b>${esc(vend.nombre)}</b> — ${esc(pDef.nombre)}: <b>${money(suma(data, x => x.total_neto))}</b> netos en ${n} venta${n === 1 ? '' : 's'} (${money(suma(data, x => x.total_bruto))} a precio final, comisión ${money(suma(data, x => x.total_descuento_comision))}).` : `<b>${esc(vend.nombre)}</b> no tuvo ventas — ${esc(pDef.nombre)}.`, chips: [`Saldo de ${vend.nombre}`, 'Mejores vendedores'] };
  }

  // resumen general de ventas
  if(/vend|venta|factur|ingres|resumen|como (vamos|viene|anda|estamos)|numeros|balance/.test(t) || periodos.length){
    const d = await datos(pDef);
    return { html: resumen(d, pDef), chips: [`Comparar ${pDef.nombre.split(' (')[0]} con el período anterior`, 'Productos más vendidos', 'Mejores vendedores'] };
  }

  // solo se nombró un producto
  if(productos.length){
    const p = productos[0];
    return { html: `<b>${esc(p.nombre)}</b>${p.unidad ? ' (' + esc(p.unidad) + ')' : ''}: precio ${money(p.precio_venta)}, stock <b>${num(p.stock_actual)}</b>. ¿Querés saber cuánto se vendió?`, chips: [`Cuánto vendimos de ${p.nombre} esta semana`, `Stock de ${p.nombre}`] };
  }

  return { html: 'No estoy seguro de haber entendido 🤔. Probá con algo como <i>"ventas de esta semana"</i>, <i>"comparar con la semana pasada"</i>, <i>"productos más devueltos"</i> o <i>"stock de ravioles"</i>. Escribí <b>ayuda</b> para ver todo lo que sé.', chips: CHIPS_BASE };
}

// ===== Interfaz =====

const CSS = `
#as-fab{position:fixed;right:22px;bottom:22px;z-index:450;background:#122436;color:#fff;border:none;border-radius:100px;padding:13px 18px;font-size:14px;font-weight:600;cursor:pointer;box-shadow:0 8px 24px rgba(0,0,0,.28);display:flex;align-items:center;gap:8px;}
#as-fab:hover{transform:translateY(-1px);}
#as-panel{position:fixed;right:22px;bottom:22px;z-index:451;width:400px;max-width:calc(100vw - 24px);height:560px;max-height:calc(100vh - 44px);background:#fff;border-radius:16px;box-shadow:0 18px 50px rgba(0,0,0,.35);display:none;flex-direction:column;overflow:hidden;font-family:'Inter',sans-serif;}
#as-panel.open{display:flex;}
.as-head{background:#122436;color:#fff;padding:13px 16px;display:flex;justify-content:space-between;align-items:center;font-family:'Space Grotesk',sans-serif;font-weight:700;font-size:15px;}
.as-head small{display:block;font-family:'Inter',sans-serif;font-weight:400;font-size:11px;opacity:.7;}
.as-head button{background:rgba(255,255,255,.15);border:none;color:#fff;border-radius:8px;width:30px;height:30px;cursor:pointer;font-size:14px;margin-left:6px;}
.as-msgs{flex:1;overflow-y:auto;padding:14px;background:#F6F7F9;display:flex;flex-direction:column;gap:10px;}
.as-m{max-width:92%;padding:10px 12px;border-radius:12px;font-size:13px;line-height:1.5;color:#1A1A1A;word-wrap:break-word;}
.as-m.bot{background:#fff;border:1px solid #E4E2DA;align-self:flex-start;border-bottom-left-radius:4px;}
.as-m.yo{background:#173DED;color:#fff;align-self:flex-end;border-bottom-right-radius:4px;}
.as-m .as-ul{margin:6px 0 0 16px;} .as-m .as-lista{margin:6px 0 0 20px;} .as-m li{margin-bottom:3px;}
.as-t{border-collapse:collapse;width:100%;font-size:12px;margin:6px 0;}
.as-t th{text-align:right;color:#6B7280;font-weight:600;border-bottom:1px solid #E4E2DA;padding:4px 3px;} .as-t th:first-child{text-align:left;}
.as-t td{padding:4px 3px;border-bottom:1px solid #F0EFEA;text-align:right;white-space:nowrap;} .as-t td:first-child{text-align:left;white-space:normal;}
.as-bueno{color:#1e8e5a;font-weight:700;} .as-malo{color:#C0392B;font-weight:700;} .as-igual{color:#6B7280;}
.as-chips{display:flex;flex-wrap:wrap;gap:6px;padding:8px 12px 0;background:#F6F7F9;}
.as-chips button{border:1px solid #D5D8DE;background:#fff;border-radius:100px;padding:6px 11px;font-size:12px;cursor:pointer;color:#122436;}
.as-chips button:hover{background:#122436;color:#fff;}
.as-form{display:flex;gap:8px;padding:10px 12px 12px;background:#F6F7F9;}
.as-form input{flex:1;padding:10px 12px;border:1px solid #D5D8DE;border-radius:100px;font-size:13px;outline:none;font-family:inherit;}
.as-form input:focus{border-color:#173DED;}
.as-form button{background:#173DED;color:#fff;border:none;border-radius:100px;padding:0 16px;font-weight:600;cursor:pointer;}
.as-pensando{color:#6B7280;font-style:italic;}
`;

const KEY = 'diarnec_asistente_v1';

export function montarAsistente(){
  if(document.getElementById('as-fab')) return;
  const st = document.createElement('style');
  st.textContent = CSS;
  document.head.appendChild(st);

  const fab = document.createElement('button');
  fab.id = 'as-fab';
  fab.innerHTML = '💬 Asistente';
  const panel = document.createElement('div');
  panel.id = 'as-panel';
  panel.innerHTML = `
    <div class="as-head"><div>Asistente DIARNEC<small>Preguntale por ventas, productos, vendedores, stock…</small></div>
      <div><button id="as-limpiar" title="Borrar la conversación">🗑</button><button id="as-cerrar" title="Cerrar">✕</button></div></div>
    <div class="as-msgs" id="as-msgs"></div>
    <div class="as-chips" id="as-chips"></div>
    <form class="as-form" id="as-form"><input id="as-input" type="text" placeholder="Escribí tu pregunta…" autocomplete="off"><button type="submit">Enviar</button></form>`;
  document.body.append(fab, panel);

  const msgs = panel.querySelector('#as-msgs');
  const chips = panel.querySelector('#as-chips');
  const input = panel.querySelector('#as-input');

  const guardar = () => { try { sessionStorage.setItem(KEY, msgs.innerHTML); } catch(e){ /* sin storage */ } };
  const agregar = (clase, html) => { const d = document.createElement('div'); d.className = `as-m ${clase}`; d.innerHTML = html; msgs.appendChild(d); msgs.scrollTop = msgs.scrollHeight; return d; };
  const mostrarChips = lista => { chips.innerHTML = (lista || CHIPS_BASE).slice(0, 5).map(c => `<button type="button">${esc(c)}</button>`).join(''); };

  async function preguntar(texto){
    texto = texto.trim();
    if(!texto) return;
    agregar('yo', esc(texto));
    input.value = '';
    const espera = agregar('bot as-pensando', 'Pensando…');
    let r;
    try { r = await responder(texto); }
    catch(e){ r = { html: `No pude consultar los datos: ${esc(e.message || e)}` }; }
    espera.className = 'as-m bot';
    espera.innerHTML = r.html;
    mostrarChips(r.chips);
    msgs.scrollTop = msgs.scrollHeight;
    guardar();
  }

  const abrir = () => { panel.classList.add('open'); fab.style.display = 'none'; setTimeout(() => input.focus(), 50); };
  const cerrar = () => { panel.classList.remove('open'); fab.style.display = ''; };
  fab.addEventListener('click', abrir);
  panel.querySelector('#as-cerrar').addEventListener('click', cerrar);
  panel.querySelector('#as-limpiar').addEventListener('click', () => { msgs.innerHTML = ''; try { sessionStorage.removeItem(KEY); } catch(e){ /* nada */ } bienvenida(); });
  panel.querySelector('#as-form').addEventListener('submit', e => { e.preventDefault(); preguntar(input.value); });
  chips.addEventListener('click', e => { const b = e.target.closest('button'); if(b) preguntar(b.textContent); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && panel.classList.contains('open')) cerrar(); });

  function bienvenida(){
    agregar('bot', 'Hola 👋 Soy el asistente de DIARNEC. Preguntame por <b>ventas</b>, <b>productos</b>, <b>vendedores</b>, <b>devoluciones</b>, <b>stock</b> o <b>saldos</b>. Podés pedirme una semana, un mes o <b>comparar</b> dos períodos.');
    mostrarChips(CHIPS_BASE);
  }
  let previo = null;
  try { previo = sessionStorage.getItem(KEY); } catch(e){ /* nada */ }
  if(previo){ msgs.innerHTML = previo; mostrarChips(CHIPS_BASE); msgs.scrollTop = msgs.scrollHeight; }
  else bienvenida();
}
