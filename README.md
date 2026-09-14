# DIARNEC — App de pedidos online

App de pedidos para DIARNEC (distribuidora de alimentos): catálogo, carrito y
checkout por WhatsApp, con un panel de gestión básico para productos y pedidos.

- `index.html` — la aplicación (catálogo + carrito + checkout + panel de gestión).
- `brand-board.html` — brand board / guía de marca.

## Estado actual

Hecha en HTML/JS puro, sin backend. Los productos están hardcodeados en el
código y los pedidos del panel de gestión viven solo en memoria del navegador:
se pierden al recargar la página y no se comparten entre dispositivos. Es
funcional para mostrar el catálogo y generar pedidos por WhatsApp, pero el
panel de gestión no persiste datos todavía (ver plan de migración más abajo).

## Desarrollo local

Es un archivo estático, no requiere build. Alcanza con abrirlo en el navegador
o servirlo con cualquier servidor estático:

```bash
npx serve .
```

## Deploy (GitHub Pages)

Publicado automáticamente desde la rama `main` vía GitHub Pages
(Settings → Pages → Source: `main` / `/ (root)`).

## Próximos pasos

Migrar a un backend con base de datos real (productos y pedidos persistentes,
multiusuario) — candidatos: Supabase, Firebase o un backend propio (Node +
Postgres) con hosting en Vercel/Render.
