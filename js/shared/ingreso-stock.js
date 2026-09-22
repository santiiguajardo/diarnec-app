// Pantalla de "Ingreso de mercadería": suma al stock varios productos de una vez (cuando llega el
// camión). La usan los dos botones de Inventario:
//   · Agregar stock manualmente → arranca con una fila vacía
//   · Adjuntar remito           → arranca con las filas que propuso remito-ocr.js, para revisar
// Todo se ingresa junto (registrar_ingreso_multiple): o entra todo o no entra nada.

import { sb } from './supabase-client.js';
import { createProductPicker } from './product-picker.js';
import { cantidadEsValida, mensajeCantidad, ajustarInputCantidad } from './cantidad.js';

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtCant = n => Number(n).toLocaleString('es-AR', { maximumFractionDigits: 3 });

const CONF = {
  alta: { txt: 'Coincide', cls: 'ok' },
  media: { txt: 'Revisar', cls: 'mid' },
  baja: { txt: 'Dudoso', cls: 'low' },
  ninguna: { txt: 'Sin coincidencia', cls: 'none' }
};

function inyectarEstilos(){
  if(document.getElementById('ing-css')) return;
  const st = document.createElement('style');
  st.id = 'ing-css';
  st.textContent = `
    .ing-overlay{position:fixed;inset:0;background:rgba(18,36,54,.55);display:flex;align-items:flex-start;justify-content:center;z-index:120;padding:4vh 12px;overflow-y:auto;}
    .ing-box{background:#fff;border-radius:16px;width:980px;max-width:100%;padding:24px;box-shadow:0 20px 50px rgba(0,0,0,.3);}
    .ing-head{display:flex;align-items:center;gap:14px;margin-bottom:14px;}
    .ing-ico{width:46px;height:46px;border-radius:12px;background:var(--navy,#122436);display:flex;align-items:center;justify-content:center;font-size:23px;flex:none;}
    .ing-head h3{font-family:'Space Grotesk',sans-serif;color:var(--navy,#122436);font-size:20px;margin:0;}
    .ing-head p{font-size:13px;color:var(--muted,#6B7280);margin:2px 0 0;}
    .ing-meta{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:14px;}
    .ing-meta label{display:flex;flex-direction:column;gap:5px;font-size:12px;font-weight:600;color:var(--navy,#122436);}
    .ing-meta input,.ing-meta select{padding:9px 10px;border:1px solid var(--line,#E4E2DA);border-radius:8px;font-size:13px;font-weight:400;}
    .ing-nota{background:#FFF6E5;border:1px solid #F5D9A0;color:#7A5300;border-radius:10px;padding:10px 14px;font-size:13px;margin-bottom:14px;line-height:1.45;}
    .ing-tabla{width:100%;border-collapse:collapse;font-size:13px;}
    .ing-tabla th{text-align:left;font-size:12px;color:var(--muted,#6B7280);font-weight:500;padding:6px;border-bottom:1px solid var(--line,#E4E2DA);}
    .ing-tabla td{padding:8px 6px;border-bottom:1px solid var(--line,#E4E2DA);vertical-align:top;}
    .ing-tabla tr.off td{opacity:.5;}
    .ing-tabla input[type=number],.ing-tabla input[type=date]{padding:8px;border:1px solid var(--line,#E4E2DA);border-radius:8px;font-size:13px;width:100%;}
    .ing-tabla .ing-cant{width:90px;text-align:right;font-weight:700;}
    .ing-tabla .ing-x{background:none;border:none;font-size:20px;color:#C0392B;cursor:pointer;padding:2px 8px;}
    .ing-orig{margin-top:5px;font-size:11px;color:var(--muted,#6B7280);font-family:ui-monospace,Consolas,monospace;background:var(--paper,#F2F1EC);border-radius:6px;padding:4px 7px;overflow-wrap:anywhere;}
    .ing-badge{display:inline-block;font-size:10.5px;font-weight:700;padding:2px 8px;border-radius:999px;margin-top:5px;margin-right:6px;}
    .ing-badge.ok{background:#DDF3E8;color:#1E8E5A;} .ing-badge.mid{background:#FFF0C7;color:#8A6100;}
    .ing-badge.low{background:#FFE1D0;color:#B9590F;} .ing-badge.none{background:#FDECEA;color:#C0392B;}
    .ing-chips{display:flex;flex-wrap:wrap;gap:4px;margin-top:5px;align-items:center;font-size:11px;color:var(--muted,#6B7280);}
    .ing-chip{border:1px solid var(--line,#E4E2DA);background:#fff;border-radius:999px;padding:2px 9px;font-size:11px;cursor:pointer;color:var(--navy,#122436);}
    .ing-chip:hover{background:var(--paper,#F2F1EC);}
    .ing-add{margin-top:12px;padding:9px 14px;border:1px dashed #9AA3B0;background:#fff;border-radius:9px;font-weight:600;font-size:13px;cursor:pointer;color:var(--navy,#122436);}
    .ing-sin{margin-top:16px;border:1px solid var(--line,#E4E2DA);border-radius:10px;padding:10px 14px;font-size:13px;}
    .ing-sin summary{cursor:pointer;font-weight:600;color:var(--navy,#122436);}
    .ing-sin-fila{display:flex;gap:10px;align-items:center;justify-content:space-between;padding:6px 0;border-top:1px solid var(--line,#E4E2DA);margin-top:6px;}
    .ing-sin-fila span{font-family:ui-monospace,Consolas,monospace;font-size:11px;overflow-wrap:anywhere;}
    .ing-pie{display:flex;align-items:center;gap:12px;margin-top:18px;flex-wrap:wrap;}
    .ing-resumen{flex:1;font-size:13px;color:var(--muted,#6B7280);min-width:180px;}
    .ing-resumen b{color:var(--navy,#122436);}
    .ing-pie button{padding:11px 20px;border:none;border-radius:10px;font-weight:700;font-size:14px;cursor:pointer;}
    .ing-cancel{background:var(--paper,#F2F1EC);color:var(--ink,#1A1A1A);}
    .ing-ok{background:var(--green,#2BB673);color:#fff;}
    .ing-ok[disabled]{opacity:.55;cursor:default;}
    .ing-aviso{display:none;margin-top:12px;padding:10px 14px;border-radius:9px;font-size:13px;background:#FDECEA;color:#A93226;border:1px solid #F0B9B2;}
    .ing-aviso.on{display:block;}
    .ing-barra{height:10px;background:var(--paper,#F2F1EC);border-radius:999px;overflow:hidden;margin:18px 0 8px;}
    .ing-barra i{display:block;height:100%;width:0;background:var(--green,#2BB673);transition:width .25s;}
    .ing-listo li{padding:6px 0;border-bottom:1px solid var(--line,#E4E2DA);list-style:none;font-size:13px;display:flex;justify-content:space-between;gap:10px;}
    @media (max-width:760px){ .ing-meta{grid-template-columns:1fr;} .ing-box{padding:16px;} .ing-tabla thead{display:none;} .ing-tabla tr{display:block;border-bottom:1px solid var(--line,#E4E2DA);padding:6px 0;} .ing-tabla td{display:block;border:none;} }
  `;
  document.head.appendChild(st);
}

