-- DIARNEC — los pedidos de la tienda online ya no se confirman solos: quedan en estado
-- 'pendiente' (sin descontar stock todavía) hasta que el staff los revisa en el panel
-- "Tienda online" y los pasa a "Venta" (ahí sí se descuenta stock, vía _fefo_consumir,
-- igual que cualquier otra venta). Las ventas manuales (canal='manual') no cambian:
-- se confirman al toque, como siempre.

alter table ventas drop constraint if exists ventas_estado_check;
alter table ventas add constraint ventas_estado_check check (estado in ('pendiente','confirmada','anulada'));

create or replace function _crear_venta(
  p_vendedor_id bigint, p_canal text, p_cliente_nombre text, p_cliente_localidad text,
  p_items jsonb, p_trust_item_overrides boolean, p_cliente_id bigint default null
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_venta_id bigint;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
  v_subtotal numeric;
  v_total_bruto numeric := 0;
  v_total_comision numeric := 0;
  v_cliente_nombre text := p_cliente_nombre;
  v_estado text := case when p_canal = 'online' then 'pendiente' else 'confirmada' end;
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene items';
  end if;

  if p_cliente_id is not null then
    select nombre into v_cliente_nombre from clientes where id = p_cliente_id;
  end if;

  insert into ventas (vendedor_id, canal, cliente_id, cliente_nombre, cliente_localidad, estado, total_bruto, total_neto, created_by)
  values (p_vendedor_id, p_canal, p_cliente_id, coalesce(v_cliente_nombre, ''), coalesce(p_cliente_localidad, ''), v_estado, 0, 0, auth.uid())
  returning id into v_venta_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    if v_cantidad is null or v_cantidad <= 0 then
      raise exception 'Cantidad inválida para el producto %', v_producto_id;
    end if;

    if p_trust_item_overrides and (v_item ? 'precio_unitario') then
      v_precio := (v_item->>'precio_unitario')::numeric;
    else
      select precio_venta into v_precio from productos where id = v_producto_id;
    end if;
    if v_precio is null then
      raise exception 'Producto % no encontrado', v_producto_id;
    end if;

    if p_trust_item_overrides and (v_item ? 'comision_pct') then
      v_pct := (v_item->>'comision_pct')::numeric;
    else
      v_pct := resolver_comision(p_vendedor_id, v_producto_id);
    end if;

    v_subtotal := v_precio * v_cantidad;
    v_total_bruto := v_total_bruto + v_subtotal;
    v_total_comision := v_total_comision + (v_subtotal * v_pct / 100);

    insert into ventas_items (venta_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (v_venta_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);

    -- Un pedido online pendiente todavía no descuenta stock: recién cuando se confirma
    -- (confirmar_pedido_online) se corre el FEFO, igual que una venta manual normal.
    if v_estado = 'confirmada' then
      perform _fefo_consumir(v_producto_id, v_cantidad, 'venta', v_venta_id);
    end if;
  end loop;

  update ventas set
    total_bruto = v_total_bruto,
    total_descuento_comision = v_total_comision,
    total_neto = v_total_bruto - v_total_comision
  where id = v_venta_id;

  return v_venta_id;
end;
$$;

-- Pasa un pedido online de 'pendiente' a 'confirmada': recién acá se descuenta stock.
create or replace function confirmar_pedido_online(p_venta_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_item record;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  if not exists (select 1 from ventas where id = p_venta_id and canal = 'online' and estado = 'pendiente') then
    raise exception 'El pedido % no existe o ya fue procesado', p_venta_id;
  end if;

  for v_item in select producto_id, cantidad from ventas_items where venta_id = p_venta_id loop
    perform _fefo_consumir(v_item.producto_id, v_item.cantidad, 'venta', p_venta_id);
  end loop;

  update ventas set estado = 'confirmada' where id = p_venta_id;
end;
$$;
revoke all on function confirmar_pedido_online(bigint) from anon;
grant execute on function confirmar_pedido_online(bigint) to authenticated;

-- Rechaza un pedido pendiente (nunca tocó stock, así que no hay nada que revertir).
create or replace function rechazar_pedido_online(p_venta_id bigint)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  if not exists (select 1 from ventas where id = p_venta_id and canal = 'online' and estado = 'pendiente') then
    raise exception 'El pedido % no existe o ya fue procesado', p_venta_id;
  end if;
  update ventas set estado = 'anulada' where id = p_venta_id;
end;
$$;
revoke all on function rechazar_pedido_online(bigint) from anon;
grant execute on function rechazar_pedido_online(bigint) to authenticated;
