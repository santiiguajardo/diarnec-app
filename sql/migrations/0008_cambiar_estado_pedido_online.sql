-- DIARNEC — un pedido online puede pasar libremente entre 3 estados:
-- pendiente / confirmada (= "Pasar a venta") / anulada (= "Cancelado").
-- El stock solo está descontado mientras el pedido está 'confirmada':
--   * a 'confirmada' desde otro estado  -> descuenta stock (FEFO)
--   * desde 'confirmada' a otro estado  -> repone stock (lote nuevo, como anular_venta)
--   * pendiente <-> anulada             -> no toca stock

create or replace function cambiar_estado_pedido_online(p_venta_id bigint, p_nuevo_estado text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_estado text;
  v_item record;
  v_lote_id bigint;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  if p_nuevo_estado not in ('pendiente','confirmada','anulada') then
    raise exception 'Estado inválido: %', p_nuevo_estado;
  end if;

  select estado into v_estado from ventas where id = p_venta_id and canal = 'online' for update;
  if v_estado is null then
    raise exception 'El pedido % no existe', p_venta_id;
  end if;
  if v_estado = p_nuevo_estado then
    return;
  end if;

  if p_nuevo_estado = 'confirmada' then
    for v_item in select producto_id, cantidad from ventas_items where venta_id = p_venta_id loop
      perform _fefo_consumir(v_item.producto_id, v_item.cantidad, 'venta', p_venta_id);
    end loop;
  elsif v_estado = 'confirmada' then
    for v_item in select producto_id, cantidad from ventas_items where venta_id = p_venta_id loop
      insert into stock_lotes (producto_id, lote, cantidad_inicial, cantidad_restante, created_by)
      values (v_item.producto_id, 'ANULACION-VENTA-' || p_venta_id, v_item.cantidad, v_item.cantidad, auth.uid())
      returning id into v_lote_id;

      insert into movimientos_stock (producto_id, lote_id, tipo, cantidad, venta_id, motivo, created_by)
      values (v_item.producto_id, v_lote_id, 'anulacion', v_item.cantidad, p_venta_id, 'Cambio de estado del pedido online', auth.uid());

      update productos set stock_actual = stock_actual + v_item.cantidad, updated_at = now()
      where id = v_item.producto_id;
    end loop;
  end if;

  update ventas set estado = p_nuevo_estado where id = p_venta_id;
end;
$$;
revoke all on function cambiar_estado_pedido_online(bigint, text) from anon;
grant execute on function cambiar_estado_pedido_online(bigint, text) to authenticated;
