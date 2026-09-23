-- 0025 — Tienda online: dos precios (comercio / particular), mínimo de compra para particulares,
-- CUIT/CUIL, dirección de entrega, vendedor elegido por el cliente, y pasar a venta con vendedor.
--
--  1) tienda_config: recargo de particulares (25%) y mínimo de compra ($50.000). Lo lee la tienda
--     (función pública) y lo edita solo el admin desde el panel.
--  2) ventas: cliente_tipo, cliente_cuit, cliente_direccion, vendedor_preferido_id (sin FK a propósito:
--     una segunda FK a vendedores haría ambiguos todos los embeds "vendedores(...)" desde ventas).
--     clientes: cuit, tipo, direccion.
--  3) crear_pedido_online reemplaza a crear_venta_online: el servidor calcula el precio según el
--     tipo, valida CUIT/dirección y el mínimo, y NUNCA confía en precios que mande el navegador.
--  4) tienda_vendedores(): nombre + WhatsApp de los vendedores activos, para el selector del carrito.
--  5) pasar_pedido_a_venta con vendedor opcional: la venta va a la cuenta de ese vendedor (con su
--     comisión) y el cliente queda en su cartera; sin vendedor queda como Tienda Online y el cliente
--     como cliente directo. Se crea/vincula el cliente por CUIT (o por nombre si no tiene).
--  6) El público (anon) ya no puede leer precio de costo ni stock de productos: solo las columnas
--     que usa la tienda.
--  7) mis_movimientos: el vendedor también ve los pedidos online que se le asignaron.

-- ===== 1) Configuración de la tienda =====

create table tienda_config (
  id boolean primary key default true check (id),
  recargo_particular_pct numeric(6,2) not null default 25 check (recargo_particular_pct >= 0),
  minimo_particular numeric(12,2) not null default 50000 check (minimo_particular >= 0),
  updated_at timestamptz not null default now(),
  updated_by uuid default auth.uid()
);
insert into tienda_config default values;
alter table tienda_config enable row level security;
create policy "tienda_config_select_staff" on tienda_config for select using (es_staff());
grant select on tienda_config to authenticated;

create or replace function tienda_config_publica() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('recargo_particular_pct', recargo_particular_pct, 'minimo_particular', minimo_particular)
  from tienda_config;
$$;
grant execute on function tienda_config_publica() to anon, authenticated;

create or replace function guardar_config_tienda(p_recargo numeric, p_minimo numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not es_admin() then
    raise exception 'Solo el administrador puede cambiar esto';
  end if;
  if p_recargo is null or p_recargo < 0 or p_recargo > 500 then
    raise exception 'El recargo tiene que ser un porcentaje entre 0 y 500';
  end if;
  if p_minimo is null or p_minimo < 0 then
    raise exception 'El mínimo de compra no puede ser negativo';
  end if;
  update tienda_config set recargo_particular_pct = p_recargo, minimo_particular = p_minimo,
    updated_at = now(), updated_by = auth.uid();
end;
$$;
revoke all on function guardar_config_tienda(numeric, numeric) from public, anon;
grant execute on function guardar_config_tienda(numeric, numeric) to authenticated;

-- ===== 2) Columnas nuevas =====

alter table ventas
  add column cliente_tipo text check (cliente_tipo in ('comercio', 'particular')),
  add column cliente_cuit text,
  add column cliente_direccion text,
  add column vendedor_preferido_id bigint;

alter table clientes
  add column cuit text,
  add column tipo text check (tipo in ('comercio', 'particular')),
  add column direccion text;
create index clientes_cuit_idx on clientes (cuit) where cuit is not null;

-- ===== 3) Pedido de la tienda =====

drop function if exists crear_venta_online(text, text, jsonb);

create or replace function crear_pedido_online(
  p_cliente_nombre text, p_tipo text, p_cuit text, p_direccion text, p_vendedor_id bigint, p_items jsonb
) returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_online bigint;
  v_cfg tienda_config%rowtype;
  v_nombre text := trim(coalesce(p_cliente_nombre, ''));
  v_dir text := trim(coalesce(p_direccion, ''));
  v_cuit text := regexp_replace(coalesce(p_cuit, ''), '\D', '', 'g');
  v_factor numeric;
  v_items jsonb;
  v_total numeric;
  v_id bigint;
