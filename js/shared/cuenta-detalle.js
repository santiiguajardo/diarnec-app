import { sb } from './supabase-client.js';
import { money, dateTime } from './format.js';

// Detalle de una cuenta corriente (de un vendedor o de un cliente): todos los movimientos con su fecha,
// los productos de cada uno y cómo va cambiando el saldo. Se abre al tocar una fila en Ventas.
//
// Cuenta corriente:  Debe = retirado/comprado − devoluciones − bonificaciones − pagos.
// Las cuentas se "limpian" (Ventas → Limpiar cuentas corrientes) sin borrar historial: la tabla cuenta solo
// desde la última limpieza, así que acá también; hay un interruptor para ver los movimientos anteriores.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MEDIOS = { efectivo: 'Efectivo', transferencia: 'Transferencia', cheque: 'Cheque' };
const ITEMS = 'cantidad, precio_unitario, subtotal, productos(nombre, unidad)';

let estilosPuestos = false;
let overlay = null;
let actual = null; // { tipo, id, nombre }
let incluirAnteriores = false;
let checkpoint = null;

function ponerEstilos(){
  if(estilosPuestos) return;
  estilosPuestos = true;
  const st = document.createElement('style');
  st.textContent = `
    .cd-overlay{position:fixed;inset:0;background:rgba(18,36,54,.55);display:none;align-items:center;justify-content:center;z-index:60;padding:16px;}
    .cd-overlay.open{display:flex;}
    .cd-box{background:#fff;border-radius:16px;width:860px;max-width:100%;max-height:92vh;display:flex;flex-direction:column;overflow:hidden;}
    .cd-head{display:flex;justify-content:space-between;align-items:flex-start;gap:12px;padding:20px 24px 12px;}
    .cd-head h3{margin:0;font-size:20px;letter-spacing:-.025em;color:var(--navy);}
    .cd-head small{display:block;color:var(--muted);font-size:12.5px;margin-top:3px;}
    .cd-x{border:none;background:none;font-size:26px;line-height:1;cursor:pointer;color:var(--muted);padding:0 4px;}
    .cd-resumen{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;padding:4px 24px 14px;}
    .cd-chip{background:var(--paper);border-radius:12px;padding:10px 14px;}
    .cd-chip span{display:block;font-size:11.5px;color:var(--muted);margin-bottom:3px;}
    .cd-chip b{font-size:16px;color:var(--navy);font-variant-numeric:tabular-nums;}
    .cd-chip.saldo{background:var(--navy);}
    .cd-chip.saldo span{color:rgba(255,255,255,.7);}
    .cd-chip.saldo b{color:#fff;}
    .cd-chip.saldo.debe b{color:#FF9A8F;}
    .cd-chip.saldo.favor b{color:#5BE39B;}
    .cd-barra{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;padding:0 24px 10px;font-size:12.5px;color:var(--muted);}
    .cd-barra label{display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--ink);}
    .cd-lista{overflow-y:auto;padding:0 24px 22px;}
    .cd-lista table{width:100%;border-collapse:collapse;font-size:13px;}
    .cd-lista th{position:sticky;top:0;background:#fff;text-align:left;font-size:11.5px;color:var(--muted);font-weight:600;padding:8px 6px;border-bottom:1px solid var(--line);}
    .cd-lista td{padding:10px 6px;border-bottom:1px solid var(--line);vertical-align:top;}
    .cd-lista .r{text-align:right;white-space:nowrap;font-variant-numeric:tabular-nums;}
    .cd-tag{display:inline-block;padding:2px 9px;border-radius:100px;font-size:11px;font-weight:700;margin-right:6px;}
    .cd-tag.retiro{background:#FDECEA;color:#B0301F;}
    .cd-tag.credito{background:#E4F6EC;color:#17804F;}
    .cd-tag.pago{background:#E6F0FB;color:#2E5DA8;}
    .cd-tag.anulada{background:#EEE;color:#777;}
    .cd-desc{font-weight:600;color:var(--ink);}
    .cd-sub{font-size:12px;color:var(--muted);margin-top:3px;line-height:1.45;}
    .cd-items{margin:6px 0 0;padding:0;list-style:none;font-size:12px;color:var(--muted);}
    .cd-items li{display:flex;justify-content:space-between;gap:10px;padding:1px 0;}
    tr.cd-anulada td{opacity:.5;}
    tr.cd-anulada .cd-desc{text-decoration:line-through;}
    .cd-mas{color:var(--ink);} .cd-menos{color:#17804F;}
    .cd-vacio{text-align:center;color:var(--muted);padding:34px 0;}
    @media (max-width:640px){ .cd-head,.cd-resumen,.cd-barra,.cd-lista{padding-left:14px;padding-right:14px;} .cd-lista th:nth-child(4),.cd-lista td:nth-child(4){display:none;} }
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

// ===== Carga de movimientos =====

async function cargarMovimientos(){
  const { tipo, id } = actual;
  const desde = incluirAnteriores ? null : checkpoint;
  const filtrar = q => (desde ? q.gte('created_at', desde) : q);
  const movs = [];
  const errores = [];

  if(tipo === 'vendedor'){
    const [v, d, b, p] = await Promise.all([
      filtrar(sb.from('ventas').select(`id, created_at, canal, estado, total_neto, cliente_nombre, ventas_items(${ITEMS})`).eq('vendedor_id', id).in('estado', ['confirmada', 'anulada'])),
      filtrar(sb.from('devoluciones_cab').select(`id, created_at, total, motivo, con_stock, anulado, devoluciones_items(${ITEMS})`).eq('vendedor_id', id)),
      filtrar(sb.from('bonificaciones').select(`id, created_at, monto, descripcion, anulado, bonificaciones_items(${ITEMS})`).eq('vendedor_id', id)),
      filtrar(sb.from('pagos_vendedores').select('id, created_at, monto, medio_pago, descripcion, anulado').eq('vendedor_id', id))
    ]);
    [v, d, b, p].forEach(r => { if(r.error) errores.push(r.error.message); });
    (v.data || []).forEach(x => movs.push({
      fecha: x.created_at, clase: 'retiro', etiqueta: 'Retiro / venta', titulo: `#${x.id}${x.canal === 'online' ? ' · tienda online' : ''}`,
      sub: x.cliente_nombre ? 'Cliente: ' + x.cliente_nombre : '', items: x.ventas_items, importe: Number(x.total_neto), signo: 1, anulado: x.estado === 'anulada'
    }));
    (d.data || []).forEach(x => movs.push({
      fecha: x.created_at, clase: 'credito', etiqueta: x.con_stock ? 'Devolución de stock' : 'Devolución', titulo: `#${x.id}`,
      sub: x.motivo || '', items: x.devoluciones_items, importe: Number(x.total), signo: -1, anulado: !!x.anulado
    }));
    (b.data || []).forEach(x => movs.push({
      fecha: x.created_at, clase: 'credito', etiqueta: 'Bonificación', titulo: `#${x.id}`,
      sub: x.descripcion || '', items: x.bonificaciones_items, importe: Number(x.monto), signo: -1, anulado: !!x.anulado
    }));
    (p.data || []).forEach(x => movs.push({
      fecha: x.created_at, clase: 'pago', etiqueta: 'Pago', titulo: MEDIOS[x.medio_pago] || x.medio_pago || '',
      sub: x.descripcion || '', items: [], importe: Number(x.monto), signo: -1, anulado: !!x.anulado
    }));
  } else {
    const [v, d, p] = await Promise.all([
      filtrar(sb.from('ventas').select(`id, created_at, canal, estado, total_neto, vendedores(nombre), ventas_items(${ITEMS})`).eq('cliente_id', id).in('estado', ['confirmada', 'anulada'])),
      filtrar(sb.from('devoluciones_cab').select(`id, created_at, total, motivo, con_stock, anulado, venta_id, ventas!inner(cliente_id), devoluciones_items(${ITEMS})`).eq('ventas.cliente_id', id)),
      filtrar(sb.from('pagos_clientes').select('id, created_at, monto, medio_pago, descripcion, anulado').eq('cliente_id', id))
    ]);
    [v, d, p].forEach(r => { if(r.error) errores.push(r.error.message); });
    (v.data || []).forEach(x => movs.push({
      fecha: x.created_at, clase: 'retiro', etiqueta: 'Compra', titulo: `#${x.id}${x.canal === 'online' ? ' · tienda online' : ''}`,
      sub: x.vendedores ? 'Vendedor: ' + x.vendedores.nombre : '', items: x.ventas_items, importe: Number(x.total_neto), signo: 1, anulado: x.estado === 'anulada'
    }));
    (d.data || []).forEach(x => movs.push({
      fecha: x.created_at, clase: 'credito', etiqueta: x.con_stock ? 'Devolución de stock' : 'Devolución', titulo: `#${x.id}${x.venta_id ? ' (de la venta #' + x.venta_id + ')' : ''}`,
      sub: x.motivo || '', items: x.devoluciones_items, importe: Number(x.total), signo: -1, anulado: !!x.anulado
    }));
    (p.data || []).forEach(x => movs.push({
      fecha: x.created_at, clase: 'pago', etiqueta: 'Pago', titulo: MEDIOS[x.medio_pago] || x.medio_pago || '',
      sub: x.descripcion || '', items: [], importe: Number(x.monto), signo: -1, anulado: !!x.anulado
    }));
  }

  // Saldo acumulado: se calcula de lo más viejo a lo más nuevo (las anuladas no cuentan) y se muestra al revés.
  movs.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));
  let saldo = 0;
  movs.forEach(m => { if(!m.anulado) saldo += m.signo * m.importe; m.saldo = saldo; });
  return { movs, errores };
}

