-- 0038 — Conteo de inventario: ajusta el stock de varios productos a lo que se contó, todo junto o nada.
--
-- p_items: [{ "producto_id": 12, "contado": 30 }, ...]   (solo los productos que se contaron)
-- Para cada uno se compara lo contado contra el stock que tiene el sistema EN ESE MOMENTO (no contra lo que se veía
-- al empezar a contar: si mientras tanto hubo ventas, el ajuste ya las considera) y la diferencia se registra con
-- registrar_ajuste_stock: si faltan unidades se descuentan de los lotes que vencen primero (movimiento "merma"),
-- si sobran se suma un lote de ajuste. Queda en el Historial con el motivo "Conteo de inventario".
-- Si algún producto falla (cantidad inválida, producto inexistente...) no se ajusta ninguno.
-- Solo el personal (admin y encargado). Devuelve el detalle: antes, contado y diferencia de cada producto.

create or replace function aplicar_conteo_inventario(p_items jsonb, p_nota text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  it jsonb;
  v_prod productos%rowtype;
  v_cont numeric;
  v_delta numeric;
  v_motivo text;
  v_res jsonb := '[]'::jsonb;
  v_vistos bigint[] := '{}';
begin
  if not es_staff() then
    raise exception 'No autorizado';
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'No hay productos contados';
  end if;
  if jsonb_array_length(p_items) > 500 then
    raise exception 'Demasiados productos juntos (máximo 500 por vez)';
  end if;

  v_motivo := 'Conteo de inventario' || coalesce(': ' || left(nullif(btrim(p_nota), ''), 120), '');

  for it in select * from jsonb_array_elements(p_items) loop
    select * into v_prod from productos where id = (it->>'producto_id')::bigint for update;
    if not found then
      raise exception 'Producto inexistente (id %)', it->>'producto_id';
    end if;
    if v_prod.id = any(v_vistos) then
      raise exception '"%" figura dos veces en el conteo', v_prod.nombre;
    end if;
    v_vistos := v_vistos || v_prod.id;

    v_cont := (it->>'contado')::numeric;
    if v_cont is null or v_cont < 0 then
      raise exception 'La cantidad contada de "%" no es válida', v_prod.nombre;
    end if;

    v_delta := v_cont - v_prod.stock_actual;
    if v_delta <> 0 then
      perform registrar_ajuste_stock(v_prod.id, v_delta, v_motivo);
    end if;

    v_res := v_res || jsonb_build_object('producto_id', v_prod.id, 'nombre', v_prod.nombre,
      'antes', v_prod.stock_actual, 'contado', v_cont, 'diferencia', v_delta);
  end loop;

  return v_res;
end;
$$;

revoke all on function aplicar_conteo_inventario(jsonb, text) from public, anon;
grant execute on function aplicar_conteo_inventario(jsonb, text) to authenticated;
