import { sb } from '../shared/supabase-client.js';
import { requireAuth } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { money } from '../shared/format.js';
import { confirmDialog, promptDialog } from '../shared/dialogs.js';
import { esPorPeso, cantidadEsValida, mensajeCantidad } from '../shared/cantidad.js';
import { abrirIngresoStock, abrirLectura } from '../shared/ingreso-stock.js';
import { leerArchivo, interpretarRemito } from '../shared/remito-ocr.js';

let productos = [];
let marcas = [];
let categorias = [];
let filtroMarca = '';
let filtroTexto = '';
let orden = 'nombre';
let mostrarInactivos = false;
let imagenProductoId = null;
let proveedores = [];

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

(async function init(){
  if(!(await requireAuth())) return;
  const content = await mountLayout('inventario', 'Inventario y precios');

  content.innerHTML = `
    <div class="stats-bar">
      <div><span>Total Artículos:</span><b id="stat-total">0</b></div>
      <div><span>Capital en Stock (Costo):</span><b id="stat-capital">$0</b></div>
    </div>

    <div class="admin-section inv-ingreso">
      <div class="inv-ingreso-txt">
        <h3>📦 Ingreso de mercadería</h3>
        <p>Cuando llega el camión: sumá el stock a mano, o subí la foto o el PDF del remito y los productos se cargan solos.</p>
      </div>
      <div class="inv-ingreso-btns">
        <button class="btn-sm btn-ingreso" id="btn-stock-manual">➕ Agregar stock manualmente</button>
        <button class="btn-sm btn-remito" id="btn-remito">📎 Adjuntar remito</button>
        <input type="file" id="remito-file" accept="image/*,application/pdf" hidden>
      </div>
    </div>

    <div class="admin-section">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;margin-bottom:12px;">
        <h3 style="margin:0;">Agregar producto nuevo</h3>
        <div class="inv-actions" style="margin:0;">
          <button class="btn-sm btn-green" id="btn-marcas">+ Agregar marca</button>
          <button class="btn-sm btn-green" id="btn-categorias">+ Agregar categoría</button>
        </div>
      </div>
      <div class="form-row">
        <select id="np-marca"></select>
        <input type="text" id="np-nombre" placeholder="Artículo">
        <input type="text" id="np-unidad" placeholder="Presentación (ej: 500g)">
        <select id="np-categoria"></select>
        <input type="text" id="np-sku" placeholder="SKU (opcional)">
        <button class="btn-sm btn-add" id="np-submit">Agregar</button>
      </div>
      <div class="form-row" style="grid-template-columns:1fr 1fr 1fr;">
        <input type="number" step="0.01" id="np-costo" placeholder="Costo $">
        <input type="number" step="0.01" id="np-precio" placeholder="Precio de venta $">
        <input type="text" id="np-imagen" placeholder="Imagen (URL, opcional)">
      </div>
    </div>

    <div class="admin-section">
      <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px;">
        <h3 style="margin:0;">Inventario</h3>
        <div class="inv-actions">
          <button class="btn-sm btn-yellow" id="btn-masiva">✏️ Act. Masiva (%)</button>
          <button class="btn-sm btn-orange" id="btn-pdf">📄 Lista a PDF</button>
        </div>
      </div>
      <div class="inv-toolbar">
        <input type="text" id="f-texto" placeholder="Buscar artículo...">
        <select id="f-marca"><option value="">Todas las marcas</option></select>
        <label>Ordenar por
          <select id="f-orden">
            <option value="nombre">Artículo (A → Z)</option>
            <option value="marca">Marca, y dentro el artículo</option>
            <option value="categoria">Categoría, marca y artículo</option>
            <option value="stock_asc">Stock: menos primero</option>
            <option value="stock_desc">Stock: más primero</option>
            <option value="precio_asc">Precio: menor a mayor</option>
            <option value="precio_desc">Precio: mayor a menor</option>
            <option value="costo_asc">Costo: menor a mayor</option>
            <option value="costo_desc">Costo: mayor a menor</option>
            <option value="margen_desc">Margen: mayor a menor</option>
            <option value="margen_asc">Margen: menor a mayor</option>
            <option value="recientes">Últimos agregados primero</option>
          </select>
        </label>
        <label><input type="checkbox" id="f-inactivos"> Mostrar dados de baja</label>
      </div>
      <table class="inv">
        <thead><tr>
          <th></th><th>Categoría</th><th>Marca</th><th>Artículo</th><th>Unidad</th><th>Costo</th><th>Margen %</th><th>Precio</th><th>Stock</th><th></th>
        </tr></thead>
        <tbody id="inv-body"></tbody>
      </table>
    </div>
  `;

  document.getElementById('f-texto').addEventListener('input', e => { filtroTexto = e.target.value.trim().toLowerCase(); renderTabla(); });
  document.getElementById('f-marca').addEventListener('change', e => { filtroMarca = e.target.value; renderTabla(); });
  document.getElementById('f-inactivos').addEventListener('change', e => { mostrarInactivos = e.target.checked; renderTabla(); });

  // Orden de la lista: se recuerda entre visitas
  try { orden = localStorage.getItem('diarnec_inv_orden') || 'nombre'; } catch(e){ /* sin almacenamiento: queda el orden por defecto */ }
  const selOrden = document.getElementById('f-orden');
  if(![...selOrden.options].some(o => o.value === orden)) orden = 'nombre';
  selOrden.value = orden;
  selOrden.addEventListener('change', e => {
    orden = e.target.value;
    try { localStorage.setItem('diarnec_inv_orden', orden); } catch(err){ /* no pasa nada */ }
    renderTabla();
  });

  // Ingreso de mercadería
  document.getElementById('btn-stock-manual').addEventListener('click', () => abrirIngreso('manual'));
  document.getElementById('btn-remito').addEventListener('click', () => document.getElementById('remito-file').click());
  document.getElementById('remito-file').addEventListener('change', e => {
    const f = e.target.files[0];
    e.target.value = '';           // permite volver a elegir el mismo archivo
    if(f) adjuntarRemito(f);
  });
  document.getElementById('np-submit').addEventListener('click', agregarProducto);
  document.getElementById('btn-masiva').addEventListener('click', abrirMasiva);
  document.getElementById('btn-pdf').addEventListener('click', () => toggleModal('modal-pdf', true));
  document.getElementById('masiva-cancel').addEventListener('click', () => toggleModal('modal-masiva', false));
  document.getElementById('masiva-confirm').addEventListener('click', aplicarMasiva);
  document.getElementById('pdf-cancel').addEventListener('click', () => toggleModal('modal-pdf', false));
  document.getElementById('pdf-color').addEventListener('click', () => exportarPDF('color'));
  document.getElementById('pdf-bn').addEventListener('click', () => exportarPDF('bn'));
  document.getElementById('imagen-cancel').addEventListener('click', () => toggleModal('modal-imagen', false));
  document.getElementById('imagen-guardar').addEventListener('click', guardarImagen);
  document.getElementById('imagen-url').addEventListener('input', actualizarPreviewImagen);

  // Administrar marcas y categorías
  document.getElementById('btn-marcas').addEventListener('click', () => { document.getElementById('mk-msg').textContent = ''; toggleModal('modal-marcas', true); });
  document.getElementById('btn-categorias').addEventListener('click', () => { document.getElementById('ct-msg').textContent = ''; toggleModal('modal-categorias', true); });
  document.getElementById('mk-cerrar').addEventListener('click', () => toggleModal('modal-marcas', false));
  document.getElementById('ct-cerrar').addEventListener('click', () => toggleModal('modal-categorias', false));
  document.getElementById('mk-add').addEventListener('click', agregarMarca);
  document.getElementById('ct-add').addEventListener('click', agregarCategoria);
  document.getElementById('mk-nombre').addEventListener('keydown', e => { if(e.key === 'Enter') agregarMarca(); });
  document.getElementById('ct-nombre').addEventListener('keydown', e => { if(e.key === 'Enter') agregarCategoria(); });

  await cargarTodo();
})();

