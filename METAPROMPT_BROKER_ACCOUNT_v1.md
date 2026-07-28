# META-PROMPT · DATOS DE CUENTA DE BRÓKER EN CLIENTES + FILTRO POR BRÓKER
## Pessaro Bridge — `app/status/clients`, `app/status` (panel general)

**Destinatario:** Claude Code
**Autor:** Pessaro Capital
**Fecha:** 24 de julio de 2026
**Repositorio:** `github.com/fcorojaslatamfx/brige`, rama `main`
**Alcance:** tabla `client_tokens`, `lib/clients.ts`, `lib/schema.ts`, `app/api/clients/route.ts`,
`app/status/clients/page.tsx`, `app/api/status/route.ts`, `app/status/page.tsx`.

---

## 0. LECTURA DE LAS TRES CAPTURAS Y UNA AMBIGÜEDAD A RESOLVER ANTES DE CODEAR

Las tres pantallas compartidas corresponden a lo que ya construyó Claude Code en
commits previos (`67a169e Tokens de cliente + dashboards diferenciados por rol`,
`7c7d5fa Unificar UX...`):

1. **Imagen 1** = `/status/clients`, vista **super_admin** ("Generar token de cliente" +
   tabla "Clientes con token"). Aquí van los 4 campos nuevos, en el formulario de alta.
2. **Imagen 2** = `/status/users` ("Usuarios del panel" — altas de `super_admin`/`admin`
   con acceso al dashboard interno). **Este documento NO toca esta pantalla**: son
   usuarios internos de Pessaro (staff), no cuentas de trading de clientes — no tiene
   sentido pedirles bróker/número de cuenta.
3. **Imagen 3** = `/status` (panel general del operador), con el filtro "ORIGEN DEL
   TRÁFICO" (`tradingview`/`test`/`manual`/`replay`/`todos`).

**Ambigüedad detectada en el pedido y resuelta así:** la frase *"en panel de admin,
también agregar los campos indicados anteriormente"* no puede referirse a la Imagen 2
literalmente (usuarios internos del panel, sin bróker) — el código confirma que
`/status/clients` es **una sola página que renderiza distinto según rol**: `super_admin`
ve "Clientes con token" (todos, con columna Admin, con el formulario de alta) y `admin`
ve "Mis clientes" (solo los suyos, sin formulario de alta — el `super_admin` es quien
genera el token). **"Panel de admin" = esa segunda vista, la del rol `admin`.** Este
documento interpreta el pedido como: los 4 campos nuevos deben ser visibles también en
la tabla que ve un `admin`, no solo en la del `super_admin`. Si esta lectura es
incorrecta, es un cambio de una línea (una condición `{isSuper && ...}`) revertirlo — se
señala explícitamente en §4 dónde está esa condición.

---

## 1. MODELO DE DATOS — MIGRACIÓN `015_client_broker_account.sql`

`client_tokens` no tiene hoy ningún campo de cuenta de bróker — se confirmó leyendo
`supabase/migrations/014_client_tokens.sql` completo. Los 4 campos nuevos, **todos
obligatorios** según el pedido:

| Campo | Tipo | Validación |
|---|---|---|
| `broker` | `text` | no vacío, ej. "Tradeview", "IC Markets", "Pepperstone" |
| `account_type` | `text` | `CHECK (account_type IN ('demo','real'))` |
| `account_number` | `text` | no vacío |
| `broker_server` | `text` | no vacío, ej. "Tradeview-Demo", "ICMarketsSC-Live06" |

### 1.1 Migración segura (posible data existente)

`NOT NULL` directo rompe si ya hay filas (aunque la Imagen 1 muestra "Sin clientes
todavía" al momento de la captura, no asumir que sigue vacía al aplicar esto en
producción — verificar primero). Patrón de dos pasos:

