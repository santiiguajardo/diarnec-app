// "Reporte de aumentos" de Inventario: cada cambio de precio de venta con su fecha, por artículo o por marca,
// filtrable por período (semanal, mensual, trimestral, semestral, anual). Lee precios_historial (ver migración 0039).

import { sb } from './supabase-client.js';
import { money, dateTime } from './format.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Los períodos cuentan hacia atrás desde hoy (ej: "Mensual" = los últimos 30 días).
const PERIODOS = [
  { k: 'semanal', t: 'Semanal', dias: 7, d: 'Últimos 7 días' },
  { k: 'mensual', t: 'Mensual', dias: 30, d: 'Últimos 30 días' },
  { k: 'trimestral', t: 'Trimestral', dias: 90, d: 'Últimos 3 meses' },
  { k: 'semestral', t: 'Semestral', dias: 180, d: 'Últimos 6 meses' },
  { k: 'anual', t: 'Anual', dias: 365, d: 'Último año' }
];
const DIA_MS = 86400000;

let periodo = 'mensual';
let vista = 'articulo'; // 'articulo' | 'marca'
let cambios = [];
let modal = null;
let pedido = 0; // para descartar respuestas viejas si se cambia de período rápido

const fechaCorta = d => new Date(d).toLocaleDateString('es-AR', { timeZone: 'America/Argentina/Buenos_Aires' });
const pct = (antes, ahora) => Number(antes) > 0 ? (Number(ahora) - Number(antes)) / Number(antes) * 100 : null;
const fmtPct = p => p === null ? '—' : `${p > 0 ? '+' : ''}${p.toFixed(1).replace('.', ',')}%`;

async function cargarCambios(desdeIso){
  const todos = [];
  for(let desde = 0; ; desde += 1000){
    const { data, error } = await sb.from('precios_historial')
      .select('id, created_at, precio_anterior, precio_nuevo, producto_id, productos(nombre, unidad, marcas(nombre, color))')
      .gte('created_at', desdeIso)
      .order('created_at', { ascending: false }).order('id', { ascending: false })
      .range(desde, desde + 999);
    if(error) throw error;
    todos.push(...data);
    if(data.length < 1000) break;
  }
  return todos;
}

// Por artículo: el primer precio del período contra el último (si cambió varias veces, cuenta el resultado final)
function netoPorArticulo(lista){
  const mapa = new Map();
  for(const c of [...lista].reverse()){ // del más viejo al más nuevo
    const m = mapa.get(c.producto_id);
    if(!m) mapa.set(c.producto_id, { producto: c.productos, antes: Number(c.precio_anterior), ahora: Number(c.precio_nuevo), ultimo: c.created_at, veces: 1 });
    else { m.ahora = Number(c.precio_nuevo); m.ultimo = c.created_at; m.veces++; }
  }
  return [...mapa.values()].map(m => ({ ...m, pct: pct(m.antes, m.ahora) }));
}

const nombreArt = p => p ? `${esc(p.nombre)}${p.unidad ? ` <small>${esc(p.unidad)}</small>` : ''}` : '—';
const marcaDe = p => (p && p.marcas && p.marcas.nombre) || 'Sin marca';

function claseCambio(a, b){ return Number(b) > Number(a) ? 'sube' : (Number(b) < Number(a) ? 'baja' : ''); }
const flecha = (a, b) => Number(b) > Number(a) ? '▲' : (Number(b) < Number(a) ? '▼' : '');

function htmlResumen(netos){
  const suben = netos.filter(n => n.ahora > n.antes);
  const bajan = netos.filter(n => n.ahora < n.antes);
  const pcts = suben.map(n => n.pct).filter(p => p !== null);
  const prom = pcts.length ? pcts.reduce((s, p) => s + p, 0) / pcts.length : null;
  return `
    <div class="rep-cards">
      <div><span>Artículos con cambio</span><b>${netos.length}</b></div>
      <div class="sube"><span>Con aumento</span><b>${suben.length}</b></div>
      <div class="baja"><span>Con baja</span><b>${bajan.length}</b></div>
      <div><span>Aumento promedio</span><b>${prom === null ? '—' : fmtPct(prom)}</b></div>
    </div>`;
}

function htmlPorArticulo(){
  return `
    <table class="rep-tabla">
      <thead><tr><th>Fecha</th><th>Marca</th><th>Artículo</th><th class="r">Antes</th><th class="r">Ahora</th><th class="r">Diferencia</th><th class="r">%</th></tr></thead>
      <tbody>${cambios.map(c => {
        const dif = Number(c.precio_nuevo) - Number(c.precio_anterior);
        const cls = claseCambio(c.precio_anterior, c.precio_nuevo);
        return `<tr>
          <td>${dateTime(c.created_at)}</td>
          <td>${esc(marcaDe(c.productos))}</td>
          <td>${nombreArt(c.productos)}</td>
          <td class="r">${money(c.precio_anterior)}</td>
          <td class="r"><b>${money(c.precio_nuevo)}</b></td>
          <td class="r ${cls}">${flecha(c.precio_anterior, c.precio_nuevo)} ${dif > 0 ? '+' : ''}${money(dif)}</td>
          <td class="r ${cls}"><b>${fmtPct(pct(c.precio_anterior, c.precio_nuevo))}</b></td>
        </tr>`;
      }).join('')}</tbody>
    </table>`;
}