function toggleModal(id, open){
  document.getElementById(id).classList.toggle('open', open);
}

async function cargarTodo(){
  const [{ data: mk }, { data: cat }, { data: prod }, { data: prv }] = await Promise.all([
    sb.from('marcas').select('id, nombre, color, proveedor_id').order('nombre'),
    sb.from('categorias').select('id, nombre, color, por_peso').order('nombre'),
    sb.from('productos').select('id, nombre, unidad, sku, precio_compra, precio_venta, stock_actual, stock_minimo, activo, imagen_url, marcas(nombre, color), categorias(nombre, por_peso)').order('nombre'),
    sb.from('proveedores').select('id, nombre, activo').order('nombre')
  ]);
  proveedores = prv || [];
  marcas = mk || [];
  categorias = cat || [];
  productos = prod || [];

  document.getElementById('np-marca').innerHTML = marcas.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
  document.getElementById('np-categoria').innerHTML = categorias.map(c => `<option value="${c.id}">${c.nombre}</option>`).join('');
  document.getElementById('f-marca').innerHTML = `<option value="">Todas las marcas</option>` + marcas.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');
  document.getElementById('masiva-marca').innerHTML = `<option value="">Todas las marcas</option>` + marcas.map(m => `<option value="${m.id}">${m.nombre}</option>`).join('');

  renderTabla();
  renderMarcas();
  renderCategorias();
}

