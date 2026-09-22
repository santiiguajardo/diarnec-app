-- DIARNEC — panel del vendedor: cuenta corriente por semana, clientes propios, ventas con remito y ranking.
--
--  · mi_semanas(n): la cuenta corriente semana por semana (lunes a domingo, hora de Argentina):
--    saldo anterior, retirado, devoluciones, bonificaciones, pagos, saldo al cierre y ganancia.
--  · mis_movimientos(desde, hasta): ahora se puede pedir un rango (una semana).
--  · mi_cartera(desde): sus clientes con lo que compró cada uno en el período (para el ranking).
--  · mi_cliente_guardar / mi_cliente_borrar: el vendedor da de alta, modifica y borra SUS clientes.
--    Borrar un cliente sin ventas lo elimina; con ventas lo da de baja para conservar el historial.
--  · mi_registrar_venta(cliente, items): el vendedor registra lo que vendió a un cliente de su cartera.
--    Es una venta de verdad (descuenta stock, suma a su cuenta y aparece en el Historial del admin) pero
--    el precio SIEMPRE es el de lista (precio final) y la comisión la define el administrador: el
--    vendedor solo elige productos y cantidades.
--  · mi_remito(venta) y mi_historial_cliente(cliente): datos para el remito en PDF (sin comisión).

create or replace function _fecha_ar(ts timestamptz) returns date language sql immutable as $$
  select (ts at time zone 'America/Argentina/Buenos_Aires')::date;
$$;

-- ===== Cuenta corriente por semana =====

create or replace function mi_semanas(p_cantidad int default 12) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  v_actual date := date_trunc('week', now() at time zone 'America/Argentina/Buenos_Aires')::date;
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;

  with mov as (
    select _fecha_ar(v.created_at) as f, v.total_neto as retirado, 0::numeric as devuelto, 0::numeric as bonificado,
           0::numeric as pagado, v.total_descuento_comision as ganancia
    from ventas v where v.vendedor_id = v_id and v.estado = 'confirmada'
    union all
    select _fecha_ar(d.created_at), 0::numeric, d.total, 0::numeric, 0::numeric,
           -coalesce((select sum(i.subtotal * i.comision_pct / 100) from devoluciones_items i where i.devolucion_id = d.id), 0)
    from devoluciones_cab d where d.vendedor_id = v_id and not d.anulado
    union all
    select _fecha_ar(b.created_at), 0::numeric, 0::numeric, b.monto, 0::numeric,
           -coalesce((select sum(i.subtotal * i.comision_pct / 100) from bonificaciones_items i where i.bonificacion_id = b.id), 0)
    from bonificaciones b where b.vendedor_id = v_id and not b.anulado
    union all
    select _fecha_ar(p.created_at), 0::numeric, 0::numeric, 0::numeric, p.monto, 0::numeric
    from pagos_vendedores p where p.vendedor_id = v_id and not p.anulado
  ), semanas as (
    select (v_actual - (i * 7))::date as desde from generate_series(0, greatest(p_cantidad, 1) - 1) as i
  )
  select coalesce(jsonb_agg(w.j order by w.d desc), '[]'::jsonb) into r from (
    select s.desde as d, jsonb_build_object(
      'desde', s.desde,
      'hasta', s.desde + 6,
      'retirado', coalesce(sum(m.retirado) filter (where m.f >= s.desde), 0),
      'devuelto', coalesce(sum(m.devuelto) filter (where m.f >= s.desde), 0),
      'bonificado', coalesce(sum(m.bonificado) filter (where m.f >= s.desde), 0),
      'pagado', coalesce(sum(m.pagado) filter (where m.f >= s.desde), 0),
      'ganancia', coalesce(sum(m.ganancia) filter (where m.f >= s.desde), 0),
      'saldo_inicial', coalesce(sum(m.retirado - m.devuelto - m.bonificado - m.pagado) filter (where m.f < s.desde), 0),
      'saldo_final', coalesce(sum(m.retirado - m.devuelto - m.bonificado - m.pagado), 0),
      'movimientos', count(m.f) filter (where m.f >= s.desde)
    ) as j
    from semanas s left join mov m on m.f <= s.desde + 6
    group by s.desde
  ) w;
  return r;
end;
$$;

-- ===== Movimientos (con rango de fechas opcional) =====

drop function if exists mis_movimientos();

