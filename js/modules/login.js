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

async function irAlPanel(){
  const perfil = await getPerfil();
  if(!perfil){
    await sb.auth.signOut();
    errEl.textContent = MSG_SIN_ACCESO;
    return false;
  }
  window.location.href = pantallaInicial(perfil);
  return true;
}

async function tryLogin(){
  const username = userEl.value.trim();
  const pass = passEl.value;
  errEl.textContent = '';
  if(!username || !pass) return;

  btn.disabled = true;
  btn.textContent = 'Ingresando...';

  const { error } = await sb.auth.signInWithPassword({ email: usernameToEmail(username), password: pass });

  if(error){
    btn.disabled = false;
    btn.textContent = 'Ingresar';
    errEl.textContent = 'Usuario o contraseña incorrectos.';
    return;
  }
  const ok = await irAlPanel();
  if(!ok){
    btn.disabled = false;
    btn.textContent = 'Ingresar';
  }
}

btn.addEventListener('click', tryLogin);
[userEl, passEl].forEach(el => el.addEventListener('keydown', e => {
  if(e.key === 'Enter') tryLogin();
}));

(async function redirectIfLoggedIn(){
  if(new URLSearchParams(location.search).get('motivo') === 'sin-acceso'){
    errEl.textContent = MSG_SIN_ACCESO;
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if(session) await irAlPanel();
})();
