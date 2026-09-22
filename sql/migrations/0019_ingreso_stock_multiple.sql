-- 0019 — Ingreso de mercadería de varios productos de una sola vez
--
-- Cuando llega el camión se cargan muchos productos juntos (a mano o leyendo un remito). Esta función
-- los ingresa TODOS o ninguno: si una línea falla no queda el stock a medias.
--
-- p_items: [{ "producto_id": 12, "cantidad": 24, "fecha_vencimiento": "2026-12-31" (opcional), "lote": "L123" (opcional) }, ...]
-- p_referencia: texto libre (ej. "Remito 0001-00012345"); se guarda como lote de las líneas que no traen uno.
-- El costo de cada lote es el precio de compra actual del producto.
--
-- Devuelve la cantidad de líneas ingresadas.

create or replace function registrar_ingreso_multiple(p_items jsonb, p_proveedor_id bigint default null, p_referencia text default null)
returns int language plpgsql security definer set search_path = public as $$
declare
  it jsonb;
  v_prod productos%rowtype;
  v_cant numeric;
  v_n int := 0;
begin
  if not es_staff() then
    raise exception 'No autorizado';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay productos para ingresar';
  end if;

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from productos where id = (it->>'producto_id')::bigint;
    if not found then
      raise exception 'Producto inexistente (id %)', it->>'producto_id';
    end if;
    v_cant := (it->>'cantidad')::numeric;
    if v_cant is null or v_cant <= 0 then
      raise exception 'La cantidad de "%" debe ser mayor a 0', v_prod.nombre;
    end if;

    perform registrar_ingreso_stock(
      v_prod.id,
      coalesce(nullif(it->>'lote', ''), nullif(p_referencia, '')),
      nullif(it->>'fecha_vencimiento', '')::date,
      v_cant,
      v_prod.precio_compra,
      p_proveedor_id
    );
    v_n := v_n + 1;
  end loop;

  return v_n;
end;
$$;

revoke all on function registrar_ingreso_multiple(jsonb, bigint, text) from public, anon;
grant execute on function registrar_ingreso_multiple(jsonb, bigint, text) to authenticated;
