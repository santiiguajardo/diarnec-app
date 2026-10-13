// Edge Function: responde con un mensaje directo (DM) a quien comenta una palabra clave en un
// reel/publicación de Instagram ("comentá QUIERO y te lo mando por privado").
//
// Flujo: Meta avisa por webhook cada comentario nuevo -> se busca una regla activa en ig_reglas
// cuyas palabras estén en el comentario -> se envía el DM como "private reply" al comentario
// (permitido una sola vez por comentario y dentro de los 7 días) -> opcionalmente se responde
// en público. Cada comentario se anota en ig_envios para no contestarlo dos veces.
//
// Secrets (Supabase -> Edge Functions -> Secrets), los carga el dueño de la cuenta:
//   IG_APP_SECRET    clave secreta de la app de Meta (valida la firma del webhook)
//   IG_VERIFY_TOKEN  texto cualquiera; el mismo se pone al registrar el webhook en Meta
//   IG_ACCESS_TOKEN  token de la cuenta de Instagram (permisos: manage_messages y manage_comments)
//
// IMPORTANTE: esta función la llama Meta, no un usuario logueado, así que hay que desactivar
// "Verify JWT" en su configuración. La seguridad la da la firma X-Hub-Signature-256.
// Mantener el TS sin comillas invertidas ni signo pesos + llave (se pega en el editor del dashboard).

import { createClient } from "npm:@supabase/supabase-js@2.116.0";

const GRAPH = "https://graph.instagram.com/v21.0";

const normalizar = (s: string) =>
  s.toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim();

const escapar = (s: string) => s.replace(/[.*+?^$()|[\]\\{}]/g, "\\$&");

function contienePalabra(texto: string, palabra: string): boolean {
  const p = normalizar(palabra);
  if (!p) return false;
  return new RegExp("(^|[^a-z0-9])" + escapar(p) + "($|[^a-z0-9])").test(texto);
}

async function firmaValida(raw: string, header: string | null): Promise<boolean> {
  const secret = Deno.env.get("IG_APP_SECRET");
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw)));
  const esperada = Array.from(sig).map((b) => b.toString(16).padStart(2, "0")).join("");
  const recibida = header.slice(7);
  if (esperada.length !== recibida.length) return false;
  let diff = 0;
  for (let i = 0; i < esperada.length; i++) diff |= esperada.charCodeAt(i) ^ recibida.charCodeAt(i);
  return diff === 0;
}

async function graph(path: string, body: unknown): Promise<{ ok: boolean; texto: string }> {
  const r = await fetch(GRAPH + path, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + Deno.env.get("IG_ACCESS_TOKEN"),
    },
    body: JSON.stringify(body),
  });
  return { ok: r.ok, texto: (await r.text()).slice(0, 500) };
}

Deno.serve(async (req) => {
  const url = new URL(req.url);

  // Verificación inicial del webhook (Meta hace un GET con un desafío)
  if (req.method === "GET") {
    const ok = url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === Deno.env.get("IG_VERIFY_TOKEN");
    return ok
      ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
      : new Response("Forbidden", { status: 403 });
  }
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const raw = await req.text();
  if (!(await firmaValida(raw, req.headers.get("x-hub-signature-256")))) {
    return new Response("Firma inválida", { status: 401 });
  }

  let payload: any;
  try { payload = JSON.parse(raw); } catch { return new Response("JSON inválido", { status: 400 }); }

  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const { data: reglas } = await admin.from("ig_reglas").select("*").eq("activa", true);

  for (const entry of payload.entry ?? []) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "comments") continue;
      const c = change.value ?? {};
      if (!c.id || !c.text) continue;
      // Ignorar respuestas (hilos) y comentarios de la propia cuenta: evita bucles
      if (c.parent_id || (c.from && c.from.id === entry.id)) continue;

      const texto = normalizar(String(c.text));
      const regla = (reglas ?? []).find((r: any) =>
        (!r.media_id || r.media_id === c.media?.id) &&
        (r.palabras as string[]).some((p) => contienePalabra(texto, p))
      );
      if (!regla) continue;

      // Reservar el comentario; si ya existe, otro intento ya lo atendió
      const { error: dup } = await admin.from("ig_envios").insert({
        comment_id: c.id, regla_id: regla.id, media_id: c.media?.id ?? null, usuario_ig: c.from?.username ?? null,
        comentario: String(c.text).slice(0, 500),
      });
      if (dup) continue;

      const usuario = c.from?.username ?? "";
      const mensaje = String(regla.mensaje_dm).replace(/\{usuario\}/g, usuario);
      const dm = await graph("/me/messages", { recipient: { comment_id: c.id }, message: { text: mensaje } });

      let detalle = dm.ok ? "DM ok" : "DM falló: " + dm.texto;
      if (dm.ok && regla.respuesta_publica) {
        const pub = await graph("/" + c.id + "/replies", { message: regla.respuesta_publica });
        if (!pub.ok) detalle += " | respuesta pública falló: " + pub.texto;
      }
      await admin.from("ig_envios").update({ estado: dm.ok ? "enviado" : "error", detalle }).eq("comment_id", c.id);
    }
  }

  // Meta reintenta si no recibe 200: siempre confirmamos lo recibido
  return new Response("ok", { status: 200 });
});
