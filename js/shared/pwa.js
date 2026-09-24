// Deja el panel listo para instalarse como app en el celular (ícono en la pantalla de inicio, pantalla completa).
// Si el navegador no lo soporta, o falla, el panel funciona igual que siempre.
if('serviceWorker' in navigator){
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(e => console.warn('No se pudo activar la app instalable:', e));
  });
}
