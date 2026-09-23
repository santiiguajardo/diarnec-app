-- 0028 — Textos de clientes sin "<" ni ">".
--
-- El nombre/dirección de un pedido de la tienda online lo escribe cualquier persona, y el nombre/dirección de
-- un cliente de la cartera lo escribe un vendedor. Después esos textos se muestran dentro del panel del
-- administrador. Las pantallas ya los escapan al mostrarlos (arreglado en la misma tanda), y esto es una segunda
-- barrera en la base: se sacan los caracteres < y > de esos campos al guardarlos, por cualquier camino.
-- Limpia también lo que ya estuviera guardado.

create or replace function _sin_html() returns trigger language plpgsql as $$
begin
  if tg_table_name = 'ventas' then
    new.cliente_nombre := translate(new.cliente_nombre, '<>', '');
    new.cliente_localidad := translate(new.cliente_localidad, '<>', '');
    new.cliente_direccion := translate(new.cliente_direccion, '<>', '');
    new.cliente_cuit := translate(new.cliente_cuit, '<>', '');
  else
    new.nombre := translate(new.nombre, '<>', '');
    new.localidad := translate(new.localidad, '<>', '');
    new.contacto := translate(new.contacto, '<>', '');
    new.telefono := translate(new.telefono, '<>', '');
    new.direccion := translate(new.direccion, '<>', '');
    new.cuit := translate(new.cuit, '<>', '');
  end if;
  return new;
end;
$$;

create trigger ventas_sin_html before insert or update on ventas
  for each row execute function _sin_html();
create trigger clientes_sin_html before insert or update on clientes
  for each row execute function _sin_html();

update ventas set cliente_nombre = cliente_nombre
where cliente_nombre ~ '[<>]' or cliente_localidad ~ '[<>]' or cliente_direccion ~ '[<>]' or cliente_cuit ~ '[<>]';
update clientes set nombre = nombre
where nombre ~ '[<>]' or localidad ~ '[<>]' or contacto ~ '[<>]' or telefono ~ '[<>]' or direccion ~ '[<>]' or cuit ~ '[<>]';
