//+------------------------------------------------------------------+
//|                                          PessaroBridgeEA.mq4      |
//|                                              Pessaro Capital      |
//+------------------------------------------------------------------+
// Pessaro Bridge · MODO DESPACHADOR MANUAL
//
// Este EA NO opera. Hace polling de GET /api/signals, y por cada señal
// recibida NOTIFICA al trader por tres canales (sonido, push, panel en el
// gráfico) con los niveles y el lote sugerido recalculado. La decisión de
// ejecutar cada operación es manual y humana.
//
// Prohibido en el flujo de señales: envío, modificación o cancelación
// automática de órdenes. Si en el futuro se activa un "modo auto", debe
// implementarse como módulo explícito y separado sobre esta misma base
// (cola, conteo y auditoría no cambian) — no está implementado aquí.
//
// Configuración requerida en el terminal:
//  1) Herramientas > Opciones > Expert Advisors > "Permitir WebRequest para
//     las URL siguientes" → agregar la URL de InpBridgeBaseUrl.
//  2) Terminal > Opciones > Notificaciones → configurar MetaQuotes ID para
//     que SendNotification() llegue al móvil.
//  3) InpBrokerToNyOffsetHours: MT4 no tiene base de datos de zonas
//     horarias. Ajustar manualmente cuántas horas sumar a la hora del
//     servidor del bróker para obtener la hora de Nueva York (revisar 2
//     veces al año por el cambio de horario DST).
//+------------------------------------------------------------------+
#property copyright "Pessaro Capital"
#property version   "1.00"
#property strict

// ==================== INPUTS ====================
input string InpBridgeBaseUrl         = "https://brige.pessaro.cl"; // dominio del bridge
input string InpEaToken                = "";     // EA_TOKEN (mismo valor configurado en Vercel)
input int    InpPollActiveSeconds      = 2;       // polling dentro de la ventana LON→NY
input int    InpPollIdleSeconds        = 30;      // polling fuera de la ventana
input int    InpMaxSignalsPerPoll      = 20;
input int    InpWindowStartHourNY      = 3;       // 03:00 NY
input int    InpWindowEndHourNY        = 16;      // 16:00 NY
input int    InpBrokerToNyOffsetHours  = -7;      // horas a sumar a la hora del servidor para obtener NY (ajustar por DST)
input string InpSymbolMap              = "";      // "XAUUSD=GOLD,US500=SPX500,EURJPY=EURJPYm"
input bool   InpSoundAlert             = true;
input bool   InpPushNotification       = true;
input bool   InpPanelEnabled           = true;
input int    InpPanelMaxRows           = 12;
input bool   InpDrawChartLines         = false;   // dibuja ENTRADA/SL/TP si el símbolo está abierto en este gráfico
input color  InpPanelColorBuy          = clrLimeGreen;
input color  InpPanelColorSell         = clrTomato;
input color  InpPanelColorWarning      = clrGold;
input color  InpPanelColorCancelled    = clrGray;

// ==================== ESTADO GLOBAL ====================
datetime g_lastPollAt          = 0;
int      g_consecutiveFailures = 0;
string   g_mapFrom[];
string   g_mapTo[];

struct PanelRow
{
   string   id;
   string   action;          // BUY_DUAL / SELL_DUAL / CANCEL_ALL
   string   symbolTv;
   string   symbolBroker;
   string   grade;
   double   price, sl, tp1, tp2, lots1, lots2;
   int      symCount, symThreshold, globalCount, globalThreshold;
   bool     exceeded;
   bool     cancelled;
   bool     symbolGap;       // true si no hay símbolo operable en el bróker
   datetime receivedAt;
};
PanelRow g_rows[];

#define PANEL_PREFIX "PessaroBridge_"

