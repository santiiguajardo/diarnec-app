-- 0035 — Eliminar un producto (solo si ya está dado de baja).
--
-- Reglas (se hacen cumplir acá, no solo en la pantalla):
--   · Lo puede usar el personal (admin y encargado).
--   · El producto tiene que estar dado de baja (activo = false): primero se da de baja, después se elimina.
--   · Si el producto tiene ventas, devoluciones o bonificaciones registradas NO se puede eliminar: se borraría
--     parte de la historia de esas operaciones. Queda dado de baja (no aparece en la tienda ni en las listas).
--   · Si solo tiene stock o movimientos de stock, se descartan junto con el producto (la pantalla avisa antes).
-- Devuelve cuántas unidades de stock y movimientos se descartaron.

create or replace function eliminar_producto(p_id bigint) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_prod productos%rowtype;
  v_stock numeric;
  v_movs int;
  v_lotes int;
begin
  if not es_staff() then
    raise exception 'No autorizado';
  end if;

  select * into v_prod from productos where id = p_id for update;
  if not found then
    raise exception 'El producto no existe';
  end if;
  if v_prod.activo then
    raise exception 'Primero dá de baja el producto; después se puede eliminar';
  end if;

  if exists (select 1 from ventas_items where producto_id = p_id) then
    raise exception '"%" tiene ventas registradas: no se puede eliminar para no perder el historial. Queda dado de baja.', v_prod.nombre;
  end if;
  if exists (select 1 from devoluciones_items where producto_id = p_id) then
    raise exception '"%" tiene devoluciones registradas: no se puede eliminar para no perder el historial. Queda dado de baja.', v_prod.nombre;
  end if;
  if exists (select 1 from bonificaciones_items where producto_id = p_id) then
    raise exception '"%" tiene bonificaciones registradas: no se puede eliminar para no perder el historial. Queda dado de baja.', v_prod.nombre;
  end if;

  select coalesce(sum(cantidad_restante), 0), count(*) into v_stock, v_lotes from stock_lotes where producto_id = p_id;
  select count(*) into v_movs from movimientos_stock where producto_id = p_id;

  delete from movimientos_stock where producto_id = p_id;
  delete from stock_lotes where producto_id = p_id;
  delete from productos where id = p_id;

  return jsonb_build_object('nombre', v_prod.nombre, 'stock_descartado', v_stock, 'lotes', v_lotes, 'movimientos', v_movs);
end;
$$;

revoke all on function eliminar_producto(bigint) from public, anon;
grant execute on function eliminar_producto(bigint) to authenticated;
