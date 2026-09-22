// Selector de producto con buscador: al enfocar despliega la lista completa, y al tipear
// filtra (sin distinguir mayúsculas ni tildes, todas las palabras deben aparecer en
// marca + nombre + presentación). Reemplaza al <select> nativo, que con ~70 productos
// era incómodo. Se comporta como un <select>: tiene .value (id del producto, como texto)
// y dispara "change" cuando el usuario elige uno.

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// productos: [{ id, nombre, unidad, marcas: { nombre, color } }]
export function createProductPicker(productos){
  const items = productos.map(p => {
    const marca = p.marcas ? p.marcas.nombre : '';
    const unidad = p.unidad || '';
    return {
      id: String(p.id), marca, unidad, nombre: p.nombre, color: p.marcas ? (p.marcas.color || '') : '',
      label: `${marca ? marca + ' - ' : ''}${p.nombre}${unidad ? ' (' + unidad + ')' : ''}`,
      haystack: norm(`${marca} ${p.nombre} ${unidad}`)
    };
  }).sort((a, b) => a.marca.localeCompare(b.marca, 'es') || a.nombre.localeCompare(b.nombre, 'es'));
  const byId = new Map(items.map(i => [i.id, i]));

  const root = document.createElement('div');
  root.className = 'pp item-producto';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'pp-input';
  input.placeholder = 'Buscar producto…';
  input.autocomplete = 'off';
  input.spellcheck = false;
  const list = document.createElement('div');
  list.className = 'pp-list';
  list.hidden = true;
  root.append(input, list);

  let selectedId = null;
  let shown = [];
  let active = -1;

  const labelOf = id => {
    const it = byId.get(id);
    return it ? it.label : (id ? `Producto #${id} (no disponible)` : '');
  };

  function highlight(){
    [...list.children].forEach((el, i) => el.classList.toggle('active', i === active));
    const el = list.children[active];
    if(!el) return;
    const top = el.offsetTop, bottom = top + el.offsetHeight;
    if(top < list.scrollTop) list.scrollTop = top - 4;
    else if(bottom > list.scrollTop + list.clientHeight) list.scrollTop = bottom - list.clientHeight + 4;
  }

  function render(query){
    const tokens = norm(query).split(/\s+/).filter(Boolean);
    shown = items.filter(it => tokens.every(t => it.haystack.includes(t)));
    active = tokens.length ? 0 : shown.findIndex(it => it.id === selectedId);
    if(active < 0 && shown.length) active = 0;
    list.innerHTML = shown.length
      ? shown.map((it, i) => `
          <div class="pp-opt" data-i="${i}">
            <span class="pp-dot" style="background:${esc(it.color || '#e4e2da')}"></span>
            <b>${esc(it.marca)}</b>
            <span class="pp-name">${esc(it.nombre)}</span>
            ${it.unidad ? `<small>${esc(it.unidad)}</small>` : ''}
          </div>`).join('')
      : '<div class="pp-empty">Sin resultados</div>';
    highlight();
  }

  function place(){
    const r = input.getBoundingClientRect();
    const width = Math.max(r.width, 440);
    const left = Math.max(8, Math.min(r.left, window.innerWidth - width - 8));
    const below = window.innerHeight - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 200 && above > below;
    const maxH = Math.max(140, Math.min(340, up ? above : below));
    Object.assign(list.style, {
      left: left + 'px', width: width + 'px', maxHeight: maxH + 'px',
      top: up ? 'auto' : (r.bottom + 4) + 'px',
      bottom: up ? (window.innerHeight - r.top + 4) + 'px' : 'auto'
    });
  }

  const onScroll = e => { if(!list.contains(e.target)) closeList(); };

  function openList(){
    if(!list.hidden) return;
    list.hidden = false;
    place();
    render('');
    document.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', closeList);
  }

  function closeList(){
    if(list.hidden) return;
    list.hidden = true;
    document.removeEventListener('scroll', onScroll, true);
    window.removeEventListener('resize', closeList);
  }

  function choose(id){
    selectedId = id;
    input.value = labelOf(id);
    closeList();
    root.dispatchEvent(new Event('change', { bubbles: true }));
  }

  input.addEventListener('focus', () => { input.select(); openList(); });
  input.addEventListener('click', openList);
  input.addEventListener('input', () => {
    if(list.hidden){ list.hidden = false; place(); document.addEventListener('scroll', onScroll, true); window.addEventListener('resize', closeList); }
    render(input.value);
  });
  input.addEventListener('keydown', e => {
    if(e.key === 'ArrowDown' || e.key === 'ArrowUp'){
      e.preventDefault();
      if(list.hidden){ openList(); return; }
      if(!shown.length) return;
      active = e.key === 'ArrowDown' ? Math.min(active + 1, shown.length - 1) : Math.max(active - 1, 0);
      highlight();
    } else if(e.key === 'Enter'){
      e.preventDefault();
      if(!list.hidden && shown[active]) choose(shown[active].id);
    } else if(e.key === 'Escape'){
      if(!list.hidden){ e.preventDefault(); e.stopPropagation(); closeList(); input.value = labelOf(selectedId); }
    }
  });
  input.addEventListener('blur', () => { closeList(); input.value = labelOf(selectedId); });

  // mousedown (no click) + preventDefault para que el input no pierda el foco antes de elegir
  list.addEventListener('mousedown', e => {
    e.preventDefault();
    const opt = e.target.closest('.pp-opt');
    if(opt) choose(shown[Number(opt.dataset.i)].id);
  });
  list.addEventListener('mouseover', e => {
    const opt = e.target.closest('.pp-opt');
    if(opt){ active = Number(opt.dataset.i); [...list.children].forEach((el, i) => el.classList.toggle('active', i === active)); }
  });

  Object.defineProperty(root, 'value', {
    get(){ return selectedId ?? ''; },
    set(v){ selectedId = v ? String(v) : null; input.value = labelOf(selectedId); }
  });
  root.focusInput = () => { input.focus(); input.select(); openList(); };

  return root;
}
