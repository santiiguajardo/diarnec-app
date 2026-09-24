// Service worker mínimo: hace que el panel se pueda instalar como app en el celular.
// A propósito NO guarda nada en caché ni toca ninguna conexión: todo va siempre directo a internet, así la app
// instalada nunca queda con una versión vieja ni con datos viejos (las cuentas y el stock tienen que ser los de ahora).
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', () => { /* sin caché: el navegador resuelve todo normalmente */ });
