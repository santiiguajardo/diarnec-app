import { sb } from '../shared/supabase-client.js';
import { requireAdmin } from '../shared/auth-guard.js';
import { mountLayout } from '../shared/layout.js';
import { dateTime } from '../shared/format.js';
import { confirmDialog } from '../shared/dialogs.js';

let reglas = [];
let editandoId = null;

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const $ = id => document.getElementById(id);
const ESTADOS = { enviado: ['ig-on', 'Enviado'], error: ['ig-err', 'Error'], procesando: ['ig-off', 'Procesando'] };

(async function init(){
  if(!(await requireAdmin())) return;
  const content = await mountLayout('instagram', 'Mensajes de Instagram');

  content.innerHTML = `
    <section class="ig-card">
      <header class="ig-head">
        <h3 id="ig-form-titulo">Nueva regla</h3>
        <p>Cuando alguien comenta una de las palabras clave, recibe el mensaje por privado. Se contesta una sola vez por comentario.</p>
      </header>
      <div class="ig-form">
        <label>Nombre de la regla<input type="text" id="ig-nombre" maxlength="80" placeholder="Ej: Guía de estructuras"></label>
        <label>Palabras clave <small>(separadas por coma)</small><input type="text" id="ig-palabras" placeholder="quiero, guia, info"></label>
        <label class="ancho">Mensaje privado <small>(podés usar {usuario} para nombrar a quien comentó)</small>
          <textarea id="ig-mensaje" maxlength="1000" placeholder="Hola {usuario}! Acá tenés lo que pediste: https://..."></textarea></label>
        <label>Respuesta pública <small>(opcional, se ve bajo el comentario)</small><input type="text" id="ig-publica" maxlength="300" placeholder="Te lo mandé por mensaje 📩"></label>
        <label>ID de la publicación <small>(opcional; vacío = todas)</small><input type="text" id="ig-media" placeholder="Copialo de la tabla de abajo" inputmode="numeric"></label>
      </div>
      <div class="ig-acciones-form">
        <button class="ig-btn ig-btn-rosa" id="ig-guardar">Guardar regla</button>
        <button class="ig-btn ig-btn-gris" id="ig-cancelar" hidden>Cancelar edición</button>
      </div>
      <div class="ig-aviso" id="ig-aviso" role="status"></div>
    </section>

    <section class="ig-card">
      <header class="ig-head"><h3>Reglas</h3><p>Si dos reglas coinciden con un comentario, se usa la primera de la lista.</p></header>
      <table>
        <thead><tr><th>Regla</th><th>Palabras</th><th>Mensaje</th><th>Publicación</th><th>Estado</th><th></th></tr></thead>
        <tbody id="ig-reglas"></tbody>
      </table>
    </section>

    <section class="ig-card ig-hist">
      <header class="ig-head"><h3>Últimos envíos</h3><p>Los 50 comentarios más recientes que dispararon una regla. El ID de publicación sirve para limitar una regla a un reel.</p></header>
      <table>
        <thead><tr><th>Fecha</th><th>Usuario</th><th>Comentario</th><th>ID publicación</th><th>Estado</th></tr></thead>
        <tbody id="ig-envios"></tbody>
      </table>
    </section>
  `;

  $('ig-guardar').addEventListener('click', guardar);
  $('ig-cancelar').addEventListener('click', limpiarForm);
  $('ig-reglas').addEventListener('click', onAccion);
  await Promise.all([cargarReglas(), cargarEnvios()]);
})();

function aviso(texto, tipo){
  const el = $('ig-aviso');
  el.textContent = texto || '';
  el.className = 'ig-aviso' + (texto ? ' ' + tipo : '');
}

async function cargarReglas(){
  const { data, error } = await sb.from('ig_reglas').select('*').order('id');
  if(error){ aviso('No se pudieron cargar las reglas: ' + error.message, 'error'); return; }
  reglas = data;
  $('ig-reglas').innerHTML = reglas.length ? reglas.map(r => `
    <tr>
      <td><b>${esc(r.nombre)}</b></td>
      <td>${r.palabras.map(p => `<span class="ig-chip">${esc(p)}</span>`).join('')}</td>
      <td><div class="ig-msg">${esc(r.mensaje_dm)}</div>${r.respuesta_publica ? `<div class="ig-msg" style="color:var(--muted);margin-top:6px;">💬 ${esc(r.respuesta_publica)}</div>` : ''}</td>
      <td>${r.media_id ? `<span class="ig-mono">${esc(r.media_id)}</span>` : 'Todas'}</td>
      <td><span class="ig-pill ${r.activa ? 'ig-on' : 'ig-off'}">${r.activa ? 'Activa' : 'Pausada'}</span></td>
      <td class="ig-acciones">
        <button class="ig-mini ig-mini-grey" data-act="editar" data-id="${r.id}">Editar</button>
        <button class="ig-mini ig-mini-green" data-act="toggle" data-id="${r.id}">${r.activa ? 'Pausar' : 'Activar'}</button>
        <button class="ig-mini ig-mini-red" data-act="borrar" data-id="${r.id}">Borrar</button>
      </td>
    </tr>`).join('') : '<tr><td colspan="6" style="color:var(--muted);">Todavía no hay reglas. Creá la primera arriba.</td></tr>';
}

