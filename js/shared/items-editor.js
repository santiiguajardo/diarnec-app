// Tabla editable de items (producto con buscador, cantidad, precio, subtotal y, si se pide,
// el neto después de la comisión del vendedor). La usa el Historial para modificar ventas y
// devoluciones. Se monta dentro de un contenedor y devuelve la API para leer/recalcular.

import { createProductPicker } from './product-picker.js';
import { money } from './format.js';
import { ajustarInputCantidad, cantidadEsValida, mensajeCantidad } from './cantidad.js';

// productos: [{ id, nombre, unidad, precio_venta, marcas:{nombre,color} }]
// comision:  null (sin columna de neto) o (productoId) => % de comisión del vendedor actual
// onChange:  ({ total, comision }) => void — se llama en cada cambio
export function mountItemsEditor(container, { productos, comision = null, onChange = () => {} }){
  const byId = Object.fromEntries(productos.map(p => [p.id, p]));
  const conNeto = typeof comision === 'function';

  container.innerHTML = `
    <table class="ie-table">
      <thead><tr>
        <th>Producto</th><th>Cant.</th><th>Precio</th><th>Subtotal</th>
        ${conNeto ? '<th title="Subtotal menos la comisión del vendedor">Neto (- comisión)</th>' : ''}
        <th></th>
      </tr></thead>
      <tbody></tbody>
    </table>
    <button type="button" class="ie-add">+ Agregar producto</button>`;
  const tbody = container.querySelector('tbody');

  const num = (tr, sel) => parseFloat(tr.querySelector(sel).value) || 0;

  function totals(){
    let total = 0, com = 0;
    tbody.querySelectorAll('tr').forEach(tr => {
      const sub = num(tr, '.ie-cant') * num(tr, '.ie-precio');
      total += sub;
      if(conNeto) com += sub * (comision(tr.querySelector('.item-producto').value) || 0) / 100;
    });
    return { total, comision: com };
  }

  function recalcFila(tr){
    const sub = num(tr, '.ie-cant') * num(tr, '.ie-precio');
    tr.querySelector('.ie-sub').textContent = money(sub);
    if(conNeto){
      const pct = comision(tr.querySelector('.item-producto').value) || 0;
      tr.querySelector('.ie-neto').innerHTML = `${money(sub - sub * pct / 100)}<small>comisión ${pct}%</small>`;
    }
  }

  function recalc(){
    tbody.querySelectorAll('tr').forEach(recalcFila);
    onChange(totals());
  }

  // item: { producto_id, cantidad, precio_unitario } (vacío = fila nueva)
  function addRow(item = null){
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td class="pp-cell"></td>
      <td><input type="number" step="1" min="1" class="ie-cant" value="${item ? Number(item.cantidad) : 1}"></td>
      <td><input type="number" step="0.01" min="0" class="ie-precio" value="${item ? Number(item.precio_unitario).toFixed(2) : ''}"></td>
      <td class="ie-sub">$0,00</td>
      ${conNeto ? '<td class="ie-neto">$0,00</td>' : ''}
      <td><button type="button" class="ie-del" title="Quitar">×</button></td>`;
    tbody.appendChild(tr);

    const picker = createProductPicker(productos);
    tr.querySelector('.pp-cell').appendChild(picker);
    if(item){ picker.value = item.producto_id; ajustarInputCantidad(tr.querySelector('.ie-cant'), byId[picker.value]); }

    // Al elegir un producto se carga su precio de venta (editable después).
    picker.addEventListener('change', () => {
      const p = byId[picker.value];
      if(p) tr.querySelector('.ie-precio').value = Number(p.precio_venta).toFixed(2);
      ajustarInputCantidad(tr.querySelector('.ie-cant'), p);
      recalc();
      tr.querySelector('.ie-cant').select();
    });
    tr.querySelector('.ie-cant').addEventListener('input', recalc);
    tr.querySelector('.ie-precio').addEventListener('input', recalc);
    tr.querySelector('.ie-del').addEventListener('click', () => { tr.remove(); recalc(); });

    recalc();
    if(!item) setTimeout(() => picker.focusInput(), 60);
  }

  container.querySelector('.ie-add').addEventListener('click', () => addRow());

  // null si alguna fila está incompleta o inválida (el llamador muestra el error)
  function getItems(){
    const items = [];
    for(const tr of tbody.querySelectorAll('tr')){
      const producto_id = Number(tr.querySelector('.item-producto').value);
      const cantidad = parseFloat(tr.querySelector('.ie-cant').value);
      const precio_unitario = parseFloat(tr.querySelector('.ie-precio').value);
      if(!producto_id || !cantidad || cantidad <= 0 || isNaN(precio_unitario) || precio_unitario < 0) return null;
      items.push({ producto_id, cantidad, precio_unitario });
    }
    return items;
  }

  // Mensaje del primer problema que tenga la tabla (vacío si está todo bien)
  function error(){
    const filas = tbody.querySelectorAll('tr');
    if(filas.length === 0) return 'Cargá al menos un producto con cantidad y precio válidos.';
    for(const tr of filas){
      const id = Number(tr.querySelector('.item-producto').value);
      const p = byId[id]; // puede faltar si el producto quedó dado de baja: se exige entero igual
      const cantidad = parseFloat(tr.querySelector('.ie-cant').value);
      const precio = parseFloat(tr.querySelector('.ie-precio').value);
      if(!id || !cantidad || cantidad <= 0 || isNaN(precio) || precio < 0) return 'Cargá al menos un producto con cantidad y precio válidos.';
      if(!cantidadEsValida(p, cantidad)) return mensajeCantidad(p);
    }
    return '';
  }

  return { addRow, getItems, recalc, totals, error };
}
