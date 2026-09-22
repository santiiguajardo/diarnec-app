import { sb } from '../shared/supabase-client.js';
import { requireAdmin, getPerfil } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { dateTime } from '../shared/format.js';
import { confirmDialog, promptDialog } from '../shared/dialogs.js';

const ROL_LABEL = { admin: 'Admin (main)', encargado: 'Encargado', vendedor: 'Vendedor' };
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let usuarios = [];
let yo = null;

(async function init(){
  if(!(await requireAdmin())) return;
  yo = await getPerfil();
  const content = await mountLayout('usuarios', 'Usuarios');

  content.innerHTML = `
    <div class="admin-section">
      <h3>Crear usuario</h3>
      <p style="color:var(--muted);font-size:13px;margin-bottom:14px;">
        Se crea un acceso interno (usuario + contraseña). No usa email, nadie recibe ningún correo.
        Un <b>vendedor</b> entra a su propio panel y ve solo lo suyo: sus movimientos, su ganancia, su cartera de clientes y la lista de precios.
        <b>Encargado</b> y <b>Admin</b> usan el panel de gestión (solo el Admin administra usuarios).
      </p>
      <div class="usr-form">
        <input type="text" id="u-username" placeholder="Usuario (ej: martin)" autocomplete="off">
        <input type="password" id="u-password" placeholder="Contraseña (mín. 6 caracteres)" autocomplete="new-password">
        <select id="u-rol">
          <option value="vendedor">Vendedor</option>
          <option value="encargado">Encargado</option>
          <option value="admin">Admin (main)</option>
        </select>
        <select id="u-vendedor"></select>
        <button class="btn-sm btn-add" id="u-crear">+ Crear usuario</button>
        <div class="usr-msg" id="u-msg"></div>
      </div>
    </div>

    <div class="admin-section">
      <h3>Usuarios con acceso</h3>
      <table>
        <thead><tr><th>Usuario</th><th>Rol</th><th>Vendedor</th><th>Creado</th><th></th></tr></thead>
        <tbody id="usuarios-body"></tbody>
      </table>
    </div>
  `;

  document.getElementById('u-crear').addEventListener('click', crearUsuario);
  document.getElementById('u-rol').addEventListener('change', actualizarCampoVendedor);
  document.getElementById('usuarios-body').addEventListener('click', onClickUsuarios);
  await cargarUsuarios();
})();

function actualizarCampoVendedor(){
  document.getElementById('u-vendedor').style.display = document.getElementById('u-rol').value === 'vendedor' ? '' : 'none';
}

