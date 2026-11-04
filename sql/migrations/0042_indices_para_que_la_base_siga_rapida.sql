-- 0042 — Índices en las columnas por las que se busca seguido.
--
-- Detectado con una revisión de la base: varias claves foráneas no tenían índice. Hoy hay pocas filas y no se nota,
-- pero a medida que crece el historial, cosas como "cuenta corriente de un vendedor", "pagos de un cliente" o "stock
-- movido por una venta" tendrían que leer la tabla entera cada vez. Los índices compuestos (entidad + fecha) cubren
-- además los filtros por período del Dashboard y del panel del vendedor.
-- Es solo aditivo: no cambia ningún dato ni ningún permiso (create index if not exists, se puede correr más de una vez).

create index if not exists pagos_vendedores_vendedor_fecha_idx on pagos_vendedores (vendedor_id, created_at);
create index if not exists pagos_clientes_cliente_fecha_idx on pagos_clientes (cliente_id, created_at);
create index if not exists pagos_proveedores_proveedor_fecha_idx on pagos_proveedores (proveedor_id, created_at);
create index if not exists devoluciones_cab_vendedor_fecha_idx on devoluciones_cab (vendedor_id, created_at);
create index if not exists devoluciones_cab_venta_idx on devoluciones_cab (venta_id);
create index if not exists bonificaciones_vendedor_fecha_idx on bonificaciones (vendedor_id, created_at);
create index if not exists clientes_vendedor_idx on clientes (vendedor_id);
create index if not exists ventas_items_producto_idx on ventas_items (producto_id);
create index if not exists devoluciones_items_producto_idx on devoluciones_items (producto_id);
create index if not exists bonificaciones_items_producto_idx on bonificaciones_items (producto_id);
create index if not exists movimientos_stock_venta_idx on movimientos_stock (venta_id);
create index if not exists movimientos_stock_devolucion_idx on movimientos_stock (devolucion_id);
create index if not exists movimientos_stock_lote_idx on movimientos_stock (lote_id);