// ===== Pantalla =====

function totales(movs){
  const t = { cargos: 0, devoluciones: 0, bonificaciones: 0, pagos: 0 };
  movs.filter(m => !m.anulado).forEach(m => {
    if(m.clase === 'retiro') t.cargos += m.importe;
    else if(m.clase === 'pago') t.pagos += m.importe;
    else if(m.etiqueta === 'Bonificación') t.bonificaciones += m.importe;
    else t.devoluciones += m.importe;
  });
  t.saldo = t.cargos - t.devoluciones - t.bonificaciones - t.pagos;
  return t;
}

function pintar({ movs, errores }){
  const esVend = actual.tipo === 'vendedor';
  const t = totales(movs);
  const sc = t.saldo > 0.005 ? 'debe' : (t.saldo < -0.005 ? 'favor' : '');
  const fila = m => `
    <tr class="${m.anulado ? 'cd-anulada' : ''}">
      <td style="white-space:nowrap;">${esc(dateTime(m.fecha))}</td>
      <td>
        <span class="cd-tag ${m.anulado ? 'anulada' : m.clase}">${esc(m.etiqueta)}${m.anulado ? ' · anulada' : ''}</span><span class="cd-desc">${esc(m.titulo)}</span>
        ${m.sub ? `<div class="cd-sub">${esc(m.sub)}</div>` : ''}
        ${listaItems(m.items)}
      </td>
      <td class="r ${m.signo > 0 ? 'cd-mas' : 'cd-menos'}">${m.signo > 0 ? '' : '− '}${money(m.importe)}</td>
      <td class="r">${m.anulado ? '' : money(m.saldo)}</td>
    </tr>`;

  overlay.querySelector('.cd-box').innerHTML = `
    <div class="cd-head">
      <div><h3 id="cd-titulo">${esc(actual.nombre)}</h3><small>Cuenta corriente de ${esVend ? 'vendedor' : 'cliente'}</small></div>
      <button class="cd-x" type="button" aria-label="Cerrar" id="cd-cerrar">&times;</button>
    </div>
    <div class="cd-resumen">
      <div class="cd-chip"><span>${esVend ? 'Retirado' : 'Comprado'}</span><b>${money(t.cargos)}</b></div>
      <div class="cd-chip"><span>Devoluciones</span><b>${money(t.devoluciones)}</b></div>
      ${esVend ? `<div class="cd-chip"><span>Bonificaciones</span><b>${money(t.bonificaciones)}</b></div>` : ''}
      <div class="cd-chip"><span>Pagos</span><b>${money(t.pagos)}</b></div>
      <div class="cd-chip saldo ${sc}"><span>${t.saldo < -0.005 ? 'A favor' : 'Debe'}</span><b>${money(Math.abs(t.saldo))}</b></div>
    </div>
    <div class="cd-barra">
      <span>${incluirAnteriores || !checkpoint ? 'Todos los movimientos.' : 'Desde la última limpieza de cuentas.'}</span>
      ${checkpoint ? `<label><input type="checkbox" id="cd-anteriores" ${incluirAnteriores ? 'checked' : ''}> Ver también los movimientos anteriores a la limpieza</label>` : ''}
    </div>
    <div class="cd-lista">
      ${errores.length ? `<div class="cd-vacio">No se pudo cargar todo el detalle: ${esc(errores[0])}</div>` : ''}
      ${movs.length === 0 && !errores.length ? `<div class="cd-vacio">Todavía no hay movimientos en esta cuenta.</div>` : `
      <table>
        <thead><tr><th>Fecha y hora</th><th>Movimiento</th><th class="r">Importe</th><th class="r">Saldo</th></tr></thead>
        <tbody>${[...movs].reverse().map(fila).join('')}</tbody>
      </table>`}
    </div>`;
  overlay.querySelector('#cd-cerrar').addEventListener('click', cerrar);
  const chk = overlay.querySelector('#cd-anteriores');
  if(chk) chk.addEventListener('change', async () => { incluirAnteriores = chk.checked; await recargar(); });
}

async function recargar(){
  overlay.querySelector('.cd-box').innerHTML = `<div class="cd-head"><div><h3 id="cd-titulo">${esc(actual.nombre)}</h3></div></div><div class="cd-vacio">Cargando…</div>`;
  pintar(await cargarMovimientos());
}

export async function abrirDetalleCuenta({ tipo, id, nombre }){
  ponerEstilos();
  asegurarOverlay();
  actual = { tipo, id, nombre };
  incluirAnteriores = false;
  overlay.classList.add('open');
  overlay.querySelector('.cd-box').innerHTML = `<div class="cd-head"><div><h3 id="cd-titulo">${esc(nombre)}</h3></div></div><div class="cd-vacio">Cargando…</div>`;
  const { data: cp } = await sb.from('cuentas_checkpoint').select('desde').maybeSingle();
  checkpoint = cp ? cp.desde : null;
  pintar(await cargarMovimientos());
}
