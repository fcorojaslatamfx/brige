/**
 * Cadencia del heartbeat de los EA y umbral del badge online/offline.
 *
 * Vive en su propio módulo, SIN importar nada, porque lo consumen los dos
 * lados: el servidor (lib/tokens.ts, lib/clients.ts) y componentes de cliente
 * como app/status/clients/page.tsx. Ponerlo en lib/tokens.ts arrastraría al
 * bundle del navegador el cliente service-role de Supabase que ese módulo
 * importa — que es exactamente la credencial que nunca debe salir del
 * servidor.
 *
 * Los dos valores están acoplados y hay que moverlos juntos:
 *
 *  · El EA pollea cada 2 s, pero su heartbeat solo se PERSISTE una vez cada
 *    INTERVAL. Antes se escribía en cada poll: 71.435 UPDATE sobre la misma
 *    fila en 30 días (medido en pg_stat_statements) para alimentar un badge.
 *
 *  · Por eso THRESHOLD tiene que ser mayor que INTERVAL. Si fuese menor, un EA
 *    perfectamente vivo aparecería "offline" la mayor parte de cada ventana,
 *    porque su última escritura sería más antigua que el umbral. El factor 2,5
 *    deja margen para un poll perdido y para la deriva de reloj.
 *
 * Efecto visible: una caída del EA se detecta en ~75 s en lugar de ~10 s. Es
 * el precio de eliminar el 97 % de las escrituras, y para un puente que
 * notifica —donde el operador reacciona en minutos— sale a cuenta.
 */

export const HEARTBEAT_MIN_INTERVAL_SECONDS = 30;

export const EA_ONLINE_THRESHOLD_SECONDS = HEARTBEAT_MIN_INTERVAL_SECONDS * 2.5;
