// Cliente único de Supabase. Requiere que la página haya cargado el script UMD de
// @supabase/supabase-js (window.supabase) ANTES de este módulo.
import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

export const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
