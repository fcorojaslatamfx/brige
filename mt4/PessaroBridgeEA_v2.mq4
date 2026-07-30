//+------------------------------------------------------------------+
//|                                       PessaroBridgeEA_v2.mq4      |
//|                                              Pessaro Capital      |
//+------------------------------------------------------------------+
// Pessaro Bridge · MODO DESPACHADOR MANUAL · contrato v2.0
//
// Este EA NO opera. Hace polling de GET /api/signals y por cada señal
// NOTIFICA al trader por tres canales (sonido, push, panel en el gráfico)
// con los niveles y el lote sugerido recalculado sobre el símbolo real del
// bróker. La decisión de ejecutar cada operación es manual y humana.
//
// Prohibido en el flujo de señales: envío, modificación o cancelación
// automática de órdenes. Cero OrderSend en todo el archivo.
//
// ── QUÉ ARREGLA RESPECTO DEL v1.0 ────────────────────────────────────────
//
//  R1 · TIPO DE ORDEN. El v1.0 leía `action` y lo traducía a "BUY"/"SELL",
//       descartando el campo `type` que el bridge SÍ envía. El operador veía
//       "BUY LIMIT" en TradingView y "BUY" en MT4 y concluía —con razón— que
//       el tipo de orden se perdía. Ahora se muestra BUY LIMIT / SELL LIMIT /
//       BUY STOP / … en panel, alerta y push.
//
//  R2 · EVENTOS DE SETUP. El v1.0 ignoraba SETUP_BUY / SETUP_SELL /
//       SETUP_CANCEL con un Print y —peor— sin ackear: la señal se quedaba
//       'claimed' en el bridge hasta morir 'expired', invisible e
//       inauditable. Ahora se procesan y se distinguen en el panel:
//         ◇ armado  = existe una pendiente colocable, el precio NO la tocó
//         ◆ disparo = el precio YA tocó el nivel
//       El armado es el aviso útil; el disparo llega cuando el límite ya pasó.
//
//  R3 · UMBRALES. Se lee el objeto anidado `thresholds` con fallback al
//       contrato plano v1. Si el bridge NO manda datos, el panel escribe
//       "s/d" — nunca "0/0". Un 0/0 fabricado hacía creer al operador que
//       tenía el cupo agotado o libre cuando el contrato llegó incompleto.
//
//  R4 · CUARENTENA. Toda señal con is_test=true, env≠production,
//       origin≠tradingview o account_id distinto del esperado se descarta sin
//       sonido ni push, se cuenta aparte y se ackea como error para que quede
//       en la auditoría del bridge. Tercera capa de defensa del aislamiento
//       de pruebas: aunque fallaran las dos del servidor, el terminal calla.
//
//  R5 · ESTADO ONLINE/OFFLINE. El v1.0 exigía "último poll < 10 s" cuando
//       fuera de ventana el polling es de 30 s y con backoff llega a 300 s:
//       decía OFFLINE con el puente perfectamente sano. Ahora la tolerancia
//       es `intervalo_vigente × 2 + 5`.
//
//  R6 · RELOJ DE POLLING. El v1.0 usaba TimeCurrent(), que es la hora del
//       ÚLTIMO TICK RECIBIDO y no avanza si el símbolo del gráfico no cotiza
//       (fin de semana, instrumento ilíquido, feriado del bróker): en un
//       gráfico tranquilo el polling se congelaba. Ahora la cadencia usa
//       GetTickCount() y las marcas visibles TimeLocal().
//
//  R7/R8 · Panel con identidad Pessaro Capital, gauges de cupo, contadores de
//       sesión, `grade` e `impulse_atr` con ★ para ELITE.
//
// ── LO QUE **NO** HACE ESTE EA, Y ES DELIBERADO ──────────────────────────
// No filtra parejas de armado+cancelación efímeras. Un setup que se arma y se
// cancela en segundos se suprime EN EL BRIDGE (settings.setup_hold_seconds,
// migración 016) y por eso nunca llega hasta aquí. Es la única capa con
// visión completa: si el filtro viviera en el EA, cada terminal —y cada EA de
// cliente— tendría que reimplementarlo, y el que se quedara atrás seguiría
// sonando. No duplicar esa lógica aquí.
//
// ── CONFIGURACIÓN REQUERIDA EN EL TERMINAL ──────────────────────────────
//  1) Herramientas > Opciones > Expert Advisors > "Permitir WebRequest para
//     las URL siguientes" → agregar la URL de InpBridgeBaseUrl.
//  2) Terminal > Opciones > Notificaciones → configurar MetaQuotes ID para
//     que SendNotification() llegue al móvil.
//  3) InpBrokerToNyOffsetHours: MT4 no tiene base de datos de zonas horarias.
//     Ajustar cuántas horas sumar a la hora del servidor del bróker para
//     obtener la de Nueva York (revisar 2 veces al año por el DST).
//+------------------------------------------------------------------+
#property copyright "Pessaro Capital"
#property version   "2.00"
#property strict

#define EA_VERSION "v2.0"

// ==================== INPUTS ====================
input string InpBridgeBaseUrl          = "https://brige.pessaro.cl"; // dominio del bridge
input string InpEaToken                = "";      // EA_TOKEN (o token de cliente)
input string InpExpectedAccountId      = "TD_CONF_LON_NY"; // account_id esperado ("" = no verificar)
input int    InpPollActiveSeconds      = 2;       // polling dentro de la ventana LON→NY
input int    InpPollIdleSeconds        = 30;      // polling fuera de la ventana
input int    InpMaxSignalsPerPoll      = 20;
input int    InpWindowStartHourNY      = 3;       // 03:00 NY
input int    InpWindowEndHourNY        = 16;      // 16:00 NY
input int    InpBrokerToNyOffsetHours  = -7;      // horas a sumar a la hora del servidor para obtener NY
input string InpSymbolMap              = "";      // "XAUUSD=GOLD,US500=SPX500,EURJPY=EURJPYm"
input bool   InpProbeSymbolSuffixes    = true;    // prueba sufijos (m, .r, _i, micro…) antes de rendirse
input bool   InpSoundAlert             = true;
input bool   InpPushNotification       = true;
input bool   InpPanelEnabled           = true;
input int    InpPanelMaxRows           = 10;
input bool   InpDrawChartLines         = false;   // dibuja ENTRADA/SL/TP si el símbolo es el del gráfico
input int    InpPanelX                 = 12;
input int    InpPanelY                 = 18;

// Identidad Pessaro Capital
input color  InpColorGold              = C'201,168,76';  // dorado #c9a84c
input color  InpColorPanelBg           = C'12,15,26';    // navy #0c0f1a
input color  InpColorBuy               = clrMediumSpringGreen;
input color  InpColorSell              = clrTomato;
input color  InpColorWarning           = clrGold;
input color  InpColorMuted             = C'110,118,140';
input color  InpColorText              = C'226,230,240';