// ==================== CICLO DE VIDA ====================
int OnInit()
{
   if(StringLen(InpEaToken) == 0)
   {
      Alert("PessaroBridge: falta configurar InpEaToken (EA_TOKEN).");
      return INIT_PARAMETERS_INCORRECT;
   }

   ParseSymbolMap();
   ArrayResize(g_rows, 0);
   EventSetTimer(1);
   DrawPanel();

   Print("PessaroBridge: iniciado en modo despachador manual — solo notifica, no envía órdenes.");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   RemovePanelObjects();
}

void OnTick()
{
   // Sin lógica de trading por tick: todo el trabajo ocurre en OnTimer (polling).
}

void OnTimer()
{
   int baseInterval = IsInActiveWindow() ? InpPollActiveSeconds : InpPollIdleSeconds;
   int interval = baseInterval;

   if(g_consecutiveFailures > 0)
   {
      int mult = (int)MathPow(2.0, MathMin(g_consecutiveFailures, 5)); // cap x32
      interval = (int)MathMin(baseInterval * mult, 300);               // cap 5 min
   }

   if(TimeCurrent() - g_lastPollAt < interval) return;
   PollSignals();
}

// ==================== VENTANA OPERATIVA ====================
bool IsInActiveWindow()
{
   int brokerHour = TimeHour(TimeCurrent());
   int nyHour = ((brokerHour + InpBrokerToNyOffsetHours) % 24 + 24) % 24;

   if(InpWindowStartHourNY <= InpWindowEndHourNY)
      return (nyHour >= InpWindowStartHourNY && nyHour < InpWindowEndHourNY);

   return (nyHour >= InpWindowStartHourNY || nyHour < InpWindowEndHourNY); // ventana que cruza medianoche
}

// ==================== POLLING Y DESPACHO ====================
bool PollSignals()
{
   string url = InpBridgeBaseUrl + "/api/signals?token=" + InpEaToken + "&max=" + IntegerToString(InpMaxSignalsPerPoll);
   string response;

   if(!HttpGet(url, response))
   {
      g_consecutiveFailures++;
      Print("PessaroBridge: fallo de polling (#", g_consecutiveFailures, ")");
      DrawPanel();
      return false;
   }

   g_consecutiveFailures = 0;
   g_lastPollAt = TimeCurrent();

   if(!JsonBool(response, "ok", false))
   {
      Print("PessaroBridge: respuesta con ok=false: ", response);
      DrawPanel();
      return false;
   }

   string arrayJson = JsonRawValue(response, "signals");
   string objs[];
   int n = JsonSplitArray(arrayJson, objs);

   for(int i = 0; i < n; i++)
      ProcessSignal(objs[i]);

   if(n == 0) DrawPanel(); // refresca el estado de "último poll" aunque no haya señales nuevas
   return true;
}

void ProcessSignal(string obj)
{
   string action = JsonString(obj, "action", "");
   if(action == "CANCEL_ALL")
      HandleCancelSignal(obj);
   else if(action == "BUY_DUAL" || action == "SELL_DUAL")
      HandleEntrySignal(obj);
   else
      Print("PessaroBridge: acción desconocida ignorada: ", action);
}

