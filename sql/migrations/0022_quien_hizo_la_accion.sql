-- 0022 — Historial: que se vea quién hizo cada movimiento
--
-- created_by ya existía en casi todas las tablas, pero sin valor por defecto: las funciones RPC lo
-- cargaban a mano (algunas), pero las inserciones directas desde el cliente (gastos, pagos, clientes,
-- proveedores...) lo dejaban en null siempre. Con `default auth.uid()` se completa solo, venga de
-- donde venga la inserción — auth.uid() lee el JWT de quien hace el pedido, así que funciona igual
-- adentro de una función security definer que en un insert directo.
--
-- Esto no toca los movimientos ya cargados (van a seguir sin usuario, quedan como "—" en el Historial).

alter table proveedores       alter column created_by set default auth.uid();
alter table ventas            alter column created_by set default auth.uid();
alter table devoluciones_cab  alter column created_by set default auth.uid();
alter table stock_lotes       alter column created_by set default auth.uid();
alter table movimientos_stock alter column created_by set default auth.uid();
alter table gastos            alter column created_by set default auth.uid();
alter table pagos_proveedores alter column created_by set default auth.uid();
alter table pagos_vendedores  alter column created_by set default auth.uid();
alter table bonificaciones    alter column created_by set default auth.uid();
alter table clientes          alter column created_by set default auth.uid();
alter table pagos_clientes    alter column created_by set default auth.uid();
