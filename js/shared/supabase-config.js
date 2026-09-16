// Conexión a Supabase (Settings → API en supabase.com). Mismo proyecto que usa index.html.
export const SUPABASE_URL = "https://pncrxtfxgomnxoveknys.supabase.co";
export const SUPABASE_ANON_KEY = "sb_publishable_JTfYvnzLzcRo2_f1EcG4og_dRjffR2K";

// Supabase Auth funciona con email+contraseña. Como el login del panel pide "usuario"
// (no email), cada usuario se crea en Supabase con un email falso "<usuario>@diarnec.local"
// — nunca se envía correo ahí, es solo un identificador interno.
export const USERNAME_EMAIL_DOMAIN = "@diarnec.local";
