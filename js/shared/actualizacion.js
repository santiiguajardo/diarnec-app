// Aviso de "versión nueva". Los vendedores y el encargado suelen dejar el panel abierto todo el día en la pestaña:
// esa pestaña sigue con el código viejo hasta que se recarga, así que un arreglo publicado no les llega.
// Cada publicación escribe la versión en /version.json; acá se compara cada vez que se vuelve a la pestaña
// (y cada 5 minutos) y, si cambió, aparece un cartel para actualizar. No recarga sola: podría haber algo a medio cargar.

let actual = null;

async function leerVersion(){
  try {
    const r = await fetch(new URL('../version.json', document.baseURI).href + '?t=' + Date.now(), { cache: 'no-store' });
    if(!r.ok) return null;
    const j = await r.json();
    return j && j.v ? String(j.v) : null;
  } catch(e){ return null; }
}

function mostrarAviso(){
  if(document.getElementById('aviso-version')) return;
  const d = document.createElement('div');
  d.id = 'aviso-version';
  d.setAttribute('role', 'status');
  d.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9998;display:flex;align-items:center;gap:10px;flex-wrap:wrap;'
    + 'justify-content:center;background:#122436;color:#fff;padding:12px 16px;border-radius:14px;box-shadow:0 10px 30px rgba(0,0,0,.35);'
    + 'font:600 14px/1.3 system-ui,sans-serif;max-width:min(94vw,460px);';
  d.innerHTML = '<span>🔄 Hay una versión nueva del panel.</span>'
    + '<button type="button" id="aviso-version-ok" style="border:none;border-radius:8px;padding:8px 14px;background:#2BB673;color:#fff;font:700 13px system-ui,sans-serif;cursor:pointer;">Actualizar ahora</button>'
    + '<button type="button" id="aviso-version-no" style="border:none;background:none;color:#B8C7D3;font:600 12px system-ui,sans-serif;cursor:pointer;text-decoration:underline;">Después</button>';
  document.body.appendChild(d);
  d.querySelector('#aviso-version-ok').addEventListener('click', () => location.reload());
  d.querySelector('#aviso-version-no').addEventListener('click', () => d.remove());
}

export async function vigilarVersion(){
  actual = await leerVersion();
  if(!actual) return; // local o sin conexión: no se vigila
  const revisar = async () => {
    const nueva = await leerVersion();
    if(nueva && nueva !== actual) mostrarAviso();
  };
  document.addEventListener('visibilitychange', () => { if(!document.hidden) revisar(); });
  setInterval(revisar, 5 * 60 * 1000);
}