begin
  if v_nombre = '' then raise exception 'Ingresá tu nombre.'; end if;
  if v_dir = '' then raise exception 'Ingresá la dirección de entrega.'; end if;
  if length(v_nombre) > 120 or length(v_dir) > 200 then raise exception 'El nombre o la dirección son demasiado largos.'; end if;
  if p_tipo is null or p_tipo not in ('comercio', 'particular') then
    raise exception 'Elegí si comprás como comercio o como particular.';
  end if;
  if p_tipo = 'comercio' and length(v_cuit) <> 11 then
    raise exception 'Ingresá el CUIT o CUIL (11 números).';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'El pedido no tiene productos.';
  end if;
  if jsonb_array_length(p_items) > 200 then raise exception 'El pedido tiene demasiados productos.'; end if;

  select id into v_online from vendedores where es_canal_online = true limit 1;
  if v_online is null then raise exception 'No hay un vendedor configurado como canal online'; end if;

  if p_vendedor_id is not null and not exists (
    select 1 from vendedores where id = p_vendedor_id and activo and not es_canal_online
  ) then
    raise exception 'El vendedor elegido ya no está disponible.';
  end if;

  select * into v_cfg from tienda_config;
  v_factor := case when p_tipo = 'particular' then 1 + v_cfg.recargo_particular_pct / 100 else 1 end;

  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where not exists (select 1 from productos p where p.id = (e->>'producto_id')::bigint and p.activo)
  ) then
    raise exception 'Hay un producto que ya no está disponible. Actualizá la página.';
  end if;
  if exists (
    select 1 from jsonb_array_elements(p_items) e
    where (e->>'cantidad')::numeric is null or (e->>'cantidad')::numeric <= 0 or (e->>'cantidad')::numeric > 9999
  ) then
    raise exception 'Hay una cantidad inválida en el pedido.';
  end if;

  -- El precio sale siempre de la base (por tipo de cliente); del navegador solo vienen producto y cantidad.
  select jsonb_agg(jsonb_build_object(
           'producto_id', p.id, 'cantidad', (e->>'cantidad')::numeric,
           'precio_unitario', round(p.precio_venta * v_factor, 2))),
         sum(round(p.precio_venta * v_factor, 2) * (e->>'cantidad')::numeric)
    into v_items, v_total
  from jsonb_array_elements(p_items) e
  join productos p on p.id = (e->>'producto_id')::bigint;

  if p_tipo = 'particular' and v_total < v_cfg.minimo_particular then
    raise exception 'El pedido mínimo para compras de particulares es de $ %.', trim(to_char(v_cfg.minimo_particular, 'FM999G999G999'));
  end if;

  v_id := _crear_venta(v_online, 'online', v_nombre, null, v_items, true);
  update ventas set cliente_tipo = p_tipo,
                    cliente_cuit = case when p_tipo = 'comercio' then v_cuit else null end,
                    cliente_direccion = v_dir,
                    vendedor_preferido_id = p_vendedor_id
  where id = v_id;

  return jsonb_build_object('id', v_id, 'total', v_total);
end;
$$;
grant execute on function crear_pedido_online(text, text, text, text, bigint, jsonb) to anon, authenticated;

-- ===== 4) Vendedores visibles en la tienda (nombre + WhatsApp) =====

create or replace function tienda_vendedores() returns table (id bigint, nombre text, telefono text)
language sql stable security definer set search_path = public as $$
  select v.id, v.nombre, v.telefono from vendedores v
  where v.activo and not v.es_canal_online and coalesce(trim(v.telefono), '') <> ''
  order by v.nombre;
$$;
grant execute on function tienda_vendedores() to anon, authenticated;

-- ===== 5) Pasar a venta con vendedor =====

drop function if exists pasar_pedido_a_venta(bigint, jsonb);

