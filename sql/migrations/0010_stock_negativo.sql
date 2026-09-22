-- DIARNEC — se puede vender sin stock suficiente: el faltante queda como stock NEGATIVO.
-- Antes _fefo_consumir tiraba "Stock insuficiente". Ahora consume lo que haya en los lotes
-- (FEFO) y el resto se anota en un lote especial 'FALTANTE' con cantidad_restante negativa,
-- más un movimiento en movimientos_stock (el historial queda completo).
-- Cuando después entra mercadería (ingreso, devolución, anulación, ajuste +), el lote nuevo
-- absorbe el faltante: el stock vuelve a subir desde el negativo. productos.stock_actual
-- sigue siendo la suma de los lotes, así que nunca se descuadra.

alter table stock_lotes drop constraint if exists stock_lotes_cantidad_restante_check;
alter table stock_lotes add constraint stock_lotes_cantidad_restante_check
  check (cantidad_restante >= 0 or lote = 'FALTANTE');

create or replace function _fefo_consumir(
  p_producto_id bigint, p_cantidad numeric, p_tipo text,
  p_venta_id bigint default null, p_devolucion_id bigint default null, p_motivo text default null
) returns void language plpgsql as $$
declare
  v_restante numeric := p_cantidad;
  v_lote record;
  v_tomar numeric;
  v_falt_id bigint;
begin
  if p_cantidad <= 0 then
    raise exception 'La cantidad a consumir debe ser mayor a 0';
  end if;

  for v_lote in
    select id, cantidad_restante from stock_lotes
    where producto_id = p_producto_id and cantidad_restante > 0
    order by fecha_vencimiento nulls last, id
    for update
  loop
    exit when v_restante <= 0;
    v_tomar := least(v_lote.cantidad_restante, v_restante);
    update stock_lotes set cantidad_restante = cantidad_restante - v_tomar where id = v_lote.id;
    insert into movimientos_stock (producto_id, lote_id, tipo, cantidad, venta_id, devolucion_id, motivo, created_by)
    values (p_producto_id, v_lote.id, p_tipo, -v_tomar, p_venta_id, p_devolucion_id, p_motivo, auth.uid());
    v_restante := v_restante - v_tomar;
  end loop;

  if v_restante > 0 then
    select id into v_falt_id from stock_lotes
    where producto_id = p_producto_id and lote = 'FALTANTE' limit 1 for update;

    if v_falt_id is null then
      insert into stock_lotes (producto_id, lote, cantidad_inicial, cantidad_restante, created_by)
      values (p_producto_id, 'FALTANTE', 0, -v_restante, auth.uid())
      returning id into v_falt_id;
    else
      update stock_lotes set cantidad_restante = cantidad_restante - v_restante where id = v_falt_id;
    end if;

    insert into movimientos_stock (producto_id, lote_id, tipo, cantidad, venta_id, devolucion_id, motivo, created_by)
    values (p_producto_id, v_falt_id, p_tipo, -v_restante, p_venta_id, p_devolucion_id,
            trim(coalesce(p_motivo, '') || ' (sin stock: queda en negativo)'), auth.uid());
  end if;

  update productos set stock_actual = stock_actual - p_cantidad, updated_at = now() where id = p_producto_id;
end;
$$;

-- Compensa el faltante (lote negativo) con un lote recién ingresado.
create or replace function _absorber_faltante(p_producto_id bigint, p_lote_id bigint)
returns void language plpgsql as $$
declare
  v_falt_id bigint;
  v_falt numeric;
  v_nuevo numeric;
  v_abs numeric;
begin
  select id, cantidad_restante into v_falt_id, v_falt from stock_lotes
  where producto_id = p_producto_id and lote = 'FALTANTE' and cantidad_restante < 0
  limit 1 for update;
  if v_falt_id is null then
    return;
  end if;

  select cantidad_restante into v_nuevo from stock_lotes where id = p_lote_id;
  v_abs := least(v_nuevo, -v_falt);
  if v_abs <= 0 then
    return;
  end if;

  update stock_lotes set cantidad_restante = cantidad_restante - v_abs where id = p_lote_id;
  update stock_lotes set cantidad_restante = cantidad_restante + v_abs where id = v_falt_id;
end;
$$;
revoke all on function _absorber_faltante(bigint, bigint) from public;

-- ===== Funciones que suman stock: cada lote nuevo absorbe el faltante =====

