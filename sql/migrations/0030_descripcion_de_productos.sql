-- 0030 — Descripción corta de cada producto (se muestra en la tienda online).
-- Sirve, por ejemplo, para aclarar en los productos por peso: "La horma trae aprox. 5 kg".
-- Se carga desde Inventario → tocando la foto del producto.

alter table productos add column if not exists descripcion text;

-- Máximo 200 caracteres (es un texto corto, no una ficha)
alter table productos drop constraint if exists productos_descripcion_largo;
alter table productos add constraint productos_descripcion_largo check (descripcion is null or char_length(descripcion) <= 200);

-- Segunda barrera contra HTML: se sacan < y > al guardar (la tienda y el panel además escapan al mostrar)
create or replace function _sin_html_producto() returns trigger language plpgsql as $$
begin
  new.descripcion := nullif(btrim(translate(new.descripcion, '<>', '')), '');
  return new;
end;
$$;
drop trigger if exists productos_sin_html on productos;
create trigger productos_sin_html before insert or update on productos
  for each row execute function _sin_html_producto();

-- La tienda (clave pública) puede leer la descripción, igual que nombre/precio/foto.
-- (Es un grant por columna: el costo y el stock siguen sin ser legibles para el público.)
grant select (descripcion) on productos to anon;
