-- DIARNEC — color por marca (igual que la app de escritorio anterior), usado para
-- resaltar filas en Inventario y en la lista de precios en PDF.

alter table marcas add column if not exists color text not null default '#ebebeb';

update marcas set color = '#93c9ff' where nombre = 'Don yeyo';
update marcas set color = '#ffb08a' where nombre = 'DeViano';
update marcas set color = '#ffff80' where nombre = 'Tremblay';
update marcas set color = '#fc7493' where nombre = 'Emezeta';
update marcas set color = '#e1031e' where nombre = 'Flor de Linares';
update marcas set color = '#ebebeb' where nombre = 'Riquitos';
update marcas set color = '#ff80ff' where nombre = 'Cris Jor';