// ===== Administrar marcas =====

const opcionesProveedor = (actual) => `<option value="">Sin proveedor</option>` +
  proveedores.filter(p => p.activo || p.id === actual).map(p => `<option value="${p.id}" ${p.id === actual ? 'selected' : ''}>${esc(p.nombre)}</option>`).join('');

function renderMarcas(){
  document.getElementById('mk-prov').innerHTML = opcionesProveedor(null);
  const tbody = document.getElementById('mk-body');
  tbody.innerHTML = marcas.length === 0
    ? '<tr><td class="empty-row">Todavía no hay marcas.</td></tr>'
    : marcas.map(m => `
      <tr>
        <td><input type="text" value="${esc(m.nombre)}" onchange="window.mkEditar(${m.id}, 'nombre', this)"></td>
        <td style="width:52px;"><input type="color" class="adm-color" value="${esc(m.color || '#e4e2da')}" onchange="window.mkEditar(${m.id}, 'color', this)"></td>
        <td><select onchange="window.mkEditar(${m.id}, 'proveedor_id', this)">${opcionesProveedor(m.proveedor_id)}</select></td>
        <td style="width:84px;text-align:right;"><button class="btn-sm btn-del" onclick="window.mkBorrar(${m.id})">Eliminar</button></td>
      </tr>`).join('');
}

function avisoMarcas(texto){ document.getElementById('mk-msg').textContent = texto || ''; }

async function agregarMarca(){
  const nombre = document.getElementById('mk-nombre').value.trim();
  const color = document.getElementById('mk-color').value;
  const proveedor_id = document.getElementById('mk-prov').value;
  avisoMarcas('');
  if(!nombre){ avisoMarcas('Escribí el nombre de la marca.'); return; }
  const { error } = await sb.from('marcas').insert({ nombre, color, proveedor_id: proveedor_id ? Number(proveedor_id) : null });
  if(error){ avisoMarcas(error.code === '23505' ? `Ya existe una marca llamada "${nombre}".` : 'No se pudo agregar: ' + error.message); return; }
  document.getElementById('mk-nombre').value = '';
  await cargarTodo();
}

