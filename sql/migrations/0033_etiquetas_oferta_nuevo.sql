-- 0033 — Etiqueta opcional de cada producto: 'oferta' o 'nuevo'. Se muestra como cartelito sobre la foto en la tienda
-- (y hay filtros "Ofertas" / "Nuevos" cuando hay productos con esa etiqueta). Se elige en Inventario → tocando la foto.

alter table productos add column if not exists etiqueta text;

alter table productos drop constraint if exists productos_etiqueta_valida;
alter table productos add constraint productos_etiqueta_valida check (etiqueta is null or etiqueta in ('oferta', 'nuevo'));

-- La tienda (clave pública) puede leer la etiqueta; el costo y el stock siguen sin ser legibles.
grant select (etiqueta) on productos to anon;