void HandleEntrySignal(string obj)
{
   string id        = JsonString(obj, "id", "");
   string symbolTv  = JsonString(obj, "symbol", "");
   string action    = JsonString(obj, "action", "");
   string grade     = JsonString(obj, "grade", "");
   double price     = JsonNumber(obj, "price", 0);
   double sl        = JsonNumber(obj, "sl", 0);
   double riskUsd   = JsonNumber(obj, "risk_usd", 0);

   string p1 = JsonRawValue(obj, "partial_1");
   string p2 = JsonRawValue(obj, "partial_2");
   double tp1 = JsonNumber(p1, "tp", 0);
   double tp2 = JsonNumber(p2, "tp", 0);
   // Los "lots" que trae el JSON son referenciales (calculados con un pip
   // global en el indicador). El EA los ignora y recalcula abajo con
   // MarketInfo del símbolo real del bróker.

   int symCount     = (int)JsonNumber(obj, "current_symbol_count", 0);
   int symThreshold = (int)JsonNumber(obj, "symbol_threshold", 0);
   int globalCount  = (int)JsonNumber(obj, "current_global_count", 0);
   int globalThresh = (int)JsonNumber(obj, "global_threshold", 0);
   bool exceeded    = JsonBool(obj, "threshold_exceeded", false);

   string symbolBroker = MapSymbol(symbolTv);
   bool brokerHasSymbol = SymbolSelect(symbolBroker, true) && MarketInfo(symbolBroker, MODE_BID) > 0;

   double lot1 = 0, lot2 = 0;
   double slDistPrice = MathAbs(price - sl);
   if(brokerHasSymbol && slDistPrice > 0 && riskUsd > 0)
   {
      lot1 = CalcLotForLeg(symbolBroker, riskUsd, slDistPrice, 0.60);
      lot2 = CalcLotForLeg(symbolBroker, riskUsd, slDistPrice, 0.40);
   }

   string direction = (action == "BUY_DUAL") ? "BUY" : "SELL";
   string summary = BuildEntrySummary(direction, symbolBroker, grade, price, sl, tp1, tp2,
                                       symCount, symThreshold, globalCount, globalThresh, exceeded);
   if(!brokerHasSymbol)
      summary += " · [SIN SÍMBOLO/MAPEO EN BRÓKER: " + symbolTv + "]";

   if(InpSoundAlert) Alert(summary);
   if(InpPushNotification) SendNotification(TruncateForPush(summary));

   PanelRow row;
   row.id = id; row.action = action; row.symbolTv = symbolTv; row.symbolBroker = symbolBroker;
   row.grade = grade; row.price = price; row.sl = sl; row.tp1 = tp1; row.tp2 = tp2;
   row.lots1 = lot1; row.lots2 = lot2;
   row.symCount = symCount; row.symThreshold = symThreshold;
   row.globalCount = globalCount; row.globalThreshold = globalThresh;
   row.exceeded = exceeded; row.cancelled = false; row.symbolGap = !brokerHasSymbol;
   row.receivedAt = TimeCurrent();
   AddPanelRow(row);

   if(InpDrawChartLines && brokerHasSymbol && Symbol() == symbolBroker)
      DrawLevelLines(id, price, sl, tp1, tp2);

   // ---- Punto de extensión futuro (no implementado) ----
   // Un eventual "modo auto" activable explícitamente iría aquí, como
   // módulo separado y opt-in, después de la notificación. No se toca
   // ninguna orden en este EA.

   if(!brokerHasSymbol)
      SendAck(id, "error", "symbol_gap:" + symbolTv + "->" + symbolBroker);
   else
      SendAck(id, "notified", "");
}

void HandleCancelSignal(string obj)
{
   string id       = JsonString(obj, "id", "");
   string symbolTv = JsonString(obj, "symbol", "");
   string symbolBroker = MapSymbol(symbolTv);

   string msg = "Setup de " + symbolBroker + " expirado — descarta la señal previa";
   if(InpSoundAlert) Alert(msg);
   if(InpPushNotification) SendNotification(TruncateForPush(msg));

   MarkCancelledInPanel(symbolBroker);

   PanelRow row;
   row.id = id; row.action = "CANCEL_ALL"; row.symbolTv = symbolTv; row.symbolBroker = symbolBroker;
   row.grade = ""; row.price = 0; row.sl = 0; row.tp1 = 0; row.tp2 = 0; row.lots1 = 0; row.lots2 = 0;
   row.symCount = 0; row.symThreshold = 0; row.globalCount = 0; row.globalThreshold = 0;
   row.exceeded = false; row.cancelled = true; row.symbolGap = false;
   row.receivedAt = TimeCurrent();
   AddPanelRow(row);

   SendAck(id, "notified", "");
}

