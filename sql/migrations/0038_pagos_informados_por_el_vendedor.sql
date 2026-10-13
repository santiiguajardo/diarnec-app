-- 0038 — El vendedor informa un pago desde su panel; admin/encargado lo verifican y recién ahí entra a la cuenta corriente.
--
-- Hasta ahora los pagos solo los cargaba el admin/encargado a mano (Movimientos > Registrar pago).
-- Ahora el vendedor puede avisar "te transferí $X" o "te entregué $X en efectivo" desde su panel:
--   · informar_pago()              el vendedor lo informa. Queda PENDIENTE: no toca ninguna cuenta ni la Caja.
--   · mis_pagos_informados()       el vendedor ve cómo van sus avisos (pendiente / confirmado / rechazado).
--   · cancelar_pago_informado()    el vendedor retira un aviso que cargó mal (solo si sigue pendiente).
--   · resolver_pago_informado()    admin/encargado: confirma (crea el pago real en pagos_vendedores, con lo que pasa
--                                  a la cuenta corriente, Caja y Dashboard igual que uno cargado a mano) o rechaza.
--
-- La tabla solo la leen admin/encargado; todo lo que escribe el vendedor pasa por estas funciones.

create table if not exists pagos_informados (
  id bigint generated always as identity primary key,
  vendedor_id bigint not null references vendedores(id),
  monto numeric(12,2) not null check (monto > 0),
  medio_pago text not null check (medio_pago in ('efectivo', 'transferencia')),
  nota text not null default '',
  estado text not null default 'pendiente' check (estado in ('pendiente', 'confirmado', 'rechazado', 'cancelado')),
  motivo_rechazo text not null default '',
  pago_id bigint references pagos_vendedores(id),
  created_at timestamptz not null default now(),
  created_by uuid default auth.uid() references auth.users(id),
  resuelto_at timestamptz,
  resuelto_por uuid references auth.users(id)
);

create index if not exists pagos_informados_estado_idx on pagos_informados (estado, created_at);
create index if not exists pagos_informados_vendedor_idx on pagos_informados (vendedor_id, created_at desc);

alter table pagos_informados enable row level security;
drop policy if exists "pagos_informados_select_staff" on pagos_informados;
create policy "pagos_informados_select_staff" on pagos_informados for select using (es_staff());

revoke all on pagos_informados from anon, authenticated;
grant select on pagos_informados to authenticated;

-- ===== Vendedor =====

create or replace function informar_pago(p_monto numeric, p_medio text, p_nota text default '')
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  v_monto numeric(12,2) := round(coalesce(p_monto, 0), 2);
  v_nota text := left(trim(coalesce(p_nota, '')), 200);
  v_nuevo bigint;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  if v_monto <= 0 then
    raise exception 'Ingresá el monto que pagaste.';
  end if;
  if v_monto > 100000000 then
    raise exception 'Ese monto es demasiado alto. Revisalo.';
  end if;
  if p_medio is null or p_medio not in ('efectivo', 'transferencia') then
    raise exception 'Elegí cómo pagaste: efectivo o transferencia.';
  end if;
  if (select count(*) from pagos_informados where vendedor_id = v_id and estado = 'pendiente') >= 10 then
    raise exception 'Ya tenés 10 pagos esperando verificación. Esperá a que los confirmen.';
  end if;
  if exists (select 1 from pagos_informados where vendedor_id = v_id and estado = 'pendiente'
             and monto = v_monto and medio_pago = p_medio and created_at > now() - interval '2 minutes') then
    raise exception 'Ya informaste ese mismo pago hace un momento.';
  end if;

  insert into pagos_informados (vendedor_id, monto, medio_pago, nota, created_by)
  values (v_id, v_monto, p_medio, v_nota, auth.uid())
  returning id into v_nuevo;
  return v_nuevo;
end;
$$;

create or replace function mis_pagos_informados() returns jsonb
language plpgsql stable security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  return coalesce((
    select jsonb_agg(to_jsonb(t) order by t.created_at desc) from (
      select id, monto, medio_pago, nota, estado, motivo_rechazo, created_at, resuelto_at
      from pagos_informados where vendedor_id = v_id
      order by created_at desc limit 30
    ) t
  ), '[]'::jsonb);
end;
$$;

create or replace function cancelar_pago_informado(p_id bigint) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint := mi_vendedor_id();
  v_pago pagos_informados%rowtype;
begin
  if v_id is null then
    raise exception 'No autorizado';
  end if;
  select * into v_pago from pagos_informados where id = p_id and vendedor_id = v_id for update;
  if not found then
    raise exception 'No se encontró ese pago.';
  end if;
  if v_pago.estado <> 'pendiente' then
    raise exception 'Ese pago ya fue %, no se puede retirar.', v_pago.estado;
  end if;
  update pagos_informados set estado = 'cancelado', resuelto_at = now(), resuelto_por = auth.uid() where id = p_id;
end;
$$;

-- ===== Admin / encargado =====

-- Devuelve el id del pago real creado (o null si se rechazó).
create or replace function resolver_pago_informado(p_id bigint, p_confirmar boolean, p_motivo text default '')
returns bigint language plpgsql security definer set search_path = public as $$
declare
  v_pago pagos_informados%rowtype;
  v_pago_id bigint;
begin
  if not es_staff() then
    raise exception 'No autorizado';
  end if;

  select * into v_pago from pagos_informados where id = p_id for update;
  if not found then
    raise exception 'No se encontró ese pago.';
  end if;
  if v_pago.estado <> 'pendiente' then
    raise exception 'Ese pago ya fue resuelto (%).', v_pago.estado;
  end if;

  if p_confirmar then
    insert into pagos_vendedores (vendedor_id, medio_pago, monto, descripcion)
    values (v_pago.vendedor_id, v_pago.medio_pago, v_pago.monto,
            'Informado por el vendedor' || case when v_pago.nota <> '' then ': ' || v_pago.nota else '' end)
    returning id into v_pago_id;
    update pagos_informados set estado = 'confirmado', pago_id = v_pago_id, resuelto_at = now(), resuelto_por = auth.uid()
    where id = p_id;
    return v_pago_id;
  end if;

  update pagos_informados set estado = 'rechazado', motivo_rechazo = left(trim(coalesce(p_motivo, '')), 200),
    resuelto_at = now(), resuelto_por = auth.uid()
  where id = p_id;
  return null;
end;
$$;

revoke all on function informar_pago(numeric, text, text), mis_pagos_informados(), cancelar_pago_informado(bigint),
  resolver_pago_informado(bigint, boolean, text) from public, anon;
grant execute on function informar_pago(numeric, text, text), mis_pagos_informados(), cancelar_pago_informado(bigint),
  resolver_pago_informado(bigint, boolean, text) to authenticated;