```sql
-- ============================================================
-- Pessaro Bridge · 015_client_broker_account.sql
-- Datos de cuenta de bróker por cliente — obligatorios para
-- todo cliente NUEVO. Backfill de filas preexistentes con un
-- valor centinela explícito para no perder NOT NULL en el
-- esquema (la UI nunca debe mostrar el centinela sin distinguirlo).
-- ============================================================

alter table public.client_tokens
  add column broker         text,
  add column account_type   text,
  add column account_number text,
  add column broker_server  text;

-- Backfill de filas creadas antes de esta migración (si existen).
-- 'SIN_DATO' es intencionalmente distinguible en la UI (§4.3) para que el
-- super_admin sepa que debe completar esos clientes manualmente.
update public.client_tokens
set broker = 'SIN_DATO', account_type = 'demo', account_number = 'SIN_DATO', broker_server = 'SIN_DATO'
where broker is null;

alter table public.client_tokens
  alter column broker         set not null,
  alter column account_type   set not null,
  alter column account_number set not null,
  alter column broker_server  set not null;

alter table public.client_tokens
  add constraint client_tokens_account_type_check check (account_type in ('demo', 'real'));

create index idx_client_tokens_broker on public.client_tokens (broker);
```

Verificar antes de aplicar: `select count(*) from public.client_tokens;` — si devuelve 0,
el backfill no hace nada y es igualmente seguro dejarlo (es idempotente y documenta la
intención para el futuro).

---

## 2. VALIDACIÓN — `lib/schema.ts`

`createClientSchema` (línea ~158) pasa de:

```ts
export const createClientSchema = z.object({
  client_name: z.string().max(120).optional(),
  client_email: z.string().email(),
  client_phone: z.string().min(3).max(30),
  assigned_admin: z.string().uuid().optional(),
  expiry: clientExpirySchema,
});
```

a:

```ts
export const createClientSchema = z.object({
  client_name: z.string().max(120).optional(),
  client_email: z.string().email(),
  client_phone: z.string().min(3).max(30),
  assigned_admin: z.string().uuid().optional(),
  expiry: clientExpirySchema,
  broker: z.string().trim().min(1, "El bróker es obligatorio").max(80),
  account_type: z.enum(["demo", "real"], { errorMap: () => ({ message: "Tipo de cuenta inválido" }) }),
  account_number: z.string().trim().min(1, "El número de cuenta es obligatorio").max(40),
  broker_server: z.string().trim().min(1, "El servidor del bróker es obligatorio").max(80),
});
```

Sin `.optional()` en ninguno de los cuatro — es el mecanismo real de "obligatorio", no
solo el `required` de HTML (que un `fetch` directo a la API podría saltarse).

---

## 3. `lib/clients.ts`

- `ClientTokenRow`: agregar los 4 campos (`broker: string`, `account_type: "demo" | "real"`,
  `account_number: string`, `broker_server: string`) — no nullable, consistente con el
  `NOT NULL` de la migración.
- `createClientToken(input)`: agregar los 4 campos al objeto que recibe y al `.insert({...})`.
  `account_type` no necesita `.trim()` (viene de un `<select>` cerrado); los otros tres sí.
- `ClientTokenView`/`listClientTokens` no requieren cambios propios — ya hacen
  `{ ...r, status: ..., ... }`, así que los campos nuevos se propagan solos al venir en `r`.

---

## 4. `app/status/clients/page.tsx`

### 4.1 Tipo `ClientRow`
Agregar los 4 campos (mismo tipo que en `lib/clients.ts`).

### 4.2 Formulario "Generar token de cliente" (solo dentro del bloque `{isSuper && (...)}`)

Insertar junto a los inputs existentes de nombre/correo/móvil, con `required` (además de
la validación Zod del servidor — defensa en dos capas, mismo patrón que ya usan
`client_email`/`client_phone`):

```tsx
const [broker, setBroker] = useState("");
const [accountType, setAccountType] = useState<"demo" | "real">("demo");
const [accountNumber, setAccountNumber] = useState("");
const [brokerServer, setBrokerServer] = useState("");
```

