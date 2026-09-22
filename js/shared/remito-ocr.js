// Lectura de remitos de ingreso de mercadería (foto o PDF) y armado de las filas a ingresar.
//
//   leerArchivo(file, onProgreso)   → { lineas: string[], via: 'pdf' | 'ocr' }
//       PDF con texto: se lee el texto tal cual (exacto). Foto o PDF escaneado: OCR en el navegador
//       (Tesseract.js, español). Las librerías se bajan de un CDN recién cuando se usan.
//   interpretarRemito(lineas, productos) → { filas, sinIdentificar }
//       Busca en cada línea el producto del catálogo (por SKU si el remito trae código, si no por
//       nombre con tolerancia a errores de lectura) y la cantidad. Devuelve una PROPUESTA: la pantalla
//       de ingreso la muestra para que se revise antes de tocar el stock.

const CDN = {
  tesseract: 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js',
  pdfjs: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  pdfWorker: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js'
};

const cargas = {};
function cargarScript(src){
  if(!cargas[src]){
    cargas[src] = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = () => { delete cargas[src]; reject(new Error('No se pudo descargar el lector de remitos. Revisá tu conexión a internet.')); };
      document.head.appendChild(s);
    });
  }
  return cargas[src];
}

// ===== Lectura del archivo =====

export async function leerArchivo(file, onProgreso = () => {}){
  const esPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  if(esPdf) return leerPdf(file, onProgreso);
  if(!/^image\//.test(file.type)) throw new Error('El archivo tiene que ser una foto (JPG, PNG) o un PDF.');
  onProgreso('Preparando la imagen…', 0.02);
  const canvas = await prepararImagen(file);
  const texto = await ocr(canvas, onProgreso);
  return { lineas: aLineas(texto), via: 'ocr' };
}

const aLineas = texto => String(texto || '').split(/\r?\n/).map(l => l.replace(/\s+/g, ' ').trim()).filter(Boolean);

// Achica/agranda a un tamaño cómodo para el OCR y sube el contraste (las fotos de remitos suelen ser grises)
async function prepararImagen(file){
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const lado = Math.max(bmp.width, bmp.height);
  const k = lado > 2600 ? 2600 / lado : (lado < 1500 ? 1500 / lado : 1);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * k);
  canvas.height = Math.round(bmp.height * k);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  contrastar(ctx, canvas.width, canvas.height);
  return canvas;
}

