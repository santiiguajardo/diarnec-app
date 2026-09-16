export const money = n =>
  new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n || 0);

export const dateTime = iso =>
  new Date(iso).toLocaleString('es-AR');

export const dateOnly = iso =>
  new Date(iso).toLocaleDateString('es-AR');
