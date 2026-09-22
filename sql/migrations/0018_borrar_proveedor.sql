-- 0018 — Borrar proveedor
--
-- Problema: el botón "Borrar" de Pago a proveedores fallaba en silencio. Un proveedor con pagos
-- ANULADOS (que la pantalla no muestra) no se podía borrar por la clave foránea, y el mensaje de error
-- salía con un alert() nativo que no se ve.
--
-- Regla nueva (una sola función, todo o nada):
--   · con pagos vigentes  → no se borra (hay que anularlos/borrarlos antes; son plata registrada)
--   · sin pagos vigentes  → se borran sus pagos anulados, sus marcas y lotes de stock quedan "sin proveedor"
--     (es solo un dato informativo) y se borra el proveedor.

create or replace function borrar_proveedor(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_nombre text;
  v_vigentes int;
begin
  if not es_staff() then
    raise exception 'No autorizado';
  end if;

  select nombre into v_nombre from proveedores where id = p_id;
  if not found then
    raise exception 'El proveedor no existe';
  end if;

  select count(*) into v_vigentes from pagos_proveedores where proveedor_id = p_id and not anulado;
  if v_vigentes > 0 then
    raise exception 'PAGOS_VIGENTES:%', v_vigentes;
  end if;

  delete from pagos_proveedores where proveedor_id = p_id;         -- solo quedan los anulados
  update marcas set proveedor_id = null where proveedor_id = p_id;
  update stock_lotes set proveedor_id = null where proveedor_id = p_id;
  delete from proveedores where id = p_id;
end;
$$;

revoke all on function borrar_proveedor(bigint) from public, anon;
grant execute on function borrar_proveedor(bigint) to authenticated;