// Guarda al salir del campo (nombre, color o proveedor)
async function mkEditar(id, campo, input){
  avisoMarcas('');
  let valor = input.value;
  if(campo === 'nombre'){
    valor = valor.trim();
    if(!valor){ avisoMarcas('El nombre no puede quedar vacío.'); await cargarTodo(); return; }
  }
  if(campo === 'proveedor_id') valor = valor ? Number(valor) : null;
  const { error } = await sb.from('marcas').update({ [campo]: valor }).eq('id', id);
  if(error){
    avisoMarcas(error.code === '23505' ? `Ya existe una marca llamada "${valor}".` : 'No se pudo guardar: ' + error.message);
    await cargarTodo();
    return;
  }
  const m = marcas.find(m => m.id === id);
  if(m) m[campo] = valor;
  input.classList.add('saved');
  setTimeout(() => input.classList.remove('saved'), 1200);
  if(campo !== 'proveedor_id') await cargarTodo(); // refresca selects y colores de la tabla
}

async function mkBorrar(id){
  const m = marcas.find(m => m.id === id);
  avisoMarcas('');
  const { count } = await sb.from('productos').select('id', { count: 'exact', head: true }).eq('marca_id', id);
  if(count > 0){
    avisoMarcas(`No se puede eliminar "${m.nombre}": tiene ${count} producto${count === 1 ? '' : 's'}. Cambiales la marca (o eliminalos) primero.`);
    return;
  }
  if(!(await confirmDialog(`¿Eliminar la marca "${m.nombre}"?\nTambién se borran las comisiones cargadas para esta marca.`, { confirmLabel: 'Eliminar' }))) return;
  await sb.from('comisiones_vendedor_marca').delete().eq('marca_id', id);
  const { error } = await sb.from('marcas').delete().eq('id', id);
  if(error){ avisoMarcas('No se pudo eliminar: ' + error.message); return; }
  await cargarTodo();
}

// ===== Administrar categorías =====

function renderCategorias(){
  const tbody = document.getElementById('ct-body');
  tbody.innerHTML = categorias.length === 0
    ? '<tr><td class="empty-row">Todavía no hay categorías.</td></tr>'
    : categorias.map(c => `
      <tr>
        <td><input type="text" value="${esc(c.nombre)}" onchange="window.ctEditar(${c.id}, 'nombre', this)"></td>
        <td style="width:52px;"><input type="color" class="adm-color" value="${esc(c.color || '#2BB673')}" onchange="window.ctEditar(${c.id}, 'color', this)"></td>
        <td style="width:90px;"><label class="chk"><input type="checkbox" ${c.por_peso ? 'checked' : ''} onchange="window.ctEditar(${c.id}, 'por_peso', this)"> Por peso</label></td>
        <td style="width:84px;text-align:right;"><button class="btn-sm btn-del" onclick="window.ctBorrar(${c.id})">Eliminar</button></td>
      </tr>`).join('');
}

function avisoCategorias(texto){ document.getElementById('ct-msg').textContent = texto || ''; }

async function agregarCategoria(){
  const nombre = document.getElementById('ct-nombre').value.trim();
  const color = document.getElementById('ct-color').value;
  const por_peso = document.getElementById('ct-peso').checked;
  avisoCategorias('');
  if(!nombre){ avisoCategorias('Escribí el nombre de la categoría.'); return; }
  const { error } = await sb.from('categorias').insert({ nombre, color, por_peso });
  if(error){ avisoCategorias(error.code === '23505' ? `Ya existe una categoría llamada "${nombre}".` : 'No se pudo agregar: ' + error.message); return; }
  document.getElementById('ct-nombre').value = '';
  document.getElementById('ct-peso').checked = false;
  await cargarTodo();
}