// ==================== ESTADO GLOBAL ====================
uint     g_lastPollTick    = 0;      // GetTickCount() del último poll OK (R6)
datetime g_lastPollLocal   = 0;      // TimeLocal() del último poll OK (solo display)
int      g_consecutiveFailures = 0;
int      g_currentInterval = 2;      // intervalo vigente en segundos (R5)
string   g_lastHttpError   = "";

string   g_mapFrom[];
string   g_mapTo[];

// Contadores de sesión (R7)
int g_cntRecibidas = 0, g_cntSetups = 0, g_cntDisparos = 0;
int g_cntCancel = 0, g_cntCuarentena = 0, g_cntSymbolGap = 0;

// Último bloque de umbrales recibido, para los gauges del panel
bool   g_thHas = false;
string g_thSymbol = "";
int    g_thSymCount = 0, g_thSymThreshold = 0, g_thGlbCount = 0, g_thGlbThreshold = 0;
bool   g_thExceeded = false;

struct PanelRow
{
   string   id;
   string   action;         // BUY_DUAL / SELL_DUAL / SETUP_BUY / SETUP_SELL / CANCEL_ALL / SETUP_CANCEL
   bool     isSetup;        // ◇ armado (true) vs ◆ disparo (false)
   bool     isCancel;
   string   typeLabel;      // "BUY LIMIT", "SELL STOP", "BUY" …
   string   symbolTv;
   string   symbolBroker;
   string   grade;
   double   impulseAtr;
   double   price, sl, tp1, tp2, lots1, lots2;
   bool     hasThresholds;  // R3: distinguir "sin datos" de "cupo en cero"
   int      symCount, symThreshold, globalCount, globalThreshold;
   bool     exceeded;
   bool     cancelled;      // marcada por una cancelación posterior
   bool     symbolGap;      // sin símbolo operable en el bróker
   bool     quarantined;    // R4
   datetime receivedAt;
};
PanelRow g_rows[];

#define PANEL_PREFIX "PessaroBridge2_"

