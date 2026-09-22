-- 0021 — Ventas: "Limpiar cuentas corrientes", columna de devolución de stock, clientes propios
-- del dueño (no los de la cartera de cada vendedor), y las ventas que un vendedor se registra solo
-- (desde su cartera) dejan de aparecer en el Historial del dueño.
--
-- 1) La cuenta corriente de vendedores mezclaba en una sola columna "Devol." tanto la devolución común
--    (vencidos, etc.) como la devolución de stock (mercadería en buen estado que vuelve a stock). La
--    cuenta ya las restaba bien a las dos (devoluciones_cab.total suma ambas), pero visualmente no se
--    distinguían. Se agrega `devuelto_stock` a la vista y a mi_panel(), sin tocar `devuelto` (sigue
--    siendo el total de las dos, así no cambia nada para quien ya lo usa).
--
-- 2) "Limpiar cuentas corrientes": todos los viernes se cierra la semana y en general queda todo en 0.
--    El botón no borra nada — el Historial, el Dashboard y "Mis movimientos" del vendedor siguen
--    mostrando todo. Lo que hace es mover un punto de corte: las cuentas corrientes (vendedores y
--    clientes, en Ventas, y "Tu saldo hoy"/"Ver totales de siempre" del panel del vendedor, que se
--    calculan a partir de la misma vista) solo suman lo que pasó DESPUÉS de ese corte.
--
-- 3) Clientes: los que un vendedor carga en "Mi cartera de clientes" son SUYOS (su propia cuenta con
--    ellos), no del dueño. clientes_saldo (la cuenta corriente de "Ventas") pasa a mostrar solo los
--    clientes SIN vendedor asignado — los que carga directamente el dueño.
--
-- 4) Cuando un vendedor registra una venta a un cliente de su propia cartera (mi_registrar_venta),
--    esa venta sigue contando en su "Retirado" (comisión, deuda, dashboard: nada de eso cambia), pero
--    deja de listarse en el Historial del dueño — es un movimiento del vendedor con su cliente, no una
--    operación que el dueño cargó. Para distinguirla se le pone canal='vendedor' (antes 'manual').

-- ===== 1) checkpoint =====

create table cuentas_checkpoint (
  id boolean primary key default true check (id),  -- una sola fila siempre
  desde timestamptz not null default '-infinity',
  updated_by uuid references auth.users(id),
  updated_at timestamptz not null default now()
);
insert into cuentas_checkpoint (id) values (true);

alter table cuentas_checkpoint enable row level security;
create policy "cuentas_checkpoint_staff_select" on cuentas_checkpoint for select using (es_staff());
revoke all on cuentas_checkpoint from public, anon;
grant select on cuentas_checkpoint to authenticated;

-- ===== 2) canal='vendedor' para lo que un vendedor se registra solo =====

do $$
declare v_con text;
begin
  select con.conname into v_con
  from pg_constraint con join pg_class rel on rel.oid = con.conrelid
  where rel.relname = 'ventas' and con.contype = 'c' and pg_get_constraintdef(con.oid) ilike '%canal%';
  if v_con is not null then
    execute format('alter table ventas drop constraint %I', v_con);
  end if;
end $$;
alter table ventas add constraint ventas_canal_check check (canal in ('manual', 'online', 'vendedor'));

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

  select jsonb_agg(jsonb_build_object('producto_id', (e->>'producto_id')::bigint, 'cantidad', (e->>'cantidad')::numeric))
  into v_items from jsonb_array_elements(p_items) e;

  return _crear_venta(v_id, 'vendedor', null, null, v_items, false, p_cliente_id);
end;
$$;

-- mis_movimientos mostraba solo canal='manual'; ahora las ventas propias del vendedor son 'vendedor'
-- y también tienen que seguir apareciendo ahí (es su cuenta).
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
      from ventas v where v.vendedor_id = v_id and v.canal in ('manual', 'vendedor')
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

-- ===== 3) vistas: checkpoint, devolución de stock separada, y solo clientes sin vendedor =====

