-- 0026 — Cartera de clientes del vendedor: campo "Dirección".
-- mi_cartera devuelve la dirección y mi_cliente_guardar la recibe (parámetro nuevo al final, opcional).
-- La versión vieja de 5 parámetros se borra para no dejar dos funciones con el mismo nombre.

drop function if exists mi_cliente_guardar(bigint, text, text, text, text);

create or replace function mi_cartera(p_desde date default null) returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  r jsonb;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.nombre), '[]'::jsonb) into r from (
    select c.id, c.nombre, c.localidad, c.direccion, c.contacto, c.telefono,
      coalesce(sum(v.total_bruto) filter (where v.estado = 'confirmada' and (p_desde is null or _fecha_ar(v.created_at) >= p_desde)), 0) as comprado,
      count(v.id) filter (where v.estado = 'confirmada' and (p_desde is null or _fecha_ar(v.created_at) >= p_desde)) as compras,
      coalesce(sum(v.total_bruto) filter (where v.estado = 'confirmada'), 0) as comprado_total,
      max(v.created_at) filter (where v.estado = 'confirmada') as ultima_compra
    from clientes c
    left join ventas v on v.cliente_id = c.id and v.vendedor_id = v_id
    where c.activo and (c.vendedor_id = v_id or exists (select 1 from ventas x where x.cliente_id = c.id and x.vendedor_id = v_id))
    group by c.id
  ) x;
  return r;
end;
$$;

create or replace function mi_cliente_guardar(p_id bigint, p_nombre text, p_localidad text, p_contacto text, p_telefono text, p_direccion text default null)
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  v_nombre text := trim(coalesce(p_nombre, ''));
  v_cli clientes%rowtype;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  if v_nombre = '' then
    raise exception 'Ingresá el nombre del cliente.';
  end if;
  if exists (select 1 from clientes where vendedor_id = v_id and activo and lower(nombre) = lower(v_nombre) and (p_id is null or id <> p_id)) then
    raise exception 'Ya tenés un cliente llamado "%".', v_nombre;
  end if;

  if p_id is null then
    insert into clientes (nombre, localidad, direccion, contacto, telefono, vendedor_id, created_by)
    values (v_nombre, trim(coalesce(p_localidad, '')), trim(coalesce(p_direccion, '')), trim(coalesce(p_contacto, '')), trim(coalesce(p_telefono, '')), v_id, auth.uid())
    returning id into p_id;
    return p_id;
  end if;

  select * into v_cli from clientes where id = p_id for update;
  if not found or not (v_cli.vendedor_id = v_id
      or (v_cli.vendedor_id is null and exists (select 1 from ventas where cliente_id = p_id and vendedor_id = v_id))) then
    raise exception 'Ese cliente no es parte de tu cartera.';
  end if;
  update clientes set nombre = v_nombre, localidad = trim(coalesce(p_localidad, '')), direccion = trim(coalesce(p_direccion, '')),
    contacto = trim(coalesce(p_contacto, '')), telefono = trim(coalesce(p_telefono, '')), vendedor_id = v_id
  where id = p_id;
  return p_id;
end;
$$;

revoke all on function mi_cliente_guardar(bigint, text, text, text, text, text) from public, anon;
grant execute on function mi_cliente_guardar(bigint, text, text, text, text, text) to authenticated;
