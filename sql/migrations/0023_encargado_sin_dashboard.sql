-- 0023 — El rol "encargado" no tiene acceso al Dashboard (ni a Usuarios, que ya era solo del admin).
--
-- dash_periodo/dash_tendencia se movían con es_staff() (admin + encargado). Pasan a es_admin(), así
-- la restricción es real (no solo esconder el link en el menú): aunque alguien intente llamar a estas
-- funciones directamente, un encargado se encuentra con "No autorizado".

create or replace function dash_periodo(p_desde date, p_hasta date) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  r jsonb;
begin
  if not es_admin() then
    raise exception 'No autorizado';
  end if;

  with v as (
    select * from ventas where estado = 'confirmada' and _fecha_ar(created_at) between p_desde and p_hasta
  ), vi as (
    select i.*, v.vendedor_id, v.cliente_id from ventas_items i join v on v.id = i.venta_id
  ), d as (
    select * from devoluciones_cab where not anulado and _fecha_ar(created_at) between p_desde and p_hasta
  ), di as (
    select i.* from devoluciones_items i join d on d.id = i.devolucion_id
  )
  select jsonb_build_object(
    'desde', p_desde,
    'hasta', p_hasta,
    'kpis', jsonb_build_object(
      'ventas_neto', coalesce((select sum(total_neto) from v), 0),
      'ventas_bruto', coalesce((select sum(total_bruto) from v), 0),
      'comisiones', coalesce((select sum(total_descuento_comision) from v), 0),
      'cantidad_ventas', (select count(*) from v),
      'unidades', coalesce((select sum(cantidad) from vi), 0),
      'devoluciones', coalesce((select sum(total) from d), 0),
      'cantidad_devoluciones', (select count(*) from d),
      'bonificaciones', coalesce((select sum(monto) from bonificaciones where not anulado and _fecha_ar(created_at) between p_desde and p_hasta), 0),
      'cobros', coalesce((select sum(monto) from pagos_vendedores where not anulado and _fecha_ar(created_at) between p_desde and p_hasta), 0)
              + coalesce((select sum(monto) from pagos_clientes where not anulado and _fecha_ar(created_at) between p_desde and p_hasta), 0),
      'gastos', coalesce((select sum(monto) from gastos where not anulado and _fecha_ar(created_at) between p_desde and p_hasta), 0),
      'pagos_proveedores', coalesce((select sum(monto_neto) from pagos_proveedores where not anulado and _fecha_ar(created_at) between p_desde and p_hasta), 0),
      'costo_estimado', coalesce((select sum(vi.cantidad * p.precio_compra) from vi join productos p on p.id = vi.producto_id), 0)
    ),
    'por_dia', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'fecha', g::date,
        'ventas_neto', coalesce((select sum(total_neto) from v where _fecha_ar(created_at) = g::date), 0),
        'cantidad', (select count(*) from v where _fecha_ar(created_at) = g::date)
      ) order by g), '[]'::jsonb)
      from generate_series(p_desde::timestamp, p_hasta::timestamp, interval '1 day') g
    ),
    'productos', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.monto desc), '[]'::jsonb) from (
        select p.id, p.nombre, p.unidad, m.nombre as marca, sum(vi.cantidad) as unidades, sum(vi.subtotal) as monto,
               count(distinct vi.venta_id) as ventas
        from vi join productos p on p.id = vi.producto_id left join marcas m on m.id = p.marca_id
        group by p.id, p.nombre, p.unidad, m.nombre order by sum(vi.subtotal) desc limit 30
      ) t
    ),
    'vendedores', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.neto desc), '[]'::jsonb) from (
        select vd.id, vd.nombre, vd.es_canal_online as online, count(*) as ventas, sum(v.total_neto) as neto,
               sum(v.total_bruto) as bruto, sum(v.total_descuento_comision) as comision,
               coalesce((select sum(d.total) from d where d.vendedor_id = vd.id), 0) as devuelto
        from v join vendedores vd on vd.id = v.vendedor_id
        group by vd.id, vd.nombre, vd.es_canal_online order by sum(v.total_neto) desc limit 15
      ) t
    ),
    'devueltos', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.unidades desc), '[]'::jsonb) from (
        select p.id, p.nombre, p.unidad, m.nombre as marca, sum(di.cantidad) as unidades, sum(di.subtotal) as monto,
               count(distinct di.devolucion_id) as devoluciones,
               coalesce((select sum(vi.cantidad) from vi where vi.producto_id = p.id), 0) as vendidas
        from di join productos p on p.id = di.producto_id left join marcas m on m.id = p.marca_id
        group by p.id, p.nombre, p.unidad, m.nombre order by sum(di.cantidad) desc limit 15
      ) t
    ),
    'marcas', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.monto desc), '[]'::jsonb) from (
        select coalesce(m.nombre, 'Sin marca') as nombre, m.color, sum(vi.subtotal) as monto, sum(vi.cantidad) as unidades
        from vi join productos p on p.id = vi.producto_id left join marcas m on m.id = p.marca_id
        group by m.nombre, m.color order by sum(vi.subtotal) desc limit 15
      ) t
    ),
    'categorias', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.monto desc), '[]'::jsonb) from (
        select coalesce(c.nombre, 'Sin categoría') as nombre, c.color, sum(vi.subtotal) as monto
        from vi join productos p on p.id = vi.producto_id left join categorias c on c.id = p.categoria_id
        group by c.nombre, c.color order by sum(vi.subtotal) desc
      ) t
    ),
    'clientes', (
      select coalesce(jsonb_agg(to_jsonb(t) order by t.monto desc), '[]'::jsonb) from (
        select c.id, c.nombre, count(*) as ventas, sum(v.total_bruto) as monto
        from v join clientes c on c.id = v.cliente_id
        group by c.id, c.nombre order by sum(v.total_bruto) desc limit 10
      ) t
    )
  ) into r;
  return r;