create or replace function pasar_pedido_a_venta(p_venta_id bigint, p_items jsonb, p_vendedor_id bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_venta ventas%rowtype;
  v_vendedor vendedores%rowtype;
  v_item jsonb;
  v_producto_id bigint;
  v_cantidad numeric;
  v_precio numeric;
  v_pct numeric;
  v_subtotal numeric;
  v_total_bruto numeric := 0;
  v_total_comision numeric := 0;
  v_dueno bigint;
  v_cliente_id bigint;
begin
  if not es_staff() then
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

  select * into v_vendedor from vendedores where id = coalesce(p_vendedor_id, v_venta.vendedor_id);
  if not found or (not v_vendedor.activo and not v_vendedor.es_canal_online) then
    raise exception 'El vendedor elegido no está disponible';
  end if;

  delete from ventas_items where venta_id = p_venta_id;

  for v_item in select * from jsonb_array_elements(p_items) loop
    v_producto_id := (v_item->>'producto_id')::bigint;
    v_cantidad := (v_item->>'cantidad')::numeric;
    v_precio := (v_item->>'precio_unitario')::numeric;
    if v_cantidad is null or v_cantidad <= 0 or v_precio is null or v_precio < 0 then
      raise exception 'Item inválido para el producto %', v_producto_id;
    end if;

    v_pct := resolver_comision(v_vendedor.id, v_producto_id);
    v_subtotal := v_precio * v_cantidad;
    v_total_bruto := v_total_bruto + v_subtotal;
    v_total_comision := v_total_comision + (v_subtotal * v_pct / 100);

    insert into ventas_items (venta_id, producto_id, cantidad, precio_unitario, comision_pct, subtotal)
    values (p_venta_id, v_producto_id, v_cantidad, v_precio, v_pct, v_subtotal);

    perform _fefo_consumir(v_producto_id, v_cantidad, 'venta', p_venta_id);
  end loop;

  -- Cliente: se vincula (o se crea) por CUIT, o por nombre si no tiene. Si la venta se asigna a un
  -- vendedor, el cliente queda en la cartera de ese vendedor; si no, es cliente directo (sin vendedor).
  v_cliente_id := v_venta.cliente_id;
  if v_cliente_id is null and coalesce(trim(v_venta.cliente_nombre), '') <> '' then
    v_dueno := case when v_vendedor.es_canal_online then null else v_vendedor.id end;
    if coalesce(v_venta.cliente_cuit, '') <> '' then
      select id into v_cliente_id from clientes
      where cuit = v_venta.cliente_cuit and vendedor_id is not distinct from v_dueno
      order by activo desc, id limit 1;
    else
      select id into v_cliente_id from clientes
      where lower(nombre) = lower(trim(v_venta.cliente_nombre)) and coalesce(cuit, '') = ''
        and vendedor_id is not distinct from v_dueno
      order by activo desc, id limit 1;
    end if;
    if v_cliente_id is null then
      insert into clientes (nombre, vendedor_id, cuit, tipo, direccion)
      values (trim(v_venta.cliente_nombre), v_dueno, nullif(v_venta.cliente_cuit, ''), v_venta.cliente_tipo, v_venta.cliente_direccion)
      returning id into v_cliente_id;
    else
      update clientes set activo = true where id = v_cliente_id and not activo;
    end if;
  end if;

  update ventas set
    estado = 'confirmada',
    vendedor_id = v_vendedor.id,
    cliente_id = v_cliente_id,
    total_bruto = v_total_bruto,
    total_descuento_comision = v_total_comision,
    total_neto = v_total_bruto - v_total_comision
  where id = p_venta_id;

  return p_venta_id;
end;
$$;
revoke all on function pasar_pedido_a_venta(bigint, jsonb, bigint) from public, anon;
grant execute on function pasar_pedido_a_venta(bigint, jsonb, bigint) to authenticated;

-- ===== 6) El público no ve costos ni stock =====

revoke select on productos from anon;
grant select (id, marca_id, categoria_id, nombre, unidad, precio_venta, imagen_url, activo) on productos to anon;

-- ===== 7) mis_movimientos: también los pedidos online asignados al vendedor =====

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
      from ventas v where v.vendedor_id = v_id and v.canal in ('manual', 'vendedor', 'online') and v.estado <> 'pendiente'
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
