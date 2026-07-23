/**
 * Siembra la tabla `tokens` con los valores que hoy viven en env vars
 * (TV_WEBHOOK_TOKEN, EA_TOKEN, OPERATOR_TOKEN), para que TradingView y el
 * EA de MT4 sigan funcionando sin repegar nada. Idempotente: no
 * sobreescribe una fila que ya exista (p.ej. un token ya regenerado desde
 * el dashboard). Correr una sola vez antes de borrar esas env vars de
 * Vercel.
 *
 * Uso: npx tsx scripts/backfill-tokens.ts
 */
import { config } from "dotenv";

config({ path: ".env.local" });

const SEEDS: { kind: "tv_webhook" | "ea" | "operator"; envVar: string }[] = [
  { kind: "tv_webhook", envVar: "TV_WEBHOOK_TOKEN" },
  { kind: "ea", envVar: "EA_TOKEN" },
  { kind: "operator", envVar: "OPERATOR_TOKEN" },
];

async function main() {
  // Import dinámico: lib/supabase.ts lee las env vars al cargarse, y debe
  // hacerlo DESPUÉS de que dotenv las inyecte arriba (un `import` estático
  // se resuelve antes que el config() de dotenv).
  const { supabase } = await import("../lib/supabase");

  for (const { kind, envVar } of SEEDS) {
    const value = process.env[envVar];
    if (!value) {
      console.log(`[skip] ${envVar} no está en el entorno.`);
      continue;
    }

    const { data: existing } = await supabase.from("tokens").select("kind").eq("kind", kind).maybeSingle();
    if (existing) {
      console.log(`[skip] tokens.${kind} ya existe, no se sobreescribe.`);
      continue;
    }

    const { error } = await supabase.from("tokens").insert({ kind, value, updated_by: "backfill-script" });
    if (error) {
      console.error(`[error] tokens.${kind}:`, error.message);
      continue;
    }
    console.log(`[ok] tokens.${kind} sembrado desde ${envVar}.`);
  }
}

main();
