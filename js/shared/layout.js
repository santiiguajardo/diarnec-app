import { sb } from './supabase-client.js';
import { logout, getPerfil } from './auth-guard.js';
import { USERNAME_EMAIL_DOMAIN } from './supabase-config.js';
import { instalarAvisos } from './dialogs.js';

// Un solo lugar para la lista de módulos del admin: agregar acá cuando se construya
// una página nueva (ver plan de fases), no hay que tocar cada .html. Los colores
// replican los de la app de escritorio anterior (cada módulo tenía su color propio).
const MODULES = [
  { key: 'dashboard', label: 'Dashboard', href: 'dashboard.html', color: '#e67e22' },
  { key: 'ventas', label: 'Ventas', href: 'ventas.html', color: '#c0392b' },
  { key: 'historial', label: 'Historial', href: 'historial.html', color: '#3498db' },
  { key: 'inventario', label: 'Inventario y precios', href: 'inventario.html', color: '#f1c40f' },
  { key: 'proveedores', label: 'Pago a proveedores', href: 'proveedores.html', color: '#27ae60' },
  { key: 'caja', label: 'Caja', href: 'caja.html', color: '#2ecc71' },
  { key: 'tienda', label: 'Tienda online', href: 'tienda-online.html', color: '#16a085' },
  { key: 'usuarios', label: 'Usuarios', href: 'usuarios.html', color: '#7f8c8d' },
];

// Inserta el sidebar+topbar en <div id="app-shell"></div> y devuelve el contenedor
// #admin-content donde cada página arma su propio contenido.
export async function mountLayout(activeKey, pageTitle){
  instalarAvisos();
  const root = document.getElementById('app-shell');
  const { data: { user } } = await sb.auth.getUser();
  const username = user ? user.email.replace(USERNAME_EMAIL_DOMAIN, '') : '';
  const perfil = await getPerfil();
  // Solo el administrador gestiona usuarios
  const modulos = MODULES.filter(m => m.key !== 'usuarios' || (perfil && perfil.rol === 'admin'));

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
  // Asistente (chat) disponible en todo el panel de gestión; si falla no rompe la página
  import('./asistente.js').then(m => m.montarAsistente()).catch(e => console.warn('Asistente no disponible:', e));
  return document.getElementById('admin-content');
}
