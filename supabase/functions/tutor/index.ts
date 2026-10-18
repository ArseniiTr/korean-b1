// Серверная функция учебника «Корейский до B1».
// GET  → короткая справка о сервисе (сайт размещается отдельно).
// POST → JSON-API: вход по коду доступа, загрузка и сохранение прогресса,
//        журнал ответов, прокси к Anthropic API (ключ живёт только здесь).
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import Anthropic from "npm:@anthropic-ai/sdk";

const MODEL = "claude-haiku-5-5"; // самая экономичная модель, по просьбе пользователя
const SESSION_DAYS = 180;
const PIN_SALT = "korean-b1::";

const supabase = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false } },
);

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function getConfig(key: string): Promise<string | null> {
  const { data } = await supabase.from("app_config").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function newSession(): Promise<string> {
  const token = randomToken();
  const expires_at = new Date(Date.now() + SESSION_DAYS * 86400e3).toISOString();
  const { error } = await supabase.from("sessions").insert({ token, expires_at });
  if (error) throw error;
  return token;
}
async function validSession(token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length < 20) return false;
  const { data } = await supabase.from("sessions").select("expires_at").eq("token", token).maybeSingle();
  return !!data && new Date(data.expires_at) > new Date();
}

// Терпимый разбор JSON: целиком, затем из ```-блока, затем от первой скобки до последней.
function parseJson(text: string): unknown {
  const tries = [text];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const first = text.search(/[\[{]/);
  const last = Math.max(text.lastIndexOf("]"), text.lastIndexOf("}"));
  if (first >= 0 && last > first) tries.push(text.slice(first, last + 1));
  for (const t of tries) {
    try { return JSON.parse(t); } catch { /* следующий вариант */ }
  }
  return undefined;
}

const SYSTEM =
  "Ты преподаватель корейского языка для русскоязычного взрослого ученика. Объясняешь просто и точно, " +
  "корейские примеры пишешь хангылем в вежливом стиле 해요체, переводы и пояснения даёшь по-русски. " +
  "Когда просят JSON, отвечаешь только JSON без пояснений.";

// Ключ Anthropic: из секрета функции ANTHROPIC_API_KEY, иначе из app_config (вводится один раз в самом приложении).
async function getApiKey(): Promise<string | null> {
  return Deno.env.get("ANTHROPIC_API_KEY") ?? (await getConfig("anthropic_api_key"));
}

async function callAi(body: Record<string, unknown>) {
  const apiKey = await getApiKey();
  if (!apiKey) return json({ error: "no_api_key" }, 503);
  const client = new Anthropic({ apiKey });
  const prompt = String(body.prompt ?? "").slice(0, 12000);
  if (!prompt) return json({ error: "empty_prompt" }, 400);
  const maxTokens = Math.min(Math.max(Number(body.max_tokens) || 900, 100), 3000);
  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: maxTokens,
      system: SYSTEM,
      // Экономия: у Haiku 5.5 адаптивное размышление включено по умолчанию и тарифицируется как вывод; для коротких JSON-ответов оно не нужно
      thinking: { type: "disabled" },
      output_config: { effort: "low" },
      messages: [{ role: "user", content: prompt }],
    });
    const text = res.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
    await supabase.from("ai_calls").insert({
      kind: String(body.kind ?? "other"),
      model: res.model ?? MODEL,
      input_tokens: res.usage.input_tokens,
      output_tokens: res.usage.output_tokens,
    });
    if (res.stop_reason === "refusal") return json({ error: "refusal" }, 422);
    let data: unknown = undefined;
    if (body.json) {
      data = parseJson(text);
      if (data === undefined) return json({ error: "invalid_json", text }, 422);
    }
    return json({ text, data, truncated: res.stop_reason === "max_tokens", usage: res.usage });
  } catch (e) {
    if (e instanceof Anthropic.AuthenticationError) return json({ error: "bad_api_key" }, 503);
    if (e instanceof Anthropic.RateLimitError) return json({ error: "rate_limited" }, 429);
    if (e instanceof Anthropic.APIError) return json({ error: "api_error", detail: e.message, status: e.status }, 502);
    throw e;
  }
}