string BuildEntrySummary(string direction, string symbolBroker, string grade, double price, double sl,
                          double tp1, double tp2, int symCount, int symThreshold, int globalCount, int globalThreshold,
                          bool exceeded)
{
   string warn = exceeded ? "⚠️ " : "";
   string gradeTag = "";
   if(grade == "ELITE") gradeTag = "[ELITE] ";
   else if(grade == "STANDARD") gradeTag = "[STANDARD] ";

   return StringFormat("%s%s%s %s @ %s · SL %s · TP %s/%s · %d/%d símbolo · %d/%d global",
                        warn, gradeTag, direction, symbolBroker,
                        DoubleToStr(price, 5), DoubleToStr(sl, 5), DoubleToStr(tp1, 5), DoubleToStr(tp2, 5),
                        symCount, symThreshold, globalCount, globalThreshold);
}

string TruncateForPush(string msg)
{
   // SendNotification() falla silenciosamente sobre ~255 caracteres.
   if(StringLen(msg) > 250) return StringSubstr(msg, 0, 247) + "...";
   return msg;
}

// ==================== LOTE SUGERIDO (solo visual, no se ejecuta) ====================
double PipSize(string sym)
{
   double point = MarketInfo(sym, MODE_POINT);
   int digits = (int)MarketInfo(sym, MODE_DIGITS);
   if(digits == 3 || digits == 5) return point * 10; // pares/instrumentos con dígito fraccionario extra
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

   double riskLegUsd = riskUsd * splitFraction;
   double rawLot = riskLegUsd / (slDistPips * pipValuePerLot);

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
   return tvSymbol; // sin mapeo -> se notifica igual con el nombre de TradingView
}

// ==================== PANEL EN EL GRÁFICO ====================
void AddPanelRow(PanelRow &row)
{
   int sz = ArraySize(g_rows);
   ArrayResize(g_rows, sz + 1);
   for(int i = sz; i > 0; i--) g_rows[i] = g_rows[i - 1];
   g_rows[0] = row;

   if(ArraySize(g_rows) > InpPanelMaxRows) ArrayResize(g_rows, InpPanelMaxRows);
   DrawPanel();
}

void MarkCancelledInPanel(string symbolBroker)
{
   for(int i = 0; i < ArraySize(g_rows); i++)
      if(g_rows[i].symbolBroker == symbolBroker && g_rows[i].action != "CANCEL_ALL" && !g_rows[i].cancelled)
         g_rows[i].cancelled = true;
}

void RemovePanelObjects()
{
   for(int i = ObjectsTotal() - 1; i >= 0; i--)
   {
      string name = ObjectName(i);
      if(StringFind(name, PANEL_PREFIX) == 0) ObjectDelete(name);
   }
}

void CreateLabel(string name, string text, int x, int y, color clr, int fontSize)
{
   if(ObjectFind(name) < 0)
   {
      ObjectCreate(name, OBJ_LABEL, 0, 0, 0);
      ObjectSet(name, OBJPROP_CORNER, CORNER_LEFT_UPPER);
      ObjectSet(name, OBJPROP_XDISTANCE, x);
      ObjectSet(name, OBJPROP_YDISTANCE, y);
   }
   ObjectSetText(name, text, fontSize, "Consolas", clr);
}