```tsx
<input
  type="text"
  value={broker}
  onChange={(e) => setBroker(e.target.value)}
  placeholder="Bróker (ej. Tradeview)"
  className={styles.settingsInput}
  style={{ minWidth: 160 }}
  required
/>
<select
  value={accountType}
  onChange={(e) => setAccountType(e.target.value as "demo" | "real")}
  className={styles.settingsInput}
  required
>
  <option value="demo">Cuenta Demo</option>
  <option value="real">Cuenta Real</option>
</select>
<input
  type="text"
  value={accountNumber}
  onChange={(e) => setAccountNumber(e.target.value)}
  placeholder="N° de cuenta"
  className={styles.settingsInput}
  style={{ minWidth: 130 }}
  required
/>
<input
  type="text"
  value={brokerServer}
  onChange={(e) => setBrokerServer(e.target.value)}
  placeholder="Servidor (ej. Tradeview-Demo)"
  className={styles.settingsInput}
  style={{ minWidth: 180 }}
  required
/>
```

En `handleCreate`, agregar los 4 valores al `body` del `POST /api/clients`, y resetear los
4 `useState` junto a los existentes tras un alta exitosa.

**Nota de UX — cuenta real vs demo:** dado que `account_type: "real"` implica dinero real
del cliente, considerar (opcional, no bloqueante para este alcance) resaltar visualmente
esa opción — por ejemplo con `color: var(--red)` en el `<option>` o un badge de
confirmación antes de enviar el formulario si `accountType === "real"`. Se deja como
sugerencia, no como requisito de aceptación.

### 4.3 Tabla — visible para `super_admin` **y** `admin` (resuelve la ambigüedad de §0)

Hoy la tabla tiene columnas condicionadas por rol solo en `Admin` (`{isSuper && <th>Admin</th>}`).
Agregar una columna nueva **sin condicionar a `isSuper`** — así aparece en ambas vistas
("Clientes con token" del super_admin y "Mis clientes" del admin):

```tsx
<th>Cuenta</th>
```

y en el `<tbody>`, junto a la celda de "Cliente" (mismo patrón visual de agrupar
información relacionada en una celda, como ya hace la celda de Cliente con
nombre+correo+teléfono):

```tsx
<td>
  <div>{c.broker}{" "}<span className={styles.mono} style={{ fontSize: 11 }}>({c.account_type === "real" ? "REAL" : "DEMO"})</span></div>
  <div className={styles.hint} style={{ margin: 0 }}>
    {c.account_number} · {c.broker_server}
  </div>
</td>
```

Usar `Badge tone="critical"` (o el rojo existente) para `account_type === "real"` en vez
de texto plano, coherente con que "REAL" es información sensible que el operador debe
notar de un vistazo — sigue el mismo principio ya aplicado en el sistema para
`badge_critical`/`badge_warning`.

Si alguna fila trae el centinela `SIN_DATO` del backfill de §1.1, mostrarlo con
`Badge tone="warning"` en vez de como texto plano, para que el super_admin note que ese
cliente antiguo necesita completarse (no hay endpoint de edición hoy — anotar como mejora
futura si se decide construirlo; **fuera del alcance de este documento**, que es alta,
no edición).

Actualizar el `colSpan` del `<tr>` de "Sin clientes todavía" / "Aún no tienes clientes
asignados" (hoy `isSuper ? 7 : 6`) sumando 1 por la columna nueva: `isSuper ? 8 : 7`.

### 4.4 `handleCreate` — payload completo

```ts
body: JSON.stringify({
  client_name: name.trim() || undefined,
  client_email: email.trim(),
  client_phone: phone.trim(),
  assigned_admin: assignedAdmin || undefined,
  expiry,
  broker: broker.trim(),
  account_type: accountType,
  account_number: accountNumber.trim(),
  broker_server: brokerServer.trim(),
}),
```

---

## 5. `app/api/clients/route.ts`

El `POST` ya delega toda la validación a `createClientSchema.safeParse(body)` (línea 44) y
pasa `input` completo a `createClientToken({...input, created_by: caller.id})` (línea 52)
— **no requiere cambios** más allá de los que ya se hicieron en `lib/schema.ts` y
`lib/clients.ts`: al ser `input` un spread tipado por el esquema Zod, los 4 campos nuevos
viajan solos. Confirmar esto con `npm run build` (TypeScript debe fallar en este archivo
si algo quedó desalineado — es la señal de que el spread no está completo).

El `audit.insert` del evento `client_token_created` (línea 57-67) puede opcionalmente
sumar `broker: created.broker` al `detail`, útil para trazabilidad futura sin ser
obligatorio para la aceptación de este documento.

