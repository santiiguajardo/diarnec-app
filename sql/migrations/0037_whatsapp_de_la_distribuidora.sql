-- 0037 — Número de WhatsApp de la distribuidora, configurable desde el panel (Tienda online → Configuración).
--
-- Es el número al que la tienda manda los pedidos cuando el cliente NO elige vendedor (o el vendedor elegido no tiene
-- WhatsApp cargado). Se guarda en el formato que pide wa.me: código de país + área + número, solo dígitos
-- (Argentina celular: 549 + área sin 0 + número sin 15). Ej: 5492262357262.
--   · La tienda lo lee con tienda_config_publica() (clave pública), igual que el recargo y el mínimo.
--   · Solo el administrador puede cambiarlo (es lo que usan los clientes para escribirte: no puede tocarlo cualquiera).
--   · Se valida en la base: solo dígitos, entre 11 y 15.

alter table tienda_config add column if not exists whatsapp text;

alter table tienda_config drop constraint if exists tienda_config_whatsapp_valido;
alter table tienda_config add constraint tienda_config_whatsapp_valido
  check (whatsapp is null or whatsapp ~ '^[0-9]{11,15}$');

-- El número que ya estaba escrito en la tienda pasa a ser el valor inicial (nada cambia para los clientes)
update tienda_config set whatsapp = '5492262357262' where id and whatsapp is null;

create or replace function tienda_config_publica() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object('recargo_particular_pct', recargo_particular_pct, 'minimo_particular', minimo_particular,
                            'whatsapp', whatsapp)
  from tienda_config;
$$;
grant execute on function tienda_config_publica() to anon, authenticated;

create or replace function guardar_whatsapp_tienda(p_numero text) returns void
language plpgsql security definer set search_path = public as $$
declare
  v text := regexp_replace(coalesce(p_numero, ''), '\D', '', 'g');
begin
  if not es_admin() then
    raise exception 'Solo el administrador puede cambiar esto';
  end if;
  if v !~ '^[0-9]{11,15}$' then
    raise exception 'El número tiene que tener entre 11 y 15 dígitos, con código de país y de área (ej: 5492262357262)';
  end if;
  update tienda_config set whatsapp = v, updated_at = now(), updated_by = auth.uid() where id;
end;
$$;

revoke all on function guardar_whatsapp_tienda(text) from public, anon;
grant execute on function guardar_whatsapp_tienda(text) to authenticated;
