import { sb } from './supabase-client.js';
import { money, dateTime } from './format.js';

// Detalle de una cuenta corriente (de un vendedor o de un cliente), por SEMANA de lunes a domingo, igual que
// el resumen semanal que ve cada vendedor en su panel: saldo al empezar la semana, lo que pasó cada día
// (con los productos de cada movimiento) y saldo al cierre. Se abre al tocar una fila en Ventas.
//
// Cuenta corriente:  Debe = retirado/comprado − devoluciones − bonificaciones − pagos.
// La cuenta se "limpia" con el botón de Ventas (Limpiar cuentas corrientes): lo anterior a la limpieza no cuenta,
// así que la primera semana arranca con el saldo que corresponda desde ahí y no se muestran semanas más viejas.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MEDIOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque' };
const ITEMS = 'cantidad, precio_unitario, subtotal, productos(nombre, unidad)';
const NOMBRE_DIA = ['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'];
const MAX_SEMANAS = 26;
const TOPE_FILAS = 1000; // Supabase devuelve como máximo 1000 filas por consulta

// ---- fechas (todo en horario de Argentina; las fechas van como 'AAAA-MM-DD') ----
const enAR = iso => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
const hoyAR = () => enAR(new Date().toISOString());
const sumarDias = (f, n) => { const d = new Date(f + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const diaSemana = f => (new Date(f + 'T12:00:00Z').getUTCDay() + 6) % 7; // 0 = lunes
const lunesDe = f => sumarDias(f, -diaSemana(f));
const fmtDia = f => { const [, m, d] = f.split('-'); return `${Number(d)}/${Number(m)}`; };
const etiquetaSemana = w => `${fmtDia(w)} al ${fmtDia(sumarDias(w, 6))}`;
const hora = iso => new Date(iso).toLocaleTimeString('es-AR', { hour: '2-digit', minute: '2-digit', timeZone: 'America/Argentina/Buenos_Aires' });
const fmtSaldo = n => n > 0.005 ? `Debe ${money(n)}` : (n < -0.005 ? `A favor ${money(-n)}` : money(0));
const claseSaldo = n => n > 0.005 ? 'debe' : (n < -0.005 ? 'favor' : '');

let estilosPuestos = false;
let overlay = null;
let actual = null;      // { tipo, id, nombre }
let movs = [];          // movimientos desde la última limpieza, de más viejo a más nuevo
let semanas = [];       // lunes de cada semana, de la más nueva a la más vieja
let semSel = 0;
let checkpoint = null;
let avisoTope = false;

function ponerEstilos(){
  if(estilosPuestos) return;
  estilosPuestos = true;
  const st = document.createElement('style');
  st.textContent = `
    .cd-overlay{position:fixed;inset:0;background:rgba(18,36,54,.55);display:none;align-items:center;justify-content:center;z-index:60;padding:16px;}
    .cd-overlay.open{display:flex;}
    .cd-box{background:#fff;border-radius:16px;width:860px;max-width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;}
    .cd-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:20px 24px 10px;}
    .cd-head h3{margin:0;font-size:20px;letter-spacing:-.025em;color:var(--navy);}
    .cd-head small{display:block;color:var(--muted);font-size:12.5px;margin-top:3px;}
    .cd-x{border:none;background:none;font-size:26px;line-height:1;cursor:pointer;color:var(--muted);padding:0 4px;}
    .cd-cuerpo{overflow-y:auto;padding:0 24px 22px;}
    .cd-nav{display:flex;align-items:center;gap:6px;background:var(--paper);border-radius:12px;padding:5px;width:fit-content;max-width:100%;margin:4px 0 14px;}
    .cd-nav button{background:#fff;border:none;width:34px;height:34px;border-radius:9px;font-size:18px;cursor:pointer;color:var(--navy);}
    .cd-nav button:disabled{opacity:.3;cursor:default;}
    .cd-nav select{border:none;background:transparent;font-weight:700;font-size:14px;color:var(--navy);padding:6px 4px;cursor:pointer;min-width:200px;max-width:100%;}
    .cd-tarjetas{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:12px;}
    .cd-chip{background:var(--paper);border-radius:12px;padding:10px 14px;}
    .cd-chip span{display:block;font-size:11.5px;color:var(--muted);margin-bottom:3px;}
    .cd-chip b{font-size:16px;color:var(--navy);font-variant-numeric:tabular-nums;}
    .cd-saldo{display:flex;align-items:center;justify-content:center;gap:16px;flex-wrap:wrap;background:var(--navy);color:#fff;border-radius:12px;padding:14px 18px;margin-bottom:8px;}
    .cd-saldo small{display:block;font-size:11.5px;color:rgba(255,255,255,.7);margin-bottom:3px;}
    .cd-saldo b{font-size:18px;font-variant-numeric:tabular-nums;}
    .cd-saldo .debe{color:#FF9A8F;} .cd-saldo .favor{color:#5BE39B;}
    .cd-saldo .flecha{font-size:20px;opacity:.6;}
    .cd-nota{font-size:12px;color:var(--muted);margin:0 0 14px;}
    .cd-dias h4{margin:16px 0 8px;font-size:14px;color:var(--navy);}
    .cd-dia{border:1px solid var(--line);border-radius:12px;margin-bottom:8px;background:#fff;}
    .cd-dia.hoy{border-color:var(--navy);box-shadow:inset 0 0 0 1px var(--navy);}
    .cd-dia summary,.cd-dia .cd-fila-fija{display:grid;grid-template-columns:minmax(120px,1.3fr) repeat(4,minmax(80px,1fr));gap:8px;align-items:center;padding:10px 14px;list-style:none;cursor:pointer;}
    .cd-dia .cd-fila-fija{cursor:default;}
    .cd-dia summary::-webkit-details-marker{display:none;}
    .cd-dia.vacio{opacity:.6;background:var(--paper);border-style:dashed;}
    .cd-dia .nom b{font-size:13.5px;} .cd-dia .nom small{display:block;color:var(--muted);font-size:11.5px;margin-top:2px;}
    .cd-dia .n{font-size:13px;font-variant-numeric:tabular-nums;text-align:right;}
    .cd-dia .n small{display:block;font-size:10.5px;color:var(--muted);}
    .cd-hoy{display:inline-block;background:var(--navy);color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:100px;margin-left:6px;vertical-align:middle;}
    .cd-movs{border-top:1px solid var(--line);padding:6px 14px 10px;}
    .cd-mov{padding:8px 0;border-bottom:1px dashed var(--line);display:grid;grid-template-columns:1fr auto;gap:2px 12px;}
    .cd-mov:last-child{border-bottom:none;}
    .cd-tag{display:inline-block;padding:2px 9px;border-radius:100px;font-size:11px;font-weight:700;margin-right:6px;}
    .cd-tag.retiro{background:#FDECEA;color:#B0301F;}
    .cd-tag.credito{background:#E4F6EC;color:#17804F;}
    .cd-tag.pago{background:#E6F0FB;color:#2E5DA8;}
    .cd-tag.anulada{background:#EEE;color:#777;}
    .cd-desc{font-weight:600;font-size:13px;}
    .cd-imp{font-weight:700;font-size:13px;font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap;}
    .cd-imp.menos{color:#17804F;}
    .cd-sub{grid-column:1 / -1;font-size:12px;color:var(--muted);line-height:1.45;}
    .cd-items{grid-column:1 / -1;margin:2px 0 0;padding:0;list-style:none;font-size:12px;color:var(--muted);}
    .cd-items li{display:flex;justify-content:space-between;gap:10px;padding:1px 0;}
    .cd-mov.anulada{opacity:.5;} .cd-mov.anulada .cd-desc{text-decoration:line-through;}
    .cd-vacio{text-align:center;color:var(--muted);padding:30px 0;}
    @media (max-width:640px){
      .cd-head,.cd-cuerpo{padding-left:14px;padding-right:14px;}
      .cd-dia summary,.cd-dia .cd-fila-fija{grid-template-columns:1fr 1fr;}
      .cd-nav select{min-width:0;}
    }
  `;
  document.head.appendChild(st);
}

function asegurarOverlay(){
  if(overlay) return overlay;
  overlay = document.createElement('div');
  overlay.className = 'cd-overlay';
  overlay.innerHTML = `<div class="cd-box" role="dialog" aria-modal="true" aria-labelledby="cd-titulo"></div>`;
  overlay.addEventListener('click', e => { if(e.target === overlay) cerrar(); });
  document.addEventListener('keydown', e => { if(e.key === 'Escape' && overlay.classList.contains('open')) cerrar(); });
  document.body.appendChild(overlay);
  return overlay;
}

function cerrar(){ overlay.classList.remove('open'); }

const listaItems = (items = []) => items.length
  ? `<ul class="cd-items">${items.map(i => `<li><span>${Number(i.cantidad)} × ${esc(i.productos ? i.productos.nombre : 'Producto')}${i.productos && i.productos.unidad ? ' (' + esc(i.productos.unidad) + ')' : ''}</span><span>${money(i.subtotal)}</span></li>`).join('')}</ul>`
  : '';

// ===== Carga de movimientos (todo lo posterior a la última limpieza) =====

async function cargarMovimientos(){
  const { tipo, id } = actual;
  const filtrar = q => (checkpoint ? q.gte('created_at', checkpoint) : q).range(0, TOPE_FILAS - 1);
  const lista = [];
  const errores = [];
  let filas = 0;

  if(tipo === 'vendedor'){
    const [v, d, b, p] = await Promise.all([
      filtrar(sb.from('ventas').select(`id, created_at, canal, estado, total_neto, cliente_nombre, ventas_items(${ITEMS})`).eq('vendedor_id', id).in('estado', ['confirmada', 'anulada'])),
      filtrar(sb.from('devoluciones_cab').select(`id, created_at, total, motivo, con_stock, anulado, devoluciones_items(${ITEMS})`).eq('vendedor_id', id)),
      filtrar(sb.from('bonificaciones').select(`id, created_at, monto, descripcion, anulado, bonificaciones_items(${ITEMS})`).eq('vendedor_id', id)),
      filtrar(sb.from('pagos_vendedores').select('id, created_at, monto, medio_pago, descripcion, anulado').eq('vendedor_id', id))
    ]);
    [v, d, b, p].forEach(r => { if(r.error) errores.push(r.error.message); filas = Math.max(filas, (r.data || []).length); });
    (v.data || []).forEach(x => lista.push({
      fecha: x.created_at, clase: 'retiro', grupo: 'cargo', etiqueta: 'Retiro / venta', titulo: `#${x.id}${x.canal === 'online' ? ' · tienda online' : ''}`,
      sub: x.cliente_nombre ? 'Cliente: ' + x.cliente_nombre : '', items: x.ventas_items, importe: Number(x.total_neto), signo: 1, anulado: x.estado === 'anulada'
    }));
    (d.data || []).forEach(x => lista.push({
      fecha: x.created_at, clase: 'credito', grupo: 'credito', etiqueta: x.con_stock ? 'Devolución de stock' : 'Devolución', titulo: `#${x.id}`,
      sub: x.motivo || '', items: x.devoluciones_items, importe: Number(x.total), signo: -1, anulado: !!x.anulado
    }));
    (b.data || []).forEach(x => lista.push({
      fecha: x.created_at, clase: 'credito', grupo: 'bonif', etiqueta: 'Bonificación', titulo: `#${x.id}`,
      sub: x.descripcion || '', items: x.bonificaciones_items, importe: Number(x.monto), signo: -1, anulado: !!x.anulado
    }));
    (p.data || []).forEach(x => lista.push({
      fecha: x.created_at, clase: 'pago', grupo: 'pago', etiqueta: 'Pago', titulo: MEDIOS[x.medio_pago] || x.medio_pago || '',
      sub: x.descripcion || '', items: [], importe: Number(x.monto), signo: -1, anulado: !!x.anulado
    }));
  } else {
    const [v, d, p] = await Promise.all([
      filtrar(sb.from('ventas').select(`id, created_at, canal, estado, total_neto, vendedores(nombre), ventas_items(${ITEMS})`).eq('cliente_id', id).in('estado', ['confirmada', 'anulada'])),
      filtrar(sb.from('devoluciones_cab').select(`id, created_at, total, motivo, con_stock, anulado, venta_id, ventas!inner(cliente_id), devoluciones_items(${ITEMS})`).eq('ventas.cliente_id', id)),
      filtrar(sb.from('pagos_clientes').select('id, created_at, monto, medio_pago, descripcion, anulado').eq('cliente_id', id))
    ]);
    [v, d, p].forEach(r => { if(r.error) errores.push(r.error.message); filas = Math.max(filas, (r.data || []).length); });
    (v.data || []).forEach(x => lista.push({
      fecha: x.created_at, clase: 'retiro', grupo: 'cargo', etiqueta: 'Compra', titulo: `#${x.id}${x.canal === 'online' ? ' · tienda online' : ''}`,
      sub: x.vendedores ? 'Vendedor: ' + x.vendedores.nombre : '', items: x.ventas_items, importe: Number(x.total_neto), signo: 1, anulado: x.estado === 'anulada'
    }));
    (d.data || []).forEach(x => lista.push({
      fecha: x.created_at, clase: 'credito', grupo: 'credito', etiqueta: x.con_stock ? 'Devolución de stock' : 'Devolución', titulo: `#${x.id}${x.venta_id ? ' (de la venta #' + x.venta_id + ')' : ''}`,
      sub: x.motivo || '', items: x.devoluciones_items, importe: Number(x.total), signo: -1, anulado: !!x.anulado
    }));
    (p.data || []).forEach(x => lista.push({
      fecha: x.created_at, clase: 'pago', grupo: 'pago', etiqueta: 'Pago', titulo: MEDIOS[x.medio_pago] || x.medio_pago || '',
      sub: x.descripcion || '', items: [], importe: Number(x.monto), signo: -1, anulado: !!x.anulado
    }));
  }

  lista.forEach(m => { m.dia = enAR(m.fecha); });
  lista.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  avisoTope = filas >= TOPE_FILAS;
  return { lista, errores };
}

// Semanas a mostrar: de la actual hacia atrás, hasta la de la limpieza o el primer movimiento (máx. 26)
function armarSemanas(){
  const w0 = lunesDe(hoyAR());
  const primero = movs.length ? movs[0].dia : w0;
  const piso = checkpoint ? enAR(checkpoint) : primero;
  const desde = lunesDe(primero < piso ? primero : piso);
  const out = [];
  for(let w = w0; w >= desde && out.length < MAX_SEMANAS; w = sumarDias(w, -7)) out.push(w);
  return out;
}

// ===== Pantalla =====

const neto = m => (m.anulado ? 0 : m.signo * m.importe);

function pintarDia(fecha, lista, saldoCierre, hoy){
  const futuro = fecha > hoy;
  const nombre = `${NOMBRE_DIA[diaSemana(fecha)]} ${fmtDia(fecha)}`;
  const vivos = lista.filter(m => !m.anulado);
  const cargo = vivos.filter(m => m.grupo === 'cargo').reduce((t, m) => t + m.importe, 0);
  const cred = vivos.filter(m => m.grupo === 'credito' || m.grupo === 'bonif').reduce((t, m) => t + m.importe, 0);
  const pagos = vivos.filter(m => m.grupo === 'pago').reduce((t, m) => t + m.importe, 0);
  const vacio = lista.length === 0;
  const etCargo = actual.tipo === 'vendedor' ? 'Retirado' : 'Comprado';
  const cab = `
      <div class="nom"><b>${nombre}</b>${fecha === hoy ? '<span class="cd-hoy">Hoy</span>' : ''}${vacio ? `<small>${futuro ? 'todavía no llegó' : 'sin movimientos'}</small>` : `<small>${lista.length} movimiento${lista.length === 1 ? '' : 's'}</small>`}</div>
      <div class="n"><small>${etCargo}</small>${vacio ? '—' : money(cargo)}</div>
      <div class="n"><small>${actual.tipo === 'vendedor' ? 'Devol. y bonif.' : 'Devoluciones'}</small>${vacio ? '—' : money(cred)}</div>
      <div class="n"><small>Pagos</small>${vacio ? '—' : money(pagos)}</div>
      <div class="n"><small>Saldo al cierre</small>${futuro ? '—' : money(saldoCierre)}</div>`;
  if(vacio) return `<div class="cd-dia vacio ${fecha === hoy ? 'hoy' : ''}"><div class="cd-fila-fija">${cab}</div></div>`;
  const movsHtml = lista.map(m => `
        <div class="cd-mov ${m.anulado ? 'anulada' : ''}">
          <div><span class="cd-tag ${m.anulado ? 'anulada' : m.clase}">${esc(m.etiqueta)}${m.anulado ? ' · anulada' : ''}</span><span class="cd-desc">${esc(m.titulo)}</span> <small style="color:var(--muted)">${esc(hora(m.fecha))}</small></div>
          <div class="cd-imp ${m.signo > 0 ? '' : 'menos'}">${m.signo > 0 ? '' : '− '}${money(m.importe)}</div>
          ${m.sub ? `<div class="cd-sub">${esc(m.sub)}</div>` : ''}
          ${listaItems(m.items)}
        </div>`).join('');
  return `<details class="cd-dia ${fecha === hoy ? 'hoy' : ''}" ${fecha === hoy ? 'open' : ''}><summary>${cab}</summary><div class="cd-movs">${movsHtml}</div></details>`;
}

function pintar(errores = []){
  const esVend = actual.tipo === 'vendedor';
  const w = semanas[semSel];
  const fin = sumarDias(w, 6);
  const hoy = hoyAR();

  const previos = movs.filter(m => m.dia < w);
  const saldoInicial = previos.reduce((t, m) => t + neto(m), 0);
  const deSemana = movs.filter(m => m.dia >= w && m.dia <= fin);
  const vivos = deSemana.filter(m => !m.anulado);
  const suma = g => vivos.filter(m => g.includes(m.grupo)).reduce((t, m) => t + m.importe, 0);
  const cargo = suma(['cargo']), devol = suma(['credito']), bonif = suma(['bonif']), pagos = suma(['pago']);
  const saldoFinal = saldoInicial + cargo - devol - bonif - pagos;

  // día por día, con el saldo corriendo desde el saldo inicial de la semana
  let corrido = saldoInicial;
  const dias = [];
  for(let k = 0; k < 7; k++){
    const f = sumarDias(w, k);
    const lista = deSemana.filter(m => m.dia === f);
    corrido += lista.reduce((t, m) => t + neto(m), 0);
    dias.push(pintarDia(f, lista, corrido, hoy));
  }

  const opciones = semanas.map((x, i) => `<option value="${i}" ${i === semSel ? 'selected' : ''}>${etiquetaSemana(x)}${i === 0 ? ' (esta semana)' : ''}</option>`).join('');
  const limpieza = checkpoint ? `Cuentas limpiadas el ${esc(dateTime(checkpoint))}: los movimientos anteriores no cuentan.` : '';

  overlay.querySelector('.cd-box').innerHTML = `
    <div class="cd-head">
      <div><h3 id="cd-titulo">${esc(actual.nombre)}</h3><small>Cuenta corriente de ${esVend ? 'vendedor' : 'cliente'} · semana de lunes a domingo</small></div>
      <button class="cd-x" type="button" aria-label="Cerrar" id="cd-cerrar">&times;</button>
    </div>
    <div class="cd-cuerpo">
      <div class="cd-nav">
        <button id="cd-prev" type="button" title="Semana anterior" ${semSel >= semanas.length - 1 ? 'disabled' : ''}>‹</button>
        <select id="cd-sel" title="Elegir semana">${opciones}</select>
        <button id="cd-next" type="button" title="Semana siguiente" ${semSel <= 0 ? 'disabled' : ''}>›</button>
      </div>
      <div class="cd-tarjetas">
        <div class="cd-chip"><span>${esVend ? 'Retirado' : 'Comprado'}</span><b>${money(cargo)}</b></div>
        <div class="cd-chip"><span>Devoluciones</span><b>${money(devol)}</b></div>
        ${esVend ? `<div class="cd-chip"><span>Bonificaciones</span><b>${money(bonif)}</b></div>` : ''}
        <div class="cd-chip"><span>Pagos</span><b>${money(pagos)}</b></div>
      </div>
      <div class="cd-saldo">
        <div><small>Saldo al empezar la semana</small><b class="${claseSaldo(saldoInicial)}">${fmtSaldo(saldoInicial)}</b></div>
        <span class="flecha">→</span>
        <div><small>Saldo al cierre</small><b class="${claseSaldo(saldoFinal)}">${fmtSaldo(saldoFinal)}</b></div>
      </div>
      <p class="cd-nota">${limpieza}${avisoTope ? ' Ojo: hay muchísimos movimientos y solo se cargaron los primeros 1000 de cada tipo.' : ''}</p>
      ${errores.length ? `<div class="cd-vacio">No se pudo cargar todo el detalle: ${esc(errores[0])}</div>` : ''}
      <div class="cd-dias">
        <h4>Día por día <span style="font-weight:400;color:var(--muted);font-size:12px;">· tocá un día para ver sus movimientos</span></h4>
        ${dias.join('')}
      </div>
    </div>`;

  overlay.querySelector('#cd-cerrar').addEventListener('click', cerrar);
  overlay.querySelector('#cd-prev').addEventListener('click', () => elegir(semSel + 1));
  overlay.querySelector('#cd-next').addEventListener('click', () => elegir(semSel - 1));
  overlay.querySelector('#cd-sel').addEventListener('change', e => elegir(Number(e.target.value)));
}

function elegir(i){
  if(i < 0 || i >= semanas.length) return;
  semSel = i;
  pintar();
}

export async function abrirDetalleCuenta({ tipo, id, nombre }){
  ponerEstilos();
  asegurarOverlay();
  actual = { tipo, id, nombre };
  semSel = 0;
  overlay.classList.add('open');
  overlay.querySelector('.cd-box').innerHTML = `<div class="cd-head"><div><h3 id="cd-titulo">${esc(nombre)}</h3></div></div><div class="cd-vacio">Cargando…</div>`;
  const { data: cp } = await sb.from('cuentas_checkpoint').select('desde').maybeSingle();
  checkpoint = cp ? cp.desde : null;
  const { lista, errores } = await cargarMovimientos();
  movs = lista;
  semanas = armarSemanas();
  pintar(errores);
}
