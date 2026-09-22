-- DIARNEC — catálogo inicial (40 productos), normalizado en marcas/categorías
-- Ejecutar después de schema.sql + functions.sql + policies.sql
-- Stock inicial: 50 unidades por producto en un lote "INICIAL" (sin vencimiento) para poder
-- probar ventas/checkout de entrada. Ajustar/corregir desde el panel una vez cargado.

insert into categorias (nombre, color) values
  ('Pastas y tapas', '#2BB673'),
  ('Panificados', '#122436'),
  ('Snacks y golosinas', '#FF8A3D'),
  ('Fiambres', '#6B7280'),
  ('Quesos', '#1B3A57')
on conflict (nombre) do nothing;

insert into marcas (nombre) values
  ('Don yeyo'),
  ('DeViano'),
  ('Riquitos'),
  ('Cris Jor'),
  ('Flor de Linares'),
  ('Emezeta'),
  ('Tremblay')
on conflict (nombre) do nothing;

insert into productos (marca_id, categoria_id, nombre, unidad, precio_venta, imagen_url) values
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Empanadas', '', 1538.16, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Pascualinas', '', 2327.64, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Rotiseras', '', 2098.14, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Sorrentinos', '', 4365.6, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Ravioles x kg', 'por kg', 5385.6, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Ravioles x 500g', '500g', 3175.26, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Ñoquis x 500g', '500g', 2570.4, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Fideos x500g', '500g', 2593.86, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Pastas y tapas'), 'Fusiles x500g', '500g', 2569.38, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Panificados'), 'Pan de hamburguesas', '', 1993.08, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Panificados'), 'Pan de panchos', '', 1993.08, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Panificados'), 'Pan de mesa x 570g', '570g', 3741.36, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Panificados'), 'Pan integral x570g', '570g', 3741.36, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Panificados'), 'Pan de mesa x350g', '350g', 2559.18, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Panificados'), 'Pan de salvado x350g', '350g', 2559.18, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Panificados'), 'Pan semillas x400g', '400g', 3342.54, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'Don yeyo'), (select id from categorias where nombre = 'Panificados'), 'Tortillas x180g', '180g', 3304.8, 'https://donyeyo.wordpress.com/wp-content/uploads/2017/03/logo-nuevo-25-ac3b1os.png'),
  ((select id from marcas where nombre = 'DeViano'), (select id from categorias where nombre = 'Pastas y tapas'), 'Ñoquis x 500g', '500g', 1925.76, ''),
  ((select id from marcas where nombre = 'DeViano'), (select id from categorias where nombre = 'Pastas y tapas'), 'Fideos x 500g', '500g', 2034.9, ''),
  ((select id from marcas where nombre = 'DeViano'), (select id from categorias where nombre = 'Pastas y tapas'), 'Ravioles x kg', 'por kg', 3874.98, ''),
  ((select id from marcas where nombre = 'Riquitos'), (select id from categorias where nombre = 'Snacks y golosinas'), 'Palitos x kg', 'por kg', 3636, 'https://distribuidora1310.com.ar/wp-content/uploads/2024/05/IMG_8056-600x596.png'),
  ((select id from marcas where nombre = 'Riquitos'), (select id from categorias where nombre = 'Snacks y golosinas'), 'Papas pay x kg', 'por kg', 9217, 'https://distribuidora1310.com.ar/wp-content/uploads/2024/06/IMG_8479-300x457.png'),
  ((select id from marcas where nombre = 'Riquitos'), (select id from categorias where nombre = 'Snacks y golosinas'), 'Papas fritas x kg', 'por kg', 5984, 'https://distribuidora1310.com.ar/wp-content/uploads/2024/06/IMG_8949-300x457.png'),
  ((select id from marcas where nombre = 'Riquitos'), (select id from categorias where nombre = 'Snacks y golosinas'), 'Alfajores triples', '', 7751, 'https://acdn-us.mitiendanube.com/stores/001/172/405/products/d_nq_np_982064-mla42011966192_052020-o1-7d9d896aa0b10fa48116152257293047-640-0.webp'),
  ((select id from marcas where nombre = 'Riquitos'), (select id from categorias where nombre = 'Snacks y golosinas'), 'Copitos', '', 12731, ''),
  ((select id from marcas where nombre = 'Riquitos'), (select id from categorias where nombre = 'Snacks y golosinas'), 'Galletitas', '', 1396, ''),
  ((select id from marcas where nombre = 'Cris Jor'), (select id from categorias where nombre = 'Snacks y golosinas'), 'Mani cervezero', '', 9726, 'https://casaomarynietos.com.ar/wp-content/uploads/2025/03/CRIS-JOR-JAMON.png'),
  ((select id from marcas where nombre = 'Flor de Linares'), (select id from categorias where nombre = 'Fiambres'), 'Salamin x kg', 'por kg', 14225, 'https://toledodigitalar.vtexassets.com/arquivos/ids/162224-800-auto?v=638796786252200000&width=800&height=auto&aspect=true'),
  ((select id from marcas where nombre = 'Emezeta'), (select id from categorias where nombre = 'Fiambres'), 'Salame milan x kg', 'por kg', 11685.45, 'https://www.emezetasa.com.ar/imagenes/media_68c4116e1ae25.png'),
  ((select id from marcas where nombre = 'Emezeta'), (select id from categorias where nombre = 'Fiambres'), 'Lomo de cerdo x kg', 'por kg', 14404.83, 'https://www.emezetasa.com.ar/imagenes/media_68c4116e1ae25.png'),
  ((select id from marcas where nombre = 'Emezeta'), (select id from categorias where nombre = 'Fiambres'), 'Paleta x kg', 'por kg', 7111.2, 'https://www.emezetasa.com.ar/imagenes/media_68c4116e1ae25.png'),
  ((select id from marcas where nombre = 'Emezeta'), (select id from categorias where nombre = 'Fiambres'), 'Panceta ahumada', '', 11000, 'https://www.emezetasa.com.ar/imagenes/media_68c4116e1ae25.png'),
  ((select id from marcas where nombre = 'Emezeta'), (select id from categorias where nombre = 'Fiambres'), 'Panceta tiernizada', '', 9540, 'https://www.emezetasa.com.ar/imagenes/media_68c4116e1ae25.png'),
  ((select id from marcas where nombre = 'Tremblay'), (select id from categorias where nombre = 'Quesos'), 'Cremoso x kg', 'por kg', 8026.2, 'https://www.tremblay.com.ar/images/productos/cremoso.png'),
  ((select id from marcas where nombre = 'Tremblay'), (select id from categorias where nombre = 'Quesos'), 'Barra x kg', 'por kg', 10150.35, 'https://www.tremblay.com.ar/images/productos/mozzarella_x4.png'),
  ((select id from marcas where nombre = 'Tremblay'), (select id from categorias where nombre = 'Quesos'), 'Pategrás', '', 14438, 'https://www.tremblay.com.ar/images/productos/pategras.png'),
  ((select id from marcas where nombre = 'Tremblay'), (select id from categorias where nombre = 'Quesos'), 'Sardo y Romano', '', 21500, 'https://www.tremblay.com.ar/images/productos/sardo.png'),
  ((select id from marcas where nombre = 'Tremblay'), (select id from categorias where nombre = 'Quesos'), 'Rallado x 40g', '40g', 24200, 'https://www.tremblay.com.ar/images/productos/rallado_x40.png'),
  ((select id from marcas where nombre = 'Tremblay'), (select id from categorias where nombre = 'Quesos'), 'Cuartirolo', '', 7318.5, 'https://www.tremblay.com.ar/images/productos/cuartirolo.png'),
  ((select id from marcas where nombre = 'Tremblay'), (select id from categorias where nombre = 'Quesos'), 'Cheddar x kg', 'por kg', 9397.5, 'https://www.tremblay.com.ar/images/productos/cheddar_barra.png');

-- Stock inicial: un lote por producto + su movimiento de entrada correspondiente
insert into stock_lotes (producto_id, lote, cantidad_inicial, cantidad_restante)
select id, 'INICIAL', 50, 50 from productos;

insert into movimientos_stock (producto_id, lote_id, tipo, cantidad)
select producto_id, id, 'entrada', 50 from stock_lotes where lote = 'INICIAL';

update productos set stock_actual = 50;

-- Vendedor especial: canal de la tienda online (checkout público se factura a este vendedor)
insert into vendedores (nombre, comision_pct, es_canal_online) values ('Tienda Online', 0, true)
on conflict do nothing;