async function ctEditar(id, campo, input){
  avisoCategorias('');
  let valor = campo === 'por_peso' ? input.checked : input.value;
  if(campo === 'nombre'){
    valor = valor.trim();
    if(!valor){ avisoCategorias('El nombre no puede quedar vacío.'); await cargarTodo(); return; }
  }
  const { error } = await sb.from('categorias').update({ [campo]: valor }).eq('id', id);
  if(error){
    avisoCategorias(error.code === '23505' ? `Ya existe una categoría llamada "${valor}".` : 'No se pudo guardar: ' + error.message);
    await cargarTodo();
    return;
  }
  input.classList.add('saved');
  setTimeout(() => input.classList.remove('saved'), 1200);
  await cargarTodo();
}

async function ctBorrar(id){
  const c = categorias.find(c => c.id === id);
  avisoCategorias('');
  const { count } = await sb.from('productos').select('id', { count: 'exact', head: true }).eq('categoria_id', id);
  if(count > 0){
    avisoCategorias(`No se puede eliminar "${c.nombre}": tiene ${count} producto${count === 1 ? '' : 's'}. Cambiales la categoría (o eliminalos) primero.`);
    return;
  }
  if(!(await confirmDialog(`¿Eliminar la categoría "${c.nombre}"?`, { confirmLabel: 'Eliminar' }))) return;
  const { error } = await sb.from('categorias').delete().eq('id', id);
  if(error){ avisoCategorias('No se pudo eliminar: ' + error.message); return; }
  await cargarTodo();
}

function margenPct(costo, venta){
  costo = Number(costo); venta = Number(venta);
  if(!costo) return null;
  return ((venta - costo) / costo) * 100;
}

function listaFiltrada(){
  let list = productos.filter(p => mostrarInactivos ? true : p.activo);
  if(filtroTexto) list = list.filter(p => p.nombre.toLowerCase().includes(filtroTexto));
  if(filtroMarca){
    const marcaNombre = (marcas.find(m => String(m.id) === filtroMarca) || {}).nombre;
    list = list.filter(p => (p.marcas ? p.marcas.nombre : '') === marcaNombre);
  }
  return ordenar(list);
}

const cmp = (a, b) => String(a).localeCompare(String(b), 'es', { sensitivity: 'base' });
const nombreMarca = p => p.marcas ? p.marcas.nombre : '';
const nombreCat = p => p.categorias ? p.categorias.nombre : '';
const margenDe = p => { const m = margenPct(p.precio_compra, p.precio_venta); return m === null ? -Infinity : m; };

// Se ordena una copia según lo elegido (desempate: nombre del artículo)
function ordenar(list){
  const porMarca = (a, b) => cmp(nombreMarca(a), nombreMarca(b)) || cmp(a.nombre, b.nombre);
  const num = (f, dir) => (a, b) => (dir * (f(a) - f(b))) || cmp(a.nombre, b.nombre);
  const criterios = {
    nombre: (a, b) => cmp(a.nombre, b.nombre) || cmp(nombreMarca(a), nombreMarca(b)),
    marca: porMarca,
    categoria: (a, b) => cmp(nombreCat(a), nombreCat(b)) || porMarca(a, b),
    stock_asc: num(p => Number(p.stock_actual), 1),
    stock_desc: num(p => Number(p.stock_actual), -1),
    precio_asc: num(p => Number(p.precio_venta), 1),
    precio_desc: num(p => Number(p.precio_venta), -1),
    costo_asc: num(p => Number(p.precio_compra), 1),
    costo_desc: num(p => Number(p.precio_compra), -1),
    margen_desc: (a, b) => (margenDe(b) - margenDe(a)) || cmp(a.nombre, b.nombre),
    margen_asc: (a, b) => (margenDe(a) - margenDe(b)) || cmp(a.nombre, b.nombre),
    recientes: (a, b) => b.id - a.id
  };
  return [...list].sort(criterios[orden] || criterios.nombre);
}