function overlay(){
  inyectarEstilos();
  const ov = document.createElement('div');
  ov.className = 'ing-overlay';
  ov.innerHTML = '<div class="ing-box"></div>';
  document.body.appendChild(ov);
  return { ov, box: ov.firstElementChild, cerrar: () => ov.remove() };
}

// ===== Progreso de lectura del remito =====
// Devuelve { progreso(texto, 0..1), error(msg), cerrar() }
export function abrirLectura(nombreArchivo){
  const { box, cerrar } = overlay();
  box.style.width = '520px';
  box.innerHTML = `
    <div class="ing-head"><div class="ing-ico">📎</div><div><h3>Leyendo el remito</h3><p>${esc(nombreArchivo)}</p></div></div>
    <div class="ing-barra"><i id="ing-barra"></i></div>
    <div id="ing-prog-txt" style="font-size:13px;color:var(--muted,#6B7280);">Empezando…</div>
    <div class="ing-aviso" id="ing-prog-err"></div>
    <div class="ing-pie"><span class="ing-resumen"></span><button class="ing-cancel" id="ing-prog-cerrar">Cancelar</button></div>`;
  let vivo = true;
  box.querySelector('#ing-prog-cerrar').addEventListener('click', () => { vivo = false; cerrar(); });
  return {
    get cancelado(){ return !vivo; },
    progreso(txt, frac){
      if(!vivo) return;
      box.querySelector('#ing-prog-txt').textContent = txt;
      box.querySelector('#ing-barra').style.width = Math.round(Math.max(0, Math.min(1, frac)) * 100) + '%';
    },
    error(msg){
      if(!vivo) return;
      const e = box.querySelector('#ing-prog-err');
      e.textContent = msg; e.classList.add('on');
      box.querySelector('#ing-prog-cerrar').textContent = 'Cerrar';
    },
    cerrar(){ vivo = false; cerrar(); }
  };
}

