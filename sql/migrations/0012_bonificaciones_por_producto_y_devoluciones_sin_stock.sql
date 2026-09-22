-- DIARNEC — dos cambios en las operaciones de Ventas:
--
-- 1) Bonificaciones por producto: igual que una devolución, se cargan con una lista de
--    productos (cantidad × precio). El monto de la bonificación es la suma de esa lista.
--    Las bonificaciones viejas (solo monto, sin detalle) siguen funcionando igual.
--
-- 2) Ni las devoluciones ni las bonificaciones vuelven al stock: la mercadería devuelta
--    es vencida / no vendible, así que solo se acredita en la cuenta del vendedor.
--    registrar_devolucion y editar_devolucion dejan de crear lotes y movimientos de stock.

-- ===== Detalle de las bonificaciones =====

create table bonificaciones_items (
  id bigint generated always as identity primary key,
  bonificacion_id bigint not null references bonificaciones(id) on delete cascade,
  producto_id bigint not null references productos(id),
  cantidad numeric(12,3) not null,
  precio_unitario numeric(12,2) not null,
  subtotal numeric(12,2) not null
);
create index bonificaciones_items_bon_idx on bonificaciones_items (bonificacion_id);

grant select, insert, update, delete on bonificaciones_items to authenticated;
alter table bonificaciones_items enable row level security;
create policy "bonificaciones_items_staff" on bonificaciones_items for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

create or replace function registrar_bonificacion(p_vendedor_id bigint, p_descripcion text, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_subtotal numeric;
  v_total numeric := 0;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La bonificación no tiene items';
  end if;

  insert into bonificaciones (vendedor_id, monto, descripcion, created_by)
  values (p_vendedor_id, 0, coalesce(p_descripcion, ''), auth.uid())
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null or v_precio < 0 then
      raise exception 'Item de bonificación inválido para el producto %', v_producto_id;
    end if;

    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal;

    insert into bonificaciones_items (bonificacion_id, producto_id, cantidad, precio_unitario, subtotal)
    values (v_id, v_producto_id, v_cantidad, v_precio, v_subtotal);
  end loop;

  update bonificaciones set monto = v_total where id = v_id;
  return v_id;
end;
$$;
revoke all on function registrar_bonificacion(bigint, text, jsonb) from anon;
grant execute on function registrar_bonificacion(bigint, text, jsonb) to authenticated;

create or replace function editar_bonificacion(p_bonificacion_id bigint, p_vendedor_id bigint, p_descripcion text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_subtotal numeric;
  v_total numeric := 0;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  perform 1 from bonificaciones where id = p_bonificacion_id for update;
  if not found then
    raise exception 'La bonificación % no existe', p_bonificacion_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La bonificación no puede quedar sin items';
  end if;

  delete from bonificaciones_items where bonificacion_id = p_bonificacion_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null or v_precio < 0 then
      raise exception 'Item de bonificación inválido para el producto %', v_producto_id;
    end if;

    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal;

    insert into bonificaciones_items (bonificacion_id, producto_id, cantidad, precio_unitario, subtotal)
    values (p_bonificacion_id, v_producto_id, v_cantidad, v_precio, v_subtotal);
  end loop;

  update bonificaciones set
    vendedor_id = p_vendedor_id,
    descripcion = coalesce(p_descripcion, ''),
    monto = v_total
  where id = p_bonificacion_id;
end;
$$;
revoke all on function editar_bonificacion(bigint, bigint, text, jsonb) from anon;
grant execute on function editar_bonificacion(bigint, bigint, text, jsonb) to authenticated;

-- ===== Devoluciones: ya no reingresan stock =====

create or replace function registrar_devolucion(p_vendedor_id bigint, p_venta_id bigint, p_motivo text, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_devolucion_id bigint;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_subtotal numeric;
  v_total numeric := 0;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La devolución no tiene items';
  end if;
  if p_venta_id is not null and not exists (select 1 from ventas where id = p_venta_id) then
    raise exception 'La venta N° % no existe', p_venta_id;
  end if;

  insert into devoluciones_cab (venta_id, vendedor_id, motivo, total, created_by)
  values (p_venta_id, p_vendedor_id, coalesce(p_motivo, ''), 0, auth.uid())
  returning id into v_devolucion_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null then
      raise exception 'Item de devolución inválido para el producto %', v_producto_id;
    end if;

    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal;

    insert into devoluciones_items (devolucion_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (v_devolucion_id, v_producto_id, v_cantidad, v_precio, 0, v_subtotal);
  end loop;

  update devoluciones_cab set total = v_total where id = v_devolucion_id;
  return v_devolucion_id;
end;
$$;

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
