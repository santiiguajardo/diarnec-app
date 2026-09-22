-- 0020 — Balance del Dashboard: plata a proveedores vs. plata ganada
--
-- dash_tendencia traía "egresos" ya sumado (gastos + pagos a proveedores) y no traía el costo de lo
-- vendido, así que no se podía graficar "lo que le pagaste a los proveedores" contra "lo que ganaste"
-- semana a semana. Se agregan esos dos campos, sin tocar los que ya usa el gráfico de tendencia.

create or replace function dash_tendencia(p_semanas int default 12) returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_actual date := date_trunc('week', now() at time zone 'America/Argentina/Buenos_Aires')::date;
  r jsonb;
begin
  if not es_staff() then
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

revoke all on function dash_tendencia(int) from public, anon;
grant execute on function dash_tendencia(int) to authenticated;