// Escala de grises + estirar el histograma (percentiles 2 y 98) para separar tinta de papel
function contrastar(ctx, w, h){
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const hist = new Uint32Array(256);
  for(let i = 0; i < d.length; i += 4){
    const g = Math.round(d[i] * 0.299 + d[i + 1] * 0.587 + d[i + 2] * 0.114);
    d[i] = d[i + 1] = d[i + 2] = g;
    hist[g]++;
  }
  const total = w * h;
  let acc = 0, lo = 0, hi = 255;
  for(let v = 0; v < 256; v++){ acc += hist[v]; if(acc >= total * 0.02){ lo = v; break; } }
  acc = 0;
  for(let v = 255; v >= 0; v--){ acc += hist[v]; if(acc >= total * 0.02){ hi = v; break; } }
  if(hi - lo < 40){ ctx.putImageData(img, 0, 0); return; }
  const f = 255 / (hi - lo);
  for(let i = 0; i < d.length; i += 4){
    const v = Math.max(0, Math.min(255, (d[i] - lo) * f));
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
}

let workerOcr = null;
async function ocr(canvas, onProgreso){
  await cargarScript(CDN.tesseract);
  onProgreso('Descargando el lector (solo la primera vez)…', 0.05);
  if(!workerOcr){
    workerOcr = await window.Tesseract.createWorker('spa', 1, {
      logger: m => {
        if(m.status === 'recognizing text') onProgreso('Leyendo el texto…', 0.15 + 0.8 * (m.progress || 0));
        else if(m.status && /loading|initializ/.test(m.status)) onProgreso('Preparando el lector…', 0.05 + 0.1 * (m.progress || 0));
      }
    });
    // Bloque uniforme de texto y espacios entre columnas conservados: lo que más se parece a un remito
    await workerOcr.setParameters({ tessedit_pageseg_mode: '6', preserve_interword_spaces: '1' });
  }
  const { data } = await workerOcr.recognize(canvas);
  return data.text;
}

async function leerPdf(file, onProgreso){
  onProgreso('Abriendo el PDF…', 0.03);
  await cargarScript(CDN.pdfjs);
  const pdfjs = window.pdfjsLib;
  if(!pdfjs.GlobalWorkerOptions.workerSrc){
    // El worker se baja como texto y se sirve como blob: así no depende de que el CDN permita cargarlo como worker
    const codigo = await (await fetch(CDN.pdfWorker)).text();
    pdfjs.GlobalWorkerOptions.workerSrc = URL.createObjectURL(new Blob([codigo], { type: 'text/javascript' }));
  }
  const pdf = await pdfjs.getDocument({ data: await file.arrayBuffer() }).promise;
  const lineas = [];
  let conTexto = 0;
  for(let n = 1; n <= pdf.numPages; n++){
    onProgreso(`Leyendo la página ${n} de ${pdf.numPages}…`, 0.05 + 0.9 * (n - 1) / pdf.numPages);
    const page = await pdf.getPage(n);
    const tc = await page.getTextContent();
    const delPdf = lineasDeTexto(tc.items);
    if(delPdf.join('').replace(/\s/g, '').length >= 30){
      conTexto++;
      lineas.push(...delPdf);
    } else {
      // Página sin texto (PDF escaneado): se dibuja y se lee con OCR
      const viewport = page.getViewport({ scale: 2.4 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      contrastar(ctx, canvas.width, canvas.height);
      lineas.push(...aLineas(await ocr(canvas, onProgreso)));
    }
  }
  return { lineas, via: conTexto ? 'pdf' : 'ocr' };
}

// Junta los fragmentos de texto del PDF en renglones: misma altura = mismo renglón; una separación
// grande entre fragmentos (columnas) se conserva con espacios.
function lineasDeTexto(items){
  const frag = items.filter(i => i.str && i.str.trim()).map(i => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width || 0 }));
  frag.sort((a, b) => b.y - a.y || a.x - b.x);
  const renglones = [];
  for(const f of frag){
    const r = renglones.find(r => Math.abs(r.y - f.y) <= 3);
    if(r) r.f.push(f); else renglones.push({ y: f.y, f: [f] });
  }
  renglones.sort((a, b) => b.y - a.y);
  return renglones.map(r => {
    r.f.sort((a, b) => a.x - b.x);
    let txt = '', fin = null;
    for(const f of r.f){
      if(fin !== null) txt += (f.x - fin > 12) ? '   ' : (f.x - fin > 0.5 ? ' ' : '');
      txt += f.s;
      fin = f.x + f.w;
    }
    return txt.replace(/\s+$/, '');
  }).filter(Boolean);
}

// ===== Coincidencia de productos =====

const STOP = new Set(['de', 'del', 'la', 'el', 'los', 'las', 'y', 'e', 'con', 'sin', 'para', 'por', 'x', 'c', 's', 'p', 'u', 'un', 'una', 'en', 'a', 'al', 'su',
  'g', 'gr', 'grs', 'gs', 'kg', 'kgs', 'ml', 'cc', 'l', 'lt', 'lts', 'unid', 'unidad', 'unidades', 'uni', 'und']);
const UNIDADES = new Set(['g', 'gr', 'grs', 'gs', 'kg', 'kgs', 'ml', 'cc', 'l', 'lt', 'lts']);

export function normalizar(s){
  return String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\bt\s*\/\s*e\b/g, 'tapas empanadas')
    .replace(/\bc\s*\/\s*/g, 'con ').replace(/\bs\s*\/\s*/g, 'sin ').replace(/\bp\s*\/\s*/g, 'para ')
    .replace(/(\d)([a-z])/g, '$1 $2')          // 330g → 330 g
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

// Palabras significativas (con peso = largo) y números (peso fijo) de un texto
function tokens(s){
  const out = [];
  for(const t of normalizar(s).split(' ')){
    if(!t || STOP.has(t)) continue;
    if(/^\d+$/.test(t)) out.push({ t, num: true, w: 2 });
    else if(t.length >= 2) out.push({ t, num: false, w: t.length });
  }
  return out;
}

function distancia(a, b){
  if(Math.abs(a.length - b.length) > 1) return 2;
  const m = a.length, n = b.length;
  let prev = Array.from({ length: n + 1 }, (_, j) => j);
  for(let i = 1; i <= m; i++){
    const cur = [i];
    for(let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[n];
}

// ¿la palabra del producto aparece (con tolerancia a errores de OCR) entre las palabras de la línea?
function aparece(p, lineaTokens){
  for(const l of lineaTokens){
    if(l.num !== p.num) continue;
    if(l.t === p.t) return true;
    if(p.num) continue;
    if(p.t.length >= 4 && l.t.length >= 4 && (p.t.startsWith(l.t) || l.t.startsWith(p.t))) return true;
    if(p.t.length >= 5 && distancia(p.t, l.t) <= 1) return true;
  }
  return false;
}

const numerosDe = s => (String(s).match(/\d{4,}/g) || []).map(n => n.replace(/^0+/, ''));

export function interpretarRemito(lineas, productos){
  const catalogo = productos.map(p => ({
    p,
    toks: tokens(p.nombre + ' ' + (p.unidad || '')),
    marca: p.marcas ? normalizar(p.marcas.nombre) : '',
    sku: p.sku ? String(p.sku).replace(/^0+/, '') : ''
  }));
  const textoTodo = normalizar(lineas.join(' '));
  const marcasEnDoc = new Set(catalogo.filter(c => c.marca && c.marca.length >= 3 && textoTodo.includes(c.marca)).map(c => c.marca));

  const filas = [];
  const sinIdentificar = [];
  const RUIDO = /\b(remito|factura|total|subtotal|cuit|c\.u\.i\.t|fecha|iva|domicilio|cliente|telefono|tel|pagina|hoja|transporte|firma|recib|bultos totales|cai)\b/;

  for(const linea of lineas){
    if(linea.length < 4) continue;
    const lt = tokens(linea);
    const codigos = numerosDe(linea);
    const lnorm = normalizar(linea);

    // puntaje de cada producto contra esta línea
    const puntajes = [];
    for(const c of catalogo){
      let score;
      const porSku = !!c.sku && codigos.includes(c.sku);
      if(porSku) score = 1.5;
      else {
        const total = c.toks.reduce((s, t) => s + t.w, 0);
        if(!total) continue;
        const hit = c.toks.filter(t => aparece(t, lt)).reduce((s, t) => s + t.w, 0);
        // que coincidan solo números o solo palabras sueltas y cortas no alcanza
        if(!c.toks.some(t => !t.num && aparece(t, lt))) continue;
        score = hit / total;
        if(c.marca.length >= 3){
          if(lnorm.includes(c.marca)) score += 0.12;
          else if(marcasEnDoc.has(c.marca)) score += 0.05;
        }
      }
      if(score >= 0.5) puntajes.push({ c, score, porSku });
    }
    puntajes.sort((a, b) => b.score - a.score);

    const mejor = puntajes[0];
    if(!mejor || mejor.score < 0.6){
      const palabra = /[a-záéíóúñ]{4,}/i.test(linea);
      const conNumero = extraerCantidades(linea, null, null).cands.length > 0;
      if(palabra && conNumero && !RUIDO.test(lnorm) && sinIdentificar.length < 40) sinIdentificar.push({ texto: linea, ...extraerCantidades(linea, null, null) });
      continue;
    }

    const margen = puntajes[1] ? mejor.score - puntajes[1].score : 1;
    let confianza = mejor.porSku || (mejor.score >= 0.85 && margen >= 0.08) ? 'alta' : (mejor.score >= 0.7 ? 'media' : 'baja');
    if(margen < 0.05 && confianza === 'alta') confianza = 'media';

    const q = extraerCantidades(linea, mejor.c.p, mejor.c.sku);
    filas.push({
      texto: linea,
      productoId: mejor.c.p.id,
      score: Math.min(1, mejor.score),
      confianza,
      cantidad: q.cantidad,
      cands: q.cands,
      alternativas: puntajes.slice(1, 4).filter(x => mejor.score - x.score < 0.25).map(x => x.c.p.id)
    });
  }
  return { filas, sinIdentificar };
}

// Cantidad probable de una línea de remito + otros números de la línea (por si la probable no es)
export function extraerCantidades(linea, producto, sku){
  const porPeso = !!(producto && producto.categorias && producto.categorias.por_peso);
  const cands = [];
  const re = /(?<![\w.,])(\d{1,3}(?:[.,]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?![\w])/g;
  const primeraPalabra = (() => { const m = /[a-záéíóúñ]{3,}/i.exec(linea); return m ? m.index : 0; })();
  // Números de la presentación ("330" de 12u x 330g) y números que forman parte del nombre ("4" de "c/ 4 Quesos")
  const presentacion = producto ? (String(producto.unidad || '').match(/\d+/g) || []) : [];
  const enNombre = producto ? (String(producto.nombre || '').match(/\d+/g) || []).map(Number) : [];
  const palabrasNombre = new Set(producto ? normalizar(producto.nombre).split(' ') : []);
  let m;
  while((m = re.exec(linea))){
    const crudo = m[1];
    const despues = linea.slice(m.index + crudo.length).trim().toLowerCase();
    const antes = linea.slice(0, m.index).trim().toLowerCase();
    const unidadSigue = /^(g|gr|grs|gs|kg|kgs|ml|cc|lt|lts|l)\b/.test(despues);
    if(despues.startsWith('%')) continue;                                   // IVA, descuentos
    // El OCR suele leer la "g" de "330g" como 6, 9, 8 o 0 y queda "3306": es la presentación, no una cantidad
    if(presentacion.some(p => p.length >= 3 && crudo.length === p.length + 1 && crudo.startsWith(p) && '6980'.includes(crudo[crudo.length - 1]))) continue;
    // "c/ 4 Quesos": el 4 es parte del nombre del producto
    if(enNombre.includes(Number(crudo)) && palabrasNombre.has(normalizar(despues).split(' ')[0])) continue;
    if(sku && crudo.replace(/^0+/, '') === sku) continue;                   // código del producto
    if(/(^|\s)x$/.test(antes)) continue;                                    // "x 615g": presentación
    if(unidadSigue && !(porPeso && /^(kg|kgs)\b/.test(despues))) continue;  // "500 g": presentación
    if(/^\d{5,}$/.test(crudo)) continue;                                // códigos largos (sin separadores)
    if(/^\d{4}$/.test(crudo) && m.index < primeraPalabra) continue;         // código antes de la descripción
    if(/^\d{1,3}(?:[.,]\d{3})+[.,]\d{1,2}$/.test(crudo)) continue;          // 1.234,50 = importe
    let valor;
    if(/^\d+([.,]0+)?$/.test(crudo)) valor = parseInt(crudo, 10);           // 12 · 12,00
    else if(porPeso && /^\d+[.,]\d{1,3}$/.test(crudo)) valor = parseFloat(crudo.replace(',', '.'));  // 12,5 kg
    else continue;                                                          // decimales en producto por unidad: importe
    if(!(valor > 0) || valor > 5000) continue;
    if(!cands.includes(valor)) cands.push(valor);
  }
  return { cantidad: cands.length ? cands[0] : null, cands };
}