async function stats() {
  const { data: attempts } = await supabase.from("attempts").select("topic_id,correct,created_at").order("created_at", { ascending: false }).limit(5000);
  const { data: calls } = await supabase.from("ai_calls").select("input_tokens,output_tokens,created_at").limit(10000);
  const byTopic: Record<string, { n: number; c: number }> = {};
  for (const a of attempts ?? []) {
    const t = byTopic[a.topic_id ?? "?"] ??= { n: 0, c: 0 };
    t.n++;
    if (a.correct) t.c++;
  }
  let inTok = 0, outTok = 0;
  for (const c of calls ?? []) { inTok += c.input_tokens ?? 0; outTok += c.output_tokens ?? 0; }
  return json({ attempts: attempts?.length ?? 0, byTopic, ai: { calls: calls?.length ?? 0, input_tokens: inTok, output_tokens: outTok, model: MODEL } });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method === "GET") {
    // Supabase не отдаёт HTML со своих доменов (принудительный text/plain и CSP sandbox),
    // поэтому сайт размещается отдельно, а здесь только API.
    return json({ service: "korean-b1 tutor API", model: MODEL, ai: !!(await getApiKey()) });
  }
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
  const action = String(body.action ?? "");
  try {
    if (action === "status") {
      const hash = await getConfig("pin_hash");
      return json({ configured: !!hash, ai: !!(await getApiKey()), model: MODEL });
    }
    if (action === "setup") {
      if (await getConfig("pin_hash")) return json({ error: "already_configured" }, 409);
      const pin = String(body.pin ?? "");
      if (pin.length < 4) return json({ error: "pin_too_short" }, 400);
      const { error } = await supabase.from("app_config").insert({ key: "pin_hash", value: await sha256(PIN_SALT + pin) });
      if (error) throw error;
      return json({ token: await newSession() });
    }
    if (action === "login") {
      const hash = await getConfig("pin_hash");
      if (!hash) return json({ error: "not_configured" }, 409);
      if ((await sha256(PIN_SALT + String(body.pin ?? ""))) !== hash) return json({ error: "wrong_pin" }, 401);
      return json({ token: await newSession() });
    }
    if (!(await validSession(body.token))) return json({ error: "unauthorized" }, 401);
    if (action === "load") {
      const { data } = await supabase.from("progress").select("data,updated_at").eq("id", "me").maybeSingle();
      return json({ data: data?.data ?? null, updated_at: data?.updated_at ?? null });
    }
    if (action === "save") {
      if (!body.data || typeof body.data !== "object") return json({ error: "no_data" }, 400);
      const { error } = await supabase.from("progress").upsert({ id: "me", data: body.data, updated_at: new Date().toISOString() });
      if (error) throw error;
      return json({ ok: true });
    }
    if (action === "attempt") {
      const a = (body.attempt ?? {}) as Record<string, unknown>;
      const { error } = await supabase.from("attempts").insert({
        topic_id: String(a.topic ?? ""), type: String(a.type ?? ""), question: String(a.q ?? "").slice(0, 2000),
        answer: String(a.a ?? "").slice(0, 2000), user_answer: String(a.user ?? "").slice(0, 2000), correct: !!a.correct,
      });
      if (error) throw error;
      return json({ ok: true });
    }
    if (action === "set_key") {
      // Ключ вводит сам пользователь в приложении; проверяем его одним минимальным запросом и сохраняем.
      const key = String(body.key ?? "").trim();
      if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return json({ error: "bad_key_format" }, 400);
      try {
        const probe = new Anthropic({ apiKey: key });
        const res = await probe.messages.create({ model: MODEL, max_tokens: 5, thinking: { type: "disabled" }, output_config: { effort: "low" }, messages: [{ role: "user", content: "안녕" }] });
        await supabase.from("ai_calls").insert({ kind: "key_check", model: res.model ?? MODEL, input_tokens: res.usage.input_tokens, output_tokens: res.usage.output_tokens });
      } catch (e) {
        if (e instanceof Anthropic.AuthenticationError) return json({ error: "bad_api_key" }, 400);
        if (e instanceof Anthropic.APIError) return json({ error: "api_error", detail: e.message, status: e.status }, 502);
        throw e;
      }
      const { error } = await supabase.from("app_config").upsert({ key: "anthropic_api_key", value: key });
      if (error) throw error;
      return json({ ok: true });
    }
    if (action === "clear_key") {
      await supabase.from("app_config").delete().eq("key", "anthropic_api_key");
      return json({ ok: true });
    }
    if (action === "ai") return await callAi(body);
    if (action === "stats") return await stats();
    return json({ error: "unknown_action" }, 400);
  } catch (e) {
    console.error(e);
    return json({ error: "server_error", detail: String((e as Error)?.message ?? e) }, 500);
  }
});
