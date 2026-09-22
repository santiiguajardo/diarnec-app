-- DIARNEC — tres cambios en las operaciones de Ventas y el Historial:
--
-- 1) Comisión en devoluciones y bonificaciones. El vendedor retira la mercadería con su
--    comisión descontada (ventas.total_neto), así que lo que se le acredita tiene que ir igual:
--    precio menos la comisión que ese vendedor tiene por esa marca (Administrar comisiones).
--    devoluciones_cab.total y bonificaciones.monto pasan a ser el NETO (lo que se acredita);
--    los items guardan el subtotal bruto y el % de comisión aplicado, como en las ventas.
--
-- 2) "Devolución de stock": una devolución que sí vuelve a ingresar al stock (lote
--    'DEVOLUCION-<id>'). La devolución común (vencidos, etc.) sigue sin tocar stock.
--    Se distingue con devoluciones_cab.con_stock.
--
-- 3) Anular cualquier movimiento desde el Historial. Las ventas ya tenían estado 'anulada';
--    el resto (devoluciones, bonificaciones, pagos, gastos) gana una marca `anulado`. Un movimiento
--    anulado queda en el Historial pero no suma en cuentas corrientes, caja ni dashboard.
--    Anular una devolución de stock retira del stock lo que había reingresado.

alter table devoluciones_cab add column con_stock boolean not null default false;
alter table bonificaciones_items add column comision_pct numeric(5,2) not null default 0;

alter table devoluciones_cab add column anulado boolean not null default false;
alter table bonificaciones add column anulado boolean not null default false;
alter table pagos_vendedores add column anulado boolean not null default false;
alter table pagos_proveedores add column anulado boolean not null default false;
alter table pagos_clientes add column anulado boolean not null default false;
alter table gastos add column anulado boolean not null default false;

-- Las cuentas corrientes ignoran lo anulado (create or replace conserva los permisos de la vista)
create or replace view vendedores_saldo as
select
  v.id as vendedor_id,
  v.nombre,
  coalesce((select sum(total_neto) from ventas where vendedor_id = v.id and estado = 'confirmada'), 0) as retirado,
  coalesce((select sum(total) from devoluciones_cab where vendedor_id = v.id and not anulado), 0) as devuelto,
  coalesce((select sum(monto) from pagos_vendedores where vendedor_id = v.id and not anulado), 0) as pagado,
  coalesce((select sum(monto) from bonificaciones where vendedor_id = v.id and not anulado), 0) as bonificado
from vendedores v;

create or replace view clientes_saldo as
select
  c.id as cliente_id,
  c.nombre,
  coalesce((select sum(total_neto) from ventas where cliente_id = c.id and estado = 'confirmada'), 0) as comprado,
  coalesce((select sum(d.total) from devoluciones_cab d join ventas v on v.id = d.venta_id where v.cliente_id = c.id and not d.anulado), 0) as devuelto,
  coalesce((select sum(monto) from pagos_clientes where cliente_id = c.id and not anulado), 0) as pagado
from clientes c;

-- Alta común de devoluciones (con o sin reingreso de stock). Solo la llaman las dos funciones públicas.
create or replace function _crear_devolucion(
  p_vendedor_id bigint, p_venta_id bigint, p_motivo text, p_items jsonb, p_con_stock boolean
) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
  v_subtotal numeric;
  v_total numeric := 0;
