// Reemplaza confirm()/prompt() nativos: en algunos navegadores/contextos esos diálogos
// no se muestran y la llamada devuelve false o tira una excepción en silencio, dejando
// botones que "no hacen nada". Estos modales corren siempre igual, en cualquier navegador.

export function confirmDialog(message, { confirmLabel = 'Confirmar', cancelLabel = 'Cancelar' } = {}){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay';
    overlay.innerHTML = `
      <div class="app-confirm-box">
        <p>${message}</p>
        <div class="app-confirm-actions">
          <button class="app-confirm-cancel">${cancelLabel}</button>
          <button class="app-confirm-ok">${confirmLabel}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('.app-confirm-cancel').addEventListener('click', () => cleanup(false));
    overlay.querySelector('.app-confirm-ok').addEventListener('click', () => cleanup(true));
    overlay.addEventListener('click', e => { if(e.target === overlay) cleanup(false); });
    document.addEventListener('keydown', function onKey(e){
      if(e.key === 'Escape'){ document.removeEventListener('keydown', onKey); cleanup(false); }
    });
  });
}

// opciones.password: el campo muestra puntos (para contraseñas)
export function promptDialog(message, defaultValue = '', { password = false } = {}){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay';
    overlay.innerHTML = `
      <div class="app-confirm-box">
        <p>${message}</p>
        <input type="${password ? 'password' : 'text'}" class="app-prompt-input" value="${defaultValue}" ${password ? 'autocomplete="new-password"' : ''}>
        <div class="app-confirm-actions">
          <button class="app-confirm-cancel">Cancelar</button>
          <button class="app-confirm-ok">Aceptar</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);

    const input = overlay.querySelector('.app-prompt-input');
    input.focus();
    input.select();

    const cleanup = (result) => { overlay.remove(); resolve(result); };
    overlay.querySelector('.app-confirm-cancel').addEventListener('click', () => cleanup(null));
    overlay.querySelector('.app-confirm-ok').addEventListener('click', () => cleanup(input.value));
    input.addEventListener('keydown', e => {
      if(e.key === 'Enter') cleanup(input.value);
      if(e.key === 'Escape') cleanup(null);
    });
    overlay.addEventListener('click', e => { if(e.target === overlay) cleanup(null); });
  });
}

// Aviso con un solo botón. Los alert() nativos no se ven en todos los contextos y el error pasaba
// desapercibido; layout.js reemplaza window.alert por esto (instalarAvisos) en todo el panel.
export function alertDialog(message){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'app-confirm-overlay';
    overlay.innerHTML = `
      <div class="app-confirm-box">
        <p></p>
        <div class="app-confirm-actions"><button class="app-confirm-ok">Entendido</button></div>
      </div>`;
    overlay.querySelector('p').textContent = String(message ?? '');
    document.body.appendChild(overlay);
    const cleanup = () => { overlay.remove(); resolve(); };
    overlay.querySelector('.app-confirm-ok').addEventListener('click', cleanup);
    overlay.addEventListener('click', e => { if(e.target === overlay) cleanup(); });
    overlay.querySelector('.app-confirm-ok').focus();
  });
}

export function instalarAvisos(){
  window.alert = msg => { alertDialog(msg); };
}