void DrawPanel()
{
   if(!InpPanelEnabled) return;
   RemovePanelObjects();

   int x = 10, y = 20, lineHeight = 16;

   CreateLabel(PANEL_PREFIX + "title", "PESSARO BRIDGE · Despachador Manual (solo notifica)", x, y, clrGold, 10);
   y += lineHeight + 4;

   string header = StringFormat("%-4s %-10s %-8s %10s %10s %21s %6s/%-6s %5s/%-5s %5s/%-5s",
                                 "DIR", "SIMBOLO", "GRADE", "PRICE", "SL", "TP1/TP2", "LOT1", "LOT2", "SIM", "UMB", "GLB", "UMB");
   CreateLabel(PANEL_PREFIX + "header", header, x, y, clrSilver, 8);
   y += lineHeight;

   for(int i = 0; i < ArraySize(g_rows); i++)
   {
      PanelRow r = g_rows[i];
      string line;
      color c;

      if(r.action == "CANCEL_ALL")
      {
         line = StringFormat("CXL  %-10s expirado — descarta señal previa", r.symbolBroker);
         c = InpPanelColorCancelled;
      }
      else
      {
         string dir = (r.action == "BUY_DUAL") ? "BUY" : "SELL";
         string gradeTag = (r.grade == "ELITE") ? "*ELITE" : r.grade;
         line = StringFormat("%-4s %-10s %-8s %10s %10s %10s/%-10s %6s/%-6s %5d/%-5d %5d/%-5d",
                              dir, r.symbolBroker, gradeTag,
                              DoubleToStr(r.price, 5), DoubleToStr(r.sl, 5),
                              DoubleToStr(r.tp1, 5), DoubleToStr(r.tp2, 5),
                              DoubleToStr(r.lots1, 2), DoubleToStr(r.lots2, 2),
                              r.symCount, r.symThreshold, r.globalCount, r.globalThreshold);
         if(r.exceeded) line = "⚠ " + line;
         if(r.symbolGap) line += " [GAP]";

         c = r.cancelled ? InpPanelColorCancelled
                          : (r.exceeded ? InpPanelColorWarning : (dir == "BUY" ? InpPanelColorBuy : InpPanelColorSell));
      }

      CreateLabel(PANEL_PREFIX + "row" + IntegerToString(i), line, x, y, c, 8);
      y += lineHeight;
   }

   bool online = (g_lastPollAt > 0) && (TimeCurrent() - g_lastPollAt < 10);
   string status = StringFormat("EA %s · último poll: %s · fallos consecutivos: %d",
                                 online ? "ONLINE" : "OFFLINE",
                                 (g_lastPollAt > 0 ? TimeToString(g_lastPollAt, TIME_SECONDS) : "—"),
                                 g_consecutiveFailures);
   CreateLabel(PANEL_PREFIX + "status", status, x, y + 4, online ? clrLimeGreen : clrTomato, 8);
}

void DrawHLine(string name, double price, color clr)
{
   if(price <= 0) return;
   if(ObjectFind(name) < 0) ObjectCreate(name, OBJ_HLINE, 0, 0, price);
   ObjectSet(name, OBJPROP_PRICE1, price);
   ObjectSet(name, OBJPROP_COLOR, clr);
   ObjectSet(name, OBJPROP_STYLE, STYLE_DASH);
}

void DrawLevelLines(string id, double price, double sl, double tp1, double tp2)
{
   string prefix = PANEL_PREFIX + "lvl_" + id + "_";
   DrawHLine(prefix + "entry", price, clrDodgerBlue);
   DrawHLine(prefix + "sl", sl, clrTomato);
   DrawHLine(prefix + "tp1", tp1, clrLimeGreen);
   DrawHLine(prefix + "tp2", tp2, clrLimeGreen);
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
      Print("PessaroBridge: WebRequest GET error ", GetLastError(),
            " — verifica que la URL esté permitida en Opciones > Expert Advisors.");
      return false;
   }
   if(res != 200)
   {
      Print("PessaroBridge: HTTP ", res, " en GET ", url);
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
   if(len > 0) ArrayResize(postData, len - 1); // StringToCharArray agrega \0 final; WebRequest no lo espera

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
// No es un parser JSON genérico: está acotado a la forma fija de los
// payloads del bridge (objetos planos + partial_1/partial_2 anidados un
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

double JsonNumber(string json, string key, double def = 0)
{
   string v = JsonRawValue(json, key);
   if(StringLen(v) == 0 || v == "null") return def;
   return StringToDouble(v);
}

string JsonString(string json, string key, string def = "")
{
   string v = JsonRawValue(json, key);
   if(StringLen(v) == 0) return def;
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
