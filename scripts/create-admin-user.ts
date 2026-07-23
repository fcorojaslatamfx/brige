/**
 * Crea el usuario admin único del dashboard (correo + contraseña vía
 * Supabase Auth). Sin flujo de signup público — se corre una sola vez.
 *
 * Uso:
 *   ADMIN_EMAIL=correo@ejemplo.com ADMIN_INITIAL_PASSWORD=xxxx npx tsx scripts/create-admin-user.ts
 */
import { config } from "dotenv";

config({ path: ".env.local" });

async function main() {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_INITIAL_PASSWORD;

  if (!email || !password) {
    console.error("Faltan ADMIN_EMAIL y/o ADMIN_INITIAL_PASSWORD en el entorno.");
    process.exit(1);
  }

  // Import dinámico: lib/supabase.ts lee las env vars al cargarse, y debe
  // hacerlo DESPUÉS de que dotenv las inyecte arriba.
  const { supabase } = await import("../lib/supabase");

  const { data, error } = await supabase.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });

  if (error) {
    console.error("No se pudo crear el usuario:", error.message);
    process.exit(1);
  }

  console.log(`Usuario admin creado: ${data.user?.email} (id ${data.user?.id})`);
}

main();
