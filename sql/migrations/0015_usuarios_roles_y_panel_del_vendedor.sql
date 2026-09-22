-- DIARNEC — usuarios reales con roles, y panel propio para cada vendedor.
--
-- POR QUÉ NO ANDABA LA CREACIÓN DE USUARIOS: la Edge Function crea el acceso en Supabase Auth y
-- después lo anota en staff_usuarios con la service_role key, pero en este proyecto service_role no
-- tenía permisos sobre las tablas de public: el alta de Auth se hacía y el registro fallaba, dejando
-- usuarios "huérfanos" (santiago y emiliano existen en Auth pero no en staff_usuarios).
--
-- QUÉ CAMBIA:
--  1) service_role recibe permisos sobre public (arregla la creación).
--  2) staff_usuarios se vincula con un vendedor (vendedor_id) y se cargan los usuarios ya existentes
--     (cristian = admin; emiliano = vendedor Emiliano).
--  3) Roles de verdad. Hasta hoy todas las políticas decían "cualquier usuario logueado", lo cual con
--     usuarios vendedores les daría acceso a todo. Ahora es_staff() (admin/encargado) reemplaza a ese
--     chequeo en todas las políticas RLS y en todas las funciones. Un vendedor no ve ni escribe nada
--     directamente: solo usa las funciones mi_* de abajo, que devuelven únicamente lo suyo.
--  4) Cierres de seguridad: la función interna _crear_venta (sin chequeo de rol) deja de ser
--     ejecutable desde afuera; los saldos ya no se ven con los permisos del dueño de la vista; y el
--     costo/stock de los productos deja de ser legible con la clave pública de la tienda.
--  5) Panel del vendedor: mi_panel, mis_movimientos, mi_cartera y mi_lista_precios.
--  6) clientes.vendedor_id: a quién pertenece cada cliente (la "cartera" del vendedor).

-- ===== 1) Permisos de service_role =====

grant usage on schema public to service_role;
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;

-- ===== 2) Vínculo usuario <-> vendedor y usuarios existentes =====

alter table staff_usuarios add column vendedor_id bigint references vendedores(id);
create unique index staff_usuarios_vendedor_uniq on staff_usuarios (vendedor_id) where vendedor_id is not null;
alter table staff_usuarios add constraint staff_usuarios_vendedor_chk check ((rol = 'vendedor') = (vendedor_id is not null));

insert into staff_usuarios (auth_user_id, username, rol)
select id, 'cristian', 'admin' from auth.users where email = 'cristian@diarnec.local'
on conflict (auth_user_id) do nothing;

insert into staff_usuarios (auth_user_id, username, rol, vendedor_id)
select u.id, 'emiliano', 'vendedor', v.id
from auth.users u, vendedores v
where u.email = 'emiliano@diarnec.local' and v.nombre = 'Emiliano' and not v.es_canal_online
on conflict (auth_user_id) do nothing;

-- ===== 3) Roles: helpers y políticas =====

create or replace function es_staff() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_usuarios where auth_user_id = auth.uid() and rol in ('admin', 'encargado'));
$$;

create or replace function es_admin() returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from staff_usuarios where auth_user_id = auth.uid() and rol = 'admin');
$$;

create or replace function mi_vendedor_id() returns bigint language sql stable security definer set search_path = public as $$
  select vendedor_id from staff_usuarios where auth_user_id = auth.uid() and rol = 'vendedor';
$$;

create or replace function mi_perfil() returns jsonb language sql stable security definer set search_path = public as $$
  select to_jsonb(x) from (select username, rol, vendedor_id from staff_usuarios where auth_user_id = auth.uid()) x;
$$;

revoke all on function es_staff(), es_admin(), mi_vendedor_id(), mi_perfil() from public;
grant execute on function es_staff(), es_admin() to anon, authenticated;
grant execute on function mi_vendedor_id(), mi_perfil() to authenticated;

-- Cada usuario puede leer su propia fila (así el navegador sabe qué rol tiene)
create policy "staff_usuarios_select_self" on staff_usuarios for select using (auth_user_id = auth.uid());

-- Toda política que decía "usuario logueado" pasa a exigir staff (admin/encargado)
do $$
declare
  p record;
  q text;
  w text;
