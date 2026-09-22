// Regla de cantidades: todo se maneja por unidad (1, 2, 3...), salvo las categorías por peso
// (Fiambres y Quesos, categorias.por_peso), que admiten decimales (ej: 0,5 kg).
// Los productos se cargan con categorias(por_peso) en el select.

export const esPorPeso = p => !!(p && p.categorias && p.categorias.por_peso);

// Atributos del <input type="number"> de cantidad según el producto
export const stepCantidad = p => esPorPeso(p) ? '0.001' : '1';

export const cantidadEsValida = (p, cant) =>
  Number.isFinite(cant) && cant > 0 && (esPorPeso(p) || Number.isInteger(cant));

export const mensajeCantidad = p =>
  `La cantidad de "${p ? p.nombre : 'este producto'}" tiene que ser un número entero (solo fiambres y quesos se manejan por peso).`;

// Deja el input de cantidad acorde al producto: paso entero o decimal, y si el producto no es
// por peso y la cantidad tenía decimales la redondea (mínimo 1).
export function ajustarInputCantidad(input, p){
  input.step = stepCantidad(p);
  input.min = esPorPeso(p) ? '0' : '1';
  const v = parseFloat(input.value);
  if(p && !esPorPeso(p) && Number.isFinite(v) && !Number.isInteger(v)) input.value = Math.max(1, Math.round(v));
}
