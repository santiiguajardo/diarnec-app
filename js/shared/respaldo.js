import { sb } from './supabase-client.js';

// Copia de seguridad en Excel: un solo archivo .xlsx con una hoja por tabla del sistema (ventas, pagos, stock,
// clientes, etc.), con los nombres al lado de los números internos (vendedor, cliente, producto...).
// Solo la usa el administrador (Dashboard). Necesita la librería SheetJS cargada en la página (window.XLSX).
// Las celdas de texto se guardan como texto (no como fórmulas), así que nada de lo cargado se ejecuta al abrir el archivo.

const KEY_ULTIMA = 'diarnec_ultima_copia';

// [nombre de la hoja, tabla, columnas a leer, columnas que se ocultan]
const TABLAS = [
  ['Ventas', 'ventas'],
  ['Ventas - productos', 'ventas_items'],
  ['Devoluciones', 'devoluciones_cab'],
  ['Devoluciones - productos', 'devoluciones_items'],
  ['Bonificaciones', 'bonificaciones'],
  ['Bonificaciones - productos', 'bonificaciones_items'],
  ['Pagos de clientes', 'pagos_clientes'],
  ['Pagos de vendedores', 'pagos_vendedores'],
  ['Pagos a proveedores', 'pagos_proveedores'],
  ['Gastos', 'gastos'],
  ['Movimientos de stock', 'movimientos_stock'],
  ['Stock por lote', 'stock_lotes'],
  ['Productos', 'productos'],
  ['Marcas', 'marcas'],
  ['Categorias', 'categorias'],
  ['Clientes', 'clientes'],
  ['Vendedores', 'vendedores'],
  ['Proveedores', 'proveedores'],
  ['Comisiones por marca', 'comisiones_vendedor_marca']
];
const OCULTAR = new Set(['auth_user_id']);

async function leerTabla(tabla){
  const filas = [];
  const paso = 1000;
  for(let ini = 0; ini < 200000; ini += paso){
    const { data, error } = await sb.from(tabla).select('*').order('created_at', { ascending: true, nullsFirst: true }).range(ini, ini + paso - 1);
    if(error){
      // algunas tablas no tienen created_at: se reintenta sin ordenar
      const r = await sb.from(tabla).select('*').range(ini, ini + paso - 1);
      if(r.error) throw r.error;
      filas.push(...(r.data || []));
      if(!r.data || r.data.length < paso) break;
      continue;
    }
    filas.push(...(data || []));
    if(!data || data.length < paso) break;
  }
  return filas;
}

export function ultimaCopia(){
  try { const t = Number(localStorage.getItem(KEY_ULTIMA)); return t > 0 ? t : null; } catch(e){ return null; }
}

export function textoUltimaCopia(){
  const t = ultimaCopia();
  if(!t) return { texto: 'Todavía no descargaste ninguna copia desde este navegador.', antigua: true };
  const dias = Math.floor((Date.now() - t) / 86400000);
  const f = new Date(t);
  const cuando = `${String(f.getDate()).padStart(2, '0')}/${String(f.getMonth() + 1).padStart(2, '0')}/${f.getFullYear()} ${String(f.getHours()).padStart(2, '0')}:${String(f.getMinutes()).padStart(2, '0')}`;
  return { texto: `Última copia descargada desde este navegador: ${cuando}${dias >= 1 ? ` (hace ${dias} día${dias === 1 ? '' : 's'})` : ' (hoy)'}.`, antigua: dias >= 7 };
}

// progreso(texto) se llama a medida que avanza. Devuelve { archivo, hojas, avisos }.
export async function descargarCopiaExcel(progreso = () => {}){
  if(!window.XLSX) throw new Error('No se cargó la librería de Excel. Recargá la página e intentá de nuevo.');
  const XLSX = window.XLSX;

  const datos = {};
  const avisos = [];
  for(const [hoja, tabla] of TABLAS){
    progreso(`Leyendo ${hoja}...`);
    try { datos[tabla] = await leerTabla(tabla); }
    catch(e){ datos[tabla] = []; avisos.push(`${hoja}: ${e.message || e}`); }
  }

  // Nombres legibles al lado de los números internos
  progreso('Armando el archivo...');
  const nombres = (tabla, campo = 'nombre') => new Map((datos[tabla] || []).map(r => [r.id, r[campo]]));
  const mapas = {
    vendedor_id: nombres('vendedores'), cliente_id: nombres('clientes'), producto_id: nombres('productos'),
    proveedor_id: nombres('proveedores'), marca_id: nombres('marcas'), categoria_id: nombres('categorias')
  };
  const etiquetaCol = { vendedor_id: 'vendedor', cliente_id: 'cliente', producto_id: 'producto', proveedor_id: 'proveedor', marca_id: 'marca', categoria_id: 'categoria' };
  const usuarios = new Map();
  try {
    const { data } = await sb.from('staff_usuarios').select('auth_user_id, username');
    (data || []).forEach(u => usuarios.set(u.auth_user_id, u.username));
  } catch(e){ /* sin nombres de usuario: queda el código */ }

  const enriquecer = fila => {
    const salida = {};
    for(const [k, v] of Object.entries(fila)){
      if(OCULTAR.has(k)) continue;
      if(v !== null && typeof v === 'object') { salida[k] = JSON.stringify(v); continue; }
      salida[k] = v;
    }
    for(const [col, mapa] of Object.entries(mapas)){
      if(col in fila && fila[col] != null && mapa.has(fila[col])) salida[etiquetaCol[col]] = mapa.get(fila[col]);
    }
    if(fila.created_by && usuarios.has(fila.created_by)) salida.cargado_por = usuarios.get(fila.created_by);
    return salida;
  };

  const wb = XLSX.utils.book_new();
  const hoy = new Date();
  const fechaTxt = `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;

  const leeme = [
    ['DIARNEC — Copia de seguridad'],
    ['Generada el', hoy.toLocaleString('es-AR')],
    [''],
    ['Hoja', 'Filas'],
    ...TABLAS.map(([hoja, tabla]) => [hoja, (datos[tabla] || []).length]),
    [''],
    ['Es una foto de los datos al momento de descargarla. No se puede volver a cargar sola en el sistema: sirve para consultar y como respaldo.'],
    ...(avisos.length ? [[''], ['Atención: no se pudieron leer estas hojas:'], ...avisos.map(a => [a])] : [])
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(leeme), 'LEEME');

  for(const [hoja, tabla] of TABLAS){
    const filas = (datos[tabla] || []).map(enriquecer);
    const ws = filas.length ? XLSX.utils.json_to_sheet(filas) : XLSX.utils.aoa_to_sheet([['(sin registros)']]);
    if(filas.length){
      const cols = Object.keys(filas[0]);
      ws['!cols'] = cols.map(c => ({ wch: Math.min(40, Math.max(10, c.length + 2)) }));
    }
    XLSX.utils.book_append_sheet(wb, ws, hoja.slice(0, 31));
  }

  const archivo = `DIARNEC-copia-${fechaTxt}.xlsx`;
  XLSX.writeFile(wb, archivo);
  try { localStorage.setItem(KEY_ULTIMA, String(Date.now())); } catch(e){ /* sin storage */ }
  return { archivo, hojas: TABLAS.length, avisos };
}
