// Серверная часть учебника «Корейский до B1» на Cloudflare Workers (бесплатный тариф, не засыпает).
// База — Cloudflare D1 (SQLite). JSON-API и коды ошибок те же, что были у Supabase Edge Function `tutor`:
// POST {action: status|setup|login|load|save|attempt|set_key|clear_key|ai|stats|backups|restore, token, ...}.
import Anthropic from "@anthropic-ai/sdk";

export interface Env {
  DB: D1Database;
  // Необязательный секрет (`wrangler secret put ANTHROPIC_API_KEY`); иначе ключ берётся из app_config,
  // куда его один раз вводит сам пользователь в приложении (действие set_key).
  ANTHROPIC_API_KEY?: string;
  // Durable Object, закреплённый в США: через него уходят запросы к Anthropic (см. AiRelay)
  AI_RELAY?: DurableObjectNamespace;
}

const MODEL = "claude-haiku-5-5"; // самая экономичная модель, по просьбе пользователя
const SESSION_DAYS = 180;
const PIN_SALT = "korean-b1::";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });

const nowIso = () => new Date().toISOString();

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function randomToken(): string {
  const a = new Uint8Array(24);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function getConfig(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM app_config WHERE key = ?1").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}
async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO app_config (key, value, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value, nowIso())
    .run();
}
async function newSession(db: D1Database): Promise<string> {
  const token = randomToken();
  const now = Date.now();
  await db.batch([
    db.prepare("INSERT INTO sessions (token, created_at, expires_at) VALUES (?1, ?2, ?3)")
      .bind(token, new Date(now).toISOString(), new Date(now + SESSION_DAYS * 86400e3).toISOString()),
    db.prepare("DELETE FROM sessions WHERE expires_at < ?1").bind(new Date(now).toISOString()), // попутно чистим просроченные
  ]);
  return token;
}
async function validSession(db: D1Database, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length < 20) return false;
  const row = await db.prepare("SELECT expires_at FROM sessions WHERE token = ?1").bind(token).first<{ expires_at: string }>();
  return !!row && new Date(row.expires_at) > new Date();
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

async function getApiKey(env: Env): Promise<string | null> {
  return env.ANTHROPIC_API_KEY ?? (await getConfig(env.DB, "anthropic_api_key"));
}

async function logCall(db: D1Database, kind: string, res: Anthropic.Message): Promise<void> {
  await db
    .prepare("INSERT INTO ai_calls (kind, model, input_tokens, output_tokens, created_at) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(kind, res.model ?? MODEL, res.usage.input_tokens, res.usage.output_tokens, nowIso())
    .run();
}

// Anthropic отвечает 403 {"type":"forbidden","message":"Request not allowed"}, если запрос пришёл из неподдерживаемого
// региона. Воркер выполняется в ближайшем к пользователю узле Cloudflare, и при перегрузке узла запрос может уйти
// через соседний (например, Гонконг). Поэтому вызов делаем из Durable Object, закреплённого в США (locationHint),
// а прямой вызов оставляем запасным, если объект недоступен.
const RELAY_HINT: DurableObjectLocationHint = "enam";
async function callAi(env: Env, body: Record<string, unknown>, colo = ""): Promise<Response> {
  const apiKey = await getApiKey(env);
  if (!apiKey) return json({ error: "no_api_key" }, 503);
  if (env.AI_RELAY) {
    try {
      const stub = env.AI_RELAY.get(env.AI_RELAY.idFromName("anthropic-us"), { locationHint: RELAY_HINT });
      const r = await stub.fetch("https://relay/ai", { method: "POST", body: JSON.stringify({ apiKey, body, colo }) });
      // 403 forbidden из США быть не должно; если всё же пришёл, пробуем напрямую
      const err = r.status === 502 ? ((await r.clone().json().catch(() => ({}))) as { status?: number }) : {};
      if (err.status !== 403) return r;
      console.error("relay_forbidden", colo);
    } catch (e) {
      console.error("relay_error", colo, (e as Error).message);
    }
  }
  return callAnthropic(env, apiKey, body, colo);
}

export class AiRelay implements DurableObject {
  constructor(_state: DurableObjectState, private env: Env) {}
  async fetch(req: Request): Promise<Response> {
    const { apiKey, body, colo } = (await req.json()) as { apiKey: string; body: Record<string, unknown>; colo?: string };
    return callAnthropic(this.env, apiKey, body, colo ?? "");
  }
}

async function callAnthropic(env: Env, apiKey: string, body: Record<string, unknown>, colo: string): Promise<Response> {
  // Перегрузка или обрыв на стороне Anthropic: SDK сам повторяет 429/5xx, даём ему до 4 попыток и 60 с на запрос
  const client = new Anthropic({ apiKey, maxRetries: 4, timeout: 60_000 });
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
    await logCall(env.DB, String(body.kind ?? "other"), res);
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
    if (e instanceof Anthropic.APIError) {
      console.error("anthropic_error", String(body.kind ?? ""), e.status, e.message, "colo", colo);
      return json({ error: "api_error", detail: e.message, status: e.status }, 502);
    }
    throw e;
  }
}

// Защита прогресса: перед перезаписью сохраняем снимок (не чаще раза в час, или всегда, если новых данных заметно меньше), храним последние 60
const BACKUP_KEEP = 60;
function countAnswers(data: string): { answers: number; days: number } {
  try {
    const s = JSON.parse(data) as { topics?: Record<string, { n?: number }>; days?: Record<string, number> };
    return { answers: Object.values(s.topics ?? {}).reduce((a, p) => a + (p?.n ?? 0), 0), days: Object.keys(s.days ?? {}).length };
  } catch { return { answers: 0, days: 0 }; }
}
async function snapshotProgress(db: D1Database, force: boolean, incoming?: string): Promise<void> {
  const cur = await db.prepare("SELECT data, updated_at FROM progress WHERE id = 'me'").first<{ data: string; updated_at: string }>();
  if (!cur?.data) return;
  if (!force) {
    const last = await db.prepare("SELECT created_at FROM progress_backup ORDER BY id DESC LIMIT 1").first<{ created_at: string }>();
    const stale = !last || Date.now() - new Date(last.created_at).getTime() > 3600e3;
    const shrink = incoming !== undefined && countAnswers(cur.data).answers >= 10 && countAnswers(incoming).answers < countAnswers(cur.data).answers * 0.5;
    if (!stale && !shrink) return;
  }
  await db.batch([
    db.prepare("INSERT INTO progress_backup (data, updated_at, created_at) VALUES (?1, ?2, ?3)").bind(cur.data, cur.updated_at, nowIso()),
    db.prepare("DELETE FROM progress_backup WHERE id NOT IN (SELECT id FROM progress_backup ORDER BY id DESC LIMIT ?1)").bind(BACKUP_KEEP),
  ]);
}

async function stats(db: D1Database): Promise<Response> {
  const { results: attempts } = await db
    .prepare("SELECT topic_id, correct FROM attempts ORDER BY created_at DESC LIMIT 5000")
    .all<{ topic_id: string | null; correct: number | null }>();
  const ai = await db
    .prepare("SELECT COUNT(*) AS calls, COALESCE(SUM(input_tokens), 0) AS input_tokens, COALESCE(SUM(output_tokens), 0) AS output_tokens FROM ai_calls")
    .first<{ calls: number; input_tokens: number; output_tokens: number }>();
  const byTopic: Record<string, { n: number; c: number }> = {};
  for (const a of attempts) {
    const t = (byTopic[a.topic_id ?? "?"] ??= { n: 0, c: 0 });
    t.n++;
    if (a.correct) t.c++;
  }
  return json({
    attempts: attempts.length,
    byTopic,
    ai: { calls: ai?.calls ?? 0, input_tokens: ai?.input_tokens ?? 0, output_tokens: ai?.output_tokens ?? 0, model: MODEL },
  });
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
    if (req.method === "GET") return json({ service: "korean-b1 tutor API", runtime: "cloudflare-workers", model: MODEL, ai: !!(await getApiKey(env)) });
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
    let body: Record<string, unknown>;
    try { body = await req.json(); } catch { return json({ error: "bad_json" }, 400); }
    const action = String(body.action ?? "");
    const db = env.DB;
    try {
      if (action === "status") {
        const hash = await getConfig(db, "pin_hash");
        return json({ configured: !!hash, ai: !!(await getApiKey(env)), model: MODEL });
      }
      if (action === "setup") {
        if (await getConfig(db, "pin_hash")) return json({ error: "already_configured" }, 409);
        const pin = String(body.pin ?? "");
        if (pin.length < 4) return json({ error: "pin_too_short" }, 400);
        await setConfig(db, "pin_hash", await sha256(PIN_SALT + pin));
        return json({ token: await newSession(db) });
      }
      if (action === "login") {
        const hash = await getConfig(db, "pin_hash");
        if (!hash) return json({ error: "not_configured" }, 409);
        if ((await sha256(PIN_SALT + String(body.pin ?? ""))) !== hash) return json({ error: "wrong_pin" }, 401);
        return json({ token: await newSession(db) });
      }
      if (!(await validSession(db, body.token))) return json({ error: "unauthorized" }, 401);
      if (action === "load") {
        const row = await db.prepare("SELECT data, updated_at FROM progress WHERE id = 'me'").first<{ data: string; updated_at: string }>();
        let data: unknown = null;
        if (row?.data) { try { data = JSON.parse(row.data); } catch { data = null; } }
        return json({ data, updated_at: row?.updated_at ?? null });
      }
      if (action === "save") {
        if (!body.data || typeof body.data !== "object") return json({ error: "no_data" }, 400);
        const incoming = JSON.stringify(body.data);
        await snapshotProgress(db, false, incoming);
        await db
          .prepare("INSERT INTO progress (id, data, updated_at) VALUES ('me', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
          .bind(JSON.stringify(body.data), nowIso())
          .run();
        return json({ ok: true });
      }
      if (action === "attempt") {
        const a = (body.attempt ?? {}) as Record<string, unknown>;
        await db
          .prepare("INSERT INTO attempts (topic_id, type, question, answer, user_answer, correct, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)")
          .bind(
            String(a.topic ?? ""), String(a.type ?? ""), String(a.q ?? "").slice(0, 2000),
            String(a.a ?? "").slice(0, 2000), String(a.user ?? "").slice(0, 2000), a.correct ? 1 : 0, nowIso(),
          )
          .run();
        return json({ ok: true });
      }
      if (action === "set_key") {
        // Ключ вводит сам пользователь в приложении; проверяем его одним минимальным запросом и сохраняем.
        const key = String(body.key ?? "").trim();
        if (!/^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key)) return json({ error: "bad_key_format" }, 400);
        try {
          const probe = new Anthropic({ apiKey: key });
          const res = await probe.messages.create({
            model: MODEL, max_tokens: 5, thinking: { type: "disabled" }, output_config: { effort: "low" },
            messages: [{ role: "user", content: "안녕" }],
          });
          await logCall(db, "key_check", res);
        } catch (e) {
          if (e instanceof Anthropic.AuthenticationError) return json({ error: "bad_api_key" }, 400);
          if (e instanceof Anthropic.APIError) return json({ error: "api_error", detail: e.message, status: e.status }, 502);
          throw e;
        }
        await setConfig(db, "anthropic_api_key", key);
        return json({ ok: true });
      }
      if (action === "clear_key") {
        await db.prepare("DELETE FROM app_config WHERE key = 'anthropic_api_key'").run();
        return json({ ok: true });
      }
      if (action === "backups") {
        const { results } = await db.prepare("SELECT id, data, updated_at, created_at FROM progress_backup ORDER BY id DESC LIMIT ?1").bind(BACKUP_KEEP)
          .all<{ id: number; data: string; updated_at: string; created_at: string }>();
        return json({ list: results.map((b) => ({ id: b.id, created_at: b.created_at, updated_at: b.updated_at, ...countAnswers(b.data) })) });
      }
      if (action === "restore") {
        const row = await db.prepare("SELECT data FROM progress_backup WHERE id = ?1").bind(Number(body.id)).first<{ data: string }>();
        if (!row) return json({ error: "not_found" }, 404);
        await snapshotProgress(db, true); // текущее состояние тоже остаётся снимком
        await db.prepare("INSERT INTO progress (id, data, updated_at) VALUES ('me', ?1, ?2) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at")
          .bind(row.data, nowIso()).run();
        let data: unknown = null; try { data = JSON.parse(row.data); } catch { data = null; }
        return json({ data });
      }
      if (action === "ai") return await callAi(env, body, String((req.cf as { colo?: string } | undefined)?.colo ?? ""));
      if (action === "stats") return await stats(db);
      return json({ error: "unknown_action" }, 400);
    } catch (e) {
      console.error(e);
      return json({ error: "server_error", detail: String((e as Error)?.message ?? e) }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
