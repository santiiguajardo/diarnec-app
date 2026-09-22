// Edge Function: administra los accesos (usuario + contraseña, sin email real) del panel.
// Corre server-side porque manejar usuarios de Supabase Auth requiere la service_role key, que
// nunca debe llegar al navegador. SOLO puede usarla un admin (se verifica en staff_usuarios).
//
// Acciones (campo "accion" del body; por defecto "crear"):
//   crear            { username, password, rol, vendedor_id? }   vendedor_id es obligatorio si rol = vendedor
//   cambiar_password { auth_user_id, password }
//   eliminar         { auth_user_id }
//
// Si el alta en Auth sale bien pero falla anotarlo en staff_usuarios, el usuario de Auth se borra
// para no dejar "huérfanos" (así quedaron santiago y emiliano antes de este arreglo).

import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const USERNAME_EMAIL_DOMAIN = "@diarnec.local";
const ROLES = ["admin", "encargado", "vendedor"];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const callerClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user: caller }, error: authError } = await callerClient.auth.getUser();
    if (authError || !caller) return json({ error: "No autorizado" }, 401);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);

    // Solo un administrador puede gestionar usuarios
    const { data: perfil, error: perfilError } = await admin
      .from("staff_usuarios").select("rol").eq("auth_user_id", caller.id).maybeSingle();
    if (perfilError) return json({ error: "No se pudo verificar tu rol: " + perfilError.message }, 500);
    if (!perfil || perfil.rol !== "admin") return json({ error: "Solo un administrador puede gestionar usuarios." }, 403);

    const body = await req.json();
    const accion = body.accion || "crear";

    // ---------- crear ----------
    if (accion === "crear") {
      const username = String(body.username || "").trim().toLowerCase();
      const password = String(body.password || "");
      const rol = String(body.rol || "vendedor");
      const vendedorId = body.vendedor_id ? Number(body.vendedor_id) : null;

      if (!/^[a-z0-9_.]{3,32}$/.test(username)) {
        return json({ error: "Usuario inválido: solo letras, números, punto y guión bajo (3-32 caracteres)." }, 400);
      }
      if (password.length < 6) return json({ error: "La contraseña debe tener al menos 6 caracteres." }, 400);
      if (!ROLES.includes(rol)) return json({ error: "Rol inválido." }, 400);

      if (rol === "vendedor") {
        if (!vendedorId) return json({ error: "Elegí a qué vendedor corresponde este usuario." }, 400);
        const { data: vend } = await admin.from("vendedores")
          .select("id, nombre, activo, es_canal_online").eq("id", vendedorId).maybeSingle();
        if (!vend || vend.es_canal_online) return json({ error: "El vendedor elegido no existe." }, 400);
        const { data: yaVinculado } = await admin.from("staff_usuarios")
          .select("username").eq("vendedor_id", vendedorId).maybeSingle();
        if (yaVinculado) return json({ error: vend.nombre + " ya tiene un usuario (" + yaVinculado.username + ")." }, 400);
      }

      const { data: existente } = await admin.from("staff_usuarios").select("username").eq("username", username).maybeSingle();
      if (existente) return json({ error: "Ese usuario ya existe." }, 400);

      const email = username + USERNAME_EMAIL_DOMAIN;
      let userId: string | null = null;
      let creadoAhora = true;

      const { data: created, error: createError } = await admin.auth.admin.createUser({
        email, password, email_confirm: true,
      });
      if (createError) {
        // Un acceso que quedó en Auth sin registrarse acá (intento anterior fallido): se reutiliza
        // con la contraseña nueva en vez de bloquear el nombre para siempre.
        if (!/already|registered|exists/i.test(createError.message)) return json({ error: createError.message }, 400);
        const { data: lista } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
        const previo = lista?.users?.find((u) => u.email === email);
        if (!previo) return json({ error: "Ese usuario ya existe." }, 400);
        const { error: updError } = await admin.auth.admin.updateUserById(previo.id, { password, email_confirm: true });
        if (updError) return json({ error: updError.message }, 400);
        userId = previo.id;
        creadoAhora = false;
      } else {
        userId = created.user.id;
      }

      const { error: insertError } = await admin.from("staff_usuarios").insert({
        auth_user_id: userId, username, rol, vendedor_id: rol === "vendedor" ? vendedorId : null, created_by: caller.id,
      });
      if (insertError) {
        if (creadoAhora) await admin.auth.admin.deleteUser(userId!);
        return json({ error: "No se pudo registrar el usuario: " + insertError.message }, 400);
      }
      return json({ ok: true, username, rol });
    }

    // ---------- cambiar contraseña / eliminar ----------
    const targetId = String(body.auth_user_id || "");
    if (!targetId) return json({ error: "Falta el usuario." }, 400);
    const { data: objetivo } = await admin.from("staff_usuarios").select("username, rol").eq("auth_user_id", targetId).maybeSingle();
    if (!objetivo) return json({ error: "El usuario no existe." }, 404);

    if (accion === "cambiar_password") {
      const password = String(body.password || "");
      if (password.length < 6) return json({ error: "La contraseña debe tener al menos 6 caracteres." }, 400);
      const { error } = await admin.auth.admin.updateUserById(targetId, { password });
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, username: objetivo.username });
    }

    if (accion === "eliminar") {
      if (targetId === caller.id) return json({ error: "No podés eliminar tu propio usuario." }, 400);
      if (objetivo.rol === "admin") {
        const { count } = await admin.from("staff_usuarios").select("auth_user_id", { count: "exact", head: true }).eq("rol", "admin");
        if ((count ?? 0) <= 1) return json({ error: "No se puede eliminar al único administrador." }, 400);
      }
      const { error } = await admin.auth.admin.deleteUser(targetId); // staff_usuarios se borra en cascada
      if (error) return json({ error: error.message }, 400);
      return json({ ok: true, username: objetivo.username });
    }

    return json({ error: "Acción desconocida." }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
