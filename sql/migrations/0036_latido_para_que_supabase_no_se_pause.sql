-- 0036 — "Latido": actividad semanal automática para que Supabase (plan gratis) no pause el proyecto por inactividad.
--
-- Una tarea programada de GitHub (.github/workflows/mantener-activo.yml) llama a registrar_latido() dos veces por semana.
-- Anota la fecha en una tabla de una sola fila. No toca ventas, pagos, stock, caja ni el historial: no ensucia nada.
--   · La tabla no se puede leer ni escribir desde afuera (RLS activada, sin permisos): solo la función.
--   · La función no recibe datos ni devuelve nada sensible, así que se puede llamar con la clave pública.
--   · Si alguien la llamara en exceso, no pasa nada: se actualiza como máximo una vez por minuto.

create table if not exists latido (
  id boolean primary key default true check (id),  -- una sola fila siempre
  ultimo timestamptz not null default now(),
  veces bigint not null default 0
);
insert into latido (id) values (true) on conflict (id) do nothing;

alter table latido enable row level security;
revoke all on latido from public, anon, authenticated;

create or replace function registrar_latido() returns timestamptz
language plpgsql security definer set search_path = public as $$
begin
  update latido set ultimo = now(), veces = veces + 1
  where id and ultimo < now() - interval '1 minute';
  return now();
end;
$$;

revoke all on function registrar_latido() from public;
grant execute on function registrar_latido() to anon, authenticated;
