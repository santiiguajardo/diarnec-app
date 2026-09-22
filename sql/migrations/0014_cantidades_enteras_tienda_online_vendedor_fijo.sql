-- DIARNEC — tres cambios:
--
-- 1) Cantidades enteras. Todo se vende y se controla por unidad (1, 2, 3...), salvo las categorías
--    que se manejan por peso: Fiambres y Quesos (categorias.por_peso). Se valida en la base para que
--    valga en cualquier pantalla: items de ventas, devoluciones y bonificaciones, e ingresos de stock.
--
-- 2) El vendedor "Tienda Online" (vendedores.es_canal_online) es fijo: no se puede borrar ni dar de
--    baja, y no gana comisión (resolver_comision devuelve 0 para él, hoy y aunque alguien le cargue una).
--
-- 3) Pedidos online: "pasar a venta" se hace desde el panel de Ventas con los productos ya cargados
--    (pasar_pedido_a_venta: reemplaza los items con lo confirmado, descuenta stock y lo deja como
--    venta), y se pueden borrar (borrar_pedido_online: si ya era venta, repone el stock).

-- ===== 1) Cantidades enteras =====

alter table categorias add column por_peso boolean not null default false;
update categorias set por_peso = true where lower(nombre) in ('fiambres', 'quesos');

create or replace function _validar_cantidad_entera() returns trigger language plpgsql as $$
declare
  v_nombre text;
  v_por_peso boolean;
begin
  if new.cantidad <> trunc(new.cantidad) then
    select p.nombre, coalesce(c.por_peso, false) into v_nombre, v_por_peso
    from productos p left join categorias c on c.id = p.categoria_id
    where p.id = new.producto_id;
    if not coalesce(v_por_peso, false) then
      raise exception 'La cantidad de "%" tiene que ser un número entero (solo fiambres y quesos se manejan por peso)', v_nombre;
    end if;
  end if;
  return new;
end;
$$;

create trigger ventas_items_cantidad_entera before insert or update of cantidad, producto_id
  on ventas_items for each row execute function _validar_cantidad_entera();
create trigger devoluciones_items_cantidad_entera before insert or update of cantidad, producto_id
  on devoluciones_items for each row execute function _validar_cantidad_entera();
create trigger bonificaciones_items_cantidad_entera before insert or update of cantidad, producto_id
  on bonificaciones_items for each row execute function _validar_cantidad_entera();

create or replace function _validar_cantidad_entera_lote() returns trigger language plpgsql as $$
declare
  v_nombre text;
  v_por_peso boolean;
begin
  if new.cantidad_inicial <> trunc(new.cantidad_inicial) then
    select p.nombre, coalesce(c.por_peso, false) into v_nombre, v_por_peso
    from productos p left join categorias c on c.id = p.categoria_id
    where p.id = new.producto_id;
    if not coalesce(v_por_peso, false) then
      raise exception 'La cantidad de "%" tiene que ser un número entero (solo fiambres y quesos se manejan por peso)', v_nombre;
    end if;
  end if;
  return new;
end;
$$;

create trigger stock_lotes_cantidad_entera before insert
  on stock_lotes for each row execute function _validar_cantidad_entera_lote();

-- ===== 2) Vendedor "Tienda Online": fijo y sin comisión =====

create or replace function _proteger_vendedor_online() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then
    if old.es_canal_online then
      raise exception 'El vendedor "Tienda online" es fijo: no se puede borrar';
    end if;
    return old;
  end if;
  if old.es_canal_online and (new.activo is distinct from old.activo or new.es_canal_online is distinct from old.es_canal_online) then
    raise exception 'El vendedor "Tienda online" es fijo: no se puede dar de baja';
  end if;
  return new;
end;
$$;

create trigger vendedores_proteger_online before update or delete
  on vendedores for each row execute function _proteger_vendedor_online();

create or replace function resolver_comision(p_vendedor_id bigint, p_producto_id bigint)
returns numeric language plpgsql stable as $$
declare
  v_marca_id bigint;
  v_pct numeric;
begin
  if exists (select 1 from vendedores where id = p_vendedor_id and es_canal_online) then
    return 0;
  end if;

  select marca_id into v_marca_id from productos where id = p_producto_id;

  select comision_pct into v_pct from comisiones_vendedor_marca
  where vendedor_id = p_vendedor_id and marca_id = v_marca_id;

  return coalesce(v_pct, 0);
end;
$$;

-- ===== 3) Pedidos online =====

-- Pasa un pedido (pendiente o cancelado) a venta con los items confirmados en el panel de Ventas.
create or replace function pasar_pedido_a_venta(p_venta_id bigint, p_items jsonb)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_venta ventas%rowtype;
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

  select * into v_venta from ventas where id = p_venta_id and canal = 'online' for update;
  if not found then
    raise exception 'El pedido % no existe', p_venta_id;
  end if;
  if v_venta.estado = 'confirmada' then
    raise exception 'El pedido % ya está registrado como venta', p_venta_id;
  end if;
  if p_items is null or jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no puede quedar sin items';
  end if;

  delete from ventas_items where venta_id = p_venta_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null or v_precio < 0 then
      raise exception 'Item inválido para el producto %', v_producto_id;
    end if;

    v_pct := resolver_comision(v_venta.vendedor_id, v_producto_id);
    v_subtotal := v_precio * v_cantidad;
    v_total_bruto := v_total_bruto + v_subtotal;
    v_total_comision := v_total_comision + (v_subtotal * v_pct / 100);

    insert into ventas_items (venta_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (p_venta_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);

    perform _fefo_consumir(v_producto_id, v_cantidad, 'venta', p_venta_id);
  end loop;

  update ventas set
    estado = 'confirmada',
    total_bruto = v_total_bruto,
    total_descuento_comision = v_total_comision,
    total_neto = v_total_bruto - v_total_comision
  where id = p_venta_id;

  return p_venta_id;
end;
$$;
revoke all on function pasar_pedido_a_venta(bigint, jsonb) from anon;
grant execute on function pasar_pedido_a_venta(bigint, jsonb) to authenticated;

-- Borra un pedido online. Si ya era venta se repone el stock; el historial de stock se conserva
-- (pierde solo el vínculo al pedido borrado).
create or replace function borrar_pedido_online(p_venta_id bigint)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_estado text;
  v_item record;
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;

  select estado into v_estado from ventas where id = p_venta_id and canal = 'online' for update;
  if not found then
    raise exception 'El pedido % no existe', p_venta_id;
  end if;

  if v_estado = 'confirmada' then
    for v_item in
      select producto_id, sum(cantidad) as cantidad from ventas_items
      where venta_id = p_venta_id group by producto_id
    loop
      perform _ajustar_stock_edicion(v_item.producto_id, v_item.cantidad, 'anulacion', 'venta',
        'ANULACION-VENTA-' || p_venta_id, p_venta_id, null, 'Pedido online #' || p_venta_id || ' eliminado');
    end loop;
  end if;

  update movimientos_stock set venta_id = null where venta_id = p_venta_id;
  update devoluciones_cab set venta_id = null where venta_id = p_venta_id;
  delete from ventas where id = p_venta_id;
end;
$$;
revoke all on function borrar_pedido_online(bigint) from anon;
grant execute on function borrar_pedido_online(bigint) to authenticated;
