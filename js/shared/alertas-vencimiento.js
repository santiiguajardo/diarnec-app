import { sb } from './supabase-client.js';

// Alertas de vencimiento: lotes con stock que ya vencieron o vencen pronto. Se monta en Dashboard
// (admin) e Inventario (admin y encargado). Lee stock_lotes, que ven todos los usuarios del panel.

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const DIAS_POR_DEFECTO = 30;
const OPCIONES_DIAS = [7, 15, 30, 60, 90];

// Fecha de hoy en Argentina, como 'YYYY-MM-DD' (las fechas de vencimiento son solo día, sin hora).
function hoyAR(){
  return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Argentina/Buenos_Aires' });
}
function diasEntre(hoy, fecha){
  return Math.round((Date.parse(fecha + 'T00:00:00Z') - Date.parse(hoy + 'T00:00:00Z')) / 86400000);
}
function sumarDias(fecha, n){
  const d = new Date(fecha + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const fmtFecha = f => f.split('-').reverse().join('/');
const fmtCant = n => new Intl.NumberFormat('es-AR', { maximumFractionDigits: 3 }).format(Number(n));

let estilosPuestos = false;
function ponerEstilos(){
  if(estilosPuestos) return;
  estilosPuestos = true;
  const st = document.createElement('style');
  st.textContent = `
    .venc-card{border-left:5px solid #17A06B;}
    .venc-card.alerta{border-left-color:#E67E22;}
    .venc-card.critica{border-left-color:#C0392B;}
    .venc-head{display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:6px;}
    .venc-head h3{margin:0;}
    .venc-head label{font-size:13px;color:var(--muted);display:flex;align-items:center;gap:6px;}
    .venc-head select{padding:6px 10px;border:1px solid var(--line);border-radius:8px;font-size:13px;background:#fff;}
    .venc-resumen{display:flex;gap:10px;flex-wrap:wrap;margin:6px 0 10px;}
    .venc-pill{padding:5px 12px;border-radius:100px;font-size:13px;font-weight:600;}
    .venc-pill.rojo{background:#FBE7E4;color:#B0301F;}
    .venc-pill.naranja{background:#FFF0DC;color:#A85A00;}
    .venc-pill.verde{background:#E4F6EC;color:#17804F;}
    .venc-tabla-wrap{max-height:320px;overflow:auto;}
    .venc-dias{font-weight:700;white-space:nowrap;}
    .venc-dias.rojo{color:#C0392B;} .venc-dias.naranja{color:#C67300;}
    .venc-vacio{color:var(--muted);font-size:14px;padding:6px 0;}
  `;
  document.head.appendChild(st);
}

export async function montarAlertasVencimiento(el){
  ponerEstilos();
  let dias = DIAS_POR_DEFECTO;

  async function pintar(){
    const hoy = hoyAR();
    const { data, error } = await sb.from('stock_lotes')
      .select('id, lote, fecha_vencimiento, cantidad_restante, productos(nombre, unidad, marcas(nombre))')
      .gt('cantidad_restante', 0)
      .not('fecha_vencimiento', 'is', null)
      .lte('fecha_vencimiento', sumarDias(hoy, dias))
      .order('fecha_vencimiento', { ascending: true })
      .limit(500);

    if(error){
      el.innerHTML = `<div class="admin-section venc-card"><div class="venc-head"><h3>⏰ Vencimientos</h3></div><div class="venc-vacio">No se pudieron cargar los vencimientos: ${esc(error.message)}</div></div>`;
      return;
    }
    const lotes = (data || []).map(l => ({ ...l, dias: diasEntre(hoy, l.fecha_vencimiento) }));
    const vencidos = lotes.filter(l => l.dias < 0);
    const proximos = lotes.filter(l => l.dias >= 0 && l.dias <= 7);
    const luego = lotes.filter(l => l.dias > 7);
    const clase = vencidos.length ? 'critica' : (lotes.length ? 'alerta' : '');

    const filas = lotes.map(l => {
      const c = l.dias < 0 ? 'rojo' : (l.dias <= 7 ? 'naranja' : '');
      const cuando = l.dias < 0 ? `Venció hace ${-l.dias} ${-l.dias === 1 ? 'día' : 'días'}` :
                     l.dias === 0 ? 'Vence hoy' : `Vence en ${l.dias} ${l.dias === 1 ? 'día' : 'días'}`;
      const prod = l.productos || {};
      return `<tr>
        <td>${esc(prod.nombre || '')}<br><small style="color:var(--muted);">${esc((prod.marcas && prod.marcas.nombre) || '')}${l.lote ? ' · lote ' + esc(l.lote) : ''}</small></td>
        <td>${fmtCant(l.cantidad_restante)}${prod.unidad ? ' <small>' + esc(prod.unidad) + '</small>' : ''}</td>
        <td>${fmtFecha(l.fecha_vencimiento)}</td>
        <td class="venc-dias ${c}">${cuando}</td>
      </tr>`;
    }).join('');

    el.innerHTML = `
      <div class="admin-section venc-card ${clase}">
        <div class="venc-head">
          <h3>⏰ Vencimientos</h3>
          <label>Mostrar lo que vence en los próximos
            <select id="venc-dias">${OPCIONES_DIAS.map(n => `<option value="${n}" ${n === dias ? 'selected' : ''}>${n} días</option>`).join('')}</select>
          </label>
        </div>
        ${lotes.length === 0
          ? `<div class="venc-vacio">✅ No hay mercadería vencida ni por vencer en los próximos ${dias} días.</div>`
          : `<div class="venc-resumen">
              ${vencidos.length ? `<span class="venc-pill rojo">${vencidos.length} ${vencidos.length === 1 ? 'lote vencido' : 'lotes vencidos'}</span>` : ''}
              ${proximos.length ? `<span class="venc-pill naranja">${proximos.length} vencen en 7 días o menos</span>` : ''}
              ${luego.length ? `<span class="venc-pill verde">${luego.length} vencen en ${dias} días o menos</span>` : ''}
            </div>
            <div class="venc-tabla-wrap"><table>
              <thead><tr><th>Producto</th><th>Cantidad</th><th>Vencimiento</th><th></th></tr></thead>
              <tbody>${filas}</tbody>
            </table></div>`}
      </div>`;
    const sel = el.querySelector('#venc-dias');
    if(sel) sel.addEventListener('change', () => { dias = Number(sel.value); pintar(); });
  }

  await pintar();
}
