-- 0034 — Seguimiento de pedidos de la tienda online + cuenta corriente de la Tienda online.
--
--  1) ventas.entregado_at: un pedido online que ya es venta ("Pasar a venta") se puede marcar "Entregado".
--     Si el pedido deja de ser venta (vuelve a Pendiente o se cancela) se limpia solo.
--     Los estados que ve el panel: Pendiente · Pasar a venta · Entregado · Cancelado.
--  2) marcar_pedido_entregado(): lo puede usar el personal (admin y encargado).
--  3) La cuenta corriente de la Tienda online es la del vendedor fijo "Tienda Online" (vendedores_saldo ya la calcula).
--     Se le puede ingresar dinero (pagos), cargar devoluciones y bonificaciones. La única diferencia con un
--     vendedor: NO tiene "devolución de stock" (lo que vuelve de la tienda online no se repone al stock).
--     Esto se hace cumplir acá, en la base, no solo en la pantalla.

-- ===== 1) Entregado =====

alter table ventas add column if not exists entregado_at timestamptz;

create or replace function _entregado_solo_si_venta() returns trigger language plpgsql as $$
begin
  if new.estado is distinct from 'confirmada' then
    new.entregado_at := null;
  end if;
  return new;
end;
$$;

drop trigger if exists ventas_entregado_coherente on ventas;
create trigger ventas_entregado_coherente before insert or update on ventas
  for each row execute function _entregado_solo_si_venta();

-- ===== 2) Marcar / desmarcar entregado =====

create or replace function marcar_pedido_entregado(p_venta_id bigint, p_entregado boolean default true) returns void
language plpgsql security definer set search_path = public as $$
declare
  v_estado text;
begin
  if not es_staff() then
    raise exception 'No autorizado';
  end if;
  select estado into v_estado from ventas where id = p_venta_id and canal = 'online' for update;
  if v_estado is null then
    raise exception 'El pedido % no existe', p_venta_id;
  end if;
  if v_estado <> 'confirmada' then
    raise exception 'Primero pasá el pedido a venta';
  end if;
  update ventas set entregado_at = case when p_entregado then now() else null end where id = p_venta_id;
end;
$$;
revoke all on function marcar_pedido_entregado(bigint, boolean) from public, anon;
grant execute on function marcar_pedido_entregado(bigint, boolean) to authenticated;

-- ===== 3) La Tienda online no devuelve stock =====

create or replace function _online_sin_devolucion_de_stock() returns trigger language plpgsql as $$
begin
  if new.con_stock and exists (select 1 from vendedores where id = new.vendedor_id and es_canal_online) then
    raise exception 'La Tienda online no devuelve stock: cargá la devolución común (sin stock)';
  end if;
  return new;
end;
$$;

drop trigger if exists devoluciones_online_sin_stock on devoluciones_cab;
create trigger devoluciones_online_sin_stock before insert or update on devoluciones_cab
  for each row execute function _online_sin_devolucion_de_stock();
