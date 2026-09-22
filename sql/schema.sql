-- DIARNEC — esquema unificado (tienda online + gestión)
-- Ejecutar en Supabase: SQL Editor → New query → Run (en este orden: schema.sql, functions.sql, policies.sql, seed_products.sql)

-- ===== Referencia =====

create table proveedores (
  id bigint generated always as identity primary key,
  nombre text not null,
  contacto text default '',
  telefono text default '',
  email text default '',
  notas text default '',
  activo boolean not null default true,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

create table marcas (
  id bigint generated always as identity primary key,
  nombre text not null unique,
  proveedor_id bigint references proveedores(id),
  created_at timestamptz default now()
);

-- El color es un atributo visual de la categoría (así estaba en el catálogo real:
-- todas las categorías tienen un color propio usado como fondo del thumbnail cuando
-- el producto no tiene imagen), no de la marca.
create table categorias (
  id bigint generated always as identity primary key,
  nombre text not null unique,
  color text not null default '#2BB673',
  created_at timestamptz default now()
);

-- ===== Catálogo y stock =====

create table productos (
  id bigint generated always as identity primary key,
  marca_id bigint references marcas(id),
  categoria_id bigint references categorias(id),
  nombre text not null,
  unidad text default '',
  sku text,
  precio_compra numeric(12,2) not null default 0,
  precio_venta numeric(12,2) not null,
  stock_actual numeric(12,3) not null default 0,
  stock_minimo numeric(12,3) not null default 0,
  imagen_url text default '',
  activo boolean not null default true,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create index productos_marca_idx on productos (marca_id);
create index productos_categoria_idx on productos (categoria_id);

-- ===== Vendedores =====

create table vendedores (
  id bigint generated always as identity primary key,
  nombre text not null,
  telefono text default '',
  email text default '',
  comision_pct numeric(5,2) not null default 0,
  es_canal_online boolean not null default false,
  auth_user_id uuid unique references auth.users(id),
  activo boolean not null default true,
  created_at timestamptz default now()
);
create unique index vendedores_un_canal_online on vendedores (es_canal_online) where es_canal_online;

create table comisiones_vendedor_marca (
  id bigint generated always as identity primary key,
  vendedor_id bigint not null references vendedores(id) on delete cascade,
  marca_id bigint not null references marcas(id) on delete cascade,
  comision_pct numeric(5,2) not null default 0,
  unique (vendedor_id, marca_id)
);

-- ===== Ventas =====

create table ventas (
  id bigint generated always as identity primary key,
  vendedor_id bigint not null references vendedores(id),
  canal text not null default 'manual' check (canal in ('manual','online')),
  cliente_nombre text default '',
  cliente_localidad text default '',
  total_bruto numeric(12,2) not null,
  total_descuento_comision numeric(12,2) not null default 0,
  total_neto numeric(12,2) not null,
  estado text not null default 'confirmada' check (estado in ('confirmada','anulada')),
  fecha date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);
create index ventas_vendedor_idx on ventas (vendedor_id);
create index ventas_fecha_idx on ventas (fecha desc);

create table ventas_items (
  id bigint generated always as identity primary key,
  venta_id bigint not null references ventas(id) on delete cascade,
  producto_id bigint not null references productos(id),
  cantidad numeric(12,3) not null,
  precio_unitario numeric(12,2) not null,
  comision_pct numeric(5,2) not null default 0,
  subtotal numeric(12,2) not null
);
create index ventas_items_venta_idx on ventas_items (venta_id);

-- ===== Devoluciones =====

create table devoluciones_cab (
  id bigint generated always as identity primary key,
  venta_id bigint references ventas(id),
  vendedor_id bigint not null references vendedores(id),
  motivo text default '',
  total numeric(12,2) not null,
  fecha date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

create table devoluciones_items (
  id bigint generated always as identity primary key,
  devolucion_id bigint not null references devoluciones_cab(id) on delete cascade,
  producto_id bigint not null references productos(id),
  cantidad numeric(12,3) not null,
  precio_unitario numeric(12,2) not null,
  comision_pct numeric(5,2) not null default 0,
  subtotal numeric(12,2) not null
);
create index devoluciones_items_dev_idx on devoluciones_items (devolucion_id);

-- ===== Lotes de stock (fuente de verdad FEFO) y movimientos (historial) =====

create table stock_lotes (
  id bigint generated always as identity primary key,
  producto_id bigint not null references productos(id),
  lote text default '',
  fecha_vencimiento date,
  cantidad_inicial numeric(12,3) not null,
  cantidad_restante numeric(12,3) not null check (cantidad_restante >= 0),
  costo_unitario numeric(12,2) default 0,
  proveedor_id bigint references proveedores(id),
  fecha_ingreso date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);
create index stock_lotes_fefo_idx on stock_lotes (producto_id, fecha_vencimiento nulls last, id);

create table movimientos_stock (
  id bigint generated always as identity primary key,
  producto_id bigint not null references productos(id),
  lote_id bigint references stock_lotes(id),
  tipo text not null check (tipo in ('entrada','venta','devolucion','ajuste','merma','anulacion')),
  cantidad numeric(12,3) not null,
  venta_id bigint references ventas(id),
  devolucion_id bigint references devoluciones_cab(id),
  motivo text default '',
  fecha date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);
create index movimientos_producto_idx on movimientos_stock (producto_id, fecha desc, id desc);
create index movimientos_tipo_idx on movimientos_stock (tipo, fecha desc);

-- ===== Dinero: gastos y pagos =====

create table gastos (
  id bigint generated always as identity primary key,
  descripcion text not null,
  monto numeric(12,2) not null,
  fecha date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

create table pagos_proveedores (
  id bigint generated always as identity primary key,
  proveedor_id bigint not null references proveedores(id),
  medio_pago text not null check (medio_pago in ('efectivo','transferencia','cheque')),
  monto_bruto numeric(12,2) not null,
  comision_pct numeric(5,2) not null default 0,
  monto_neto numeric(12,2) generated always as
    (monto_bruto - monto_bruto * comision_pct / 100) stored,
  descripcion text default '',
  fecha date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

create table pagos_vendedores (
  id bigint generated always as identity primary key,
  vendedor_id bigint not null references vendedores(id),
  medio_pago text not null check (medio_pago in ('efectivo','transferencia')),
  monto numeric(12,2) not null,
  descripcion text default '',
  fecha date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

create table bonificaciones (
  id bigint generated always as identity primary key,
  vendedor_id bigint not null references vendedores(id),
  monto numeric(12,2) not null,
  descripcion text default '',
  fecha date not null default current_date,
  created_at timestamptz default now(),
  created_by uuid references auth.users(id)
);

-- ===== Vista de saldo por vendedor =====

create or replace view vendedores_saldo as
select
  v.id as vendedor_id,
  v.nombre,
  coalesce((select sum(total_neto) from ventas where vendedor_id = v.id and estado = 'confirmada'), 0) as retirado,
  coalesce((select sum(total) from devoluciones_cab where vendedor_id = v.id), 0) as devuelto,
  coalesce((select sum(monto) from pagos_vendedores where vendedor_id = v.id), 0) as pagado,
  coalesce((select sum(monto) from bonificaciones where vendedor_id = v.id), 0) as bonificado
from vendedores v;
