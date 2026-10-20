-- 0040 — El historial de precios también registra los cambios de COSTO (precio de compra).
--
-- precios_historial pasa a tener una columna "campo": 'venta' (lo que cobrás) o 'costo' (lo que pagás).
-- Las filas que ya existían son todas de venta. Los cambios de costo anteriores a hoy no se conservaron.
--
-- Solo se anotan cambios sobre un precio que ya existía: pasar de $0 (todavía sin cargar) a un valor es "cargar
-- el precio", no un aumento, y ensuciaría el reporte.

alter table precios_historial
  add column if not exists campo text not null default 'venta' check (campo in ('venta', 'costo'));

create or replace function _registrar_cambio_de_precio() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.precio_venta is distinct from old.precio_venta and coalesce(old.precio_venta, 0) > 0 then
    insert into precios_historial (producto_id, campo, precio_anterior, precio_nuevo)
    values (new.id, 'venta', old.precio_venta, coalesce(new.precio_venta, 0));
  end if;
  if new.precio_compra is distinct from old.precio_compra and coalesce(old.precio_compra, 0) > 0 then
    insert into precios_historial (producto_id, campo, precio_anterior, precio_nuevo)
    values (new.id, 'costo', old.precio_compra, coalesce(new.precio_compra, 0));
  end if;
  return new;
end;
$$;

drop trigger if exists productos_historial_de_precios on productos;
create trigger productos_historial_de_precios
  after update of precio_venta, precio_compra on productos
  for each row when (old.precio_venta is distinct from new.precio_venta or old.precio_compra is distinct from new.precio_compra)
  execute function _registrar_cambio_de_precio();
