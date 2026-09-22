-- DIARNEC — permite editar los items de un pedido online mientras sigue 'pendiente'
-- (antes de pasarlo a venta). Como todavía no descontó stock, alcanza con reemplazar
-- ventas_items y recalcular los totales — no hay que tocar stock_lotes/movimientos_stock.

create or replace function editar_pedido_online(p_venta_id bigint, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_vendedor_id bigint;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
  v_subtotal numeric;
  v_total_bruto numeric := 0;
  v_total_comision numeric := 0;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;

  select vendedor_id into v_vendedor_id from ventas
  where id = p_venta_id and canal = 'online' and estado = 'pendiente';
  if v_vendedor_id is null then
    raise exception 'El pedido % no existe o ya fue procesado', p_venta_id;
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'El pedido no puede quedar sin items';
  end if;

  delete from ventas_items where venta_id = p_venta_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null or v_precio < 0 then
      raise exception 'Item inválido para el producto %', v_producto_id;
    end if;

    v_pct := resolver_comision(v_vendedor_id, v_producto_id);
    v_subtotal := v_precio * v_cantidad;
    v_total_bruto := v_total_bruto + v_subtotal;
    v_total_comision := v_total_comision + (v_subtotal * v_pct / 100);

    insert into ventas_items (venta_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (p_venta_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);
  end loop;

  update ventas set
    total_bruto = v_total_bruto,
    total_descuento_comision = v_total_comision,
    total_neto = v_total_bruto - v_total_comision
  where id = p_venta_id;
end;
$$;
revoke all on function editar_pedido_online(bigint, jsonb) from anon;
grant execute on function editar_pedido_online(bigint, jsonb) to authenticated;