async function cargarUsuarios(){
  const [{ data, error }, { data: vend }] = await Promise.all([
    sb.from('staff_usuarios').select('auth_user_id, username, rol, vendedor_id, created_at, vendedores(nombre)').order('created_at', { ascending: false }),
    sb.from('vendedores').select('id, nombre').eq('activo', true).eq('es_canal_online', false).order('nombre')
  ]);
  usuarios = data || [];

  // Para un usuario vendedor se elige a qué vendedor corresponde (uno que todavía no tenga usuario)
  const conUsuario = new Set(usuarios.map(u => u.vendedor_id).filter(Boolean));
  const libres = (vend || []).filter(v => !conUsuario.has(v.id));
  const sel = document.getElementById('u-vendedor');
  sel.innerHTML = libres.length
    ? '<option value="">Elegí el vendedor…</option>' + libres.map(v => `<option value="${v.id}">${esc(v.nombre)}</option>`).join('')
    : '<option value="">Todos los vendedores ya tienen usuario</option>';
  actualizarCampoVendedor();

  const tbody = document.getElementById('usuarios-body');
  if(error){
    tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No se pudo cargar: ${esc(error.message)}</td></tr>`;
    return;
  }
  tbody.innerHTML = usuarios.length === 0
    ? `<tr><td colspan="5" class="empty-row">Todavía no hay usuarios.</td></tr>`
    : usuarios.map(u => {
        const soyYo = u.username === yo.username;
        return `
      <tr>
        <td>${esc(u.username)}${soyYo ? ' <small style="color:var(--muted);">(vos)</small>' : ''}</td>
        <td><span class="rol-badge rol-${u.rol}">${ROL_LABEL[u.rol] || u.rol}</span></td>
        <td>${u.vendedores ? esc(u.vendedores.nombre) : '—'}</td>
        <td>${dateTime(u.created_at)}</td>
        <td><div class="row-actions">
          <button class="btn-sm btn-grey" data-act="password" data-id="${u.auth_user_id}" title="Cambiarle la contraseña">🔑 Contraseña</button>
          <button class="btn-sm btn-del" data-act="eliminar" data-id="${u.auth_user_id}" ${soyYo ? 'disabled title="No podés eliminar tu propio usuario"' : ''}>Eliminar</button>
        </div></td>
      </tr>`;
      }).join('');
}

// sb.functions.invoke() no siempre trae el mensaje de error real del servidor en error.message
// (a veces es un genérico "non-2xx status code"): hay que leer el body de error.context.
async function extraerError(error, data){
  if(data && data.error) return data.error;
  if(error && error.context && typeof error.context.json === 'function'){
    try {
      const body = await error.context.json();
      if(body && body.error) return body.error;
    } catch(e){ /* el body no era JSON, seguimos con error.message */ }
  }
  return (error && error.message) || 'No se pudo completar la operación.';
}

async function llamar(body){
  const { data, error } = await sb.functions.invoke('crear-usuario', { body });
  if(error || (data && data.error)) return { error: await extraerError(error, data) };
  return { data };
}

function mensaje(texto, ok){
  const msg = document.getElementById('u-msg');
  msg.className = 'usr-msg ' + (ok ? 'ok' : 'err');
  msg.textContent = texto;
}

async function crearUsuario(){
  const username = document.getElementById('u-username').value.trim();
  const password = document.getElementById('u-password').value;
  const rol = document.getElementById('u-rol').value;
  const vendedor_id = rol === 'vendedor' ? Number(document.getElementById('u-vendedor').value) : null;
  mensaje('', true);

  if(!username || !password){ mensaje('Completá usuario y contraseña.', false); return; }
  if(rol === 'vendedor' && !vendedor_id){ mensaje('Elegí a qué vendedor corresponde este usuario.', false); return; }

  const btn = document.getElementById('u-crear');
  btn.disabled = true;
  btn.textContent = 'Creando…';
  const { data, error } = await llamar({ accion: 'crear', username, password, rol, vendedor_id });
  btn.disabled = false;
  btn.textContent = '+ Crear usuario';

  if(error){ mensaje(error, false); return; }
  mensaje(`Usuario "${data.username}" creado. Ya puede entrar con su usuario y contraseña.`, true);
  document.getElementById('u-username').value = '';
  document.getElementById('u-password').value = '';
  document.getElementById('u-rol').value = 'vendedor';
  await cargarUsuarios();
}

async function onClickUsuarios(e){
  const btn = e.target.closest('button[data-act]');
  if(!btn || btn.disabled) return;
  const u = usuarios.find(u => u.auth_user_id === btn.dataset.id);
  if(!u) return;

  if(btn.dataset.act === 'password'){
    const nueva = await promptDialog(`Nueva contraseña para "${u.username}" (mínimo 6 caracteres):`, '', { password: true });
    if(nueva === null) return;
    if(nueva.length < 6){ mensaje('La contraseña debe tener al menos 6 caracteres.', false); return; }
    const { error } = await llamar({ accion: 'cambiar_password', auth_user_id: u.auth_user_id, password: nueva });
    if(error){ mensaje(error, false); return; }
    mensaje(`Contraseña de "${u.username}" actualizada.`, true);
  } else if(btn.dataset.act === 'eliminar'){
    if(!(await confirmDialog(`¿Eliminar el usuario "${u.username}"?\nYa no podrá entrar${u.vendedores ? '. El vendedor ' + u.vendedores.nombre + ' y su historial se conservan' : ''}.`, { confirmLabel: 'Eliminar' }))) return;
    const { error } = await llamar({ accion: 'eliminar', auth_user_id: u.auth_user_id });
    if(error){ mensaje(error, false); return; }
    mensaje(`Usuario "${u.username}" eliminado.`, true);
    await cargarUsuarios();
  }
}
