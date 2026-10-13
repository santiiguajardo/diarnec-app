import { sb } from './supabase-client.js';

// Anti-clickjacking: el panel no se muestra dentro de un marco de otra página (GitHub Pages no permite
// mandar la cabecera X-Frame-Options, así que se corta acá).
if(window.top !== window.self){ document.documentElement.innerHTML = ''; }

// Roles: 'admin' y 'encargado' usan el panel de gestión; 'vendedor' usa solo su panel (mi-panel.html).
// El rol vive en la tabla staff_usuarios y lo hace cumplir la base (RLS): esto solo decide a qué
// pantalla va cada uno.

let perfilCache = null;
let vigilando = false;

// { username, rol, vendedor_id } del usuario logueado, o null si no tiene acceso configurado.
// Si la consulta FALLA (se cortó la conexión, Supabase no responde) tira el error: no es lo mismo que "sin acceso",
// y confundirlos cerraba la sesión de gente que sí tenía acceso apenas había un corte.
export async function getPerfil(){
  if(perfilCache) return perfilCache;
  const { data, error } = await sb.rpc('mi_perfil');
  if(error) throw error;
  perfilCache = data || null;
  return perfilCache;
}

// Cartel a pantalla completa cuando no se pudo verificar el acceso por un problema de conexión.
// La sesión NO se cierra: "Reintentar" recarga y listo.
function pantallaSinConexion(){
  if(document.getElementById('sin-conexion')) return;
  const d = document.createElement('div');
  d.id = 'sin-conexion';
  d.style.cssText = 'position:fixed;inset:0;z-index:10000;background:#122436;display:flex;align-items:center;justify-content:center;padding:20px;';
  d.innerHTML = '<div style="background:#fff;border-radius:14px;padding:26px;max-width:340px;text-align:center;font:14px/1.4 system-ui,sans-serif;color:#1c2b36;">'
    + '<h3 style="margin:0 0 8px;font-size:18px;">No se pudo conectar</h3>'
    + '<p style="margin:0 0 16px;color:#5b6b78;">No pudimos verificar tu acceso. Revisá tu conexión: <b>tu sesión sigue abierta</b>.</p>'
    + '<button type="button" id="sin-conexion-reintentar" style="width:100%;padding:11px;border:none;border-radius:8px;background:#122436;color:#fff;font-weight:700;font-size:14px;cursor:pointer;">Reintentar</button>'
    + '</div>';
  document.body.appendChild(d);
  d.querySelector('#sin-conexion-reintentar').addEventListener('click', () => location.reload());
}

// Si la sesión se cierra (en otra pestaña, vencida, o la cerró el servidor) esta pantalla vuelve sola al login.
// Antes quedaba abierta con los datos viejos y los botones fallando, y solo recargando la página aparecía el login.
// Solo se instala en las pantallas del panel: en el login mismo un "SIGNED_OUT" es normal y no debe redirigir.
function vigilarSesion(){
  if(vigilando) return;
  vigilando = true;
  sb.auth.onAuthStateChange(event => {
    if(event === 'SIGNED_OUT') window.location.href = 'login.html';
  });
  // Al volver a esta pantalla con el botón "Atrás" el navegador puede mostrarla congelada (aunque ya se cerró la sesión)
  window.addEventListener('pageshow', async e => {
    if(!e.persisted) return;
    const { data: { session } } = await sb.auth.getSession();
    if(!session) window.location.href = 'login.html';
  });
}

async function sinAcceso(){
  await sb.auth.signOut({ scope: 'local' }); // solo este dispositivo (no cierra las sesiones del mismo usuario en otros equipos)
  window.location.href = 'login.html?motivo=sin-acceso';
  return null;
}

// Páginas del panel de gestión (admin / encargado). Un vendedor va a su propio panel.
export async function requireAuth(){
  const { data: { session } } = await sb.auth.getSession();
  if(!session){
    window.location.href = 'login.html';
    return null;
  }
  let perfil;
  try { perfil = await getPerfil(); } catch(e){ pantallaSinConexion(); return null; }
  if(!perfil) return sinAcceso();
  if(perfil.rol === 'vendedor'){
    window.location.href = 'mi-panel.html';
    return null;
  }
  vigilarSesion();
  return session;
}

// Páginas solo para el administrador (Usuarios, Dashboard). El encargado que llega acá (por link
// directo, no debería pasar porque el menú ya no le muestra estas páginas) va a la pantalla que sí
// le corresponde, no a Dashboard — si no, con Dashboard también restringido, quedaría en un
// ping-pong de redirecciones.
export async function requireAdmin(){
  const session = await requireAuth();
  if(!session) return null;
  const perfil = await getPerfil();
  if(perfil.rol !== 'admin'){
    window.location.href = pantallaInicial(perfil);
    return null;
  }
  return session;
}

// Panel del vendedor
export async function requireVendedor(){
  const { data: { session } } = await sb.auth.getSession();
  if(!session){
    window.location.href = 'login.html';
    return null;
  }
  let perfil;
  try { perfil = await getPerfil(); } catch(e){ pantallaSinConexion(); return null; }
  if(!perfil) return sinAcceso();
  if(perfil.rol !== 'vendedor'){
    window.location.href = 'dashboard.html';
    return null;
  }
  vigilarSesion();
  return session;
}

export async function logout(){
  perfilCache = null;
  await sb.auth.signOut({ scope: 'local' }); // solo este dispositivo (no cierra las sesiones del mismo usuario en otros equipos)
  window.location.href = 'login.html';
}

// A dónde va cada rol después de entrar: el vendedor a su panel, el encargado (sin Dashboard) a
// Ventas, y el admin al Dashboard.
export function pantallaInicial(perfil){
  if(!perfil) return 'login.html';
  if(perfil.rol === 'vendedor') return 'mi-panel.html';
  if(perfil.rol === 'encargado') return 'ventas.html';
  return 'dashboard.html';
}