// ==================== CICLO DE VIDA ====================
int OnInit()
{
   if(StringLen(InpEaToken) == 0)
   {
      Alert("PessaroBridge: falta configurar InpEaToken.");
      return INIT_PARAMETERS_INCORRECT;
   }

   ParseSymbolMap();
   ArrayResize(g_rows, 0);
   g_currentInterval = InpPollActiveSeconds;
   EventSetTimer(1);
   DrawPanel();

   Print("PessaroBridge ", EA_VERSION, ": iniciado en modo despachador manual — solo notifica, no envía órdenes.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   RemoveAllObjects();
}

void OnTick()
{
   // Sin lógica de trading por tick: todo el trabajo ocurre en OnTimer.
}

void OnTimer()
{
   int baseInterval = IsInActiveWindow() ? InpPollActiveSeconds : InpPollIdleSeconds;
   if(baseInterval < 1) baseInterval = 1;

   int interval = baseInterval;
   if(g_consecutiveFailures > 0)
   {
      int mult = (int)MathPow(2.0, MathMin(g_consecutiveFailures, 5)); // cap x32
      interval = (int)MathMin(baseInterval * mult, 300);               // cap 5 min
   }
   g_currentInterval = interval;

   // R6: GetTickCount() avanza siempre, incluso sin ticks del símbolo. La
   // resta en aritmética uint absorbe el desborde cada ~49,7 días.
   uint now = GetTickCount();
   if(g_lastPollTick != 0 && (now - g_lastPollTick) < (uint)(interval * 1000))
   {
      DrawPanel(); // refresca "hace Xs" y el semáforo aunque no toque pollear
      return;
   }

   PollSignals();
}

// ==================== VENTANA OPERATIVA ====================
bool IsInActiveWindow()
{
   int brokerHour = TimeHour(TimeCurrent());
   int nyHour = ((brokerHour + InpBrokerToNyOffsetHours) % 24 + 24) % 24;

   if(InpWindowStartHourNY <= InpWindowEndHourNY)
      return (nyHour >= InpWindowStartHourNY && nyHour < InpWindowEndHourNY);

   return (nyHour >= InpWindowStartHourNY || nyHour < InpWindowEndHourNY); // cruza medianoche
}

// ==================== POLLING Y DESPACHO ====================
bool PollSignals()
{
   string url = InpBridgeBaseUrl + "/api/signals?token=" + InpEaToken
              + "&max=" + IntegerToString(InpMaxSignalsPerPoll);
   string response;

   if(!HttpGet(url, response))
   {
      g_consecutiveFailures++;
      Print("PessaroBridge: fallo de polling (#", g_consecutiveFailures, ") ", g_lastHttpError);
      DrawPanel();
      return false;
   }

   // Sello del poll ANTES de procesar: el heartbeat mide "el puente respondió",
   // no "el despacho terminó" (procesar 20 señales puede tomar segundos).
   g_lastPollTick  = GetTickCount();
   if(g_lastPollTick == 0) g_lastPollTick = 1; // 0 es el centinela de "nunca polleó"
   g_lastPollLocal = TimeLocal();

   if(!JsonBool(response, "ok", false))
   {
      g_consecutiveFailures++;
      g_lastHttpError = "ok=false: " + JsonString(response, "error", "(sin detalle)");
      Print("PessaroBridge: ", g_lastHttpError);
      DrawPanel();
      return false;
   }

   g_consecutiveFailures = 0;
   g_lastHttpError = "";

   string arrayJson = JsonRawValue(response, "signals");
   string objs[];
   int n = JsonSplitArray(arrayJson, objs);

   for(int i = 0; i < n; i++)
      ProcessSignal(objs[i]);

   DrawPanel();
   return true;
}

void ProcessSignal(string obj)
{
   string id     = JsonString(obj, "id", "");
   string action = JsonString(obj, "action", "");

   g_cntRecibidas++;

   // R4 · CUARENTENA — se evalúa antes que nada: una señal que no debería
   // existir no suena, no vibra y no pinta niveles.
   string motivo = QuarantineReason(obj);
   if(StringLen(motivo) > 0)
   {
      g_cntCuarentena++;
      Print("PessaroBridge: señal en CUARENTENA (", motivo, ") id=", id, " action=", action);
      AddQuarantineRow(id, action, JsonString(obj, "symbol", "?"), motivo);
      SendAck(id, "error", "quarantine:" + motivo);
      return;
   }

   if(action == "CANCEL_ALL" || action == "SETUP_CANCEL")
   {
      HandleCancelSignal(obj, action);
      return;
   }

   if(action == "BUY_DUAL" || action == "SELL_DUAL"
      || action == "SETUP_BUY" || action == "SETUP_SELL")
   {
      HandleEntrySignal(obj, action);
      return;
   }

   // Acción no reconocida: se ACKEA de todos modos. El v1.0 solo imprimía y la
   // dejaba 'claimed' hasta que el TTL la mataba como 'expired', lo que en
   // /status era indistinguible de un terminal apagado.
   Print("PessaroBridge: acción desconocida '", action, "' — ackeada como error para no dejarla colgada.");
   SendAck(id, "error", "unknown_action:" + action);
}

/** "" si la señal es legítima; el motivo si debe ir a cuarentena (R4). */
string QuarantineReason(string obj)
{
   if(JsonBool(obj, "is_test", false)) return "is_test";

   string env = JsonString(obj, "env", "production");
   if(env != "production") return "env=" + env;

   string origin = JsonString(obj, "origin", "tradingview");
   if(origin != "tradingview") return "origin=" + origin;

   if(StringLen(InpExpectedAccountId) > 0)
   {
      string acc = JsonString(obj, "account_id", "");
      if(StringLen(acc) > 0 && acc != InpExpectedAccountId)
         return "account_id=" + acc;
   }
   return "";
}

void HandleEntrySignal(string obj, string action)
{
   string id       = JsonString(obj, "id", "");
   string symbolTv = JsonString(obj, "symbol", "");
   string orderType= JsonString(obj, "type", "");   // R1: LIMIT / STOP / MARKET
   string grade    = JsonString(obj, "grade", "");
   double impAtr   = JsonNumber(obj, "impulse_atr", 0);
   double price    = JsonNumber(obj, "price", 0);
   double sl       = JsonNumber(obj, "sl", 0);
   double riskUsd  = JsonNumber(obj, "risk_usd", 0);

   string p1 = JsonRawValue(obj, "partial_1");
   string p2 = JsonRawValue(obj, "partial_2");
   double tp1 = JsonNumber(p1, "tp", 0);
   double tp2 = JsonNumber(p2, "tp", 0);
   // Los "lots" del JSON son referenciales (el indicador los calcula con un
   // pip global). Se ignoran y se recalculan abajo con MarketInfo del símbolo
   // real del bróker.

   bool isSetup = (action == "SETUP_BUY" || action == "SETUP_SELL");
   bool isBuy   = (action == "BUY_DUAL"  || action == "SETUP_BUY");
   if(isSetup) g_cntSetups++; else g_cntDisparos++;

   // R3 · umbrales: anidado primero, plano v1 después, "sin datos" si ninguno.
   int  symCount = 0, symThreshold = 0, globalCount = 0, globalThreshold = 0;
   bool exceeded = false;
   bool hasTh = ReadThresholds(obj, symCount, symThreshold, globalCount, globalThreshold, exceeded);
   if(hasTh)
   {
      g_thHas = true; g_thSymbol = symbolTv;
      g_thSymCount = symCount; g_thSymThreshold = symThreshold;
      g_thGlbCount = globalCount; g_thGlbThreshold = globalThreshold;
      g_thExceeded = exceeded;
   }

   string symbolBroker = ResolveBrokerSymbol(symbolTv);
   bool brokerHasSymbol = (StringLen(symbolBroker) > 0);
   if(!brokerHasSymbol)
   {
      symbolBroker = MapSymbol(symbolTv); // nombre para mostrar, aunque no opere
      g_cntSymbolGap++;
   }

   double lot1 = 0, lot2 = 0;
   double slDistPrice = MathAbs(price - sl);
   if(brokerHasSymbol && slDistPrice > 0 && riskUsd > 0)
   {
      lot1 = CalcLotForLeg(symbolBroker, riskUsd, slDistPrice, 0.60);
      lot2 = CalcLotForLeg(symbolBroker, riskUsd, slDistPrice, 0.40);
   }

   string typeLabel = OrderTypeLabel(isBuy, orderType);
   string summary = BuildEntrySummary(isSetup, typeLabel, symbolBroker, grade, impAtr,
                                       price, sl, tp1, tp2, lot1, lot2,
                                       hasTh, symCount, symThreshold, globalCount, globalThreshold, exceeded);
   if(!brokerHasSymbol)
      summary += " · [SIN SÍMBOLO/MAPEO EN BRÓKER: " + symbolTv + "]";

   if(InpSoundAlert)       Alert(summary);
   if(InpPushNotification) SendNotification(TruncateForPush(summary));

   PanelRow row;
   row.id = id; row.action = action; row.isSetup = isSetup; row.isCancel = false;
   row.typeLabel = typeLabel; row.symbolTv = symbolTv; row.symbolBroker = symbolBroker;
   row.grade = grade; row.impulseAtr = impAtr;
   row.price = price; row.sl = sl; row.tp1 = tp1; row.tp2 = tp2;
   row.lots1 = lot1; row.lots2 = lot2;
   row.hasThresholds = hasTh;
   row.symCount = symCount; row.symThreshold = symThreshold;
   row.globalCount = globalCount; row.globalThreshold = globalThreshold;
   row.exceeded = exceeded; row.cancelled = false;
   row.symbolGap = !brokerHasSymbol; row.quarantined = false;
   row.receivedAt = TimeLocal();
   AddPanelRow(row);

   if(InpDrawChartLines && brokerHasSymbol && Symbol() == symbolBroker)
      DrawLevelLines(id, price, sl, tp1, tp2);

   // ---- Punto de extensión futuro (no implementado) ----
   // Un eventual "modo auto" activable explícitamente iría aquí, como módulo
   // separado y opt-in, después de la notificación. Este EA no toca órdenes.

   if(!brokerHasSymbol)
      SendAck(id, "error", "symbol_gap:" + symbolTv);
   else
      SendAck(id, "notified", "");
}

void HandleCancelSignal(string obj, string action)
{
   string id       = JsonString(obj, "id", "");
   string symbolTv = JsonString(obj, "symbol", "");
   string symbolBroker = ResolveBrokerSymbol(symbolTv);
   if(StringLen(symbolBroker) == 0) symbolBroker = MapSymbol(symbolTv);

   g_cntCancel++;

   // Solo se marca como cancelada una fila que este EA mostró antes. Si no hay
   // ninguna, se dice de forma explícita: el bridge ya suprime las parejas
   // efímeras (migración 016), así que una cancelación huérfana que llegue
   // hasta aquí significa que su armado murió por TTL o que el terminal estuvo
   // apagado — y eso el operador tiene que poder verlo, no que se lo escondan.
   bool teniaFila = MarkCancelledInPanel(symbolBroker);

   string msg = teniaFila
      ? ("CANCELADA " + symbolBroker + " — retira la pendiente que te avisamos")
      : ("CANCELADA " + symbolBroker + " — no te habíamos notificado su armado (revisa /status)");

   if(InpSoundAlert)       Alert(msg);
   if(InpPushNotification) SendNotification(TruncateForPush(msg));

   PanelRow row;
   row.id = id; row.action = action; row.isSetup = false; row.isCancel = true;
   row.typeLabel = "CANCEL"; row.symbolTv = symbolTv; row.symbolBroker = symbolBroker;
   row.grade = ""; row.impulseAtr = 0;
   row.price = 0; row.sl = 0; row.tp1 = 0; row.tp2 = 0; row.lots1 = 0; row.lots2 = 0;
   row.hasThresholds = false;
   row.symCount = 0; row.symThreshold = 0; row.globalCount = 0; row.globalThreshold = 0;
   row.exceeded = false; row.cancelled = true; row.symbolGap = false; row.quarantined = false;
   row.receivedAt = TimeLocal();
   AddPanelRow(row);

   RemoveLevelLines(symbolBroker);
   SendAck(id, "notified", teniaFila ? "" : "cancel_sin_armado_previo");
}

void AddQuarantineRow(string id, string action, string symbol, string motivo)
{
   PanelRow row;
   row.id = id; row.action = action; row.isSetup = false; row.isCancel = false;
   row.typeLabel = "CUARENTENA:" + motivo;
   row.symbolTv = symbol; row.symbolBroker = symbol;
   row.grade = ""; row.impulseAtr = 0;
   row.price = 0; row.sl = 0; row.tp1 = 0; row.tp2 = 0; row.lots1 = 0; row.lots2 = 0;
   row.hasThresholds = false;
   row.symCount = 0; row.symThreshold = 0; row.globalCount = 0; row.globalThreshold = 0;
   row.exceeded = false; row.cancelled = false; row.symbolGap = false; row.quarantined = true;
   row.receivedAt = TimeLocal();
   AddPanelRow(row);
}

// ==================== R1 · TIPO DE ORDEN ====================
// El contrato transporta la dirección en `action` y el tipo en `type`. El v1.0
// leía solo el primero y perdía el segundo; esta función es el arreglo.
string OrderTypeLabel(bool isBuy, string orderType)
{
   string dir = isBuy ? "BUY" : "SELL";
   string t = orderType;
   StringToUpper(t);

   if(t == "LIMIT")  return dir + " LIMIT";
   if(t == "STOP")   return dir + " STOP";
   if(t == "MARKET") return dir + " (mercado)";
   if(StringLen(t) == 0) return dir;   // contrato v1.x sin `type`
   return dir + " " + t;               // tipo nuevo desconocido: se muestra tal cual
}

// ==================== R3 · UMBRALES ====================
// true solo si se pudieron leer los CINCO valores. Si el bridge omitió el
// bloque (regla dura del §3.2: obligatorio o ausente, jamás con ceros), se
// devuelve false y el panel escribe "s/d".
bool ReadThresholds(string obj, int &symCount, int &symThreshold,
                    int &globalCount, int &globalThreshold, bool &exceeded)
{
   string th = JsonRawValue(obj, "thresholds");
   if(StringLen(th) > 0
      && JsonHasKey(th, "symbol_count") && JsonHasKey(th, "symbol_threshold")
      && JsonHasKey(th, "global_count") && JsonHasKey(th, "global_threshold"))
   {
      symCount        = (int)JsonNumber(th, "symbol_count", 0);
      symThreshold    = (int)JsonNumber(th, "symbol_threshold", 0);
      globalCount     = (int)JsonNumber(th, "global_count", 0);
      globalThreshold = (int)JsonNumber(th, "global_threshold", 0);
      exceeded        = JsonBool(th, "exceeded", false);
      return true;
   }

   // Fallback al contrato plano v1 (mismos valores autoritativos, campos sueltos).
   if(JsonHasKey(obj, "current_symbol_count") && JsonHasKey(obj, "symbol_threshold")
      && JsonHasKey(obj, "current_global_count") && JsonHasKey(obj, "global_threshold"))
   {
      symCount        = (int)JsonNumber(obj, "current_symbol_count", 0);
      symThreshold    = (int)JsonNumber(obj, "symbol_threshold", 0);
      globalCount     = (int)JsonNumber(obj, "current_global_count", 0);
      globalThreshold = (int)JsonNumber(obj, "global_threshold", 0);
      exceeded        = JsonBool(obj, "threshold_exceeded", false);
      return true;
   }

   symCount = 0; symThreshold = 0; globalCount = 0; globalThreshold = 0; exceeded = false;
   return false;
}

// ==================== TEXTO DE ALERTA Y PUSH ====================
string BuildEntrySummary(bool isSetup, string typeLabel, string symbolBroker, string grade,
                          double impAtr, double price, double sl, double tp1, double tp2,
                          double lot1, double lot2, bool hasTh,
                          int symCount, int symThreshold, int globalCount, int globalThreshold,
                          bool exceeded)
{
   int dg = SymbolDigitsOrDefault(symbolBroker);

   string prefijo = exceeded ? "⚠ " : "";
   // ◇ armado (hay pendiente colocable) · ◆ disparo (el precio tocó el nivel)
   prefijo += isSetup ? "◇ ARMADO " : "◆ DISPARO ";

   string calidad = "";
   if(grade == "ELITE")         calidad = "★ELITE ";
   else if(grade == "STANDARD") calidad = "STANDARD ";
   if(impAtr > 0) calidad += StringFormat("%.2f×ATR ", impAtr);

   string cupo = hasTh
      ? StringFormat("%d/%d símbolo · %d/%d cartera", symCount, symThreshold, globalCount, globalThreshold)
      : "cupo s/d";

   return StringFormat("%s%s %s · %s@ %s · SL %s · TP %s/%s · lotes %s/%s · %s",
                        prefijo, typeLabel, symbolBroker, calidad,
                        DoubleToStr(price, dg), DoubleToStr(sl, dg),
                        DoubleToStr(tp1, dg), DoubleToStr(tp2, dg),
                        DoubleToStr(lot1, 2), DoubleToStr(lot2, 2), cupo);
}

string TruncateForPush(string msg)
{
   // SendNotification() falla silenciosamente sobre ~255 caracteres.
   if(StringLen(msg) > 250) return StringSubstr(msg, 0, 247) + "...";
   return msg;
}

// ==================== LOTE SUGERIDO (solo visual, no se ejecuta) ====================
int SymbolDigitsOrDefault(string sym)
{
   int d = (int)MarketInfo(sym, MODE_DIGITS);
   return (d > 0 ? d : 5);
}

double PipSize(string sym)
{
   double point = MarketInfo(sym, MODE_POINT);
   int digits = (int)MarketInfo(sym, MODE_DIGITS);
   if(digits == 3 || digits == 5) return point * 10; // dígito fraccionario extra
   return point;
}

double CalcLotForLeg(string sym, double riskUsd, double slDistancePrice, double splitFraction)
{
   double pip = PipSize(sym);
   if(pip <= 0) return 0;

   double slDistPips = slDistancePrice / pip;
   if(slDistPips <= 0) return 0;

   double tickValue = MarketInfo(sym, MODE_TICKVALUE);
   double tickSize  = MarketInfo(sym, MODE_TICKSIZE);
   if(tickValue <= 0 || tickSize <= 0) return 0;

   double pipValuePerLot = tickValue * (pip / tickSize);
   if(pipValuePerLot <= 0) return 0;

   double rawLot = (riskUsd * splitFraction) / (slDistPips * pipValuePerLot);

   double minLot  = MarketInfo(sym, MODE_MINLOT);
   double lotStep = MarketInfo(sym, MODE_LOTSTEP);
   double maxLot  = MarketInfo(sym, MODE_MAXLOT);
   if(lotStep <= 0) lotStep = 0.01;

   double steppedLot = MathFloor(rawLot / lotStep) * lotStep;
   if(steppedLot < minLot) steppedLot = minLot;
   if(maxLot > 0 && steppedLot > maxLot) steppedLot = maxLot;

   return NormalizeDouble(steppedLot, 2);
}

// ==================== MAPEO DE SÍMBOLOS TV→BRÓKER ====================
void ParseSymbolMap()
{
   ArrayResize(g_mapFrom, 0);
   ArrayResize(g_mapTo, 0);
   if(StringLen(InpSymbolMap) == 0) return;

   string pairs[];
   int n = StringSplit(InpSymbolMap, ',', pairs);
   for(int i = 0; i < n; i++)
   {
      string pair = pairs[i];
      int eq = StringFind(pair, "=");
      if(eq < 0) continue;

      string from = StringSubstr(pair, 0, eq);
      string to   = StringSubstr(pair, eq + 1);
      StringTrimLeft(from);  StringTrimRight(from);
      StringTrimLeft(to);    StringTrimRight(to);
      if(StringLen(from) == 0 || StringLen(to) == 0) continue;

      int sz = ArraySize(g_mapFrom);
      ArrayResize(g_mapFrom, sz + 1);
      ArrayResize(g_mapTo, sz + 1);
      g_mapFrom[sz] = from;
      g_mapTo[sz] = to;
   }
}

string MapSymbol(string tvSymbol)
{
   for(int i = 0; i < ArraySize(g_mapFrom); i++)
      if(g_mapFrom[i] == tvSymbol) return g_mapTo[i];
   return tvSymbol;
}

bool SymbolIsTradable(string sym)
{
   if(StringLen(sym) == 0) return false;
   if(!SymbolSelect(sym, true)) return false;
   return (MarketInfo(sym, MODE_BID) > 0);
}

/**
 * Nombre operable en este bróker, o "" si no hay ninguno.
 *
 * El mapeo explícito manda siempre. Si está vacío, se prueban los sufijos
 * habituales antes de rendirse: 11 de las 171 señales de la auditoría se
 * perdieron por un símbolo que existía en el bróker con sufijo (EURJPYm) y
 * cuyo mapeo nadie había rellenado.
 */
string ResolveBrokerSymbol(string tvSymbol)
{
   string mapped = MapSymbol(tvSymbol);
   if(SymbolIsTradable(mapped)) return mapped;

   // Si había mapeo explícito y no funciona, es un error de configuración que
   // no se debe tapar adivinando sobre el nombre de TradingView.
   if(mapped != tvSymbol) return "";
   if(!InpProbeSymbolSuffixes) return "";

   string suffixes[] = {"m", "M", ".r", "_i", "micro", ".a", ".p", "-ECN", "pro", "c"};
   for(int i = 0; i < ArraySize(suffixes); i++)
   {
      string candidate = tvSymbol + suffixes[i];
      if(SymbolIsTradable(candidate))
      {
         Print("PessaroBridge: ", tvSymbol, " resuelto por sufijo → ", candidate,
               ". Conviene fijarlo en InpSymbolMap para no depender del sondeo.");
         return candidate;
      }
   }
   return "";
}

// ==================== PANEL ====================
void AddPanelRow(PanelRow &row)
{
   int sz = ArraySize(g_rows);
   ArrayResize(g_rows, sz + 1);
   for(int i = sz; i > 0; i--) g_rows[i] = g_rows[i - 1];
   g_rows[0] = row;

   if(ArraySize(g_rows) > InpPanelMaxRows) ArrayResize(g_rows, InpPanelMaxRows);
   DrawPanel();
}

/** true si había al menos una fila viva de ese símbolo a la que marcar. */
bool MarkCancelledInPanel(string symbolBroker)
{
   bool encontrada = false;
   for(int i = 0; i < ArraySize(g_rows); i++)
   {
      if(g_rows[i].symbolBroker == symbolBroker && !g_rows[i].isCancel
         && !g_rows[i].quarantined && !g_rows[i].cancelled)
      {
         g_rows[i].cancelled = true;
         encontrada = true;
      }
   }
   return encontrada;
}

void RemoveAllObjects()
{
   for(int i = ObjectsTotal() - 1; i >= 0; i--)
   {
      string name = ObjectName(i);
      if(StringFind(name, PANEL_PREFIX) == 0) ObjectDelete(name);
   }
}

/**
 * Etiquetas de fila que sobran tras encoger la lista.
 *
 * DrawPanel corre una vez por segundo. El v1.0 borraba TODOS los objetos y los
 * recreaba en cada pasada, lo que en MT4 produce un parpadeo permanente del
 * panel. Aquí las etiquetas se reutilizan (CreateLabel actualiza si ya existe)
 * y solo se borra el excedente.
 */
void PurgeExtraRowLabels(int rowsDrawn)
{
   for(int i = rowsDrawn; i < InpPanelMaxRows + 2; i++)
      ObjectDelete(PANEL_PREFIX + "row" + IntegerToString(i));
   if(rowsDrawn > 0) ObjectDelete(PANEL_PREFIX + "row_empty");
}

void CreateLabel(string name, string text, int x, int y, color clr, int fontSize, string font = "Consolas")
{
   if(ObjectFind(name) < 0)
   {
      ObjectCreate(name, OBJ_LABEL, 0, 0, 0);
      ObjectSet(name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSet(name, OBJPROP_SELECTABLE, false);
   }
   ObjectSet(name, OBJPROP_XDISTANCE, x);
   ObjectSet(name, OBJPROP_YDISTANCE, y);
   ObjectSetText(name, text, fontSize, font, clr);
}

// Las propiedades de OBJ_RECTANGLE_LABEL (XSIZE/YSIZE/BGCOLOR/BORDER_TYPE) son
// de la API moderna: se fijan con ObjectSetInteger, no con el ObjectSet clásico.
//
// El fondo se crea ANTES que las etiquetas y se DIMENSIONA DESPUÉS, en dos
// pasos. En MT4 los objetos del mismo plano se dibujan en orden de creación, así
// que el rectángulo tiene que nacer primero o taparía el texto; pero su alto
// real solo se conoce cuando ya se pintaron todas las filas, que son variables
// (0 a InpPanelMaxRows) y además dependen de si hay datos de cupo. Calcularlo
// por adelantado con una constante es justo lo que estaba mal: se quedaba ~80 px
// corto y la franja inferior caía fuera del recuadro.
void EnsureBackground(int x, int y, int w)
{
   string name = PANEL_PREFIX + "bg";
   if(ObjectFind(name) < 0)
   {
      ObjectCreate(0, name, OBJ_RECTANGLE_LABEL, 0, 0, 0);
      ObjectSetInteger(0, name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSetInteger(0, name, OBJPROP_SELECTABLE, false);
      ObjectSetInteger(0, name, OBJPROP_BACK, false);
      ObjectSetInteger(0, name, OBJPROP_BORDER_TYPE, BORDER_FLAT);
      ObjectSetInteger(0, name, OBJPROP_BGCOLOR, InpColorPanelBg);
      ObjectSetInteger(0, name, OBJPROP_COLOR, InpColorGold);
   }
   ObjectSetInteger(0, name, OBJPROP_XDISTANCE, x);
   ObjectSetInteger(0, name, OBJPROP_YDISTANCE, y);
   ObjectSetInteger(0, name, OBJPROP_XSIZE, w);
}

void SizeBackground(int height)
{
   ObjectSetInteger(0, PANEL_PREFIX + "bg", OBJPROP_YSIZE, height);
}

string Gauge(int count, int threshold, int width)
{
   if(threshold <= 0) return "s/d";
   int filled = (int)MathRound((double)count / threshold * width);
   if(filled < 0) filled = 0;
   if(filled > width) filled = width;

   string bar = "";
   for(int i = 0; i < filled; i++)       bar += "█";
   for(int i = filled; i < width; i++)   bar += "░";
   return bar;
}

/** Segundos desde el último poll OK, medidos con el reloj que sí avanza (R6). */
int SecondsSinceLastPoll()
{
   if(g_lastPollTick == 0) return -1;
   return (int)((GetTickCount() - g_lastPollTick) / 1000);
}

void DrawPanel()
{
   if(!InpPanelEnabled) return;

   int x = InpPanelX, y = InpPanelY, lh = 15;
   int rows = ArraySize(g_rows);
   int yTop = y - 6;
   EnsureBackground(x - 6, yTop, 780);

   // ---- Cabecera ----
   int since = SecondsSinceLastPoll();
   // R5: fuera de ventana el intervalo es de 30 s y con backoff llega a 300 s.
   // Un umbral fijo de 10 s marcaba OFFLINE con el puente sano.
   int tolerance = g_currentInterval * 2 + 5;
   bool online = (since >= 0 && since <= tolerance);

   CreateLabel(PANEL_PREFIX + "title", "⬥ PESSARO BRIDGE · DESPACHADOR MANUAL", x, y, InpColorGold, 11, "Arial Black");
   CreateLabel(PANEL_PREFIX + "titlestate",
               (online ? "● ONLINE  " : "○ OFFLINE  ") + EA_VERSION,
               x + 520, y, online ? InpColorBuy : InpColorSell, 10, "Arial Black");
   y += lh + 6;

   // ---- Estado del puente ----
   CreateLabel(PANEL_PREFIX + "s0", "──── ESTADO DEL PUENTE ────", x, y, InpColorMuted, 8); y += lh;
   CreateLabel(PANEL_PREFIX + "s1",
               StringFormat("Ventana:      %s · poll %ds",
                            IsInActiveWindow() ? "LON→NY ACTIVA" : "fuera de ventana",
                            g_currentInterval),
               x, y, InpColorText, 8); y += lh;
   CreateLabel(PANEL_PREFIX + "s2",
               StringFormat("Último poll:  %s%s",
                            (g_lastPollLocal > 0 ? TimeToString(g_lastPollLocal, TIME_SECONDS) : "—"),
                            (since >= 0 ? StringFormat("   (hace %ds, tolerancia %ds)", since, tolerance) : "")),
               x, y, InpColorText, 8); y += lh;
   CreateLabel(PANEL_PREFIX + "s3",
               StringFormat("Fallos:       %d%s", g_consecutiveFailures,
                            (StringLen(g_lastHttpError) > 0 ? "  · " + g_lastHttpError : "")),
               x, y, g_consecutiveFailures > 0 ? InpColorWarning : InpColorText, 8); y += lh;
   CreateLabel(PANEL_PREFIX + "s4", "Modo:         DESPACHADOR MANUAL · cero OrderSend", x, y, InpColorMuted, 8);
   y += lh + 4;

   // ---- Umbrales (informativos, jamás bloquean) ----
   CreateLabel(PANEL_PREFIX + "u0", "──── UMBRALES DE CONTROL MANUAL ────", x, y, InpColorMuted, 8); y += lh;
   if(g_thHas)
   {
      CreateLabel(PANEL_PREFIX + "u1",
                  StringFormat("SÍMBOLO %-10s %s  %d/%d", g_thSymbol,
                               Gauge(g_thSymCount, g_thSymThreshold, 12), g_thSymCount, g_thSymThreshold),
                  x, y, g_thExceeded ? InpColorWarning : InpColorText, 8); y += lh;
      CreateLabel(PANEL_PREFIX + "u2",
                  StringFormat("CARTERA           %s  %d/%d",
                               Gauge(g_thGlbCount, g_thGlbThreshold, 12), g_thGlbCount, g_thGlbThreshold),
                  x, y, g_thExceeded ? InpColorWarning : InpColorText, 8); y += lh;
      CreateLabel(PANEL_PREFIX + "u3",
                  g_thExceeded ? "⚠ Umbral alcanzado — advertencia, la señal se entrega igual"
                               : "✓ Dentro de los umbrales configurados",
                  x, y, g_thExceeded ? InpColorWarning : InpColorBuy, 8); y += lh + 4;
   }
   else
   {
      // R3: sin datos NO es cupo en cero. El v1.0 pintaba "0/0" y el operador
      // no podía distinguir "no he operado" de "el contrato llegó incompleto".
      CreateLabel(PANEL_PREFIX + "u1", "Sin datos de cupo todavía (el bridge los envía con cada señal)",
                  x, y, InpColorMuted, 8); y += lh + 4;
   }

   // ---- Contadores de sesión ----
   CreateLabel(PANEL_PREFIX + "f0", "──── FLUJO DE SEÑALES · SESIÓN ────", x, y, InpColorMuted, 8); y += lh;
   CreateLabel(PANEL_PREFIX + "f1",
               StringFormat("Recibidas %-4d Armados %-4d Disparos %-4d Cancel. %-4d",
                            g_cntRecibidas, g_cntSetups, g_cntDisparos, g_cntCancel),
               x, y, InpColorText, 8); y += lh;
   CreateLabel(PANEL_PREFIX + "f2",
               StringFormat("Cuarentena %-4d Symbol-gap %-4d", g_cntCuarentena, g_cntSymbolGap),
               x, y, (g_cntCuarentena > 0 || g_cntSymbolGap > 0) ? InpColorWarning : InpColorMuted, 8);
   y += lh + 4;

   // ---- Últimos eventos ----
   CreateLabel(PANEL_PREFIX + "e0", "──── ÚLTIMOS EVENTOS ────", x, y, InpColorMuted, 8); y += lh;
   CreateLabel(PANEL_PREFIX + "head",
               StringFormat("%-5s %-12s %-10s %-9s %10s %10s %19s %11s %s",
                            "HORA", "ORDEN", "SÍMBOLO", "CALIDAD", "ENTRADA", "SL",
                            "TP1/TP2", "LOTES", "CUPO"),
               x, y, InpColorMuted, 8);
   y += lh;

   if(rows == 0)
   {
      CreateLabel(PANEL_PREFIX + "row_empty", "(sin señales en esta sesión)", x, y, InpColorMuted, 8);
      y += lh;
   }

   for(int i = 0; i < rows; i++)
   {
      CreateLabel(PANEL_PREFIX + "row" + IntegerToString(i), FormatRow(g_rows[i]), x, y, RowColor(g_rows[i]), 8);
      y += lh;
   }
   PurgeExtraRowLabels(rows);

   // ---- Franja inferior ----
   CreateLabel(PANEL_PREFIX + "foot",
               "Este EA solo notifica · ◇ armado = pendiente colocable · ◆ disparo = el precio ya tocó el nivel",
               x, y + 4, InpColorGold, 7);

   // Ahora sí se conoce el alto real: hasta la franja inferior más su margen.
   SizeBackground((y + 4 + 12) - yTop + 6);

   // Sin esto el panel queda congelado justo en el escenario que motivó el R6:
   // MT4 repinta los objetos cuando llega un evento del gráfico, y en un símbolo
   // que no cotiza (fin de semana, instrumento ilíquido, feriado del bróker) no
   // llega ninguno. El polling avanzaría por GetTickCount() y el trader seguiría
   // viendo el estado de hace horas, que es peor que verlo OFFLINE.
   ChartRedraw();
}

string FormatRow(PanelRow &r)
{
   string hora = TimeToString(r.receivedAt, TIME_MINUTES);

   if(r.quarantined)
      return StringFormat("%-5s %-12s %-10s  descartada, no se notificó", hora, "CUARENTENA", r.symbolBroker)
             + " · " + r.typeLabel;

   if(r.isCancel)
      return StringFormat("%-5s %-12s %-10s  retira la pendiente", hora, "CANCEL", r.symbolBroker);

   int dg = SymbolDigitsOrDefault(r.symbolBroker);
   string marca = r.isSetup ? "◇ " : "◆ ";
   string calidad = (r.grade == "ELITE") ? "★ELITE" : r.grade;
   if(r.impulseAtr > 0) calidad = StringFormat("%s %.2fx", calidad, r.impulseAtr);

   string cupo = r.hasThresholds
      ? StringFormat("%d/%d · %d/%d", r.symCount, r.symThreshold, r.globalCount, r.globalThreshold)
      : "s/d";

   string line = StringFormat("%-5s %s%-10s %-10s %-9s %10s %10s %9s/%-9s %5s/%-5s %s",
                              hora, marca, r.typeLabel, r.symbolBroker, calidad,
                              DoubleToStr(r.price, dg), DoubleToStr(r.sl, dg),
                              DoubleToStr(r.tp1, dg), DoubleToStr(r.tp2, dg),
                              DoubleToStr(r.lots1, 2), DoubleToStr(r.lots2, 2), cupo);

   if(r.exceeded)  line = "⚠" + line;
   if(r.symbolGap) line += " [SIN SÍMBOLO EN BRÓKER]";
   if(r.cancelled) line += " [CANCELADA]";
   return line;
}

color RowColor(PanelRow &r)
{
   if(r.quarantined) return InpColorMuted;
   if(r.cancelled)   return InpColorMuted;
   if(r.exceeded)    return InpColorWarning;

   bool isBuy = (r.action == "BUY_DUAL" || r.action == "SETUP_BUY");
   return isBuy ? InpColorBuy : InpColorSell;
}

// ==================== LÍNEAS DE NIVEL ====================
void DrawHLine(string name, double price, color clr)
{
   if(price <= 0) return;
   if(ObjectFind(name) < 0) ObjectCreate(name, OBJ_HLINE, 0, 0, price);
   ObjectSet(name, OBJPROP_PRICE1, price);
   ObjectSet(name, OBJPROP_COLOR, clr);
   ObjectSet(name, OBJPROP_STYLE, STYLE_DASH);
   ObjectSet(name, OBJPROP_SELECTABLE, false);
}

void DrawLevelLines(string id, double price, double sl, double tp1, double tp2)
{
   string prefix = PANEL_PREFIX + "lvl_" + id + "_";
   DrawHLine(prefix + "entry", price, InpColorGold);
   DrawHLine(prefix + "sl",    sl,    InpColorSell);
   DrawHLine(prefix + "tp1",   tp1,   InpColorBuy);
   DrawHLine(prefix + "tp2",   tp2,   InpColorBuy);
}

/** Las líneas de una señal cancelada se retiran: dejarlas invita a operar algo retirado. */
void RemoveLevelLines(string symbolBroker)
{
   if(Symbol() != symbolBroker) return;
   for(int i = ObjectsTotal() - 1; i >= 0; i--)
   {
      string name = ObjectName(i);
      if(StringFind(name, PANEL_PREFIX + "lvl_") == 0) ObjectDelete(name);
   }
}

// ==================== CLIENTE HTTP (WebRequest) ====================
bool HttpGet(string url, string &responseOut)
{
   string headers = "";
   char postData[];
   char result[];
   string resultHeaders;

   ResetLastError();
   int res = WebRequest("GET", url, headers, 5000, postData, result, resultHeaders);
   if(res == -1)
   {
      int err = GetLastError();
      g_lastHttpError = "WebRequest err " + IntegerToString(err)
                      + (err == 4060 ? " (URL no permitida en Opciones > Expert Advisors)" : "");
      return false;
   }
   if(res != 200)
   {
      g_lastHttpError = "HTTP " + IntegerToString(res);
      if(res == 401) g_lastHttpError += " (token inválido)";
      if(res == 403) g_lastHttpError += " (token caducado o revocado)";
      return false;
   }

   responseOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return true;
}

bool HttpPostJson(string url, string body, string &responseOut)
{
   string headers = "Content-Type: application/json\r\n";
   char postData[];
   StringToCharArray(body, postData, 0, WHOLE_ARRAY, CP_UTF8);
   int len = ArraySize(postData);
   if(len > 0) ArrayResize(postData, len - 1); // StringToCharArray agrega \0; WebRequest no lo espera

   char result[];
   string resultHeaders;

   ResetLastError();
   int res = WebRequest("POST", url, headers, 5000, postData, result, resultHeaders);
   if(res == -1)
   {
      Print("PessaroBridge: WebRequest POST error ", GetLastError());
      return false;
   }

   responseOut = CharArrayToString(result, 0, WHOLE_ARRAY, CP_UTF8);
   return (res == 200);
}

void SendAck(string id, string status, string errMsg)
{
   if(StringLen(id) == 0) return;

   string url = InpBridgeBaseUrl + "/api/ack?token=" + InpEaToken;
   string body = "{\"id\":\"" + id + "\",\"status\":\"" + status + "\"";
   if(StringLen(errMsg) > 0) body += ",\"error\":\"" + JsonEscape(errMsg) + "\"";
   body += "}";

   string response;
   if(!HttpPostJson(url, body, response))
      Print("PessaroBridge: fallo enviando ack para señal ", id);
}

string JsonEscape(string s)
{
   string r = s;
   StringReplace(r, "\\", "\\\\");
   StringReplace(r, "\"", "\\\"");
   return r;
}

// ==================== UTILIDADES JSON (parser dirigido al contrato) ====================
// No es un parser JSON genérico: está acotado a la forma fija de los payloads
// del bridge (objeto plano + partial_1 / partial_2 / thresholds anidados un
// nivel). Suficiente y verificable para este contrato cerrado.

string JsonRawValue(string json, string key)
{
   string pattern = "\"" + key + "\"";
   int keyPos = StringFind(json, pattern, 0);
   if(keyPos < 0) return "";

   int colonPos = StringFind(json, ":", keyPos + StringLen(pattern));
   if(colonPos < 0) return "";

   int len = StringLen(json);
   int p = colonPos + 1;
   while(p < len)
   {
      ushort c = StringGetCharacter(json, p);
      if(c == ' ' || c == '\n' || c == '\r' || c == '\t') { p++; continue; }
      break;
   }
   if(p >= len) return "";

   ushort c = StringGetCharacter(json, p);
   int start = p;

   if(c == '"')
   {
      p++;
      while(p < len)
      {
         ushort cc = StringGetCharacter(json, p);
         if(cc == '\\') { p += 2; continue; }
         if(cc == '"') { p++; break; }
         p++;
      }
      return StringSubstr(json, start + 1, p - start - 2);
   }

   if(c == '{' || c == '[')
   {
      ushort openC = c;
      ushort closeC = (c == '{') ? '}' : ']';
      int depth = 0;
      while(p < len)
      {
         ushort cc = StringGetCharacter(json, p);
         if(cc == '"')
         {
            p++;
            while(p < len)
            {
               ushort sc = StringGetCharacter(json, p);
               if(sc == '\\') { p += 2; continue; }
               if(sc == '"') { p++; break; }
               p++;
            }
            continue;
         }
         if(cc == openC) { depth++; p++; continue; }
         if(cc == closeC) { depth--; p++; if(depth == 0) break; continue; }
         p++;
      }
      return StringSubstr(json, start, p - start);
   }

   // número / booleano / null
   while(p < len)
   {
      ushort cc = StringGetCharacter(json, p);
      if(cc == ',' || cc == '}' || cc == ']') break;
      p++;
   }
   string raw = StringSubstr(json, start, p - start);
   StringTrimLeft(raw);
   StringTrimRight(raw);
   return raw;
}

/**
 * Presencia REAL de la clave, no "valor no vacío".
 *
 * Es la diferencia entre "el bridge dice que llevas 0 señales" y "el bridge no
 * mandó el dato": JsonNumber(...,0) colapsa los dos casos en un cero y ese
 * colapso es justamente el defecto 4 (paneles con 0/0). El contrato prohíbe
 * emitir el bloque de umbrales a medias, así que aquí se comprueba la clave.
 */
bool JsonHasKey(string json, string key)
{
   string pattern = "\"" + key + "\"";
   int keyPos = StringFind(json, pattern, 0);
   if(keyPos < 0) return false;

   int colonPos = StringFind(json, ":", keyPos + StringLen(pattern));
   if(colonPos < 0) return false;

   string v = JsonRawValue(json, key);
   return (StringLen(v) > 0 && v != "null");
}

double JsonNumber(string json, string key, double def = 0)
{
   string v = JsonRawValue(json, key);
   if(StringLen(v) == 0 || v == "null") return def;
   return StringToDouble(v);
}

string JsonString(string json, string key, string def = "")
{
   string v = JsonRawValue(json, key);
   if(StringLen(v) == 0 || v == "null") return def;
   return v;
}

bool JsonBool(string json, string key, bool def = false)
{
   string v = JsonRawValue(json, key);
   if(v == "true") return true;
   if(v == "false") return false;
   return def;
}

int JsonSplitArray(string arrayJson, string &out[])
{
   ArrayResize(out, 0);
   int len = StringLen(arrayJson);
   int p = 0;
   while(p < len && StringGetCharacter(arrayJson, p) != '[') p++;
   p++;

   int count = 0;
   while(p < len)
   {
      while(p < len)
      {
         ushort c = StringGetCharacter(arrayJson, p);
         if(c == ' ' || c == '\n' || c == '\r' || c == '\t' || c == ',') { p++; continue; }
         break;
      }
      if(p >= len) break;

      ushort c = StringGetCharacter(arrayJson, p);
      if(c == ']') break;

      if(c == '{')
      {
         int start = p;
         int depth = 0;
         while(p < len)
         {
            ushort cc = StringGetCharacter(arrayJson, p);
            if(cc == '"')
            {
               p++;
               while(p < len)
               {
                  ushort sc = StringGetCharacter(arrayJson, p);
                  if(sc == '\\') { p += 2; continue; }
                  if(sc == '"') { p++; break; }
                  p++;
               }
               continue;
            }
            if(cc == '{') { depth++; p++; continue; }
            if(cc == '}') { depth--; p++; if(depth == 0) break; continue; }
            p++;
         }
         ArrayResize(out, count + 1);
         out[count] = StringSubstr(arrayJson, start, p - start);
         count++;
         continue;
      }
      p++;
   }
   return count;
}
