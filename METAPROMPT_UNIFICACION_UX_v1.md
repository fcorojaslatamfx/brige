# META-PROMPT · UNIFICACIÓN UX PESSARO BRIDGE ↔ PESSARO.CL
## Migrar el dashboard interno al sistema de diseño "Navy / Púrpura / Dorado" del sitio corporativo

**Destinatario:** Claude Code
**Autor:** Pessaro Capital
**Fecha:** 24 de julio de 2026
**Repositorio a modificar:** `github.com/fcorojaslatamfx/brige` (privado), rama `main`
**Repositorio de referencia (solo lectura, NO se toca):** `github.com/fcorojaslatamfx/pessaro_CL`
**Alcance:** exclusivamente la capa visual (`app/**/*.module.css`, `app/layout.tsx`, JSX de las páginas). Cero cambios de lógica, rutas, esquema Zod, SQL o contrato de señales.

---

## 0. DIAGNÓSTICO — CONFIRMADO ANTES DE ESCRIBIR ESTE DOCUMENTO

Se leyó `MEMORIA_PROYECTO.md` (raíz del repo de Brige) y se auditó el código real de ambos
repositorios antes de proponer cualquier cambio. Conclusión: **no hay conflicto de
arquitectura ni de rutas** — `/status` es y sigue siendo el home del panel (confirmado en
`middleware.ts`: usuario autenticado en `/login` → redirect a `/status`; usuario sin
sesión en cualquier `/status/*` → redirect a `/login`). Lo que sí existe, y es la razón de
este documento, es una **inconsistencia de sistema de diseño entre dos mitades del mismo
producto**:

| | `app/login/login.module.css` | `app/status/status.module.css` |
|---|---|---|
| Fondo | `#030915` / `#091423` | `#0c0f1a` / `#141826` |
| Acento dorado | `#d4a656` / `#e8c374` | `#c9a84c` / `#f0d080` |
| Púrpura | `--violet: #765cde` **declarado pero nunca usado** | **no existe** |
| Animaciones | ninguna (solo `:hover` de color plano) | ninguna (solo `:hover` de color plano) |
| Usado por | `/login` únicamente | `/status`, `/status/tokens`, `/status/users`, `/set-password` (el 90 % de las pantallas) |

`/login` **ya había empezado**, sin documentarlo, a acercarse a la paleta de `pessaro.cl`
(fondo casi negro-azulado, dorado `#d4a656`, y hasta una variable `--violet` que nadie
llegó a conectar a ningún elemento). El resto del panel — que es lo que el trader ve el
90 % del tiempo — se quedó en la identidad original de Bridge documentada en
`MEMORIA_PROYECTO.md` §7 (`#0c0f1a` / `#c9a84c`, sin púrpura, sin animación). Es decir: el
"conflicto" no es que este trabajo vaya a chocar con algo — es que hoy **ya conviven dos
paletas** y esta migración es precisamente lo que las reconcilia en una sola fuente de
verdad, la de `pessaro.cl`.

Se clonó y auditó `pessaro_CL` — en particular `PESSARO_CL_REDISENO_UX_v1.9_2026_07_17.md`
y `src/index.css` — para extraer la paleta, la tipografía y el vocabulario de animación
exactos ya validados en producción en el sitio corporativo. Ver §1–§3.

**Fuera de alcance, explícitamente:** el EA de MT4 (`PessaroBridgeEA_v2.mq4`) tiene su
propia paleta en constantes `PC_*` (`#0c0f1a`/`#c9a84c`, la identidad *antigua*). No se
toca en este documento — es un artefacto MQL4 sin relación con Next.js/CSS. Si se decide
alinearlo también, es un meta-prompt aparte.

---

## 1. FUENTE DE VERDAD — TOKENS DE `pessaro.cl`