---

## 6. FILTRO POR BRÓKER EN EL PANEL GENERAL (`/status`)

### 6.1 Qué existe hoy y por qué el bróker no es un campo de `signals`

El filtro "ORIGEN DEL TRÁFICO" (`app/status/page.tsx` línea ~190-211) filtra
`signals.origin` (`tradingview`/`test`/`manual`/`replay`/`all`) — un atributo de **cómo
llegó la señal al bridge**. El bróker, en cambio, es un atributo del **cliente que la
recibe** (`client_tokens.broker`, recién agregado en §1), no de la señal misma: la misma
señal de XAUUSD se difunde a todos los clientes activos sin importar su bróker (ver
`claim_signals_for_client` en `014_client_tokens.sql` — difusión, no segmentación por
bróker). Por lo tanto, "filtrar señales por bróker" en la práctica significa: **filtrar
qué señales fueron entregadas a clientes de ese bróker**, vía la tabla
`client_deliveries`.

### 6.2 Nuevo filtro — mismo lenguaje visual, fila adicional

Agregar, **debajo** de la fila "Origen del tráfico" existente (mismo `<section className={styles.panel}>`,
no una sección nueva, para que se sienta como parte del mismo control de filtros):

```tsx
<div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginTop: 10 }}>
  <span className={styles.statLabel}>Bróker</span>
  <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
    {(["all", ...data?.brokers ?? []] as string[]).map((b) => (
      <button
        key={b}
        type="button"
        onClick={() => setBroker(b)}
        className={styles.gateButton}
        style={{ opacity: broker === b ? 1 : 0.5, textTransform: "none" }}
      >
        {b === "all" ? "todos" : b}
      </button>
    ))}
  </div>
</div>
```

con `const [broker, setBroker] = useState<string>("all");` junto al `origin` existente, y
el mismo patrón de dependencia en `fetchStatus`/`useEffect` que ya tiene `origin` (línea
91-121) — agregar `broker` a la query string y al arreglo de dependencias del `useCallback`.

### 6.3 `app/api/status/route.ts`

- Nuevo query param `broker` (por defecto `"all"`), sin whitelist fija como `ORIGIN_FILTERS`
  porque los brokers son dinámicos (los define el super_admin al crear clientes) — validar
  solo que sea un string no vacío razonable (`.slice(0, 80)` como guardarraíl, sin más).
- Agregar al `Promise.all` una consulta de brokers distintos para poblar los botones:
  ```ts
  supabase.from("client_tokens").select("broker").order("broker"),
  ```
  y derivar `const brokers = [...new Set((brokersRes.data ?? []).map(r => r.broker))];`
  — devolver en la respuesta JSON como `brokers`.
- Cuando `broker !== "all"`, la query de `recentQuery` (líneas 26-32) necesita filtrarse
  por señales entregadas a clientes de ese bróker. Como `signals` no tiene FK directa a
  `client_tokens`, resolver en dos pasos (más simple y explícito que un `JOIN` anidado en
  PostgREST, y más fácil de leer/mantener):
  ```ts
  let signalIdsForBroker: string[] | null = null;
  if (broker !== "all") {
    const { data: clientRows } = await supabase
      .from("client_tokens")
      .select("id")
      .eq("broker", broker);
    const clientIds = (clientRows ?? []).map((c) => c.id);
    const { data: deliveryRows } = await supabase
      .from("client_deliveries")
      .select("signal_id")
      .in("client_id", clientIds.length > 0 ? clientIds : ["00000000-0000-0000-0000-000000000000"]);
    signalIdsForBroker = [...new Set((deliveryRows ?? []).map((d) => d.signal_id))];
  }
  ```
  y aplicar `if (signalIdsForBroker) recentQuery.in("id", signalIdsForBroker.length > 0 ? signalIdsForBroker : ["00000000-0000-0000-0000-000000000000"]);`
  (el UUID centinela evita que un `.in([])` vacío se interprete como "sin filtro" en
  PostgREST — problema conocido de la librería, no un capricho de estilo).
