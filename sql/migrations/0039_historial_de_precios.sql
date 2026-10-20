-- 0039 — Historial de cambios de precio de venta (para el "Reporte de aumentos" de Inventario).
--
-- Hasta ahora, al cambiar un precio se perdía el anterior. Esta tabla guarda cada cambio de precio de venta
-- de un producto (precio anterior, precio nuevo y cuándo), lo cargue quien lo cargue: la edición en Inventario,
-- "Act. Masiva (%)" o un cambio directo en la base. Lo escribe un disparador (trigger), nadie desde el navegador.
-- Solo admin y encargado lo pueden leer.

create table if not exists precios_historial (
  id bigint generated always as identity primary key,
  producto_id bigint not null references productos(id) on delete cascade,
  precio_anterior numeric(12,2) not null,
  precio_nuevo numeric(12,2) not null,
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id)
);

create index if not exists precios_historial_fecha_idx on precios_historial (created_at desc);
create index if not exists precios_historial_producto_idx on precios_historial (producto_id, created_at);

alter table precios_historial enable row level security;
drop policy if exists "precios_historial_select_staff" on precios_historial;
create policy "precios_historial_select_staff" on precios_historial for select using (es_staff());

revoke all on precios_historial from anon, authenticated;
grant select on precios_historial to authenticated;

create or replace function _registrar_cambio_de_precio() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into precios_historial (producto_id, precio_anterior, precio_nuevo)
  values (new.id, coalesce(old.precio_venta, 0), coalesce(new.precio_venta, 0));
  return new;
end;
$$;

drop trigger if exists productos_historial_de_precios on productos;
create trigger productos_historial_de_precios
  after update of precio_venta on productos
  for each row when (old.precio_venta is distinct from new.precio_venta)
  execute function _registrar_cambio_de_precio();

-- Los cambios de la actualización de lista del 20/10/2026 ya estaban hechos: se reconstruyen comparando
-- con el resguardo que se guardó justo antes (esquema respaldo_20261020). Los de más atrás no se conservaron.
do $$
begin
  if to_regclass('respaldo_20261020.productos') is not null
     and not exists (select 1 from precios_historial) then
    insert into precios_historial (producto_id, precio_anterior, precio_nuevo, created_at)
    select r.id, r.precio_venta, p.precio_venta, timestamptz '2026-10-20 12:00:00-03'
    from respaldo_20261020.productos r
    join productos p on p.id = r.id
    where r.precio_venta is distinct from p.precio_venta;
  end if;
end $$;
