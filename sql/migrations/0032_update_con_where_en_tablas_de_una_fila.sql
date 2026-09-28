-- 0032 — Arregla dos funciones que fallaban al usarse desde el panel.
--
-- Supabase carga la protección "safeupdate" en las conexiones de la API (session_preload_libraries del rol
-- authenticator): un UPDATE sin WHERE se rechaza con "UPDATE requires a WHERE clause". En el editor SQL esa
-- protección no está, por eso al probar las funciones ahí andaban, pero desde el panel daban error.
--
-- Afectadas (las dos actualizan una tabla de una sola fila sin condición):
--   · guardar_config_tienda      → cambiar el % de recargo / mínimo de los particulares (Tienda online)
--   · limpiar_cuentas_corrientes → botón "Limpiar cuentas" (Ventas)
-- Solución: se agrega "where id" (la fila única tiene id = true). No cambia nada más.

create or replace function guardar_config_tienda(p_recargo numeric, p_minimo numeric) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not es_admin() then
    raise exception 'Solo el administrador puede cambiar esto';
  end if;
  if p_recargo is null or p_recargo < 0 or p_recargo > 500 then
    raise exception 'El recargo tiene que ser un porcentaje entre 0 y 500';
  end if;
  if p_minimo is null or p_minimo < 0 then
    raise exception 'El mínimo de compra no puede ser negativo';
  end if;
  update tienda_config set recargo_particular_pct = p_recargo, minimo_particular = p_minimo,
    updated_at = now(), updated_by = auth.uid()
  where id;
end;
$$;

create or replace function limpiar_cuentas_corrientes() returns timestamptz
language plpgsql security definer set search_path = public as $$
declare
  v_ahora timestamptz := now();
begin
  if not es_staff() then
    raise exception 'No autorizado';
  end if;
  update cuentas_checkpoint set desde = v_ahora, updated_by = auth.uid(), updated_at = v_ahora
  where id;
  return v_ahora;
end;
$$;

-- (los permisos de ejecución no cambian: create or replace los conserva)