// ===== Pantalla de ingreso =====
// productos: activos, con marcas(nombre,color) y categorias(por_peso)
// proveedores: [{id,nombre,activo}]
// filas: propuesta del remito [{texto, productoId, confianza, cantidad, cands, alternativas}]
// sinIdentificar: [{texto, cands}]
export function abrirIngresoStock({ productos, proveedores = [], filas = [], sinIdentificar = [], origen = 'manual', nombreArchivo = '', onListo = () => {} }){
  const { box, cerrar } = overlay();
  const byId = Object.fromEntries(productos.map(p => [String(p.id), p]));
  const etiqueta = id => { const p = byId[String(id)]; return p ? `${p.marcas ? p.marcas.nombre + ' · ' : ''}${p.nombre}${p.unidad ? ' (' + p.unidad + ')' : ''}` : ''; };
  const esRemito = origen === 'remito';

  box.innerHTML = `
    <div class="ing-head">
      <div class="ing-ico">${esRemito ? '📎' : '📦'}</div>
      <div>
        <h3>${esRemito ? 'Ingreso desde remito' : 'Ingreso de mercadería'}</h3>
        <p>${esRemito ? `Leído de «${esc(nombreArchivo)}». Revisá cada producto y cantidad antes de ingresar.` : 'Cargá lo que llegó en el camión. Se suma al stock de cada producto.'}</p>
      </div>
    </div>
    ${esRemito ? `<div class="ing-nota">${filas.length
      ? `Encontré <b>${filas.length}</b> producto${filas.length === 1 ? '' : 's'} en el remito. La lectura automática puede equivocarse: chequeá que el producto y la cantidad coincidan con lo que dice el papel (se muestra debajo de cada uno). Las filas tildadas son las que se ingresan.`
      : 'No pude identificar ningún producto en este remito. Si la foto salió movida o con poca luz, probá con otra; o agregá los productos a mano acá abajo.'}</div>` : ''}
    <div class="ing-meta">
      <label>Proveedor <small style="font-weight:400;color:var(--muted,#6B7280);">(opcional)</small>
        <select id="ing-prov"><option value="">Sin especificar</option>${proveedores.filter(p => p.activo).map(p => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}</select>
      </label>
      <label>N° de remito / referencia <small style="font-weight:400;color:var(--muted,#6B7280);">(opcional)</small>
        <input type="text" id="ing-ref" placeholder="Ej: 0001-00012345" maxlength="60">
      </label>
    </div>
    <table class="ing-tabla">
      <thead><tr><th style="width:28px;"></th><th>Producto</th><th style="width:130px;">Cantidad</th><th style="width:150px;">Vencimiento <small>(opcional)</small></th><th style="width:34px;"></th></tr></thead>
      <tbody id="ing-body"></tbody>
    </table>
    <button class="ing-add" id="ing-add">+ Agregar producto</button>
    <div id="ing-sin"></div>
    <div class="ing-aviso" id="ing-aviso"></div>
    <div class="ing-pie">
      <div class="ing-resumen" id="ing-resumen"></div>
      <button class="ing-cancel" id="ing-cancel">Cancelar</button>
      <button class="ing-ok" id="ing-ok">Ingresar al stock</button>
    </div>`;

  const body = box.querySelector('#ing-body');
  const aviso = t => { const a = box.querySelector('#ing-aviso'); a.textContent = t || ''; a.classList.toggle('on', !!t); };

  function resumen(){
    let n = 0, u = 0;
    for(const tr of body.querySelectorAll('tr')){
      if(!tr.querySelector('.ing-chk').checked) continue;
      const c = parseFloat(tr.querySelector('.ing-cant').value);
      if(tr.querySelector('.item-producto').value && c > 0){ n++; u += c; }
    }
    box.querySelector('#ing-resumen').innerHTML = n ? `Se van a ingresar <b>${n}</b> producto${n === 1 ? '' : 's'} · <b>${fmtCant(u)}</b> unidades` : 'Todavía no hay nada para ingresar.';
  }

  function addRow(f = {}){
    const tr = document.createElement('tr');
    const conf = CONF[f.productoId ? (f.confianza || 'alta') : 'ninguna'];
    const marcada = esRemito ? (!!f.productoId && (f.confianza === 'alta' || f.confianza === 'media') && f.cantidad > 0) : true;
    tr.innerHTML = `
      <td><input type="checkbox" class="ing-chk" ${marcada ? 'checked' : ''} title="Incluir en el ingreso"></td>
      <td class="ing-prod">
        <div class="ing-pp"></div>
        ${esRemito && f.texto ? `<span class="ing-badge ${conf.cls}">${conf.txt}</span><div class="ing-orig">📄 ${esc(f.texto)}</div>` : ''}
        <div class="ing-alt"></div>
      </td>
      <td><input type="number" class="ing-cant" min="0" step="1" value="${f.cantidad ?? ''}" placeholder="0"><div class="ing-chips"></div></td>
      <td><input type="date" class="ing-venc"></td>
      <td><button class="ing-x" title="Quitar">×</button></td>`;
    body.appendChild(tr);

    const picker = createProductPicker(productos);
    tr.querySelector('.ing-pp').appendChild(picker);
    if(f.productoId) picker.value = f.productoId;
    const cant = tr.querySelector('.ing-cant');
    if(f.productoId) ajustarInputCantidad(cant, byId[picker.value]);

    const pintarAlternativas = () => {
      const alt = (f.alternativas || []).filter(id => String(id) !== picker.value);
      tr.querySelector('.ing-alt').innerHTML = alt.length
        ? `<div class="ing-chips">¿Será?${alt.map(id => `<button class="ing-chip" data-id="${id}">${esc(etiqueta(id))}</button>`).join('')}</div>` : '';
    };
    const pintarCands = () => {
      const otros = (f.cands || []).filter(v => v !== parseFloat(cant.value));
      tr.querySelector('.ing-cant + .ing-chips').innerHTML = otros.length
        ? `otros números:${otros.map(v => `<button class="ing-chip" data-v="${v}">${fmtCant(v)}</button>`).join('')}` : '';
    };
    pintarAlternativas(); pintarCands();

    tr.addEventListener('click', e => {
      const a = e.target.closest('.ing-alt .ing-chip');
      if(a){ picker.value = a.dataset.id; picker.dispatchEvent(new Event('change', { bubbles: true })); return; }
      const c = e.target.closest('.ing-chips .ing-chip[data-v]');
      if(c){ cant.value = c.dataset.v; cant.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    picker.addEventListener('change', () => {
      ajustarInputCantidad(cant, byId[picker.value]);
      tr.querySelector('.ing-chk').checked = true;
      pintarAlternativas(); resumen();
      if(!cant.value) cant.focus();
    });
    cant.addEventListener('input', () => { pintarCands(); resumen(); });
    // Enter en la cantidad = fila nueva (carga rápida con teclado)
    cant.addEventListener('keydown', e => { if(e.key === 'Enter'){ e.preventDefault(); addRow(); } });
    tr.querySelector('.ing-chk').addEventListener('change', () => { tr.classList.toggle('off', !tr.querySelector('.ing-chk').checked); resumen(); });
    tr.classList.toggle('off', !marcada);
    tr.querySelector('.ing-x').addEventListener('click', () => { tr.remove(); resumen(); });

    resumen();
    if(!f.texto && !f.productoId) setTimeout(() => picker.focusInput(), 60);
    return tr;
  }

  filas.forEach(f => addRow(f));
  if(!filas.length) addRow();

  // Líneas del remito que no se pudieron asociar a ningún producto
  if(sinIdentificar.length){
    const cont = box.querySelector('#ing-sin');
    cont.innerHTML = `<details class="ing-sin"><summary>Líneas que no pude identificar (${sinIdentificar.length})</summary>
      ${sinIdentificar.map((s, i) => `<div class="ing-sin-fila" data-i="${i}"><span>${esc(s.texto)}</span><button class="ing-chip" data-i="${i}">+ Agregar como fila</button></div>`).join('')}</details>`;
    cont.addEventListener('click', e => {
      const b = e.target.closest('button[data-i]');
      if(!b) return;
      const s = sinIdentificar[Number(b.dataset.i)];
      addRow({ texto: s.texto, cantidad: s.cantidad, cands: s.cands, confianza: 'ninguna' });
      b.closest('.ing-sin-fila').remove();
    });
  }

  box.querySelector('#ing-add').addEventListener('click', () => addRow());
  box.querySelector('#ing-cancel').addEventListener('click', cerrar);

  box.querySelector('#ing-ok').addEventListener('click', async () => {
    aviso('');
    const items = [];
    for(const tr of body.querySelectorAll('tr')){
      if(!tr.querySelector('.ing-chk').checked) continue;
      const id = tr.querySelector('.item-producto').value;
      const cantidad = parseFloat(tr.querySelector('.ing-cant').value);
      if(!id){ aviso('Hay una fila tildada sin producto. Elegí el producto o destildala.'); return; }
      const p = byId[id];
      if(!(cantidad > 0)){ aviso(`Falta la cantidad de "${p.nombre}".`); return; }
      if(!cantidadEsValida(p, cantidad)){ aviso(mensajeCantidad(p)); return; }
      items.push({ producto_id: Number(id), cantidad, fecha_vencimiento: tr.querySelector('.ing-venc').value || null });
    }
    if(!items.length){ aviso('No hay nada tildado para ingresar.'); return; }

    const ok = box.querySelector('#ing-ok');
    ok.disabled = true; ok.textContent = 'Ingresando…';
    const prov = box.querySelector('#ing-prov').value;
    const { error } = await sb.rpc('registrar_ingreso_multiple', {
      p_items: items,
      p_proveedor_id: prov ? Number(prov) : null,
      p_referencia: box.querySelector('#ing-ref').value.trim() || null
    });
    ok.disabled = false; ok.textContent = 'Ingresar al stock';
    if(error){ aviso('No se pudo ingresar (no se cargó nada): ' + error.message); return; }

    const unidades = items.reduce((s, i) => s + i.cantidad, 0);
    box.style.width = '560px';
    box.innerHTML = `
      <div class="ing-head"><div class="ing-ico" style="background:var(--green,#2BB673);">✅</div>
        <div><h3>Stock actualizado</h3><p>${items.length} producto${items.length === 1 ? '' : 's'} · ${fmtCant(unidades)} unidades sumadas</p></div></div>
      <ul class="ing-listo">${items.map(i => `<li><span>${esc(etiqueta(i.producto_id))}</span><b>+${fmtCant(i.cantidad)}</b></li>`).join('')}</ul>
      <div class="ing-pie"><span class="ing-resumen"></span><button class="ing-ok" id="ing-fin">Listo</button></div>`;
    box.querySelector('#ing-fin').addEventListener('click', cerrar);
    onListo();
  });
}
