-- DIARNEC — el Historial pasa a ser el lugar donde se gestionan los movimientos, así que
-- ventas y devoluciones tienen que poder modificarse (items, cantidades, precios, vendedor,
-- cliente) sin romper el stock. Se aplica solo la DIFERENCIA de cantidades por producto:
--   · si en una venta confirmada sube la cantidad, se descuenta lo que falta (FEFO);
--   · si baja (o se quita el producto), se repone lo que sobra en un lote 'EDICION-VENTA-<id>'.
-- Lo mismo, al revés, para devoluciones. Cada corrección queda en movimientos_stock.
-- (Gastos, pagos y bonificaciones se corrigen con un update directo: no tocan stock.)

-- Aplica un cambio de stock por edición. p_delta > 0 suma stock (lote nuevo, absorbe faltante);
-- p_delta < 0 lo resta con el motor FEFO (puede dejar el producto en negativo, ver 0010).
create or replace function _ajustar_stock_edicion(
  p_producto_id bigint, p_delta numeric, p_tipo_alta text, p_tipo_baja text,
  p_lote text, p_venta_id bigint, p_devolucion_id bigint, p_motivo text
) returns void language plpgsql as $$
declare
  v_lote_id bigint;
begin
  if p_delta = 0 then return; end if;

  if p_delta > 0 then
    insert into stock_lotes (producto_id, lote, cantidad_inicial, cantidad_restante, created_by)
    values (p_producto_id, p_lote, p_delta, p_delta, auth.uid())
    returning id into v_lote_id;

    insert into movimientos_stock (producto_id, lote_id, tipo, cantidad, venta_id, devolucion_id, motivo, created_by)
    values (p_producto_id, v_lote_id, p_tipo_alta, p_delta, p_venta_id, p_devolucion_id, p_motivo, auth.uid());

    perform _absorber_faltante(p_producto_id, v_lote_id);

    update productos set stock_actual = stock_actual + p_delta, updated_at = now()
    where id = p_producto_id;
  else
    perform _fefo_consumir(p_producto_id, -p_delta, p_tipo_baja, p_venta_id, p_devolucion_id, p_motivo);
  end if;
end;
$$;
revoke all on function _ajustar_stock_edicion(bigint, numeric, text, text, text, bigint, bigint, text) from public;

-- ===== Editar una venta (manual u online; pendiente o confirmada) =====
-- p_cliente_id solo aplica a ventas manuales (null = sin cliente). En una venta online se
-- conservan los datos del cliente que cargó el pedido.

create or replace function editar_venta(p_venta_id bigint, p_vendedor_id bigint, p_cliente_id bigint, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_venta ventas%rowtype;
  v_vendedor_id bigint;
  v_cliente_id bigint;
  v_cliente_nombre text;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
  v_subtotal numeric;
  v_total_bruto numeric := 0;
  v_total_comision numeric := 0;
  v_dif record;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;

  select * into v_venta from ventas where id = p_venta_id for update;
  if not found then
    raise exception 'La venta % no existe', p_venta_id;
  end if;
  if v_venta.estado = 'anulada' then
    raise exception 'La venta % está anulada: no se puede modificar', p_venta_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no puede quedar sin items';
  end if;

  v_vendedor_id := coalesce(p_vendedor_id, v_venta.vendedor_id);
  if v_venta.canal = 'manual' then
    v_cliente_id := p_cliente_id;
    v_cliente_nombre := coalesce((select nombre from clientes where id = p_cliente_id), '');
  else
    v_cliente_id := v_venta.cliente_id;
    v_cliente_nombre := v_venta.cliente_nombre;
  end if;

  -- Stock: solo una venta confirmada lo tiene descontado. Se compara por producto lo que
  -- había antes contra lo que queda (delta > 0 = sobra mercadería, vuelve al stock).
  if v_venta.estado = 'confirmada' then
    for v_dif in
      select producto_id, sum(antes) - sum(despues) as delta
      from (
        select producto_id, cantidad as antes, 0::numeric as despues
        from ventas_items where venta_id = p_venta_id
        union all
        select (e->>'producto_id')::bigint, 0::numeric, (e->>'cantidad')::numeric
        from jsonb_array_elements(p_items) e
      ) t
      group by producto_id
      having sum(antes) - sum(despues) <> 0
    loop
      perform _ajustar_stock_edicion(
        v_dif.producto_id, v_dif.delta, 'anulacion', 'venta',
        'EDICION-VENTA-' || p_venta_id, p_venta_id, null, 'Edición de la venta #' || p_venta_id);
    end loop;
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
    vendedor_id = v_vendedor_id,
    cliente_id = v_cliente_id,
    cliente_nombre = v_cliente_nombre,
    total_bruto = v_total_bruto,
    total_descuento_comision = v_total_comision,
    total_neto = v_total_bruto - v_total_comision
  where id = p_venta_id;
end;
$$;
revoke all on function editar_venta(bigint, bigint, bigint, jsonb) from anon;
grant execute on function editar_venta(bigint, bigint, bigint, jsonb) to authenticated;

-- ===== Editar una devolución =====

create or replace function editar_devolucion(
  p_devolucion_id bigint, p_vendedor_id bigint, p_venta_id bigint, p_motivo text, p_items jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_subtotal numeric;
  v_total numeric := 0;
  v_dif record;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  perform 1 from devoluciones_cab where id = p_devolucion_id for update;
  if not found then
    raise exception 'La devolución % no existe', p_devolucion_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La devolución no puede quedar sin items';
  end if;
  if p_venta_id is not null and not exists (select 1 from ventas where id = p_venta_id) then
    raise exception 'La venta N° % no existe', p_venta_id;
  end if;

  -- Una devolución suma stock: delta > 0 = entra más mercadería que antes.
  for v_dif in
    select producto_id, sum(despues) - sum(antes) as delta
    from (
      select producto_id, cantidad as antes, 0::numeric as despues
      from devoluciones_items where devolucion_id = p_devolucion_id
      union all
      select (e->>'producto_id')::bigint, 0::numeric, (e->>'cantidad')::numeric
      from jsonb_array_elements(p_items) e
    ) t
    group by producto_id
    having sum(despues) - sum(antes) <> 0
  loop
    perform _ajustar_stock_edicion(
      v_dif.producto_id, v_dif.delta, 'devolucion', 'ajuste',
      'EDICION-DEVOLUCION-' || p_devolucion_id, null, p_devolucion_id, 'Edición de la devolución #' || p_devolucion_id);
  end loop;

  delete from devoluciones_items where devolucion_id = p_devolucion_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null or v_precio < 0 then
      raise exception 'Item de devolución inválido para el producto %', v_producto_id;
    end if;

    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal;

    insert into devoluciones_items (devolucion_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (p_devolucion_id, v_producto_id, v_cantidad, v_precio, 0, v_subtotal);
  end loop;

  update devoluciones_cab set
    vendedor_id = p_vendedor_id,
    venta_id = p_venta_id,
    motivo = coalesce(p_motivo, ''),
    total = v_total
  where id = p_devolucion_id;
end;
$$;
revoke all on function editar_devolucion(bigint, bigint, bigint, text, jsonb) from anon;
grant execute on function editar_devolucion(bigint, bigint, bigint, text, jsonb) to authenticated;