-- OJO: create or replace view solo permite AGREGAR columnas al final de la lista (si "devuelto_stock"
-- se inserta en el medio, Postgres lo interpreta como que se está renombrando "pagado" y falla).
create or replace view vendedores_saldo as
select
  v.id as vendedor_id,
  v.nombre,
  coalesce((select sum(total_neto) from ventas
    where vendedor_id = v.id and estado = 'confirmada' and created_at >= (select desde from cuentas_checkpoint)), 0) as retirado,
  coalesce((select sum(total) from devoluciones_cab
    where vendedor_id = v.id and not anulado and created_at >= (select desde from cuentas_checkpoint)), 0) as devuelto,
  coalesce((select sum(monto) from pagos_vendedores
    where vendedor_id = v.id and not anulado and created_at >= (select desde from cuentas_checkpoint)), 0) as pagado,
  coalesce((select sum(monto) from bonificaciones
    where vendedor_id = v.id and not anulado and created_at >= (select desde from cuentas_checkpoint)), 0) as bonificado,
  coalesce((select sum(total) from devoluciones_cab
    where vendedor_id = v.id and not anulado and con_stock and created_at >= (select desde from cuentas_checkpoint)), 0) as devuelto_stock
from vendedores v;

-- Solo los clientes que carga el dueño (sin vendedor_id): los de la cartera de cada vendedor son
-- cuenta de ese vendedor, no del dueño.
create or replace view clientes_saldo as
select
  c.id as cliente_id,
  c.nombre,
  coalesce((select sum(total_neto) from ventas
    where cliente_id = c.id and estado = 'confirmada' and created_at >= (select desde from cuentas_checkpoint)), 0) as comprado,
  coalesce((select sum(d.total) from devoluciones_cab d join ventas v on v.id = d.venta_id
    where v.cliente_id = c.id and not d.anulado and d.created_at >= (select desde from cuentas_checkpoint)), 0) as devuelto,
  coalesce((select sum(monto) from pagos_clientes
    where cliente_id = c.id and not anulado and created_at >= (select desde from cuentas_checkpoint)), 0) as pagado
from clientes c
where c.vendedor_id is null;

grant select on vendedores_saldo, clientes_saldo to authenticated;

create or replace function limpiar_cuentas_corrientes() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_ahora timestamptz := now();
begin
  if not es_staff() then
    raise exception 'No autorizado';
  end if;
  update cuentas_checkpoint set desde = v_ahora, updated_by = auth.uid(), updated_at = v_ahora;
  return v_ahora;
end;
$$;

revoke all on function limpiar_cuentas_corrientes() from public, anon;
grant execute on function limpiar_cuentas_corrientes() to authenticated;

-- ===== 4) mi_panel(): agrega devuelto_stock (informativo, no cambia debe ni devuelto) =====

create or replace function mi_panel() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select jsonb_build_object(
    'nombre', v.nombre,
    'retirado', s.retirado,
    'devuelto', s.devuelto,
    'devuelto_stock', s.devuelto_stock,
    'bonificado', s.bonificado,
    'pagado', s.pagado,
    'debe', s.retirado - s.devuelto - s.bonificado - s.pagado,
    'comision_ventas', coalesce((select sum(total_descuento_comision) from ventas where vendedor_id = v_id and estado = 'confirmada'), 0),
    'comision_devoluciones', coalesce((select sum(i.subtotal * i.comision_pct / 100) from devoluciones_items i
        join devoluciones_cab d on d.id = i.devolucion_id where d.vendedor_id = v_id and not d.anulado), 0)
      + coalesce((select sum(i.subtotal * i.comision_pct / 100) from bonificaciones_items i
        join bonificaciones b on b.id = i.bonificacion_id where b.vendedor_id = v_id and not b.anulado), 0),
    'cantidad_ventas', (select count(*) from ventas where vendedor_id = v_id and estado = 'confirmada')
  ) into r
  from vendedores v join vendedores_saldo s on s.vendedor_id = v.id
  where v.id = v_id;
  return r;
end;
$$;