function renderTabla(){
  const tbody = document.getElementById('inv-body');
  const list = listaFiltrada();

  document.getElementById('stat-total').textContent = list.length;
  const capital = list.reduce((s,p) => s + Number(p.precio_compra) * Number(p.stock_actual), 0);
  document.getElementById('stat-capital').textContent = money(capital);

  if(list.length === 0){
    tbody.innerHTML = `<tr><td colspan="10" class="empty-row">No hay productos que coincidan.</td></tr>`;
    return;
  }

  tbody.innerHTML = list.map(p => {
    const m = margenPct(p.precio_compra, p.precio_venta);
    const margenTxt = m === null ? '—' : `${m.toFixed(1)}%`;
    const margenClass = m !== null && m < 15 ? 'margen low' : 'margen';
    const bajoStock = Number(p.stock_actual) <= Number(p.stock_minimo || 0);
    const color = p.marcas ? p.marcas.color : '#ffffff';
    const rowStyle = `background:${color};color:#1A1A1A;` + (p.activo ? '' : 'opacity:.45;');
    return `
      <tr style="${rowStyle}">
        <td>
          <button class="thumb-btn" onclick="window.invImagen(${p.id})" title="Cambiar foto">
            ${p.imagen_url ? `<img src="${p.imagen_url}" alt="">` : '📷'}
          </button>
        </td>
        <td>${p.categorias ? p.categorias.nombre : ''}</td>
        <td>${p.marcas ? p.marcas.nombre : ''}</td>
        <td class="wrap"><b>${p.nombre}</b></td>
        <td>${p.unidad || ''}</td>
        <td><input class="cell-input" type="number" step="0.01" value="${p.precio_compra}" onchange="window.invUpdate(${p.id},'precio_compra',this.value)"></td>
        <td><span class="${margenClass}">${margenTxt}</span></td>
        <td><input class="cell-input" type="number" step="0.01" value="${p.precio_venta}" onchange="window.invUpdate(${p.id},'precio_venta',this.value)"></td>
        <td>
          <span class="cant-badge">
            <b style="${bajoStock ? 'color:#C0392B;font-weight:700;' : ''}">${Number(p.stock_actual)}</b>
            <button class="btn-sm" onclick="window.invIngreso(${p.id})">+ stock</button>
          </span>
        </td>
        <td><button class="btn-sm ${p.activo ? 'btn-del' : 'btn-add'}" onclick="window.invToggleActivo(${p.id},${p.activo})">${p.activo ? 'Dar de baja' : 'Reactivar'}</button></td>
      </tr>`;
  }).join('');
}

async function agregarProducto(){
  const marca_id = Number(document.getElementById('np-marca').value);
  const categoria_id = Number(document.getElementById('np-categoria').value);
  const nombre = document.getElementById('np-nombre').value.trim();
  const unidad = document.getElementById('np-unidad').value.trim();
  const sku = document.getElementById('np-sku').value.trim();
  const precio_compra = parseFloat(document.getElementById('np-costo').value) || 0;
  const precio_venta = parseFloat(document.getElementById('np-precio').value);
  const imagen_url = document.getElementById('np-imagen').value.trim();

  if(!marca_id || !categoria_id || !nombre || isNaN(precio_venta) || precio_venta <= 0){
    alert('Completá marca, categoría, artículo y un precio de venta válido.');
    return;
  }

  const { error } = await sb.from('productos').insert({
    marca_id, categoria_id, nombre, unidad, sku: sku || null, precio_compra, precio_venta, imagen_url
  });
  if(error){ alert('No se pudo agregar: ' + error.message); return; }

  ['np-nombre','np-unidad','np-sku','np-costo','np-precio','np-imagen'].forEach(id => document.getElementById(id).value = '');
  await cargarTodo();
}

// ===== Ingreso de mercadería (a mano o desde remito) =====

const productosActivos = () => productos.filter(p => p.activo);

function abrirIngreso(origen, extra = {}){
  abrirIngresoStock({ productos: productosActivos(), proveedores, origen, onListo: cargarTodo, ...extra });
}

