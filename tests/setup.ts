import { config } from "dotenv";

// Vitest no carga .env.local automáticamente como sí lo hace `next dev`/`next build`.
config({ path: ".env.local" });

// Aislamiento del test suite (meta-prompt v3.0 §8): marcar TODO el tráfico de
// esta corrida como entorno de prueba. Con PESSARO_ENV != "production", el
// webhook deriva is_test=true / origin='test' para cada señal (lib/origin.ts),
// así que aunque la suite pegue contra el proyecto real, sus filas nunca
// entran en la cola que ve el EA (claim_signals sólo sirve producción). El
// override es incondicional a propósito: no debe poder quedar en "production"
// por accidente al correr los tests.
process.env.PESSARO_ENV = "test";
