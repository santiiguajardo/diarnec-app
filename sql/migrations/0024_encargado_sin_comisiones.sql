-- 0024 — El encargado no puede gestionar comisiones.
--
-- comisiones_vendedor_marca tenía una sola política "for all" con es_staff() (admin + encargado),
-- por eso el encargado podía cargar/cambiar comisiones desde "Administrar comisiones" en Ventas.
-- Se separa en dos: lectura para todo el staff (la necesitan para calcular el neto de cada venta,
-- devolución, bonificación y devolución de stock) y escritura solo para admin.

drop policy "comisiones_vendedor_marca_staff" on comisiones_vendedor_marca;

create policy "comisiones_vendedor_marca_select_staff" on comisiones_vendedor_marca for select
  using (es_staff());
create policy "comisiones_vendedor_marca_write_admin" on comisiones_vendedor_marca for insert
  with check (es_admin());
create policy "comisiones_vendedor_marca_update_admin" on comisiones_vendedor_marca for update
  using (es_admin()) with check (es_admin());
create policy "comisiones_vendedor_marca_delete_admin" on comisiones_vendedor_marca for delete
  using (es_admin());