async function adjuntarRemito(file){
  const lectura = abrirLectura(file.name);
  try {
    const { lineas } = await leerArchivo(file, lectura.progreso);
    if(lectura.cancelado) return;
    const { filas, sinIdentificar } = interpretarRemito(lineas, productosActivos());
    lectura.cerrar();
    abrirIngreso('remito', { filas, sinIdentificar, nombreArchivo: file.name });
  } catch(err){
    console.error(err);
    lectura.error(err && err.message ? err.message : 'No se pudo leer el remito.');
  }
}

async function invUpdate(id, field, value){
  const num = parseFloat(value);
  if(isNaN(num) || num < 0){ alert('Valor inválido.'); await cargarTodo(); return; }
  const p = productos.find(p => p.id === id);
  if(p) p[field] = num;
  renderTabla();
  const { error } = await sb.from('productos').update({ [field]: num }).eq('id', id);
  if(error){ alert('No se pudo guardar: ' + error.message); await cargarTodo(); }
}

async function invIngreso(id){
  const p = productos.find(p => p.id === id);
  const cantidad = await promptDialog(`Ingreso de stock — ${p ? p.nombre : ''}\n\n${esPorPeso(p) ? '¿Cuántos kg entran?' : '¿Cuántas unidades entran? (número entero)'}`);
  if(cantidad === null) return;
  const num = parseFloat(String(cantidad).replace(',', '.'));
  if(isNaN(num) || num <= 0){ alert('Cantidad inválida.'); return; }
  if(!cantidadEsValida(p, num)){ alert(mensajeCantidad(p)); return; }

  const { error } = await sb.rpc('registrar_ingreso_stock', {
    p_producto_id: id, p_lote: null, p_fecha_vencimiento: null,
    p_cantidad: num, p_costo_unitario: p ? p.precio_compra : 0, p_proveedor_id: null
  });
  if(error){ alert('No se pudo registrar el ingreso: ' + error.message); return; }
  await cargarTodo();
}

async function invToggleActivo(id, estabaActivo){
  const { error } = await sb.from('productos').update({ activo: !estabaActivo }).eq('id', id);
  if(error){ alert('No se pudo actualizar: ' + error.message); return; }
  await cargarTodo();
}

function invImagen(id){
  const p = productos.find(p => p.id === id);
  if(!p) return;
  imagenProductoId = id;
  document.getElementById('imagen-producto-nombre').textContent = p.nombre;
  document.getElementById('imagen-url').value = p.imagen_url || '';
  actualizarPreviewImagen();
  toggleModal('modal-imagen', true);
}

function actualizarPreviewImagen(){
  const url = document.getElementById('imagen-url').value.trim();
  const preview = document.getElementById('imagen-preview');
  preview.innerHTML = url ? `<img src="${url}" alt="" onerror="this.parentElement.textContent='No se pudo cargar la imagen'">` : 'Sin imagen';
}

async function guardarImagen(){
  if(!imagenProductoId) return;
  const imagen_url = document.getElementById('imagen-url').value.trim();
  const { error } = await sb.from('productos').update({ imagen_url }).eq('id', imagenProductoId);
  if(error){ alert('No se pudo guardar: ' + error.message); return; }
  toggleModal('modal-imagen', false);
  await cargarTodo();
}

function abrirMasiva(){
  document.getElementById('masiva-pct').value = '';
  toggleModal('modal-masiva', true);
}

