-- DIARNEC — funciones de negocio (ejecutar después de schema.sql)
-- Todo lo que mueve stock o dinero pasa por acá, nunca por INSERT/UPDATE directo del cliente
-- sobre ventas/ventas_items/stock_lotes/movimientos_stock/devoluciones_*.

-- ===== FEFO: consume stock de los lotes más próximos a vencer =====
create or replace function _fefo_consumir(
  p_producto_id bigint, p_cantidad numeric, p_tipo text,
  p_venta_id bigint default null, p_devolucion_id bigint default null, p_motivo text default null
) returns void language plpgsql as $$
declare
  v_restante numeric := p_cantidad;
  v_lote record;
  v_tomar numeric;
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
    raise exception 'Stock insuficiente para el producto % (faltan %)', p_producto_id, v_restante;
  end if;

  update productos set stock_actual = stock_actual - p_cantidad, updated_at = now() where id = p_producto_id;
end;
$$;

-- ===== Comisión resolvida: override por marca > comisión base del vendedor =====
create or replace function resolver_comision(p_vendedor_id bigint, p_producto_id bigint)
returns numeric language plpgsql stable as $$
declare
  v_marca_id bigint;
  v_pct numeric;
begin
  select marca_id into v_marca_id from productos where id = p_producto_id;

  select comision_pct into v_pct from comisiones_vendedor_marca
  where vendedor_id = p_vendedor_id and marca_id = v_marca_id;
  if found then return v_pct; end if;

  select comision_pct into v_pct from vendedores where id = p_vendedor_id;
  return coalesce(v_pct, 0);
end;
$$;

-- ===== Núcleo compartido: crea una venta (manual u online) =====
-- p_items: [{"producto_id":1,"cantidad":2,"precio_unitario":100,"comision_pct":5}, ...]
-- Si p_trust_item_overrides es false, precio_unitario/comision_pct del item se ignoran siempre
-- (se recalculan server-side) — así protege el checkout público de precios manipulados.
create or replace function _crear_venta(
  p_vendedor_id bigint, p_canal text, p_cliente_nombre text, p_cliente_localidad text,
  p_items jsonb, p_trust_item_overrides boolean
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
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene items';
  end if;

  insert into ventas (vendedor_id, canal, cliente_nombre, cliente_localidad, total_bruto, total_neto, created_by)
  values (p_vendedor_id, p_canal, coalesce(p_cliente_nombre, ''), coalesce(p_cliente_localidad, ''), 0, 0, auth.uid())
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

    perform _fefo_consumir(v_producto_id, v_cantidad, 'venta', v_venta_id);
  end loop;

  update ventas set
    total_bruto = v_total_bruto,
    total_descuento_comision = v_total_comision,
    total_neto = v_total_bruto - v_total_comision
  where id = v_venta_id;

  return v_venta_id;
end;
$$;

-- Venta manual (staff): confía en el precio/comisión que cargue el vendedor (permite descuentos puntuales).
-- security definer para poder llamar a _crear_venta/_fefo_consumir (revocadas de PUBLIC más abajo);
-- auth.role()/auth.uid() siguen reflejando al usuario real que llama, no al dueño de la función.
create or replace function registrar_venta_manual(p_vendedor_id bigint, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  return _crear_venta(p_vendedor_id, 'manual', null, null, p_items, true);
end;
$$;
revoke all on function registrar_venta_manual(bigint, jsonb) from anon;
grant execute on function registrar_venta_manual(bigint, jsonb) to authenticated;

-- Checkout de la tienda online (público): nunca confía en precio/comisión del cliente.
create or replace function crear_venta_online(p_cliente_nombre text, p_cliente_localidad text, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_vendedor_id bigint;
begin
  select id into v_vendedor_id from vendedores where es_canal_online = true limit 1;
  if v_vendedor_id is null then
    raise exception 'No hay un vendedor configurado como canal online';
  end if;
  return _crear_venta(v_vendedor_id, 'online', p_cliente_nombre, p_cliente_localidad, p_items, false);
end;
$$;
grant execute on function crear_venta_online(text, text, jsonb) to anon, authenticated;

-- Anula una venta: revierte stock (nuevo lote de reingreso) y marca estado='anulada' sin borrar el registro.
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

    update productos set stock_actual = stock_actual + v_item.cantidad, updated_at = now()
    where id = v_item.producto_id;
  end loop;

  update ventas set estado = 'anulada' where id = p_venta_id;
end;
$$;
revoke all on function anular_venta(bigint) from anon;
grant execute on function anular_venta(bigint) to authenticated;

-- Devolución: reconstruye un lote nuevo por ítem devuelto (no pisa cantidad a mano), preserva el historial FEFO.
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

    update productos set stock_actual = stock_actual + v_cantidad, updated_at = now() where id = v_producto_id;
  end loop;

  update devoluciones_cab set total = v_total where id = v_devolucion_id;
  return v_devolucion_id;
end;
$$;
revoke all on function registrar_devolucion(bigint, bigint, text, jsonb) from anon;
grant execute on function registrar_devolucion(bigint, bigint, text, jsonb) to authenticated;

-- Ingreso de stock (compra a proveedor): crea el lote y el movimiento de entrada.
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

  update productos set stock_actual = stock_actual + p_cantidad, updated_at = now() where id = p_producto_id;
  return v_lote_id;
end;
$$;
revoke all on function registrar_ingreso_stock(bigint, text, date, numeric, numeric, bigint) from anon;
grant execute on function registrar_ingreso_stock(bigint, text, date, numeric, numeric, bigint) to authenticated;

-- Ajuste manual de stock (conteo físico / merma). Delta positivo = ajuste, negativo = merma (consume FEFO).
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

    update productos set stock_actual = stock_actual + p_cantidad_delta, updated_at = now() where id = p_producto_id;
  end if;
end;
$$;
revoke all on function registrar_ajuste_stock(bigint, numeric, text) from anon;
grant execute on function registrar_ajuste_stock(bigint, numeric, text) to authenticated;

-- Los helpers internos no se llaman directo desde el cliente, solo a través de las funciones de arriba.
revoke all on function _fefo_consumir(bigint, numeric, text, bigint, bigint, text) from public;
revoke all on function resolver_comision(bigint, bigint) from public;
revoke all on function _crear_venta(bigint, text, text, text, jsonb, boolean) from public;