begin
  for p in select * from pg_policies where schemaname = 'public'
           and (coalesce(qual, '') like '%auth.role()%' or coalesce(with_check, '') like '%auth.role()%')
  loop
    q := replace(p.qual, '(auth.role() = ''authenticated''::text)', 'es_staff()');
    w := replace(p.with_check, '(auth.role() = ''authenticated''::text)', 'es_staff()');
    execute format('alter policy %I on %I.%I %s %s', p.policyname, p.schemaname, p.tablename,
      case when q is not null then 'using (' || q || ')' else '' end,
      case when w is not null then 'with check (' || w || ')' else '' end);
  end loop;
end;
$$;

-- Lo mismo en las funciones: "auth.role() <> 'authenticated'" pasa a "not es_staff()"
do $$
declare
  f record;
  def text;
begin
  for f in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.prosrc like '%auth.role() <> ''authenticated''%'
  loop
    def := replace(pg_get_functiondef(f.oid), 'auth.role() <> ''authenticated''', 'not es_staff()');
    execute def;
  end loop;
end;
$$;

-- ===== 4) Cierres de seguridad =====

-- _crear_venta no chequea rol y confía en precios/comisiones que le pasen: solo la usan las funciones
-- públicas de venta (que corren como dueño), nadie más debe poder llamarla.
revoke all on function _crear_venta(bigint, text, text, text, jsonb, boolean, bigint) from public, anon, authenticated;

-- Los saldos se calculan con los permisos de quien consulta (antes, con los del dueño de la vista)
alter view vendedores_saldo set (security_invoker = true);
alter view clientes_saldo set (security_invoker = true);

-- Con la clave pública solo se lee lo que necesita la tienda: sin costo, stock ni SKU
alter policy productos_select_public on productos to anon;
revoke select on productos from anon;
grant select (id, marca_id, categoria_id, nombre, unidad, precio_venta, imagen_url, activo) on productos to anon;

-- ===== 5) Cartera de clientes =====

alter table clientes add column vendedor_id bigint references vendedores(id);

-- ===== 6) Panel del vendedor: solo devuelven datos del vendedor que consulta =====

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

create or replace function mis_movimientos() returns jsonb language plpgsql stable security definer set search_path = public as $$
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
    ) u order by u.f desc limit 300
  ) m;
  return r;
end;
$$;

create or replace function mi_cartera() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.nombre), '[]'::jsonb) into r from (
    select c.id, c.nombre, c.localidad, c.contacto, c.telefono,
      coalesce(sum(v.total_neto) filter (where v.estado = 'confirmada'), 0) as comprado,
      count(v.id) filter (where v.estado = 'confirmada') as compras,
      max(v.created_at) filter (where v.estado = 'confirmada') as ultima_compra
    from clientes c
    left join ventas v on v.cliente_id = c.id and v.vendedor_id = v_id
    where c.activo and (c.vendedor_id = v_id or exists (select 1 from ventas x where x.cliente_id = c.id and x.vendedor_id = v_id))
    group by c.id
  ) x;
  return r;
end;
$$;

-- Lista de precios en vivo: sin costos ni stock. Incluye la comisión del vendedor por marca.
create or replace function mi_lista_precios() returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id', p.id, 'marca', m.nombre, 'marca_color', m.color, 'categoria', c.nombre, 'por_peso', coalesce(c.por_peso, false),
    'nombre', p.nombre, 'unidad', p.unidad, 'precio', p.precio_venta, 'comision_pct', coalesce(cv.comision_pct, 0),
    'imagen_url', p.imagen_url) order by m.nombre, p.nombre), '[]'::jsonb) into r
  from productos p
  left join marcas m on m.id = p.marca_id
  left join categorias c on c.id = p.categoria_id
  left join comisiones_vendedor_marca cv on cv.marca_id = p.marca_id and cv.vendedor_id = v_id
  where p.activo;
  return r;
end;
$$;

revoke all on function mi_panel(), mis_movimientos(), mi_cartera(), mi_lista_precios() from public, anon;
grant execute on function mi_panel(), mis_movimientos(), mi_cartera(), mi_lista_precios() to authenticated;
