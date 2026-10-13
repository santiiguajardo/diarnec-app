import { sb } from '../shared/supabase-client.js';
import { USERNAME_EMAIL_DOMAIN } from '../shared/supabase-config.js';
import { getPerfil, pantallaInicial } from '../shared/auth-guard.js';

const userEl = document.getElementById('admin-user');
const passEl = document.getElementById('admin-pass');
const btn = document.getElementById('login-btn');
const errEl = document.getElementById('lock-err');

function usernameToEmail(username){
  return username.trim().toLowerCase() + USERNAME_EMAIL_DOMAIN;
}

const MSG_SIN_ACCESO = 'Tu usuario todavía no tiene acceso configurado. Pedile al administrador que lo revise.';
const MSG_SIN_CONEXION = 'No se pudo conectar con el servidor. Revisá tu conexión e intentá de nuevo.';
const MSG_DEMASIADOS = 'Demasiados intentos. Esperá un minuto y probá de nuevo.';
const ESPERA_MAX_MS = 20000;

function restablecerBoton(){
  btn.disabled = false;
  btn.textContent = 'Ingresar';
}

// Que un pedido que nunca contesta no deje el botón en "Ingresando..." para siempre.
function conTiempo(promesa){
  return Promise.race([
    promesa,
    new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('tiempo')), ESPERA_MAX_MS))
  ]);
}

// Solo es "usuario o contraseña incorrectos" cuando el servidor lo dice; un corte de conexión no lo es.
const esCredencialIncorrecta = error => error.status === 400 || error.status === 401
  || error.code === 'invalid_credentials' || /invalid login credentials/i.test(error.message || '');

async function irAlPanel(){
  let perfil;
  try {
    perfil = await conTiempo(getPerfil());
  } catch(e){
    // No se pudo verificar el acceso: no se cierra la sesión, se avisa y se puede reintentar
    errEl.textContent = MSG_SIN_CONEXION;
    return false;
  }
  if(!perfil){
    await sb.auth.signOut({ scope: 'local' }); // solo este dispositivo (no cierra las sesiones del mismo usuario en otros equipos)
    errEl.textContent = MSG_SIN_ACCESO;
    return false;
  }
  window.location.href = pantallaInicial(perfil);
  return true;
}

async function tryLogin(){
  if(btn.disabled) return; // ya hay un ingreso en curso
  const username = userEl.value.trim();
  const pass = passEl.value;
  errEl.textContent = '';
  if(!username || !pass) return;

  btn.disabled = true;
  btn.textContent = 'Ingresando...';

  try {
    const { error } = await conTiempo(sb.auth.signInWithPassword({ email: usernameToEmail(username), password: pass }));
    if(error){
      restablecerBoton();
      errEl.textContent = error.status === 429 ? MSG_DEMASIADOS
        : (esCredencialIncorrecta(error) ? 'Usuario o contraseña incorrectos.' : MSG_SIN_CONEXION);
      return;
    }
    if(!(await irAlPanel())) restablecerBoton();
  } catch(e){
    restablecerBoton();
    errEl.textContent = MSG_SIN_CONEXION;
  }
}

btn.addEventListener('click', tryLogin);
[userEl, passEl].forEach(el => el.addEventListener('keydown', e => {
  if(e.key === 'Enter') tryLogin();
}));

async function redirectIfLoggedIn(){
  if(new URLSearchParams(location.search).get('motivo') === 'sin-acceso'){
    errEl.textContent = MSG_SIN_ACCESO;
    return;
  }
  try {
    const { data: { session } } = await sb.auth.getSession();
    if(session) await irAlPanel();
  } catch(e){ /* sin sesión o sin conexión: se queda en el formulario */ }
}
redirectIfLoggedIn();

// Si se vuelve a esta pantalla con el botón "Atrás", el navegador la muestra congelada tal como quedó
// (con el botón en "Ingresando..." y sin reaccionar): se la deja lista de nuevo.
window.addEventListener('pageshow', e => {
  if(!e.persisted) return;
  restablecerBoton();
  errEl.textContent = '';
  passEl.value = '';
  redirectIfLoggedIn();
});