create or replace function mis_movimientos(p_desde date default null, p_hasta date default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select coalesce(jsonb_agg(m.j order by m.f desc), '[]'::jsonb) into r from (
    select * from (
      select v.created_at as f, jsonb_build_object(
        'tipo', 'venta', 'id', v.id, 'fecha', v.created_at, 'anulado', v.estado = 'anulada',
        'cliente', v.cliente_nombre, 'bruto', v.total_bruto, 'comision', v.total_descuento_comision, 'importe', v.total_neto,
        'items', (select coalesce(jsonb_agg(jsonb_build_object('producto', p.nombre, 'unidad', p.unidad, 'marca', mk.nombre,
            'cantidad', i.cantidad, 'precio', i.precio_unitario, 'subtotal', i.subtotal) order by i.id), '[]'::jsonb)
          from ventas_items i join productos p on p.id = i.producto_id left join marcas mk on mk.id = p.marca_id where i.venta_id = v.id)
      ) as j
      from ventas v where v.vendedor_id = v_id and v.canal = 'manual'
      union all
      select d.created_at, jsonb_build_object(
        'tipo', case when d.con_stock then 'devolucion_stock' else 'devolucion' end, 'id', d.id, 'fecha', d.created_at,
        'anulado', d.anulado, 'motivo', d.motivo, 'importe', d.total,
        'items', (select coalesce(jsonb_agg(jsonb_build_object('producto', p.nombre, 'unidad', p.unidad, 'marca', mk.nombre,
            'cantidad', i.cantidad, 'precio', i.precio_unitario, 'subtotal', i.subtotal) order by i.id), '[]'::jsonb)
          from devoluciones_items i join productos p on p.id = i.producto_id left join marcas mk on mk.id = p.marca_id where i.devolucion_id = d.id)
      )
      from devoluciones_cab d where d.vendedor_id = v_id
      union all
      select b.created_at, jsonb_build_object(
        'tipo', 'bonificacion', 'id', b.id, 'fecha', b.created_at, 'anulado', b.anulado, 'motivo', b.descripcion, 'importe', b.monto,
        'items', (select coalesce(jsonb_agg(jsonb_build_object('producto', p.nombre, 'unidad', p.unidad, 'marca', mk.nombre,
            'cantidad', i.cantidad, 'precio', i.precio_unitario, 'subtotal', i.subtotal) order by i.id), '[]'::jsonb)
          from bonificaciones_items i join productos p on p.id = i.producto_id left join marcas mk on mk.id = p.marca_id where i.bonificacion_id = b.id)
      )
      from bonificaciones b where b.vendedor_id = v_id
      union all
      select pv.created_at, jsonb_build_object(
        'tipo', 'pago', 'id', pv.id, 'fecha', pv.created_at, 'anulado', pv.anulado, 'motivo', pv.descripcion,
        'medio', pv.medio_pago, 'importe', pv.monto, 'items', '[]'::jsonb
      )
      from pagos_vendedores pv where pv.vendedor_id = v_id
    ) u
    where (p_desde is null or _fecha_ar(u.f) >= p_desde) and (p_hasta is null or _fecha_ar(u.f) <= p_hasta)
    order by u.f desc limit 300
  ) m;
  return r;
end;
$$;

-- ===== Cartera de clientes (con lo comprado en el período, para el ranking) =====

drop function if exists mi_cartera();

create or replace function mi_cartera(p_desde date default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.nombre), '[]'::jsonb) into r from (
    select c.id, c.nombre, c.localidad, c.contacto, c.telefono,
      coalesce(sum(v.total_bruto) filter (where v.estado = 'confirmada' and (p_desde is null or _fecha_ar(v.created_at) >= p_desde)), 0) as comprado,
      count(v.id) filter (where v.estado = 'confirmada' and (p_desde is null or _fecha_ar(v.created_at) >= p_desde)) as compras,
      coalesce(sum(v.total_bruto) filter (where v.estado = 'confirmada'), 0) as comprado_total,
      max(v.created_at) filter (where v.estado = 'confirmada') as ultima_compra
    from clientes c
    left join ventas v on v.cliente_id = c.id and v.vendedor_id = v_id
    where c.activo and (c.vendedor_id = v_id or exists (select 1 from ventas x where x.cliente_id = c.id and x.vendedor_id = v_id))
    group by c.id
  ) x;
  return r;
end;
$$;

-- ===== Alta / modificación / baja de clientes propios =====

