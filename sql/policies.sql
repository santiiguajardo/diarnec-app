-- DIARNEC — Row Level Security (ejecutar después de schema.sql y functions.sql)
-- Regla general: el público (anon) solo puede leer el catálogo activo. Todo lo demás
-- requiere estar autenticado. Las tablas transaccionales (ventas*, devoluciones*,
-- stock_lotes, movimientos_stock) son de solo lectura incluso para staff — se escriben
-- únicamente a través de las funciones de functions.sql, nunca por INSERT/UPDATE directo.

-- GRANTs explícitos a nivel de tabla: RLS filtra FILAS, pero sin un GRANT de Postgres
-- el rol ni siquiera puede intentar la operación. Esto no depende de la casilla
-- "Automatically expose new tables" que Supabase pregunta al crear el proyecto —
-- funciona esté tildada o no.
grant usage on schema public to anon, authenticated;

grant select on productos, marcas, categorias to anon;

grant select, insert, update, delete on
  productos, marcas, categorias, proveedores, vendedores, comisiones_vendedor_marca,
  gastos, pagos_proveedores, pagos_vendedores, bonificaciones
to authenticated;

grant select on
  ventas, ventas_items, devoluciones_cab, devoluciones_items, stock_lotes, movimientos_stock
to authenticated;

-- ===== Catálogo: lectura pública, escritura solo staff =====

alter table marcas enable row level security;
create policy "marcas_select_public" on marcas for select using (true);
create policy "marcas_write_staff" on marcas for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table categorias enable row level security;
create policy "categorias_select_public" on categorias for select using (true);
create policy "categorias_write_staff" on categorias for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table productos enable row level security;
create policy "productos_select_public" on productos for select using (activo = true);
create policy "productos_select_staff" on productos for select using (auth.role() = 'authenticated');
create policy "productos_write_staff" on productos for insert with check (auth.role() = 'authenticated');
create policy "productos_update_staff" on productos for update using (auth.role() = 'authenticated');
create policy "productos_delete_staff" on productos for delete using (auth.role() = 'authenticated');

-- ===== Referencia interna: solo staff =====

alter table proveedores enable row level security;
create policy "proveedores_staff" on proveedores for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table vendedores enable row level security;
create policy "vendedores_staff" on vendedores for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table comisiones_vendedor_marca enable row level security;
create policy "comisiones_vendedor_marca_staff" on comisiones_vendedor_marca for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- ===== Transaccionales: solo lectura para staff, escritura solo vía funciones =====

alter table ventas enable row level security;
create policy "ventas_select_staff" on ventas for select using (auth.role() = 'authenticated');

alter table ventas_items enable row level security;
create policy "ventas_items_select_staff" on ventas_items for select using (auth.role() = 'authenticated');

alter table devoluciones_cab enable row level security;
create policy "devoluciones_cab_select_staff" on devoluciones_cab for select using (auth.role() = 'authenticated');

alter table devoluciones_items enable row level security;
create policy "devoluciones_items_select_staff" on devoluciones_items for select using (auth.role() = 'authenticated');

alter table stock_lotes enable row level security;
create policy "stock_lotes_select_staff" on stock_lotes for select using (auth.role() = 'authenticated');

alter table movimientos_stock enable row level security;
create policy "movimientos_stock_select_staff" on movimientos_stock for select using (auth.role() = 'authenticated');

-- ===== Dinero: CRUD directo, solo staff =====

alter table gastos enable row level security;
create policy "gastos_staff" on gastos for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table pagos_proveedores enable row level security;
create policy "pagos_proveedores_staff" on pagos_proveedores for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table pagos_vendedores enable row level security;
create policy "pagos_vendedores_staff" on pagos_vendedores for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

alter table bonificaciones enable row level security;
create policy "bonificaciones_staff" on bonificaciones for all
  using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');