async function aplicarMasiva(){
  const marcaId = document.getElementById('masiva-marca').value;
  const pct = parseFloat(document.getElementById('masiva-pct').value);
  const scope = document.getElementById('masiva-scope').value;

  if(isNaN(pct) || pct === 0){ alert('Ingresá un porcentaje distinto de 0.'); return; }

  const marcaNombre = marcaId ? (marcas.find(m => String(m.id) === marcaId) || {}).nombre : 'TODAS LAS MARCAS';
  const campos = scope === 'ambos' ? 'costo y precio de venta' : scope === 'precio' ? 'precio de venta' : 'costo';
  if(!(await confirmDialog(`¿Aplicar ${pct}% a ${campos} de ${marcaNombre}?\n\nEsto afecta a todos los productos que coincidan.`))) return;

  const factor = 1 + pct / 100;
  const afectados = productos.filter(p => !marcaId || (p.marcas && marcas.find(m => String(m.id) === marcaId && m.nombre === p.marcas.nombre)));

  let errores = 0;
  for(const p of afectados){
    const patch = {};
    if(scope === 'ambos' || scope === 'costo') patch.precio_compra = Math.round(Number(p.precio_compra) * factor * 100) / 100;
    if(scope === 'ambos' || scope === 'precio') patch.precio_venta = Math.round(Number(p.precio_venta) * factor * 100) / 100;
    const { error } = await sb.from('productos').update(patch).eq('id', p.id);
    if(error) errores++;
  }

  toggleModal('modal-masiva', false);
  if(errores) alert(`Se aplicó, pero ${errores} producto(s) no se pudieron actualizar.`);
  await cargarTodo();
}

function loadImageAsDataURL(url){
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width; canvas.height = img.height;
      canvas.getContext('2d').drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/png'));
    };
    img.onerror = reject;
    img.src = url;
  });
}

async function exportarPDF(modo){
  toggleModal('modal-pdf', false);
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

  const fecha = new Date().toLocaleDateString('es-AR');

  try {
    const logo = await loadImageAsDataURL('../img/logo.png');
    doc.addImage(logo, 'PNG', 14, 8, 22, 22);
  } catch(e){ /* si no carga el logo, seguimos sin él */ }

  doc.setTextColor(0,0,0);
  doc.setFont(undefined, 'bold');
  doc.setFontSize(17);
  doc.text('Lista de Precios Oficial - DIARNEC', 105, 16, { align: 'center' });
  doc.setFont(undefined, 'italic');
  doc.setFontSize(10);
  doc.text(`Actualizado al: ${fecha}`, 105, 23, { align: 'center' });
  doc.setFont(undefined, 'normal');

  const list = [...productos].filter(p => p.activo).sort((a,b) => {
    const ca = a.categorias ? a.categorias.nombre : '', cb = b.categorias ? b.categorias.nombre : '';
    if(ca !== cb) return ca.localeCompare(cb);
    const ma = a.marcas ? a.marcas.nombre : '', mb = b.marcas ? b.marcas.nombre : '';
    if(ma !== mb) return ma.localeCompare(mb);
    return a.nombre.localeCompare(b.nombre);
  });

  const body = list.map(p => [
    p.categorias ? p.categorias.nombre : '',
    p.marcas ? p.marcas.nombre : '',
    p.nombre,
    p.unidad || '',
    money(p.precio_venta)
  ]);

  doc.autoTable({
    startY: 32,
    head: [['CATEGORIA', 'MARCA', 'ARTICULO', 'UNIDAD', 'PRECIO']],
    body,
    styles: { fontSize: 8, cellPadding: 2.2, fontStyle: 'bold', textColor: [0,0,0] },
    headStyles: modo === 'color'
      ? { fillColor: [18,36,54], textColor: 255 }
      : { fillColor: [230,230,230], textColor: 0 },
    didParseCell: (data) => {
      if(data.section === 'body' && modo === 'color'){
        const row = list[data.row.index];
        const color = row.marcas ? row.marcas.color : '#ffffff';
        data.cell.styles.fillColor = [parseInt(color.slice(1,3),16), parseInt(color.slice(3,5),16), parseInt(color.slice(5,7),16)];
      }
    }
  });

  const sufijo = modo === 'color' ? 'Color' : 'Impresion';
  doc.save(`${fecha.replace(/\//g,'-')}_Lista_DIARNEC_${sufijo}.pdf`);
}

Object.assign(window, { invUpdate, invIngreso, invToggleActivo, invImagen, mkEditar, mkBorrar, ctEditar, ctBorrar });