function htmlPorMarca(netos){
  const marcas = new Map();
  for(const n of netos){
    const nombre = marcaDe(n.producto);
    if(!marcas.has(nombre)) marcas.set(nombre, { nombre, arts: [] });
    marcas.get(nombre).arts.push(n);
  }
  const filas = [...marcas.values()].map(m => {
    const pcts = m.arts.map(a => a.pct).filter(p => p !== null);
    const mayor = [...m.arts].filter(a => a.pct !== null).sort((a, b) => b.pct - a.pct)[0];
    return {
      nombre: m.nombre, n: m.arts.length,
      suben: m.arts.filter(a => a.ahora > a.antes).length, bajan: m.arts.filter(a => a.ahora < a.antes).length,
      prom: pcts.length ? pcts.reduce((s, p) => s + p, 0) / pcts.length : null,
      mayor, ultimo: m.arts.reduce((u, a) => a.ultimo > u ? a.ultimo : u, '')
    };
  }).sort((a, b) => (b.prom ?? -1e9) - (a.prom ?? -1e9));

  return `
    <table class="rep-tabla">
      <thead><tr><th>Marca</th><th class="r">Artículos con cambio</th><th class="r">Subieron</th><th class="r">Bajaron</th><th class="r">Variación promedio</th><th>Mayor cambio</th><th>Último cambio</th></tr></thead>
      <tbody>${filas.map(f => `<tr>
        <td><b>${esc(f.nombre)}</b></td>
        <td class="r">${f.n}</td>
        <td class="r sube">${f.suben || '—'}</td>
        <td class="r baja">${f.bajan || '—'}</td>
        <td class="r ${f.prom === null ? '' : (f.prom > 0 ? 'sube' : (f.prom < 0 ? 'baja' : ''))}"><b>${f.prom === null ? '—' : fmtPct(f.prom)}</b></td>
        <td>${f.mayor ? `${nombreArt(f.mayor.producto)} <span class="${f.mayor.pct > 0 ? 'sube' : 'baja'}">${fmtPct(f.mayor.pct)}</span>` : '—'}</td>
        <td>${fechaCorta(f.ultimo)}</td>
      </tr>`).join('')}</tbody>
    </table>`;
}

function pintar(estado){
  if(!modal) return;
  const p = PERIODOS.find(x => x.k === periodo);
  const hasta = new Date(), desde = new Date(Date.now() - p.dias * DIA_MS);
  const box = modal.querySelector('.rep-box');
  let cuerpo;
  if(estado === 'cargando') cuerpo = '<div class="rep-vacio">Cargando…</div>';
  else if(estado && estado.error) cuerpo = `<div class="rep-vacio rep-error">No se pudo cargar el reporte: ${esc(estado.error)}</div>`;
  else if(cambios.length === 0) cuerpo = '<div class="rep-vacio">No hubo cambios de precio en este período.</div>';
  else {
    const netos = netoPorArticulo(cambios);
    cuerpo = htmlResumen(netos) + (vista === 'articulo' ? htmlPorArticulo() : htmlPorMarca(netos));
  }

  box.innerHTML = `
    <h3>📈 Reporte de aumentos</h3>
    <div class="rep-chips" id="rep-periodos">${PERIODOS.map(x => `<button type="button" data-p="${x.k}" class="${x.k === periodo ? 'active' : ''}" title="${x.d}">${x.t}</button>`).join('')}</div>
    <div class="rep-rango">${p.d}: del <b>${fechaCorta(desde)}</b> al <b>${fechaCorta(hasta)}</b></div>
    <div class="rep-chips vista" id="rep-vista">
      <button type="button" data-v="articulo" class="${vista === 'articulo' ? 'active' : ''}">Por artículo</button>
      <button type="button" data-v="marca" class="${vista === 'marca' ? 'active' : ''}">Por marca</button>
    </div>
    <div class="rep-cuerpo">${cuerpo}</div>
    <div class="rep-pie">El historial se guarda desde el 20/10/2026: los cambios anteriores no estaban registrados.</div>
    <div class="app-confirm-actions"><button type="button" class="app-confirm-cancel" data-cerrar="1">Cerrar</button></div>`;
}

async function cargar(){
  const mio = ++pedido;
  pintar('cargando');
  const p = PERIODOS.find(x => x.k === periodo);
  try {
    const datos = await cargarCambios(new Date(Date.now() - p.dias * DIA_MS).toISOString());
    if(mio !== pedido) return; // eligió otro período mientras tanto
    cambios = datos;
    pintar();
  } catch(e){
    if(mio !== pedido) return;
    cambios = [];
    pintar({ error: e.message || String(e) });
  }
}

function cerrar(){
  if(!modal) return;
  document.removeEventListener('keydown', alTeclear);
  modal.remove();
  modal = null;
  pedido++;
}

function alTeclear(e){ if(e.key === 'Escape') cerrar(); }

export function abrirReporteAumentos(){
  if(modal) return;
  modal = document.createElement('div');
  modal.className = 'app-confirm-overlay';
  modal.innerHTML = '<div class="app-confirm-box rep-box"></div>';
  modal.addEventListener('click', e => {
    if(e.target === modal || e.target.closest('[data-cerrar]')) return cerrar();
    const bp = e.target.closest('#rep-periodos button[data-p]');
    if(bp){ periodo = bp.dataset.p; cargar(); return; }
    const bv = e.target.closest('#rep-vista button[data-v]');
    if(bv){ vista = bv.dataset.v; pintar(); }
  });
  document.addEventListener('keydown', alTeclear);
  document.body.appendChild(modal);
  cargar();
}
