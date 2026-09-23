-- 0027 — Las vistas de saldo dejaban leer TODO a cualquier usuario logueado.
--
-- Las vistas (vendedores_saldo, clientes_saldo) corren con los permisos de su dueño, así que se saltean
-- las reglas de acceso (RLS) de las tablas de abajo. Como tienen "grant select ... to authenticated",
-- cualquier logueado —un vendedor, o alguien que se registre mientras el alta de usuarios esté abierta—
-- veía el saldo de todos los vendedores (retirado, devuelto, pagado, bonificado).
--
-- Con security_invoker la vista corre con los permisos de quien la consulta: el staff (admin/encargado)
-- sigue viéndola completa, y el resto no ve nada. mi_panel() no cambia: es una función del sistema que
-- ya calcula solo el saldo del propio vendedor.
--
-- OJO al crear vistas nuevas: hay que dejarlas con security_invoker = true (este bloque las cubre a todas
-- las que existan hoy).

do $$
declare v record;
begin
  for v in select viewname from pg_views where schemaname = 'public' loop
    execute format('alter view public.%I set (security_invoker = true)', v.viewname);
  end loop;
end $$;