create or replace function registrar_ingreso_stock(
  p_producto_id bigint, p_lote text, p_fecha_vencimiento date,
  p_cantidad numeric, p_costo_unitario numeric, p_proveedor_id bigint
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_lote_id bigint;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  if p_cantidad <= 0 then
    raise exception 'La cantidad debe ser mayor a 0';
  end if;

  insert into stock_lotes (producto_id, lote, fecha_vencimiento, cantidad_inicial, cantidad_restante, costo_unitario, proveedor_id, created_by)
  values (p_producto_id, coalesce(p_lote, ''), p_fecha_vencimiento, p_cantidad, p_cantidad, coalesce(p_costo_unitario, 0), p_proveedor_id, auth.uid())
  returning id into v_lote_id;

  insert into movimientos_stock (producto_id, lote_id, tipo, cantidad, created_by)
  values (p_producto_id, v_lote_id, 'entrada', p_cantidad, auth.uid());

  perform _absorber_faltante(p_producto_id, v_lote_id);
  update productos set stock_actual = stock_actual + p_cantidad, updated_at = now() where id = p_producto_id;
  return v_lote_id;
end;
$$;

create or replace function registrar_ajuste_stock(p_producto_id bigint, p_cantidad_delta numeric, p_motivo text)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_lote_id bigint;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  if p_cantidad_delta = 0 then
    raise exception 'El ajuste no puede ser 0';
  end if;

  if p_cantidad_delta < 0 then
    perform _fefo_consumir(p_producto_id, -p_cantidad_delta, 'merma', null, null, p_motivo);
  else
    insert into stock_lotes (producto_id, lote, cantidad_inicial, cantidad_restante, created_by)
    values (p_producto_id, 'AJUSTE-' || to_char(now(), 'YYYYMMDDHH24MISS'), p_cantidad_delta, p_cantidad_delta, auth.uid())
    returning id into v_lote_id;

    insert into movimientos_stock (producto_id, lote_id, tipo, cantidad, motivo, created_by)
    values (p_producto_id, v_lote_id, 'ajuste', p_cantidad_delta, p_motivo, auth.uid());

    perform _absorber_faltante(p_producto_id, v_lote_id);
    update productos set stock_actual = stock_actual + p_cantidad_delta, updated_at = now() where id = p_producto_id;
  end if;
end;
$$;

create or replace function anular_venta(p_venta_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_item record;
  v_lote_id bigint;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;

  if not exists (select 1 from ventas where id = p_venta_id and estado = 'confirmada') then
    raise exception 'La venta % no existe o ya está anulada', p_venta_id;
  end if;

  for v_item in select producto_id, cantidad from ventas_items where venta_id = p_venta_id loop
    insert into stock_lotes (producto_id, lote, cantidad_inicial, cantidad_restante, created_by)
    values (v_item.producto_id, 'ANULACION-VENTA-' || p_venta_id, v_item.cantidad, v_item.cantidad, auth.uid())
    returning id into v_lote_id;

    insert into movimientos_stock (producto_id, lote_id, tipo, cantidad, venta_id, motivo, created_by)
    values (v_item.producto_id, v_lote_id, 'anulacion', v_item.cantidad, p_venta_id, 'Anulación de venta', auth.uid());

    perform _absorber_faltante(v_item.producto_id, v_lote_id);
    update productos set stock_actual = stock_actual + v_item.cantidad, updated_at = now()
    where id = v_item.producto_id;
  end loop;

  update ventas set estado = 'anulada' where id = p_venta_id;
end;
$$;

create or replace function registrar_devolucion(p_vendedor_id bigint, p_venta_id bigint, p_motivo text, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_devolucion_id bigint;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
  v_subtotal numeric;
  v_total numeric := 0;
  v_lote_id bigint;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  if jsonb_array_length(p_items) = 0 then
    raise exception 'La devolución no tiene items';
  end if;

  insert into devoluciones_cab (venta_id, vendedor_id, motivo, total, created_by)
  values (p_venta_id, p_vendedor_id, coalesce(p_motivo, ''), 0, auth.uid())
  returning id into v_devolucion_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    v_pct := coalesce((v_item->>'comision_pct')::numeric, 0);
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null then
      raise exception 'Item de devolución inválido para el producto %', v_producto_id;
    end if;

    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal;

    insert into devoluciones_items (devolucion_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (v_devolucion_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);

    insert into stock_lotes (producto_id, lote, cantidad_inicial, cantidad_restante, created_by)
    values (v_producto_id, 'DEVOLUCION-' || v_devolucion_id, v_cantidad, v_cantidad, auth.uid())
    returning id into v_lote_id;

    insert into movimientos_stock (producto_id, lote_id, tipo, cantidad, devolucion_id, motivo, created_by)
    values (v_producto_id, v_lote_id, 'devolucion', v_cantidad, v_devolucion_id, p_motivo, auth.uid());

    perform _absorber_faltante(v_producto_id, v_lote_id);
    update productos set stock_actual = stock_actual + v_cantidad, updated_at = now() where id = v_producto_id;
  end loop;

  update devoluciones_cab set total = v_total where id = v_devolucion_id;
  return v_devolucion_id;
end;
$$;

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

      perform _absorber_faltante(v_item.producto_id, v_lote_id);
      update productos set stock_actual = stock_actual + v_item.cantidad, updated_at = now()
      where id = v_item.producto_id;
    end loop;
  end if;

  update ventas set estado = p_nuevo_estado where id = p_venta_id;
end;
$$;
