-- Mensajes automáticos de Instagram: reglas (palabra clave -> DM) y registro de envíos.
-- La Edge Function `instagram-dm` las usa con la service_role key. El panel (pantalla Instagram)
-- las lee y edita solo si es_admin(): las reglas deciden qué se le manda a la gente.

create table if not exists public.ig_reglas (
  id                 bigserial primary key,
  nombre             text        not null,
  media_id           text,                         -- null = vale para cualquier publicación
  palabras           text[]      not null,         -- palabras clave (sin tildes ni mayúsculas)
  mensaje_dm         text        not null,         -- admite {usuario}
  respuesta_publica  text,                         -- opcional: respuesta visible bajo el comentario
  activa             boolean     not null default true,
  creada             timestamptz not null default now()
);

create table if not exists public.ig_envios (
  comment_id   text primary key,                   -- evita responder dos veces al mismo comentario
  regla_id     bigint references public.ig_reglas(id) on delete set null,
  media_id     text,                   -- publicación donde comentó (para limitar una regla a un reel)
  usuario_ig   text,
  comentario   text,
  estado       text        not null default 'procesando',  -- procesando | enviado | error
  detalle      text,
  creado       timestamptz not null default now()
);

alter table public.ig_reglas enable row level security;
alter table public.ig_envios enable row level security;
revoke all on public.ig_reglas from anon, authenticated;
revoke all on public.ig_envios from anon, authenticated;

grant select, insert, update, delete on public.ig_reglas to authenticated;
grant usage, select on sequence public.ig_reglas_id_seq to authenticated;
grant select on public.ig_envios to authenticated;

create policy ig_reglas_admin on public.ig_reglas
  for all to authenticated using (es_admin()) with check (es_admin());
create policy ig_envios_admin_lee on public.ig_envios
  for select to authenticated using (es_admin());
