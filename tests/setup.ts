import { config } from "dotenv";

// Vitest no carga .env.local automáticamente como sí lo hace `next dev`/`next build`.
config({ path: ".env.local" });
