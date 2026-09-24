import { sb } from './supabase-client.js';
import { logout, getPerfil } from './auth-guard.js';
import { USERNAME_EMAIL_DOMAIN } from './supabase-config.js';
import { instalarAvisos } from './dialogs.js';

// Un solo lugar para la lista de módulos del admin: agregar acá cuando se construya
// una página nueva (ver plan de fases), no hay que tocar cada .html. Los colores
// replican los de la app de escritorio anterior (cada módulo tenía su color propio).
// roles: quién ve el link en el menú. El admin ve todo; el encargado no ve Dashboard ni Usuarios
// (Dashboard además está bloqueado en la base — ver mi_perfil/dash_periodo — no es solo visual).
const MODULES = [
  { key: 'dashboard', label: 'Dashboard', href: 'dashboard.html', color: '#e67e22', roles: ['admin'] },
  { key: 'ventas', label: 'Ventas', href: 'ventas.html', color: '#c0392b', roles: ['admin', 'encargado'] },
  { key: 'historial', label: 'Historial', href: 'historial.html', color: '#3498db', roles: ['admin', 'encargado'] },
  { key: 'inventario', label: 'Inventario y precios', href: 'inventario.html', color: '#f1c40f', roles: ['admin', 'encargado'] },
  { key: 'proveedores', label: 'Pago a proveedores', href: 'proveedores.html', color: '#27ae60', roles: ['admin', 'encargado'] },
  { key: 'caja', label: 'Caja', href: 'caja.html', color: '#2ecc71', roles: ['admin', 'encargado'] },
  { key: 'tienda', label: 'Tienda online', href: 'tienda-online.html', color: '#16a085', roles: ['admin', 'encargado'] },
  { key: 'usuarios', label: 'Usuarios', href: 'usuarios.html', color: '#7f8c8d', roles: ['admin'] },
];

// ===== Aviso de pedidos nuevos de la tienda online =====
// Cada minuto (y al volver a la pestaña) se cuentan los pedidos pendientes: se muestran en un globito junto a
// "Tienda online", en el título de la pestaña, y si llega uno nuevo mientras el panel está abierto sale un cartel.

let pendientes = null;
let tituloBase = null;

export async function refrescarAvisoPedidos(){
  const { count, error } = await sb.from('ventas').select('id', { count: 'exact', head: true })
    .eq('canal', 'online').eq('estado', 'pendiente');
  if(error || count === null) return;
  const anterior = pendientes;
  pendientes = count;

  const link = document.querySelector('.admin-sidebar a[href="tienda-online.html"]');
  if(link){
    let b = link.querySelector('.badge-pedidos');
    if(count > 0){
      if(!b){ b = document.createElement('span'); b.className = 'badge-pedidos'; link.appendChild(b); }
      b.textContent = count;
      b.title = count === 1 ? '1 pedido esperando' : `${count} pedidos esperando`;
    } else if(b){
      b.remove();
    }
  }
  if(tituloBase === null) tituloBase = document.title;
  document.title = count > 0 ? `(${count}) ${tituloBase}` : tituloBase;

  if(anterior !== null && count > anterior){
    avisoCartel(count - anterior === 1 ? '🛒 Llegó un pedido nuevo de la tienda' : `🛒 Llegaron ${count - anterior} pedidos nuevos de la tienda`);
  }
}

function avisoCartel(texto){
  document.querySelectorAll('a[data-cartel-pedido]').forEach(x => x.remove());
  const t = document.createElement('a');
  t.dataset.cartelPedido = '1';
  t.href = 'tienda-online.html';
  t.textContent = texto;
  t.style.cssText = 'position:fixed;top:16px;right:16px;z-index:9999;background:#FF8A3D;color:#fff;padding:14px 20px;border-radius:12px;'
    + 'font-weight:700;font-size:14px;text-decoration:none;box-shadow:0 10px 30px rgba(0,0,0,.25);cursor:pointer;';
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 9000);
}

function iniciarAvisoPedidos(){
  refrescarAvisoPedidos();
  setInterval(refrescarAvisoPedidos, 60000);
  document.addEventListener('visibilitychange', () => { if(!document.hidden) refrescarAvisoPedidos(); });
}

// Inserta el sidebar+topbar en <div id="app-shell"></div> y devuelve el contenedor
// #admin-content donde cada página arma su propio contenido.
export async function mountLayout(activeKey, pageTitle){
  instalarAvisos();
  const root = document.getElementById('app-shell');
  const { data: { user } } = await sb.auth.getUser();
  const username = user ? user.email.replace(USERNAME_EMAIL_DOMAIN, '') : '';
  const perfil = await getPerfil();
  const modulos = MODULES.filter(m => perfil && m.roles.includes(perfil.rol));

  root.innerHTML = `
    <div class="admin-shell">
      <aside class="admin-sidebar">
        <div class="brand">DIARNEC</div>
        <nav>
          ${modulos.map(m => `
            <a href="${m.href}" class="${m.key === activeKey ? 'active' : ''}" style="--mod-color:${m.color}">
              <span class="dot" style="background:${m.color}"></span>${m.label}
            </a>`).join('')}
        </nav>
      </aside>
      <div class="admin-main">
        <div class="admin-topbar">
          <h1>${pageTitle}</h1>
          <div>
            <span class="user-email">${username}</span>
            <button class="btn-sm" id="logout-btn">Cerrar sesión</button>
          </div>
        </div>
        <div class="admin-content" id="admin-content"></div>
      </div>
    </div>
  `;

  document.getElementById('logout-btn').addEventListener('click', logout);
  if(modulos.some(m => m.key === 'tienda')) iniciarAvisoPedidos();
  // Asistente (chat) disponible en todo el panel de gestión; si falla no rompe la página
  import('./asistente.js').then(m => m.montarAsistente()).catch(e => console.warn('Asistente no disponible:', e));
  return document.getElementById('admin-content');
}
