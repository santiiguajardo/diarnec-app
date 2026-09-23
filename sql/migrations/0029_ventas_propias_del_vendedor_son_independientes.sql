-- 0029 — Lo que un vendedor carga en su panel (ventas a SUS clientes, canal='vendedor') es independiente de la empresa.
--
-- Sirve para que el vendedor lleve la cuenta de sus propios clientes (cartera, remitos, historial de cada cliente).
-- No es plata ni mercadería de la distribuidora: lo que el vendedor le debe a la empresa sale solo de lo que RETIRA
-- (más devoluciones, bonificaciones y pagos), y el stock ya se descontó cuando lo retiró.
--
-- Hasta ahora esas ventas: (1) descontaban stock de nuevo, (2) sumaban a "retirado" en las cuentas corrientes,
-- (3) entraban en el Dashboard, y (4) sumaban a la cuenta y la ganancia del propio vendedor. Se corrige todo.
--
-- Se modifican las funciones existentes con pg_get_functiondef + replace (y se verifica que cada cambio se haya
-- aplicado), en vez de reescribirlas enteras.

-- ===== 1) _crear_venta: el canal 'vendedor' no toca el stock =====
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('_crear_venta(bigint, text, text, text, jsonb, boolean, bigint)'::regprocedure);
  n := replace(d, 'if v_estado = ''confirmada'' then', 'if v_estado = ''confirmada'' and p_canal <> ''vendedor'' then');
  if n = d then raise exception 'No se encontró el descuento de stock en _crear_venta'; end if;
  execute n;
end $$;

-- ===== 2) Cuenta corriente de los vendedores (vista): retirado sin las ventas propias =====
create or replace view vendedores_saldo as
select
  v.id as vendedor_id,
  v.nombre,
  coalesce((select sum(total_neto) from ventas
    where vendedor_id = v.id and estado = 'confirmada' and canal <> 'vendedor'
      and created_at >= (select desde from cuentas_checkpoint)), 0) as retirado,
  coalesce((select sum(total) from devoluciones_cab
    where vendedor_id = v.id and not anulado and created_at >= (select desde from cuentas_checkpoint)), 0) as devuelto,
  coalesce((select sum(monto) from pagos_vendedores
    where vendedor_id = v.id and not anulado and created_at >= (select desde from cuentas_checkpoint)), 0) as pagado,
  coalesce((select sum(monto) from bonificaciones
    where vendedor_id = v.id and not anulado and created_at >= (select desde from cuentas_checkpoint)), 0) as bonificado,
  coalesce((select sum(total) from devoluciones_cab
    where vendedor_id = v.id and not anulado and con_stock and created_at >= (select desde from cuentas_checkpoint)), 0) as devuelto_stock
from vendedores v;
alter view vendedores_saldo set (security_invoker = true);

-- ===== 3) Dashboard: solo ventas de la empresa =====
do $$
declare d text; n text; f regprocedure;
begin
  foreach f in array array['dash_periodo(date, date)'::regprocedure, 'dash_tendencia(integer)'::regprocedure] loop
    d := pg_get_functiondef(f);
    n := replace(d, 'from ventas where estado = ''confirmada''', 'from ventas where estado = ''confirmada'' and canal <> ''vendedor''');
    n := replace(n, 'where v.estado = ''confirmada''', 'where v.estado = ''confirmada'' and v.canal <> ''vendedor''');
    if n = d then raise exception 'No se encontró la lectura de ventas en %', f; end if;
    execute n;
  end loop;
end $$;

-- ===== 4) Panel del vendedor: su cuenta con la empresa sale solo de lo que retira =====
do $$
declare d text; n text;
begin
  d := pg_get_functiondef('mi_semanas(integer)'::regprocedure);
  n := replace(d, 'from ventas v where v.vendedor_id = v_id and v.estado = ''confirmada''',
                  'from ventas v where v.vendedor_id = v_id and v.estado = ''confirmada'' and v.canal <> ''vendedor''');
  if n = d then raise exception 'No se encontró la lectura de ventas en mi_semanas'; end if;
  execute n;

  d := pg_get_functiondef('mi_panel()'::regprocedure);
  n := replace(d, 'from ventas where vendedor_id = v_id and estado = ''confirmada''',
                  'from ventas where vendedor_id = v_id and estado = ''confirmada'' and canal <> ''vendedor''');
  if n = d then raise exception 'No se encontró la lectura de ventas en mi_panel'; end if;
  execute n;

  -- Sus ventas propias siguen apareciendo en su lista de movimientos, marcadas como "propia"
  -- (el panel las muestra aparte y no las suma a su cuenta).
  d := pg_get_functiondef('mis_movimientos(date, date)'::regprocedure);
  n := replace(d, '''tipo'', ''venta'', ''id'', v.id,', '''tipo'', ''venta'', ''propia'', v.canal = ''vendedor'', ''id'', v.id,');
  if n = d then raise exception 'No se encontró el armado de la venta en mis_movimientos'; end if;
  execute n;
end $$;

-- ===== 5) Corrección de lo ya cargado: se devuelve al stock lo que esas ventas propias habían descontado =====
do $$
declare v record; i record;
begin
  for v in select id from ventas where canal = 'vendedor' and estado = 'confirmada' loop
    if exists (select 1 from movimientos_stock where venta_id = v.id and tipo = 'venta')
       and not exists (select 1 from movimientos_stock where venta_id = v.id and tipo = 'anulacion') then
      for i in select producto_id, sum(cantidad) as cantidad from ventas_items where venta_id = v.id group by producto_id loop
        perform _ajustar_stock_edicion(i.producto_id, i.cantidad, 'anulacion', 'venta', 'CORRECCION-VENTA-PROPIA-' || v.id, v.id, null,
          'Corrección: las ventas propias de un vendedor no descuentan stock');
      end loop;
    end if;
  end loop;
end $$;
