-- 0031 — Logo de cada marca (URL de la imagen) para la franja "Marcas con las que trabajamos" de la tienda online.
-- Una marca aparece en la franja solo si tiene logo cargado. Se carga desde el panel: Tienda online → Logos de las marcas.

alter table marcas add column if not exists logo_url text;

-- Solo direcciones web (http/https) y de largo razonable
alter table marcas drop constraint if exists marcas_logo_url_valida;
alter table marcas add constraint marcas_logo_url_valida
  check (logo_url is null or (logo_url ~* '^https?://' and char_length(logo_url) <= 500));

-- Se limpian los espacios y un texto vacío queda como "sin logo"
create or replace function _limpiar_logo_marca() returns trigger language plpgsql as $$
begin
  new.logo_url := nullif(btrim(new.logo_url), '');
  return new;
end;
$$;
drop trigger if exists marcas_limpiar_logo on marcas;
create trigger marcas_limpiar_logo before insert or update on marcas
  for each row execute function _limpiar_logo_marca();

-- Escritura de marcas: hasta ahora la permitía cualquier usuario logueado (incluidos vendedores).
-- Como ahora lo que se guarda acá se ve en la tienda pública, se limita al personal (admin y encargado).
drop policy if exists "marcas_write_staff" on marcas;
create policy "marcas_write_staff" on marcas for all
  using (es_staff()) with check (es_staff());
