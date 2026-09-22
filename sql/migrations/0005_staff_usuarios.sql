-- DIARNEC — registro de usuarios de staff creados por el admin.
-- La creación real del login (Supabase Auth) la hace la Edge Function "crear-usuario"
-- con la service_role key (nunca expuesta acá). Esta tabla es solo para poder listarlos
-- en el panel sin necesitar la Admin API en cada carga de página.

create table staff_usuarios (
  auth_user_id uuid primary key references auth.users(id) on delete cascade,
  username text not null unique,
  rol text not null default 'vendedor' check (rol in ('admin','encargado','vendedor')),
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

grant select on staff_usuarios to authenticated;

alter table staff_usuarios enable row level security;
create policy "staff_usuarios_select_staff" on staff_usuarios for select using (auth.role() = 'authenticated');
-- Sin policy de insert/update/delete para authenticated: esas filas las escribe únicamente
-- la Edge Function con la service_role key, que ignora RLS.
