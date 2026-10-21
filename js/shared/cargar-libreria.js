// Carga de librerías pesadas solo cuando se usan.
// El generador de PDF (jsPDF + autotable) y la librería de Excel (xlsx, ~900 KB) se bajaban SIEMPRE, en cada pantalla,
// aunque solo se usan al tocar "Descargar PDF" / "Descargar copia en Excel". Ahora se piden recién en ese momento
// (una sola vez: después quedan en memoria) y con la misma verificación de integridad (SRI) que tenían antes.

const LIBRERIAS = {
  pdf: [
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/4.2.1/jspdf.umd.min.js', sri: 'sha384-qovJwSBbRDPP5cEjCp8S0UP66wrvnjaa60XMOGzTNanrThcrGfXfnZkvgY8N1KT3', listo: () => !!window.jspdf },
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf-autotable/5.0.8/jspdf.plugin.autotable.min.js', sri: 'sha384-5jk55M0XWoAw7LyhlXJe19ErOr3doBAPzxw9vahPFbvolqWa2yDk4fhHa2zuYeOa', listo: () => !!(window.jspdf && window.jspdf.jsPDF && window.jspdf.jsPDF.API && window.jspdf.jsPDF.API.autoTable) }
  ],
  xlsx: [
    { url: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js', sri: 'sha384-vtjasyidUo0kW94K5MXDXntzOJpQgBKXmE7e2Ga4LG0skTTLeBi97eFAXsqewJjw', listo: () => !!window.XLSX }
  ]
};
const NOMBRES = { pdf: 'el generador de PDF', xlsx: 'la librería de Excel' };

const pendientes = {}; // nombre -> promesa (para no bajarla dos veces si se toca el botón rápido)

function cargarScript({ url, sri, listo }){
  if(listo()) return Promise.resolve();
  return new Promise((resolver, rechazar) => {
    const s = document.createElement('script');
    s.src = url;
    s.integrity = sri;
    s.crossOrigin = 'anonymous';
    s.onload = () => listo() ? resolver() : rechazar(new Error('cargó mal'));
    s.onerror = () => { s.remove(); rechazar(new Error('sin conexión')); };
    document.head.appendChild(s);
  });
}

// Devuelve una promesa que se resuelve cuando la librería ya está lista; si falla, tira un error con un mensaje claro
// (y la próxima vez se vuelve a intentar).
export function cargarLibreria(nombre){
  const partes = LIBRERIAS[nombre];
  if(!partes) return Promise.reject(new Error(`Librería desconocida: ${nombre}`));
  if(!pendientes[nombre]){
    pendientes[nombre] = partes.reduce((p, parte) => p.then(() => cargarScript(parte)), Promise.resolve())
      .catch(() => {
        delete pendientes[nombre];
        throw new Error(`No se pudo cargar ${NOMBRES[nombre]}. Revisá tu conexión e intentá de nuevo.`);
      });
  }
  return pendientes[nombre];
}

// Baja la librería "de fondo" cuando el navegador está tranquilo, para que el primer PDF salga al toque
// (sin frenar la carga de la pantalla). Si falla, no pasa nada: se reintenta al usarla.
export function precargarLibreria(nombre){
  const ir = () => { cargarLibreria(nombre).catch(() => {}); };
  if('requestIdleCallback' in window) requestIdleCallback(ir, { timeout: 8000 });
  else setTimeout(ir, 4000);
}
