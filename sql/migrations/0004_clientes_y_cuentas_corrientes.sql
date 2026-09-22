-- DIARNEC — módulo Ventas: cuentas corrientes de Vendedores (ya existía vendedores_saldo)
-- y de Clientes (nuevo). Modelo de consignación: el vendedor "retira" mercadería (queda
-- como deuda), y va saldando con lo vendido a clientes + devoluciones + pagos + bonificaciones.

-- ===== Clientes (comercios con cuenta corriente, igual patrón que proveedores) =====

create table clientes (
  id bigint generated always as identity primary key,
  nombre text not null,
  contacto text default '',
  telefono text default '',
  localidad text default '',
  activo boolean not null default true,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

-- Vincula una venta manual a un cliente fijo (además del texto libre cliente_nombre que
-- ya usan los pedidos online, donde no hay un registro de clientes formal).
alter table ventas add column cliente_id bigint references clientes(id);
create index ventas_cliente_idx on ventas (cliente_id);

create table pagos_clientes (
  id bigint generated always as identity primary key,
  cliente_id bigint not null references clientes(id),
  medio_pago text not null check (medio_pago in ('efectivo','transferencia','cheque')),
  monto numeric(12,2) not null,
  descripcion text default '',
  fecha date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

-- ===== Vista de saldo por cliente (misma forma que vendedores_saldo) =====

create or replace view clientes_saldo as
select
  c.id as cliente_id,
  c.nombre,
  coalesce((select sum(total_neto) from ventas where cliente_id = c.id and estado = 'confirmada'), 0) as comprado,
  coalesce((select sum(d.total) from devoluciones_cab d join ventas v on v.id = d.venta_id where v.cliente_id = c.id), 0) as devuelto,
  coalesce((select sum(monto) from pagos_clientes where cliente_id = c.id), 0) as pagado
from clientes c;

-- ===== registrar_venta_manual: ahora acepta un cliente_id opcional =====

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
begin
  if jsonb_array_length(p_items) = 0 then
    raise exception 'La venta no tiene items';
  end if;

  if p_cliente_id is not null then
    select nombre into v_cliente_nombre from clientes where id = p_cliente_id;
  end if;

  insert into ventas (vendedor_id, canal, cliente_id, cliente_nombre, cliente_localidad, total_bruto, total_neto, created_by)
  values (p_vendedor_id, p_canal, p_cliente_id, coalesce(v_cliente_nombre, ''), coalesce(p_cliente_localidad, ''), 0, 0, auth.uid())
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

create or replace function registrar_venta_manual(p_vendedor_id bigint, p_items jsonb, p_cliente_id bigint default null)
returns bigint language plpgsql security definer set search_path = public as $$
begin
  if auth.role() <> 'authenticated' then
    raise exception 'No autorizado';
  end if;
  return _crear_venta(p_vendedor_id, 'manual', null, null, p_items, true, p_cliente_id);
end;
$$;
revoke all on function registrar_venta_manual(bigint, jsonb, bigint) from anon;
grant execute on function registrar_venta_manual(bigint, jsonb, bigint) to authenticated;

-- La versión vieja de 2 parámetros queda huérfana (Postgres permite overloads);
-- la borramos para no dejar dos formas de registrar una venta manual.
drop function if exists registrar_venta_manual(bigint, jsonb);

-- ===== Permisos =====

grant select, insert, update, delete on clientes, pagos_clientes to authenticated;

-- Las vistas son objetos aparte: necesitan su propio grant aunque el usuario ya
-- tenga acceso a las tablas de abajo. vendedores_saldo venía de schema.sql (fase 0)
-- y nunca se le dio grant hasta ahora, por eso el módulo de Ventas no la podía leer.
grant select on vendedores_saldo, clientes_saldo to authenticated;

alter table clientes enable row level security;
create policy "clientes_staff" on clientes for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table pagos_clientes enable row level security;
create policy "pagos_clientes_staff" on pagos_clientes for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