async function cargarEnvios(){
  const { data, error } = await sb.from('ig_envios').select('*').order('creado', { ascending: false }).limit(50);
  if(error){ aviso('No se pudo cargar el registro: ' + error.message, 'error'); return; }
  $('ig-envios').innerHTML = data.length ? data.map(e => {
    const [cls, lbl] = ESTADOS[e.estado] || ESTADOS.procesando;
    return `<tr>
      <td>${dateTime(e.creado)}</td>
      <td>${e.usuario_ig ? '@' + esc(e.usuario_ig) : '—'}</td>
      <td>${esc(e.comentario)}</td>
      <td class="ig-mono">${esc(e.media_id || '—')}</td>
      <td><span class="ig-pill ${cls}" title="${esc(e.detalle)}">${lbl}</span></td>
    </tr>`;
  }).join('') : '<tr><td colspan="5" style="color:var(--muted);">Todavía no se envió ningún mensaje.</td></tr>';
}

function limpiarForm(){
  editandoId = null;
  for(const id of ['ig-nombre', 'ig-palabras', 'ig-mensaje', 'ig-publica', 'ig-media']) $(id).value = '';
  $('ig-form-titulo').textContent = 'Nueva regla';
  $('ig-cancelar').hidden = true;
  aviso('');
}

async function guardar(){
  const nombre = $('ig-nombre').value.trim();
  const palabras = [...new Set($('ig-palabras').value.split(',').map(p => p.trim()).filter(Boolean))];
  const mensaje = $('ig-mensaje').value.trim();
  const publica = $('ig-publica').value.trim();
  const media = $('ig-media').value.trim();

  if(!nombre) return aviso('Poné un nombre para la regla.', 'error');
  if(!palabras.length) return aviso('Cargá al menos una palabra clave.', 'error');
  if(!mensaje) return aviso('Escribí el mensaje que se va a enviar.', 'error');
  if(media && !/^\d+$/.test(media)) return aviso('El ID de la publicación son solo números.', 'error');

  const fila = { nombre, palabras, mensaje_dm: mensaje, respuesta_publica: publica || null, media_id: media || null };
  $('ig-guardar').disabled = true;
  const { error } = editandoId
    ? await sb.from('ig_reglas').update(fila).eq('id', editandoId)
    : await sb.from('ig_reglas').insert(fila);
  $('ig-guardar').disabled = false;
  if(error) return aviso('No se pudo guardar: ' + error.message, 'error');

  const editaba = editandoId !== null;
  limpiarForm();
  aviso(editaba ? 'Regla actualizada.' : 'Regla creada.', 'ok');
  await cargarReglas();
}

async function onAccion(ev){
  const btn = ev.target.closest('button[data-act]');
  if(!btn) return;
  const regla = reglas.find(r => r.id === Number(btn.dataset.id));
  if(!regla) return;

  if(btn.dataset.act === 'editar'){
    editandoId = regla.id;
    $('ig-nombre').value = regla.nombre;
    $('ig-palabras').value = regla.palabras.join(', ');
    $('ig-mensaje').value = regla.mensaje_dm;
    $('ig-publica').value = regla.respuesta_publica || '';
    $('ig-media').value = regla.media_id || '';
    $('ig-form-titulo').textContent = 'Editando: ' + regla.nombre;
    $('ig-cancelar').hidden = false;
    aviso('');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }

  if(btn.dataset.act === 'toggle'){
    const { error } = await sb.from('ig_reglas').update({ activa: !regla.activa }).eq('id', regla.id);
    if(error) return aviso('No se pudo cambiar el estado: ' + error.message, 'error');
  } else if(btn.dataset.act === 'borrar'){
    if(!(await confirmDialog('¿Borrar la regla "' + regla.nombre + '"? Los envíos ya hechos quedan en el registro.', { confirmLabel: 'Borrar' }))) return;
    const { error } = await sb.from('ig_reglas').delete().eq('id', regla.id);
    if(error) return aviso('No se pudo borrar: ' + error.message, 'error');
    if(editandoId === regla.id) limpiarForm();
  }
  await cargarReglas();
}
