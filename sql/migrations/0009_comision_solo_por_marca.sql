-- DIARNEC — no existe la "comisión base" del vendedor: la comisión se define únicamente
-- por vendedor + marca (tabla comisiones_vendedor_marca). Sin fila = 0%.
-- (La columna vendedores.comision_pct queda en la tabla pero ya no se usa.)

create or replace function resolver_comision(p_vendedor_id bigint, p_producto_id bigint)
returns numeric language plpgsql stable as $$
declare
  v_marca_id bigint;
  v_pct numeric;
begin
  select marca_id into v_marca_id from productos where id = p_producto_id;

  select comision_pct into v_pct from comisiones_vendedor_marca
  where vendedor_id = p_vendedor_id and marca_id = v_marca_id;

  return coalesce(v_pct, 0);
end;
$$;