end;
$$;

create or replace function dash_tendencia(p_semanas int default 12) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_actual date := date_trunc('week', now() at time zone 'America/Argentina/Buenos_Aires')::date;
  r jsonb;
begin
  if not es_admin() then
    raise exception 'No autorizado';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'desde', s.desde,
    'hasta', s.desde + 6,
    'ventas_neto', coalesce((select sum(total_neto) from ventas where estado = 'confirmada' and _fecha_ar(created_at) between s.desde and s.desde + 6), 0),
    'cantidad_ventas', (select count(*) from ventas where estado = 'confirmada' and _fecha_ar(created_at) between s.desde and s.desde + 6),
    'creditos', coalesce((select sum(total) from devoluciones_cab where not anulado and _fecha_ar(created_at) between s.desde and s.desde + 6), 0)
              + coalesce((select sum(monto) from bonificaciones where not anulado and _fecha_ar(created_at) between s.desde and s.desde + 6), 0),
    'cobros', coalesce((select sum(monto) from pagos_vendedores where not anulado and _fecha_ar(created_at) between s.desde and s.desde + 6), 0)
            + coalesce((select sum(monto) from pagos_clientes where not anulado and _fecha_ar(created_at) between s.desde and s.desde + 6), 0),
    'egresos', coalesce((select sum(monto) from gastos where not anulado and _fecha_ar(created_at) between s.desde and s.desde + 6), 0)
             + coalesce((select sum(monto_neto) from pagos_proveedores where not anulado and _fecha_ar(created_at) between s.desde and s.desde + 6), 0),
    'pagos_proveedores', coalesce((select sum(monto_neto) from pagos_proveedores where not anulado and _fecha_ar(created_at) between s.desde and s.desde + 6), 0),
    'costo_estimado', coalesce((
      select sum(vi.cantidad * p.precio_compra)
      from ventas_items vi join ventas v on v.id = vi.venta_id join productos p on p.id = vi.producto_id
      where v.estado = 'confirmada' and _fecha_ar(v.created_at) between s.desde and s.desde + 6
    ), 0)
  ) order by s.desde desc), '[]'::jsonb) into r
  from (select (v_actual - (i * 7))::date as desde from generate_series(0, greatest(p_semanas, 1) - 1) as i) s;
  return r;
end;
$$;