- `delivery_funnel`/`latency_stats` (RPCs `p_origin`) quedan **sin cambios** — están
  pensados para el embudo por origen de ingestión, no por bróker de destino; extenderlos
  a bróker es una mejora de analítica más grande, fuera de este alcance mínimo. Documentar
  esto como decisión, no como olvido.
- Sumar `brokers` y `broker` (el filtro activo) a la respuesta `StatusResponse`.

### 6.4 Tipos en `app/status/page.tsx`

```ts
type StatusResponse = {
  // ...existentes...
  broker: string;
  brokers: string[];
};
```

---

## 7. DISCIPLINA DE TRABAJO

1. Rama de trabajo: `git checkout -b feature/broker-cuenta-cliente`.
2. Aplicar la migración 015 contra Supabase **antes** de tocar código TypeScript (si el
   tipo generado se usa en algún lado vía `generate_typescript_types`, regenerarlo).
3. `npm run build` limpio — es la señal de que el spread de campos en
   `app/api/clients/route.ts` quedó completo (§5).
4. Loop visual: captura de `/status/clients` con el formulario nuevo (los 4 campos
   visibles y marcados como obligatorios), captura de la tabla con al menos un cliente
   de prueba mostrando bróker/tipo/cuenta/servidor, captura de la vista `admin` ("Mis
   clientes") confirmando que también ve la columna nueva, y captura de `/status` con el
   filtro "Bróker" funcionando (togglear entre un bróker específico y "todos").
5. Verificación por grep:
   ```bash
   grep -n "broker" lib/schema.ts lib/clients.ts app/api/clients/route.ts app/status/clients/page.tsx
   # debe aparecer en los 4 archivos — si falta en alguno, el campo no viaja end-to-end
   ```
6. Push a la rama → reportar preview → detenerse (merge a `main` es decisión humana).

---

## 8. CRITERIOS DE ACEPTACIÓN

| # | Criterio | Verificación |
|---|---|---|
| 1 | Los 4 campos son obligatorios tanto en el HTML (`required`) como en el servidor (Zod sin `.optional()`) | Intentar `POST /api/clients` sin `broker` vía curl → debe devolver 400 |
| 2 | La migración no rompe si `client_tokens` ya tiene filas | Ejecutar contra una copia con datos de prueba antes de aplicar en producción |
| 3 | La tabla de clientes muestra bróker/tipo/cuenta/servidor tanto en la vista `super_admin` como en la vista `admin` | Captura de ambas vistas |
| 4 | `account_type: "real"` se distingue visualmente de `"demo"` (no es texto plano indistinguible) | Captura |
| 5 | El filtro "Bróker" en `/status` se puebla dinámicamente desde `client_tokens`, sin lista fija hardcodeada | Crear un cliente con un bróker nuevo y confirmar que aparece como botón sin tocar código |
| 6 | Al filtrar por un bróker específico, la tabla "Señales en vivo" solo muestra señales entregadas a clientes de ese bróker | Verificación cruzada contra `client_deliveries` en Supabase |
| 7 | `npm run build` sin errores | Log de build |
| 8 | Cero cambios en `app/status/users/page.tsx` (Imagen 2, fuera de alcance — ver §0) | `git diff --stat` no debe listar ese archivo |

---

## 9. FUERA DE ALCANCE (explícito)

- Edición de clientes existentes (hoy solo hay alta + revocación, no edición — completar
  el centinela `SIN_DATO` de filas antiguas requiere un endpoint `PATCH` que no existe;
  es un meta-prompt aparte si se decide construirlo).
- `/status/users` (Imagen 2) — usuarios internos del panel, no cuentas de trading.
- Extender `delivery_funnel`/`latency_stats` con desglose por bróker (§6.3).
- Mostrar bróker/cuenta en el portal del cliente (`app/portal`) — el cliente ya sabe cuál
  es su propia cuenta, no es información que necesite ver reflejada de vuelta.
- El EA de MT4 — no necesita conocer el bróker del cliente vía este mecanismo, ya lo
  configura directamente en `InpSymbolMap`/su propia cuenta de MT4.

---

*Pessaro Capital · Meta-prompt datos de cuenta de bróker v1.0 · 24 de julio de 2026*
