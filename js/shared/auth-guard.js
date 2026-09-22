import { sb } from './supabase-client.js';

// Roles: 'admin' y 'encargado' usan el panel de gestión; 'vendedor' usa solo su panel (mi-panel.html).
// El rol vive en la tabla staff_usuarios y lo hace cumplir la base (RLS): esto solo decide a qué
// pantalla va cada uno.

let perfilCache = null;

// { username, rol, vendedor_id } del usuario logueado, o null si no tiene acceso configurado.
export async function getPerfil(){
  if(perfilCache) return perfilCache;
  const { data, error } = await sb.rpc('mi_perfil');
  perfilCache = (!error && data) ? data : null;
  return perfilCache;
}

async function sinAcceso(){
  await sb.auth.signOut();
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
  const perfil = await getPerfil();
  if(!perfil) return sinAcceso();
  if(perfil.rol === 'vendedor'){
    window.location.href = 'mi-panel.html';
    return null;
  }
  return session;
}

// Páginas solo para el administrador (Usuarios)
export async function requireAdmin(){
  const session = await requireAuth();
  if(!session) return null;
  const perfil = await getPerfil();
  if(perfil.rol !== 'admin'){
    window.location.href = 'dashboard.html';
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
  const perfil = await getPerfil();
  if(!perfil) return sinAcceso();
  if(perfil.rol !== 'vendedor'){
    window.location.href = 'dashboard.html';
    return null;
  }
  return session;
}

export async function logout(){
  perfilCache = null;
  await sb.auth.signOut();
  window.location.href = 'login.html';
}

// A dónde va cada rol después de entrar
export const pantallaInicial = perfil => perfil && perfil.rol === 'vendedor' ? 'mi-panel.html' : 'dashboard.html';
