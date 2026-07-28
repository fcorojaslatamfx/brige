/**
 * Asigna el rol de un usuario existente del dashboard, saltándose la UI.
 * Red de seguridad para el caso "me quedé sin super_admin" (p. ej. si el único
 * super_admin se auto-degrada invitándose a sí mismo como admin): sin ningún
 * super_admin vivo, /status/users devuelve 403 y no hay forma de arreglarlo
 * desde el panel.
 *
 * Uso:
 *   npx tsx scripts/set-user-role.ts correo@ejemplo.com super_admin
 */
import { config } from "dotenv";

config({ path: ".env.local" });

const ROLES = ["super_admin", "admin"] as const;
type Role = (typeof ROLES)[number];

async function main() {
  const [email, role] = process.argv.slice(2);

  if (!email || !ROLES.includes(role as Role)) {
    console.error("Uso: npx tsx scripts/set-user-role.ts <correo> <super_admin|admin>");
    process.exit(1);
  }

  // Import dinámico: lib/supabase.ts lee las env vars al cargarse, y debe
  // hacerlo DESPUÉS de que dotenv las inyecte arriba.
  const { supabase } = await import("../lib/supabase");
  const { findAuthUserByEmail } = await import("../lib/users");

  const user = await findAuthUserByEmail(email);
  if (!user) {
    console.error(`No existe una cuenta de Supabase Auth con el correo ${email}.`);
    process.exit(1);
  }

  const { data: before } = await supabase.from("user_roles").select("role").eq("user_id", user.id).maybeSingle();
  if (!before) {
    console.error(`${email} no tiene fila en user_roles (acceso revocado). Invítalo desde el panel primero.`);
    process.exit(1);
  }

  const { error } = await supabase.from("user_roles").update({ role }).eq("user_id", user.id);
  if (error) {
    console.error("No se pudo actualizar el rol:", error.message);
    process.exit(1);
  }

  await supabase.from("audit").insert({
    signal_id: null,
    event_type: "user_role_changed",
    detail: { user_id: user.id, old_role: before.role, new_role: role, changed_by: "scripts/set-user-role.ts" },
  });

  console.log(`${email}: ${before.role} → ${role}`);
}

main();
