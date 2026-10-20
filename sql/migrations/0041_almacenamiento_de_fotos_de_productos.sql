-- 0041 — Lugar donde se guardan las fotos de productos que se pegan desde el panel (Ctrl+V).
--
-- Antes la foto de un producto era solo una dirección web (URL) escrita a mano. Ahora, desde Inventario se puede pegar
-- una imagen copiada de cualquier página: el panel la achica, la sube a este bucket y guarda su dirección en el producto
-- (productos.imagen_url), igual que antes. La tienda sigue leyendo imagen_url sin cambios.
--
--  · El bucket es público para LEER (la tienda tiene que mostrar las fotos) pero no se puede listar su contenido.
--  · Solo admin y encargado pueden subir, reemplazar o borrar fotos (vendedores y público, no).
--  · Tope de 2 MB por foto, solo JPG / PNG / WEBP.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('productos', 'productos', true, 2097152, array['image/jpeg', 'image/png', 'image/webp'])
on conflict (id) do update set
  public = true,
  file_size_limit = 2097152,
  allowed_mime_types = array['image/jpeg', 'image/png', 'image/webp'];

drop policy if exists "productos_fotos_subir_staff" on storage.objects;
create policy "productos_fotos_subir_staff" on storage.objects for insert to authenticated
  with check (bucket_id = 'productos' and public.es_staff());

drop policy if exists "productos_fotos_cambiar_staff" on storage.objects;
create policy "productos_fotos_cambiar_staff" on storage.objects for update to authenticated
  using (bucket_id = 'productos' and public.es_staff())
  with check (bucket_id = 'productos' and public.es_staff());

drop policy if exists "productos_fotos_borrar_staff" on storage.objects;
create policy "productos_fotos_borrar_staff" on storage.objects for delete to authenticated
  using (bucket_id = 'productos' and public.es_staff());
