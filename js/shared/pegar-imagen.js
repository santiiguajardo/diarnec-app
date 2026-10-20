// Pegar (Ctrl+V) o arrastrar una imagen para la foto de un producto, sin tener que buscar su dirección web.
// La imagen se achica (máx. 800 px de lado, JPG), se sube al almacenamiento de Supabase (bucket "productos", ver migración
// 0041) y se devuelve su dirección pública, que se guarda en productos.imagen_url igual que una URL escrita a mano.

import { sb } from './supabase-client.js';

const BUCKET = 'productos';
const LADO_MAX = 800;

// De un evento de pegado, la imagen copiada (como archivo), o null si lo que se pegó no es una imagen.
export function imagenPegada(e){
  const items = e.clipboardData ? [...e.clipboardData.items] : [];
  const it = items.find(i => i.kind === 'file' && i.type.startsWith('image/'));
  return it ? it.getAsFile() : null;
}

// Algunos navegadores, al copiar una imagen de una página, solo dejan el HTML (<img src="...">) y no el archivo.
function urlDeImagenEnHtml(e){
  if(!e.clipboardData || e.clipboardData.getData('text/plain')) return null; // si hay texto, es un pegado normal
  const m = (e.clipboardData.getData('text/html') || '').match(/<img[^>]+src=["']([^"']+)["']/i);
  return m && /^https?:\/\//i.test(m[1]) ? m[1] : null;
}

async function reducir(archivo){
  let bmp;
  try { bmp = await createImageBitmap(archivo); }
  catch(e){ throw new Error('no se pudo leer esa imagen (probá con otra, JPG o PNG).'); }
  const escala = Math.min(1, LADO_MAX / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * escala)), h = Math.max(1, Math.round(bmp.height * escala));
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // los PNG con fondo transparente quedan sobre blanco, no negro
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.85));
  if(!blob) throw new Error('no se pudo procesar la imagen.');
  return blob;
}

// Devuelve la dirección pública de la foto subida.
export async function subirFotoProducto(archivo, prefijo){
  const blob = await reducir(archivo);
  const ruta = `${prefijo}-${Date.now()}.jpg`;
  const { error } = await sb.storage.from(BUCKET).upload(ruta, blob, { contentType: 'image/jpeg', cacheControl: '31536000' });
  if(error) throw new Error(error.message);
  return sb.storage.from(BUCKET).getPublicUrl(ruta).data.publicUrl;
}

// activo():  ¿está abierta la pantalla/campo que recibe la imagen? (el pegado es de toda la página, así que se acota)
// prefijo(): nombre base del archivo (ej: "p12")
// estado(texto, tipo): para mostrar "Subiendo…", "listo" o el error ('ocupado' | 'ok' | 'error')
// alSubir(url): se llama con la dirección de la foto ya subida
// zona (opcional): elemento donde también se puede soltar un archivo arrastrado
export function instalarPegadoDeImagen({ activo, prefijo, estado, alSubir, zona }){
  let ocupado = false;

  async function procesar(archivo, urlDirecta){
    if(ocupado) return;
    ocupado = true;
    try {
      if(urlDirecta){ alSubir(urlDirecta); estado('✔ Imagen tomada de la página. Tocá Guardar para aplicarla.', 'ok'); return; }
      estado('Subiendo imagen…', 'ocupado');
      const url = await subirFotoProducto(archivo, prefijo());
      alSubir(url);
      estado('✔ Imagen cargada. Tocá Guardar para aplicarla.', 'ok');
    } catch(err){
      estado('No se pudo subir la imagen: ' + (err.message || err), 'error');
    } finally { ocupado = false; }
  }

  document.addEventListener('paste', e => {
    if(!activo()) return;
    const archivo = imagenPegada(e);
    const urlDirecta = archivo ? null : urlDeImagenEnHtml(e);
    if(!archivo && !urlDirecta) return; // texto común: se pega como siempre
    e.preventDefault();
    procesar(archivo, urlDirecta);
  });

  if(zona){
    zona.addEventListener('dragover', e => { e.preventDefault(); zona.classList.add('encima'); });
    zona.addEventListener('dragleave', () => zona.classList.remove('encima'));
    zona.addEventListener('drop', e => {
      e.preventDefault();
      zona.classList.remove('encima');
      const archivo = [...(e.dataTransfer ? e.dataTransfer.files : [])].find(f => f.type.startsWith('image/'));
      if(archivo) procesar(archivo, null);
      else estado('Eso no es una imagen.', 'error');
    });
  }
}