begin
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La devolución no tiene items';
  end if;
  if p_venta_id is not null and not exists (select 1 from ventas where id = p_venta_id) then
    raise exception 'La venta N° % no existe', p_venta_id;
  end if;

  insert into devoluciones_cab (venta_id, vendedor_id, motivo, total, con_stock, created_by)
  values (p_venta_id, p_vendedor_id, coalesce(p_motivo, ''), 0, p_con_stock, auth.uid())
  returning id into v_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null or v_precio < 0 then
      raise exception 'Item de devolución inválido para el producto %', v_producto_id;
    end if;

    v_pct := resolver_comision(p_vendedor_id, v_producto_id);
    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal - (v_subtotal * v_pct / 100);

    insert into devoluciones_items (devolucion_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (v_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);

    if p_con_stock then
      perform _ajustar_stock_edicion(v_producto_id, v_cantidad, 'devolucion', 'ajuste',
        'DEVOLUCION-' || v_id, null, v_id, p_motivo);
    end if;
  end loop;

  update devoluciones_cab set total = v_total where id = v_id;
  return v_id;
end;
$$;
revoke all on function _crear_devolucion(bigint, bigint, text, jsonb, boolean) from public;

create or replace function registrar_devolucion(p_vendedor_id bigint, p_venta_id bigint, p_motivo text, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  return _crear_devolucion(p_vendedor_id, p_venta_id, p_motivo, p_items, false);
end;
$$;

create or replace function registrar_devolucion_stock(p_vendedor_id bigint, p_venta_id bigint, p_motivo text, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  return _crear_devolucion(p_vendedor_id, p_venta_id, p_motivo, p_items, true);
end;
$$;
revoke all on function registrar_devolucion_stock(bigint, bigint, text, jsonb) from anon;
grant execute on function registrar_devolucion_stock(bigint, bigint, text, jsonb) to authenticated;

-- Editar una devolución: recalcula la comisión con el vendedor elegido y, si es una
-- devolución de stock, ajusta el stock por la diferencia de cantidades.
create or replace function editar_devolucion(
  p_devolucion_id bigint, p_vendedor_id bigint, p_venta_id bigint, p_motivo text, p_items jsonb
) returns void language plpgsql security definer set search_path = public as $$
declare
  v_con_stock boolean;
  v_anulado boolean;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
  v_subtotal numeric;
  v_total numeric := 0;
  v_dif record;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  select con_stock, anulado into v_con_stock, v_anulado from devoluciones_cab where id = p_devolucion_id for update;
  if not found then
    raise exception 'La devolución % no existe', p_devolucion_id;
  end if;
  if v_anulado then
    raise exception 'La devolución % está anulada: no se puede modificar', p_devolucion_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La devolución no puede quedar sin items';
  end if;
  if p_venta_id is not null and not exists (select 1 from ventas where id = p_venta_id) then
    raise exception 'La venta N° % no existe', p_venta_id;
  end if;

  if v_con_stock then
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
  end if;

  delete from devoluciones_items where devolucion_id = p_devolucion_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null or v_precio < 0 then
      raise exception 'Item de devolución inválido para el producto %', v_producto_id;
    end if;

    v_pct := resolver_comision(p_vendedor_id, v_producto_id);
    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal - (v_subtotal * v_pct / 100);

    insert into devoluciones_items (devolucion_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (p_devolucion_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);
  end loop;

  update devoluciones_cab set
    vendedor_id = p_vendedor_id,
    venta_id = p_venta_id,
    motivo = coalesce(p_motivo, ''),
    total = v_total
  where id = p_devolucion_id;
end;
$$;

-- ===== Bonificaciones: también netas de comisión =====

create or replace function registrar_bonificacion(p_vendedor_id bigint, p_descripcion text, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
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

    v_pct := resolver_comision(p_vendedor_id, v_producto_id);
    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal - (v_subtotal * v_pct / 100);

    insert into bonificaciones_items (bonificacion_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (v_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);
  end loop;

  update bonificaciones set monto = v_total where id = v_id;
  return v_id;
end;
$$;

create or replace function editar_bonificacion(p_bonificacion_id bigint, p_vendedor_id bigint, p_descripcion text, p_items jsonb)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_anulado boolean;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
  v_subtotal numeric;
  v_total numeric := 0;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  select anulado into v_anulado from bonificaciones where id = p_bonificacion_id for update;
  if not found then
    raise exception 'La bonificación % no existe', p_bonificacion_id;
  end if;
  if v_anulado then
    raise exception 'La bonificación % está anulada: no se puede modificar', p_bonificacion_id;
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

    v_pct := resolver_comision(p_vendedor_id, v_producto_id);
    v_subtotal := v_precio * v_cantidad;
    v_total := v_total + v_subtotal - (v_subtotal * v_pct / 100);

    insert into bonificaciones_items (bonificacion_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (p_bonificacion_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);
  end loop;

  update bonificaciones set
    vendedor_id = p_vendedor_id,
    descripcion = coalesce(p_descripcion, ''),
    monto = v_total
  where id = p_bonificacion_id;
end;
$$;

-- ===== Anular una devolución =====
-- Una devolución de stock retira del stock lo que había reingresado (puede dejarlo en negativo,
-- como cualquier salida). La devolución común no toca stock.

create or replace function anular_devolucion(p_devolucion_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_dev devoluciones_cab%rowtype;
  v_item record;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  select * into v_dev from devoluciones_cab where id = p_devolucion_id for update;
  if not found then
    raise exception 'La devolución % no existe', p_devolucion_id;
  end if;
  if v_dev.anulado then
    raise exception 'La devolución % ya está anulada', p_devolucion_id;
  end if;

  if v_dev.con_stock then
    for v_item in
      select producto_id, sum(cantidad) as cantidad from devoluciones_items
      where devolucion_id = p_devolucion_id group by producto_id
    loop
      perform _fefo_consumir(v_item.producto_id, v_item.cantidad, 'ajuste', null, p_devolucion_id,
        'Anulación de la devolución #' || p_devolucion_id);
    end loop;
  end if;

  update devoluciones_cab set anulado = true where id = p_devolucion_id;
end;
$$;
revoke all on function anular_devolucion(bigint) from anon;
grant execute on function anular_devolucion(bigint) to authenticated;