Copiados literalmente de `pessaro_CL/src/index.css` (`:root`, sección "Navy / Purple /
Gold scale", líneas 69–82) y del resumen ejecutivo de `PESSARO_CL_REDISENO_UX_v1.9`:

```css
--navy-950:    #070c16;   /* fondo más profundo */
--navy-900:    #0a1628;   /* fondo de paneles/popover */
--navy-800:    #101d34;   /* superficie de card */
--navy-700:    #182746;   /* superficie secundaria */
--navy-600:    #22345c;   /* borde/hover sutil */

--purple:       #6c5ce7;  /* acento PRIMARIO — CTAs, navegación, foco */
--purple-deep:  #5e17eb;  /* variante profunda para gradientes */
--purple-light: #a29bfe;  /* texto/ícono sobre fondo oscuro */

--gold:        #d4a656;   /* acento PREMIUM secundario — reservado para señales de calidad */
--gold-light:  #e8c374;

--green: #00d084;   /* positivo / BUY / OK */
--red:   #ff4757;   /* negativo / SELL / crítico */
--blue:  #0984e3;   /* confianza / información */
```

**Jerarquía semántica que trae `pessaro.cl` y que hoy Bridge no tiene** (es la pieza que
falta, no solo el color): *"Púrpura: acento primario, CTAs. Dorado: acento premium
secundario"* — cita textual del resumen ejecutivo. Bridge hoy usa **dorado para todo**
(botones primarios, badges, títulos), lo que diluye su significado. Al traer el púrpura
como color de acción primaria, el dorado queda libre para significar exactamente lo que
ya significa en el contrato de señales: **calidad ELITE**. Es una mejora semántica, no
solo cosmética — ver §6.

---

## 2. TIPOGRAFÍA — DECISIÓN EXPLÍCITA (leer antes de tocar `layout.tsx`)

`pessaro.cl` usa **Plus Jakarta Sans** (sans única, sin serif) + **JetBrains Mono**
(reservada estrictamente para cifras/precios). Bridge usa **Playfair Display** (serif,
solo para el wordmark "PESSARO BRIDGE" / "Pessaro Capital") + **DM Sans** (cuerpo) +
**DM Mono** (cifras) — documentado como identidad propia en `MEMORIA_PROYECTO.md` §7.

**Decisión de este meta-prompt: se conserva la tipografía actual de Bridge.** Razones:

1. El *principio* que importa migrar es "sans para cuerpo, mono estricta para cifras" —
   DM Sans/DM Mono ya cumplen ese principio con la misma disciplina que Plus
   Jakarta/JetBrains Mono en `pessaro.cl`. Cambiar la familia tipográfica concreta no
   aporta nada al objetivo real (unificar la sensación de marca), solo agrega riesgo.
2. Playfair Display en el wordmark es lo único que **ya es consistente** entre `/login` y
   `/status` hoy — es el único hilo que no hay que remendar.
3. Bridge es una herramienta operativa interna (dos roles, sin público), no un sitio de
   marketing: no necesita la fuente exacta del sitio corporativo, necesita **la misma
   gramática visual de color, jerarquía y movimiento**.

Si en el futuro se decide unificar también la tipografía exacta (Plus Jakarta Sans +
JetBrains Mono en todo el panel), es un cambio de una sola línea en `app/layout.tsx`
(reemplazar los tres `next/font/google` por esas dos familias) — se deja anotado aquí
como opción consciente, no como parte de este alcance.

---

## 3. VOCABULARIO DE ANIMACIÓN A IMPORTAR

Extraído de `pessaro_CL/src/index.css`, con la clase original, su técnica, y el
elemento de Bridge al que se mapea. Se importa la *técnica*, no el HTML/JSX de
`pessaro.cl` — Bridge no tiene heroes, velas japonesas ni componentes de marketing, y no
debe adquirirlos.

| Técnica en `pessaro.cl` | Qué hace | Dónde aplica en Bridge |
|---|---|---|
| `--ease-hover: 180ms ease-out` / `--ease-reveal: 850ms cubic-bezier(.16,.8,.3,1)` | Timing unificado de toda micro-interacción | Token global nuevo, usado por todo lo demás en esta tabla |
| `.card-premium` (borde-gradiente en hover vía `mask-composite`, elevación `translateY(-7px)`) | Tarjeta con borde púrpura→dorado que aparece solo al hover, sin ocupar espacio en reposo | `.statTile` y `.panel` — hoy son cajas estáticas con borde plano |
| `.btn-gold` (gradiente dorado + barrido de brillo diagonal en hover) | Botón premium con destello | `.saveButton` (Guardar umbrales), `.button`/`.gateButton` (Entrar) — ya son dorados, ganan el barrido |
| `.btn-primary` (gradiente púrpura + mismo barrido) | Botón de acción primaria | Enlaces `Tokens` / `Usuarios` en el header de `/status` — hoy comparten estilo con "Cerrar sesión", sin jerarquía |
| `button:not(:disabled)::after` (barrido aplicado globalmente a `<button>`) | Que **todo** botón, sin excepción, tenga el mismo lenguaje de hover | Todos los botones de `/status/tokens` y `/status/users` (crear/revocar token, invitar/editar usuario) |
| `.badge-live` (punto pulsante `@keyframes pulse-dot`) | Indicador "en vivo" con punto que respira | **`EaStatusBadge`** — calce semántico perfecto: "● EA ONLINE" ya existe pero es texto estático; el punto pulsante comunica "en vivo" de un vistazo, igual que el badge de precios en vivo de `pessaro.cl` |
| `.rv` / `.rv.in` (scroll/mount-reveal: `opacity 0 → 1`, `translateY(28px) → 0`) | Entrada suave de secciones | Cada `<section className={styles.panel}>` de `/status` al montar (no scroll-triggered, mount-triggered: son 5 secciones fijas, no hay scroll largo) |
| `.spark-line` (`stroke-dasharray`/`stroke-dashoffset`, dibujo progresivo de un trazo SVG) | Línea que se "dibuja" sola | Opcional — solo si se decide graficar el conteo diario por símbolo como sparkline en vez de tabla (fuera del alcance mínimo de este documento, anotar como mejora futura) |
| `.nav-glass` (`backdrop-filter: blur(18px) saturate(1.3)`) | Header translúcido con blur | `.header` de `/status` — hoy es fondo sólido; con `position: sticky` gana translucidez al hacer scroll en tablas largas |
| `@media (prefers-reduced-motion: reduce)` (desactiva toda animación) | Accesibilidad | Obligatorio, calcado 1:1 del bloque de `pessaro.cl` — Bridge hoy no tiene ninguno |

**No se importa** `.nav-progress-bar` (barra de progreso entre rutas): en `pessaro.cl` es
un SPA con Vite; en Next.js App Router requiere una integración distinta con
`next/navigation` que no está resuelta en la referencia y no vale la complejidad para un
panel de 5 rutas. Si se quiere en el futuro, evaluarlo aparte.

---

## 4. ARQUITECTURA DE TOKENS — CORTAR LA CAUSA RAÍZ, NO SOLO EL SÍNTOMA

Hoy cada `.module.css` declara **su propia copia** de las variables de marca dentro de
`.page { --bg: ...; --gold: ...; }`. Es exactamente así como el sistema llegó a
desincronizarse: alguien tocó una copia y no la otra. Antes de aplicar la paleta nueva,
crear una fuente única.

### 4.1 Nuevo archivo `app/theme.css`

```css
/*
 * Fuente única de los tokens de marca Pessaro Capital para el panel Bridge.
 * Extraído 1:1 de pessaro_CL/src/index.css (24-jul-2026) — ver
 * METAPROMPT_UNIFICACION_UX_v1.md para el detalle de la migración.
 * Cualquier color nuevo se agrega AQUÍ, nunca dentro de un .module.css.
 */
:root {
  --navy-950: #070c16;
  --navy-900: #0a1628;
  --navy-800: #101d34;
  --navy-700: #182746;
  --navy-600: #22345c;

  --purple: #6c5ce7;
  --purple-deep: #5e17eb;
  --purple-light: #a29bfe;

  --gold: #d4a656;
  --gold-light: #e8c374;
  --gold-deep: #a8862c;

  --green: #00d084;
  --red: #ff4757;
  --blue: #0984e3;

  --border: rgba(255, 255, 255, 0.08);
  --text-primary: #f1f2f6;
  --text-muted: #9aa3b8;

  --ease-hover: 180ms ease-out;
  --ease-reveal: 850ms cubic-bezier(0.16, 0.8, 0.3, 1);
}
```

Importar **una sola vez**, en `app/layout.tsx`:

```tsx
import "./theme.css";
```

### 4.2 Los `.module.css` dejan de redeclarar colores

`login.module.css` y `status.module.css` **eliminan** su bloque `.page { --bg: ...; }` y
en su lugar consumen `var(--navy-950)`, `var(--gold)`, etc. directamente — las variables
ya están en `:root` gracias a `theme.css`. Esto es lo que garantiza que no vuelva a pasar
lo que ya pasó: si mañana se ajusta un hex, se ajusta en un solo lugar y las cuatro
páginas lo heredan.

---

## 5. PLAN DE APLICACIÓN, ARCHIVO POR ARCHIVO

### 5.1 `app/theme.css` (nuevo) + `app/layout.tsx`
- Crear el archivo de §4.1.
- Importarlo en `layout.tsx`.
- Añadir el bloque `@media (prefers-reduced-motion: reduce)` global ahí también (aplica a
  toda la app, no por módulo).

### 5.2 `app/login/login.module.css`
- Quitar el bloque de variables locales (`--bg`, `--gold`, `--violet`, etc. dentro de
  `.page`); pasar a `var(--navy-950)`, `var(--gold)`, `var(--purple)` desde `theme.css`.
  **`--violet` deja de ser una variable huérfana**: se convierte en `var(--purple)` y se
  le da un uso real (ver siguiente punto).
- `.linkButton` ("¿Olvidaste tu contraseña?"): actualmente `color: var(--text-muted)` con
  subrayado. Cambiar el color de hover a `var(--purple-light)` en vez del dorado que usa
  `.button` — así el enlace secundario y el botón primario quedan visualmente
  diferenciados (exactamente el rol que `pessaro.cl` le da al púrpura: navegación/enlaces
  vs. dorado para la acción principal "Entrar").
- `.button` adopta la técnica `.btn-gold` de §3 (gradiente + barrido).
- El fondo (`.backdrop`/`.backdropOverlay`) **no se toca** — ya fue corregido en la
  iteración anterior de esta conversación (overlay topado en 0.25). No revertir eso.

### 5.3 `app/status/status.module.css` (el cambio de mayor impacto — 90 % de las pantallas)
- Quitar variables locales de `.page`, consumir `theme.css`.
- `.statTile` → aplicar la técnica `.card-premium` (borde-gradiente púrpura→dorado en
  hover + elevación). `.statTileWarning` conserva su tinte dorado de fondo, pero ahora
  sobre la base `.card-premium`.
- `.panel` → misma técnica `.card-premium`, pero **sin** la elevación en hover (son
  contenedores de tablas, no tarjetas clicables; la elevación se sentiría rara en un
  bloque tan grande). Aplicar solo el borde-gradiente sutil en hover, o directamente un
  borde estático más marcado (`var(--purple)` al 20 % de opacidad) sin interacción — a
  criterio del implementador, documentar cuál se eligió.
- `.saveButton` → técnica `.btn-gold`.
- Enlaces `Tokens` / `Usuarios` del header (hoy comparten `.saveButton`) → **separar en
  una clase nueva `.navLink`** con la técnica `.btn-primary` (púrpura), distinguiéndolos
  de "Guardar umbrales" (dorado) y de "Cerrar sesión" (que debe quedar como `.btn-ghost`:
  borde sutil, sin relleno — es una acción destructiva/de salida, no debe competir
  visualmente con las dos anteriores).
- `EaStatusBadge` → agregar la técnica `.badge-live` (punto pulsante) **solo cuando
  `ea_online === true`**. Cuando está OFFLINE, el punto no debe pulsar (pulsar algo en
  estado de error transmite lo contrario de lo que se busca) — usar un punto estático en
  su lugar, o un pulso de menor frecuencia con `var(--red)`. Decidir y documentar.
- `Badge` → agregar un tono nuevo `badge_purple` (fondo `rgba(108,92,231,.14)`, texto
  `var(--purple-light)`, borde `rgba(108,92,231,.4)` — mismo patrón que los tonos
  existentes) para usos informativos neutros que hoy comparten el gris de `neutral` sin
  necesidad real de serlo (evaluar si `pending`/`claimed` en `StatusBadge` deberían pasar
  de `neutral` a `purple` — es una mejora de legibilidad, no obligatoria).
- Las 5 `<section className={styles.panel}>` → envolver con la clase `.rv` + lógica de
  montaje (agregar `.in` con un `useEffect`/`requestAnimationFrame` tras el primer
  render, o vía `IntersectionObserver` si se prefiere activarlo también al hacer scroll
  en pantallas pequeñas donde no todo cabe en el viewport inicial).
- `.header` → `position: sticky; top: 0;` + técnica `.nav-glass` (blur), con
  `z-index` por encima de las tablas para que el blur se note al hacer scroll.
- Todos los `<button>` de esta hoja de estilos heredan el barrido genérico
  (`button:not(:disabled)::after`) de §3 vía una regla en `theme.css` o en el propio
  `status.module.css` — verificar que no choque con `.btn-gold`/`.btn-primary` (el
  barrido genérico debe ser el *fallback* para botones sin clase de énfasis, no
  duplicarse encima de los que ya tienen su propio barrido).

### 5.4 `app/status/tokens/page.tsx` y `app/status/users/page.tsx`
- No requieren cambios de JSX más allá de, si aplica, usar `.navLink`/`.badge_purple`
  nuevos donde corresponda semánticamente (por ejemplo, un botón "Invitar usuario" o
  "Crear token" es una acción primaria → candidato a `.btn-primary`/púrpura, mientras que
  "Revocar" o "Eliminar" son destructivas → `.btn-ghost` con texto en `var(--red)` al
  hover, nunca dorado ni púrpura).
- Heredan automáticamente todo lo de §5.3 al compartir `status.module.css` — confirmar
  visualmente que ninguna tabla específica de estas páginas rompe con anchos/paddings
  nuevos del `.card-premium`.

### 5.5 `app/set-password/page.tsx`
- Comparte `status.module.css` (usa `.gate`, `.gateForm`, `.gateInput`, `.gateButton`).
  Aplicar a `.gate` la misma técnica `.card-premium` que a `.statTile`/`.panel`, y a
  `.gateButton` la técnica `.btn-gold`. Sin cambios de JSX.

---

## 6. POR QUÉ EL PÚRPURA IMPORTA SEMÁNTICAMENTE (no es solo "agregar un color")

Hoy en Bridge, **dorado significa tres cosas distintas a la vez**: "botón principal",
"botón secundario", y "señal ELITE" (`badge_gold`). Eso diluye la señal más importante
del sistema — cuando el trader ve dorado en la tabla de señales, tiene que distinguir por
contexto si es una fila ELITE o solo el estilo de la tabla. Al mover **navegación y
acciones primarias a púrpura**, dorado queda reservado casi exclusivamente para lo que ya
significa en el contrato JSON: `grade: "ELITE"`. Después de esta migración, **cualquier
dorado que el trader vea en la pantalla de señales debe significar ELITE**, sin
ambigüedad — es la misma disciplina que `pessaro.cl` ya aplica ("dorado = acento premium
secundario", nunca el color por defecto de todo).

---

## 7. DISCIPLINA DE TRABAJO (mismo patrón ya validado en `pessaro_CL`)

Tomado literalmente de cómo se ejecutó el rediseño de `pessaro.cl`
(`FIX_v6.1_footer_dedup_paleta.md` §4, `PESSARO_CL_REDISENO_UX_v1.9` bug #2) — ese
proyecto ya aprendió estas lecciones, no hay que repetir los mismos errores en Bridge:

1. **Rama de trabajo, nunca `main` directo.**
   ```bash
   git checkout -b feature/unificacion-ux-pessaro-cl
   git branch --show-current   # confirmar antes de tocar nada
   ```
2. **`npm run build` limpio antes de cada commit.** Bridge es Next.js/Vercel — un error
   de build bloquea el deploy completo, no solo una página.
3. **Loop visual obligatorio antes de pedir merge**: capturas de `/login`, `/status`,
   `/status/tokens`, `/status/users` y `/set-password`, en desktop (1280px) y móvil
   (390px), mostrando: paleta unificada, badge EA con punto pulsante, botones con
   barrido visible en hover, panels con reveal al cargar.
4. **Verificación por grep al cierre:**
   ```bash
   # Cero hex de la paleta antigua fuera de theme.css / archivos históricos
   grep -rn "#0c0f1a\|#c9a84c\|#f0d080\|#a8862c" app/ --include="*.css" | grep -v theme.css
   # --violet ya no debe existir como variable huérfana
   grep -rn "\-\-violet" app/
   # Confirmar que theme.css es la única fuente de --purple/--navy-950
   grep -rln "\-\-purple:" app/
   ```
   Los tres deben devolver **cero resultados relevantes** (el primero puede seguir
   apareciendo en el EA `.mq4` o en HTML históricos — no es parte de este alcance;
   filtrar solo `app/`).
5. **`prefers-reduced-motion` probado** con la emulación del navegador (DevTools → Rendering
   → "Emulate CSS media feature prefers-reduced-motion: reduce") en al menos `/status`.
6. Push a la rama de trabajo → reportar preview de Vercel → **detenerse**. El merge a
   `main` es decisión humana, igual que en `pessaro.cl`.

---

## 8. CRITERIOS DE ACEPTACIÓN

| # | Criterio | Verificación |
|---|---|---|
| 1 | `login.module.css` y `status.module.css` no declaran ningún hex de color propio; todos vienen de `var(--...)` definidas en `theme.css` | Inspección + grep de §7.4 |
| 2 | `--violet`/`--purple` tiene al menos un uso real y visible (enlace "olvidaste tu contraseña" y/o nav links Tokens/Usuarios) | Captura |
| 3 | El dorado, tras el cambio, aparece **únicamente** en: wordmark, botones marcados como premium (`Entrar`, `Guardar umbrales`) y `badge_gold` (ELITE) — no en navegación genérica | Inspección visual de `/status` |
| 4 | `EaStatusBadge` pulsa cuando `ea_online: true` y no pulsa (o pulsa distinto) cuando `false` | Captura en ambos estados, o toggle manual en dev |
| 5 | Las 5 secciones de `/status` entran con `opacity`/`translateY` animado al cargar, no aparecen de golpe | Captura de video corto o grabación de pantalla |
| 6 | `.header` de `/status` es sticky con blur visible al hacer scroll sobre una tabla larga | Captura con scroll |
| 7 | Todo `<button>` del panel (incluyendo `/status/tokens` y `/status/users`) tiene el barrido de brillo en hover | Inspección |
| 8 | `@media (prefers-reduced-motion: reduce)` desactiva todas las animaciones nuevas | Verificado con emulación de DevTools |
| 9 | `npm run build` sin errores ni warnings nuevos | Log de build |
| 10 | Cero cambios en `app/api/**`, `middleware.ts`, esquemas Zod, o cualquier archivo `.sql` | `git diff --stat` solo debe listar `.css`/`.tsx` de presentación y `theme.css` |

---

## 9. FUERA DE ALCANCE (explícito, para que no se expanda solo)

- El EA de MT4 (`PessaroBridgeEA_v2.mq4`) y su paleta `PC_*` — artefacto separado, sin
  relación con este stack.
- Cualquier lógica de negocio: cálculo de umbrales, deduplicación, cron, Zod, RLS de
  Supabase — nada de eso cambia.
- Tipografía (ver §2 — decisión consciente de no tocarla en esta iteración).
- `.nav-progress-bar` (ver §3 — requiere integración con `next/navigation` no resuelta en
  la referencia).
- Sincronizar el manual HTML del indicador (`manual_td_confluence_v1_1.html`) o cualquier
  documento fuera de `app/` — quedan con la identidad `#0c0f1a`/`#c9a84c` documentada en
  `MEMORIA_PROYECTO.md`, que sigue vigente para esos artefactos hasta que se decida lo
  contrario en un documento aparte.

---

*Pessaro Capital · Meta-prompt de unificación UX v1.0 · 24 de julio de 2026*