create or replace function mi_cliente_guardar(p_id bigint, p_nombre text, p_localidad text, p_contacto text, p_telefono text)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  v_nombre text := trim(coalesce(p_nombre, ''));
  v_cli clientes%rowtype;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  if v_nombre = '' then
    raise exception 'Ingresá el nombre del cliente.';
  end if;
  if exists (select 1 from clientes where vendedor_id = v_id and activo and lower(nombre) = lower(v_nombre) and (p_id is null or id <> p_id)) then
    raise exception 'Ya tenés un cliente llamado "%".', v_nombre;
  end if;

  if p_id is null then
    insert into clientes (nombre, localidad, contacto, telefono, vendedor_id, created_by)
    values (v_nombre, trim(coalesce(p_localidad, '')), trim(coalesce(p_contacto, '')), trim(coalesce(p_telefono, '')), v_id, auth.uid())
    returning id into p_id;
    return p_id;
  end if;

  select * into v_cli from clientes where id = p_id for update;
  if not found or not (v_cli.vendedor_id = v_id
      or (v_cli.vendedor_id is null and exists (select 1 from ventas where cliente_id = p_id and vendedor_id = v_id))) then
    raise exception 'Ese cliente no es parte de tu cartera.';
  end if;
  update clientes set nombre = v_nombre, localidad = trim(coalesce(p_localidad, '')),
    contacto = trim(coalesce(p_contacto, '')), telefono = trim(coalesce(p_telefono, '')), vendedor_id = v_id
  where id = p_id;
  return p_id;
end;
$$;

-- Devuelve 'borrado' (sin ventas) o 'baja' (tiene ventas: se conserva el historial y sale de su cartera)
create or replace function mi_cliente_borrar(p_id bigint) returns text language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  v_cli clientes%rowtype;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select * into v_cli from clientes where id = p_id for update;
  if not found or v_cli.vendedor_id is distinct from v_id then
    raise exception 'Ese cliente no es parte de tu cartera.';
  end if;
  if exists (select 1 from ventas where cliente_id = p_id) or exists (select 1 from pagos_clientes where cliente_id = p_id) then
    update clientes set activo = false where id = p_id;
    return 'baja';
  end if;
  delete from clientes where id = p_id;
  return 'borrado';
end;
$$;

-- ===== Venta del vendedor a un cliente de su cartera =====

create or replace function mi_registrar_venta(p_cliente_id bigint, p_items jsonb) returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  v_items jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  if not exists (select 1 from clientes where id = p_cliente_id and activo and vendedor_id = v_id) then
    raise exception 'Ese cliente no es parte de tu cartera.';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'Elegí al menos un producto.';
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) e
             where not exists (select 1 from productos p where p.id = (e->>'producto_id')::bigint and p.activo)) then
    raise exception 'Hay un producto que ya no está disponible.';
  end if;

  -- Solo producto y cantidad: el precio (de lista) y la comisión los pone el sistema
  select jsonb_agg(jsonb_build_object('producto_id', (e->>'producto_id')::bigint, 'cantidad', (e->>'cantidad')::numeric))
  into v_items from jsonb_array_elements(p_items) e;

  return _crear_venta(v_id, 'manual', null, null, v_items, false, p_cliente_id);
end;
$$;

-- Datos del remito de una venta propia (precio final, sin comisión)
create or replace function mi_remito(p_venta_id bigint) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select jsonb_build_object(
    'id', v.id, 'fecha', v.created_at, 'anulado', v.estado = 'anulada', 'total', v.total_bruto,
    'vendedor', vd.nombre,
    'cliente', c.nombre, 'localidad', c.localidad, 'telefono', c.telefono,
    'items', (select coalesce(jsonb_agg(jsonb_build_object('marca', mk.nombre, 'producto', p.nombre, 'unidad', p.unidad,
        'cantidad', i.cantidad, 'precio', i.precio_unitario, 'subtotal', i.subtotal) order by i.id), '[]'::jsonb)
      from ventas_items i join productos p on p.id = i.producto_id left join marcas mk on mk.id = p.marca_id where i.venta_id = v.id)
  ) into r
  from ventas v
  join vendedores vd on vd.id = v.vendedor_id
  left join clientes c on c.id = v.cliente_id
  where v.id = p_venta_id and v.vendedor_id = v_id;
  if r is null then
    raise exception 'La venta no existe.';
  end if;
  return r;
end;
$$;

-- Remitos de un cliente (para volver a descargarlos o mandarlos)
create or replace function mi_historial_cliente(p_cliente_id bigint) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object('id', v.id, 'fecha', v.created_at, 'total', v.total_bruto,
      'anulado', v.estado = 'anulada') order by v.created_at desc), '[]'::jsonb) into r
  from ventas v where v.cliente_id = p_cliente_id and v.vendedor_id = v_id and v.canal = 'manual';
  return r;
end;
$$;

revoke all on function mi_semanas(int), mis_movimientos(date, date), mi_cartera(date), mi_cliente_guardar(bigint, text, text, text, text),
  mi_cliente_borrar(bigint), mi_registrar_venta(bigint, jsonb), mi_remito(bigint), mi_historial_cliente(bigint) from public, anon;
grant execute on function mi_semanas(int), mis_movimientos(date, date), mi_cartera(date), mi_cliente_guardar(bigint, text, text, text, text),
  mi_cliente_borrar(bigint), mi_registrar_venta(bigint, jsonb), mi_remito(bigint), mi_historial_cliente(bigint) to authenticated;
