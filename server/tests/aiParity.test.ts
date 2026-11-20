import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { AnthropicProvider, toAnthropic } from "../src/ai/anthropic.js";
import { listModels } from "../src/ai/connection.js";
import { cleanSummary } from "../src/ai/insights.js";
import { AI_PRESETS, presetsFor, validApiKey } from "../src/ai/presets.js";
import type { AiProvider, AssistantMessage, ChatMessage, ToolSpec } from "../src/ai/provider.js";
import { aiKeyContext } from "../src/ai/resolve.js";
import { createApp } from "../src/app.js";
import { loadConfig } from "../src/config.js";
import { createServices } from "../src/services.js";
import { testDatabaseUrl } from "./database.js";
import { fakeCanvas, seedCourse } from "./fakeCanvas.js";
import { Browser, config, connectCanvas, db, logger, resetDatabase, signUp } from "./helpers.js";

beforeEach(async () => {
  await resetDatabase();
  fakeCanvas.reset();
});
afterAll(() => db.$disconnect());

type Step = (messages: ChatMessage[], tools: ToolSpec[]) => AssistantMessage;

/** Plays back scripted replies and records what it was sent. */
class ScriptedAi implements AiProvider {
  readonly model = "scripted";
  readonly source = "server";
  readonly calls: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  constructor(private readonly steps: Step[]) {}
  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<AssistantMessage> {
    this.calls.push({ messages: structuredClone(messages), tools });
    const step = this.steps[this.calls.length - 1];
    if (!step) throw new Error("no scripted reply left");
    return step(messages, tools);
  }
}

/** Answers summary and estimate requests by their prompt. */
class InsightAi implements AiProvider {
  readonly model = "insight-model";
  readonly source = "server";
  summaries = 0;
  estimates = 0;
  async complete(messages: ChatMessage[]): Promise<AssistantMessage> {
    const system = (messages[0] as { content: string }).content;
    if (system.startsWith("Summarize")) {
      this.summaries += 1;
      return { role: "assistant", content: '```json\n{"summary": "Build a <b>responsive</b> page. See https://example.com"}\n```' };
    }
    this.estimates += 1;
    return { role: "assistant", content: JSON.stringify({ total_minutes: 93, low_minutes: 60, high_minutes: 150 }) };
  }
}

const call = (id: string, name: string, args: object = {}) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });
const say = (content: string): Step => () => ({ role: "assistant", content });

function appWith(ai: AiProvider | null, aiFetch?: typeof fetch, env: Record<string, string> = {}) {
  const custom = Object.keys(env).length
    ? loadConfig({
        NODE_ENV: "test",
        DATABASE_URL: testDatabaseUrl(),
        SESSION_SECRET: "test-session-secret-0123456789abcdef",
        CREDENTIALS_KEY: Buffer.alloc(32, 7).toString("base64"),
        ALLOWED_ORIGINS: "http://localhost:5173",
        CANVAS_ALLOWED_HOSTS: "canvas.example.com",
        SYNC_INTERVAL_MINUTES: "0",
        LOG_LEVEL: "silent",
        ...env,
      })
    : config;
  const services = createServices({ config: custom, db, logger, canvas: fakeCanvas.factory, ai, aiFetch });
  return { app: createApp({ config: custom, db, logger, services }), services };
}

/** Ada with the fake Canvas course, signed in on a browser of `app`. */
async function adaOn(app: ReturnType<typeof appWith>["app"]): Promise<Browser> {
  seedCourse(fakeCanvas);
  await connectCanvas(await signUp());
  const browser = new Browser(app);
  expect((await browser.signIn()).status).toBe(201);
  return browser;
}

async function bobOn(app: ReturnType<typeof appWith>["app"]): Promise<Browser> {
  const bob = new Browser(app);
  expect((await bob.send("post", "/api/users", { body: { username: "bob", email: "bob@example.com", password: "test-password-123" } })).status).toBe(201);
  return bob;
}

const KEY = "sk-test-0123456789abcdef";

/** A fake provider API: model lists and chat completions, recording each request. */
function fakeProvider(options: { status?: number } = {}) {
  const requests: { url: string; auth: string | null; body: unknown }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({ url, auth: new Headers(init?.headers).get("Authorization"), body: init?.body ? JSON.parse(String(init.body)) : null });
    if (options.status) return new Response("{}", { status: options.status });
    if (url.endsWith("/models")) return Response.json({ data: [{ id: "deepseek-chat" }, { id: "deepseek-alpha" }, { nope: 1 }] });
    return Response.json({ choices: [{ message: { role: "assistant", content: "OK" } }] });
  };
  return { fetchImpl, requests };
}

describe("AI settings", () => {
  it("offers fixed presets, hides local ones unless allowed, and validates keys", () => {
    expect(presetsFor(false).some((preset) => preset.protocol === "local")).toBe(false);
    expect(presetsFor(true).map((preset) => preset.id)).toEqual(AI_PRESETS.map((preset) => preset.id));
    expect(validApiKey(KEY)).toBe(true);
    expect(validApiKey("Bearer abcdefghijk")).toBe(false);
    expect(validApiKey("sk-with space-123")).toBe(false);
    expect(validApiKey("sk-ключ-12345")).toBe(false);
  });

  it("keeps the server default until the user's own connection passes its test", async () => {
    const provider = fakeProvider();
    const { app, services } = appWith(new ScriptedAi([]), provider.fetchImpl);
    const ada = await adaOn(app);

    const initial = await ada.send("get", "/api/settings/ai");
    expect(initial.body).toMatchObject({ provider: "server", server_default: { available: true, model: "scripted" }, active: "server", chat_ready: true });
    expect(initial.body.providers.map((preset: { id: string }) => preset.id)).not.toContain("ollama");

    expect((await ada.send("put", "/api/settings/ai", { body: { provider: "ollama", model_id: "llama3" } })).status).toBe(422);
    expect((await ada.send("put", "/api/settings/ai", { body: { provider: "custom", model_id: "x" } })).status).toBe(422);
    // A key can only be added for the saved provider.
    expect((await ada.send("post", "/api/settings/ai/credential", { body: { provider: "deepseek", api_key: KEY } })).status).toBe(409);

    const saved = await ada.send("put", "/api/settings/ai", { body: { provider: "deepseek", model_id: "" } });
    expect(saved.body).toMatchObject({ provider: "deepseek", base_url: "https://api.deepseek.com/v1", requires_key: true, credential_loaded: false, verified: false, active: "server" });
    const bad = await ada.send("post", "/api/settings/ai/credential", { body: { provider: "deepseek", api_key: `Bearer ${KEY}` } });
    expect(bad.status).toBe(422);
    expect((await ada.send("post", "/api/settings/ai/credential", { body: { provider: "deepseek", api_key: KEY } })).body).toEqual({ credential_loaded: true });

    // Sealed for this user and purpose; never sent back.
    const user = await db.user.findFirstOrThrow({ where: { usernameKey: "ada" } });
    const row = await db.aiConnection.findUniqueOrThrow({ where: { userId: user.id } });
    expect(row.keyCiphertext).not.toContain(KEY);
    expect(services.secrets.open(row.keyCiphertext as string, aiKeyContext(user.id))).toBe(KEY);
    expect(() => services.secrets.open(row.keyCiphertext as string, user.id)).toThrow();
    const status = await ada.send("get", "/api/settings/ai");
    expect(JSON.stringify(status.body)).not.toContain(KEY);
    expect(status.body.credential_loaded).toBe(true);

    const models = await ada.send("post", "/api/settings/ai/models");
    expect(models.body).toEqual({ success: true, models: ["deepseek-alpha", "deepseek-chat"], message: null });
    expect(provider.requests[0]).toMatchObject({ url: "https://api.deepseek.com/v1/models", auth: `Bearer ${KEY}` });

    // Testing needs a saved model, and the model tested must be the saved one.
    expect((await ada.send("post", "/api/settings/ai/test", { body: {} })).body).toMatchObject({ success: false, message: "Enter a model ID first." });
    await ada.send("put", "/api/settings/ai", { body: { provider: "deepseek", model_id: "deepseek-chat" } });
    expect((await ada.send("post", "/api/settings/ai/test", { body: { model_id: "other" } })).body.success).toBe(false);
    const tested = await ada.send("post", "/api/settings/ai/test", { body: { model_id: "deepseek-chat" } });
    expect(tested.body).toMatchObject({ success: true, model_id: "deepseek-chat", message: null });
    expect(typeof tested.body.latency_ms).toBe("number");
    expect(provider.requests.at(-1)).toMatchObject({ url: "https://api.deepseek.com/v1/chat/completions", body: { model: "deepseek-chat" } });
    expect((await ada.send("get", "/api/ai")).body).toEqual({ enabled: true, model: "deepseek-chat", source: "own" });

    // A new model needs a new test; until then the server default serves.
    const switched = await ada.send("put", "/api/settings/ai", { body: { provider: "deepseek", model_id: "deepseek-alpha" } });
    expect(switched.body).toMatchObject({ verified: false, active: "server", credential_loaded: true });
    // A new provider drops the old key.
    const moved = await ada.send("put", "/api/settings/ai", { body: { provider: "claude", model_id: "claude-x" } });
    expect(moved.body).toMatchObject({ provider: "claude", credential_loaded: false, verified: false });
    expect((await ada.send("put", "/api/settings/ai", { body: { provider: "server" } })).body).toMatchObject({ provider: "server", active: "server" });
    expect(await db.aiConnection.count()).toBe(0);
  });

  it("reports provider failures with fixed sentences", async () => {
    const provider = fakeProvider({ status: 401 });
    const { app } = appWith(null, provider.fetchImpl);
    const ada = await adaOn(app);
    expect((await ada.send("get", "/api/settings/ai")).body).toMatchObject({ provider: null, active: null, chat_ready: false });
    await ada.send("put", "/api/settings/ai", { body: { provider: "gpt", model_id: "gpt-x" } });
    expect((await ada.send("post", "/api/settings/ai/models")).body).toMatchObject({ success: false, message: "Add this provider's API key first." });
    await ada.send("post", "/api/settings/ai/credential", { body: { provider: "gpt", api_key: KEY } });
    const models = await ada.send("post", "/api/settings/ai/models");
    expect(models.body).toEqual({ success: false, models: [], message: expect.stringContaining("rejected the key") });
    const tested = await ada.send("post", "/api/settings/ai/test", { body: {} });
    expect(tested.body).toMatchObject({ success: false, latency_ms: null });
    expect((await ada.send("get", "/api/ai")).body.enabled).toBe(false);
    expect((await ada.send("delete", "/api/settings/ai/credential")).status).toBe(204);
    expect((await ada.send("get", "/api/settings/ai")).body.credential_loaded).toBe(false);
  });

  it("allows a local model without a key only when the server allows it", async () => {
    const provider = fakeProvider();
    const { app } = appWith(null, provider.fetchImpl, { AI_ALLOW_LOCAL: "true" });
    const ada = await adaOn(app);
    await ada.send("put", "/api/settings/ai", { body: { provider: "ollama", model_id: "llama3.1:8b" } });
    expect((await ada.send("post", "/api/settings/ai/credential", { body: { provider: "ollama", api_key: KEY } })).status).toBe(422);
    expect((await ada.send("post", "/api/settings/ai/test", { body: {} })).body.success).toBe(true);
    expect(provider.requests.at(-1)?.url).toBe("http://host.docker.internal:11434/v1/chat/completions");
    expect((await ada.send("get", "/api/ai")).body).toEqual({ enabled: true, model: "llama3.1:8b", source: "own" });
  });

  it("is read-only for preview accounts", async () => {
    const { app } = appWith(new ScriptedAi([]));
    const ada = await adaOn(app);
    await db.user.updateMany({ where: { usernameKey: "ada" }, data: { previewExpiresAt: new Date(Date.now() + 3_600_000) } });
    expect((await ada.send("get", "/api/settings/ai")).body).toMatchObject({ read_only: true, active: "server" });
    expect((await ada.send("put", "/api/settings/ai", { body: { provider: "gpt", model_id: "x" } })).status).toBe(403);
    expect((await ada.send("post", "/api/settings/ai/models")).status).toBe(403);
  });
});

describe("Anthropic provider", () => {
  it("translates tool conversations both ways and pages the model list", async () => {
    const { system, turns } = toAnthropic([
      { role: "system", content: "Be brief." },
      { role: "user", content: "Hi" },
      { role: "assistant", content: null, tool_calls: [call("t1", "list_courses")] },
      { role: "tool", tool_call_id: "t1", content: "{}" },
      { role: "tool", tool_call_id: "t2", content: "[]" },
    ]);
    expect(system).toBe("Be brief.");
    expect(turns.map((turn) => turn.role)).toEqual(["user", "assistant", "user"]);
    expect(turns[2]?.content).toHaveLength(2);

    let sent: { url: string; headers: Headers; body: Record<string, unknown> } | null = null;
    const provider = new AnthropicProvider({ baseUrl: "https://api.anthropic.com/v1", apiKey: KEY, model: "claude-x" }, async (input, init) => {
      sent = { url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) };
      return Response.json({ role: "assistant", content: [{ type: "text", text: "Looking." }, { type: "tool_use", id: "u1", name: "get_task", input: { task_id: 3 } }] });
    });
    const reply = await provider.complete([{ role: "user", content: "Hi" }], [{ type: "function", function: { name: "get_task", description: "d", parameters: {} } }]);
    expect(reply).toEqual({ role: "assistant", content: "Looking.", tool_calls: [call("u1", "get_task", { task_id: 3 })] });
    expect(sent!.url).toBe("https://api.anthropic.com/v1/messages");
    expect(sent!.headers.get("x-api-key")).toBe(KEY);
    expect(sent!.body).toMatchObject({ model: "claude-x", tools: [{ name: "get_task", input_schema: {} }] });

    const pages: string[] = [];
    const claude = AI_PRESETS.find((preset) => preset.id === "claude")!;
    const models = await listModels(claude, KEY, async (input) => {
      pages.push(String(input));
      return pages.length === 1
        ? Response.json({ data: [{ id: "b" }], has_more: true, last_id: "b" })
        : Response.json({ data: [{ id: "a" }], has_more: false, last_id: "a" });
    });
    expect(models).toEqual(["a", "b"]);
    expect(pages[1]).toContain("after_id=b");
  });
});

describe("AI Chat conversations and confirmations", () => {
  async function taskOf(ada: Browser) {
    return (await ada.send("get", "/api/tasks")).body[0] as { id: number; progress: number };
  }

  it("keeps the conversation on the server and sends it back to the model", async () => {
    const ai = new ScriptedAi([say("First answer."), say("Second answer."), say("Hi Bob.")]);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    const first = await ada.send("post", "/api/ai/chat", { body: { message: "Hello" } });
    expect(first.body).toMatchObject({ message: "First answer.", confirmation: null });
    const id = first.body.conversation_id;
    const second = await ada.send("post", "/api/ai/chat", { body: { conversation_id: id, message: "And now?" } });
    expect(second.body.conversation_id).toBe(id);
    const sent = ai.calls[1]?.messages.filter((message) => message.role !== "system").map((message) => (message as { content: string }).content);
    expect(sent).toEqual(["Hello", "First answer.", "And now?"]);

    const stored = await ada.send("get", `/api/ai/chat/conversations/${id}`);
    expect(stored.body.messages.map((message: { role: string; content: string }) => [message.role, message.content])).toEqual([
      ["user", "Hello"],
      ["assistant", "First answer."],
      ["user", "And now?"],
      ["assistant", "Second answer."],
    ]);
    const bob = await bobOn(app);
    expect((await bob.send("get", `/api/ai/chat/conversations/${id}`)).status).toBe(404);
    // Someone else's id starts a new conversation instead of joining theirs.
    const reply = await bob.send("post", "/api/ai/chat", { body: { conversation_id: id, message: "Hi" } });
    expect(reply.body.conversation_id).not.toBe(id);
    expect(ai.calls[2]?.messages.filter((message) => message.role === "user")).toHaveLength(1);
  });

  it("does not keep the message when the AI fails, so it can be sent again", async () => {
    const ai = new ScriptedAi([() => { throw new Error("boom"); }]);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    expect((await ada.send("post", "/api/ai/chat", { body: { message: "Hello" } })).status).toBe(500);
    expect(await db.aiChatMessage.count()).toBe(0);
  });

  it("proposes a change, applies it only once on confirm, and refuses other users", async () => {
    let taskId = 0;
    const ai = new ScriptedAi([
      () => ({ role: "assistant", content: null, tool_calls: [call("a", "set_task_progress", { task_id: 999_999, progress_percent: 60 })] }),
      (messages) => {
        expect((messages.at(-1) as { content: string }).content).toContain("could not be found");
        return { role: "assistant", content: "I'll set it to 60%.", tool_calls: [call("b", "set_task_progress", { task_id: taskId, progress_percent: 60 })] };
      },
    ]);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    taskId = (await taskOf(ada)).id;
    const res = await ada.send("post", "/api/ai/chat", { body: { message: "I'm 60% done with MP 1" } });
    expect(res.body).toMatchObject({
      message: "I'll set it to 60%.",
      confirmation: { tool_name: "set_task_progress", status: "pending", summary: 'Set progress on "MP 1: Layout" to 60%' },
    });
    expect(res.body.confirmation.details).toContainEqual({ label: "Progress", value: "0% → 60%" });
    expect((await taskOf(ada)).progress).toBe(0);
    const id = res.body.confirmation.id;

    const bob = await bobOn(app);
    expect((await bob.send("post", "/api/ai/chat/confirm", { body: { confirmation_id: id, action: "confirm" } })).status).toBe(404);

    const confirmed = await ada.send("post", "/api/ai/chat/confirm", { body: { confirmation_id: id, action: "confirm" } });
    expect(confirmed.body).toMatchObject({ message: "Change applied.", confirmation: { status: "applied" } });
    expect((await taskOf(ada)).progress).toBe(60);
    const again = await ada.send("post", "/api/ai/chat/confirm", { body: { confirmation_id: id, action: "cancel" } });
    expect(again.status).toBe(409);
    expect(again.body.code).toBe("CONFIRMATION_ALREADY_RESOLVED");

    const stored = await ada.send("get", `/api/ai/chat/conversations/${res.body.conversation_id}`);
    const kinds = stored.body.messages.map((message: { kind: string }) => message.kind);
    expect(kinds).toEqual(["message", "message", "confirmation", "mutation_result"]);
    expect(stored.body.messages[2].confirmation.status).toBe("applied");
  });

  it("applies confirmed task changes through the task state machine", async () => {
    let taskId = 0;
    const ai = new ScriptedAi([
      () => ({ role: "assistant", content: null, tool_calls: [call("a", "mark_task_completed", { task_id: taskId })] }),
      () => ({ role: "assistant", content: null, tool_calls: [call("b", "ignore_task", { task_id: taskId })] }),
      () => ({ role: "assistant", content: null, tool_calls: [call("c", "set_task_progress", { task_id: taskId, progress_percent: 100 })] }),
      () => ({ role: "assistant", content: null, tool_calls: [call("d", "undo_ignore_task", { task_id: taskId })] }),
    ]);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    const [mp] = (await ada.send("get", "/api/tasks")).body;
    const { body: reading } = await ada.send("post", "/api/tasks", { body: { course_id: mp.course.id, title: "Reading" } });
    const tasks = [mp, reading];
    const confirm = async (message: string) => {
      const proposed = await ada.send("post", "/api/ai/chat", { body: { message } });
      const done = await ada.send("post", "/api/ai/chat/confirm", { body: { confirmation_id: proposed.body.confirmation.id, action: "confirm" } });
      expect(done.body.confirmation.status).toBe("applied");
      return (await ada.send("get", `/api/tasks/${taskId}`)).body;
    };
    const history = () => db.taskProgress.findMany({ where: { taskId }, orderBy: { id: "asc" }, select: { progress: true, completed: true } });

    // Mark done: the running timer stops, the revision moves on and a history row is kept.
    taskId = tasks[0].id;
    await ada.send("post", `/api/tasks/${taskId}/work/start`);
    const done = await confirm("Mark MP 1 done");
    expect(done).toMatchObject({ state: "done", state_revision: tasks[0].state_revision + 1 });
    expect((await ada.send("get", "/api/work/active")).body.active).toBeNull();
    expect(await history()).toEqual([{ progress: 0, completed: true }]);

    // Ignore: the timer stops too.
    taskId = tasks[1].id;
    await ada.send("post", `/api/tasks/${taskId}/work/start`);
    const ignored = await confirm("Ignore it");
    expect(ignored).toMatchObject({ state: "ignored", state_revision: tasks[1].state_revision + 1 });
    expect((await ada.send("get", "/api/work/active")).body.active).toBeNull();

    // 100% completes the task, as the progress slider does.
    const full = await confirm("I finished it");
    expect(full).toMatchObject({ progress: 100, state: "done", state_revision: tasks[1].state_revision + 2 });
    expect(full.completed_at).not.toBeNull();
    expect(await history()).toEqual([{ progress: 100, completed: true }]);
    const back = await confirm("Stop ignoring it");
    expect(back).toMatchObject({ ignored_at: null, state_revision: tasks[1].state_revision + 3 });
  });

  it("lets proposals expire and be cancelled", async () => {
    const ai = new ScriptedAi([
      () => ({ role: "assistant", content: null, tool_calls: [call("a", "ignore_task", { task_id: taskId })] }),
      () => ({ role: "assistant", content: null, tool_calls: [call("b", "create_manual_event", { title: "Study group", start: "2026-12-01T15:00:00-06:00", end: "2026-12-01T16:00:00-06:00" })] }),
      () => ({ role: "assistant", content: null, tool_calls: [call("c", "create_manual_event", { title: "Bad", start: "2026-12-01T15:00:00-06:00", end: "2026-12-01T14:00:00-06:00" })] }),
      say("That end time is before the start."),
    ]);
    let taskId = 0;
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    taskId = (await taskOf(ada)).id;

    const ignore = await ada.send("post", "/api/ai/chat", { body: { message: "Ignore MP 1" } });
    await db.aiConfirmation.update({ where: { id: ignore.body.confirmation.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const expired = await ada.send("post", "/api/ai/chat/confirm", { body: { confirmation_id: ignore.body.confirmation.id, action: "confirm" } });
    expect(expired.status).toBe(410);
    expect((await ada.send("get", "/api/tasks")).body).toHaveLength(1);

    const event = await ada.send("post", "/api/ai/chat", { body: { message: "Add study group Dec 1 3pm" } });
    expect(event.body.confirmation.summary).toBe('Add "Study group" to the calendar');
    const cancelled = await ada.send("post", "/api/ai/chat/confirm", { body: { confirmation_id: event.body.confirmation.id, action: "cancel" } });
    expect(cancelled.body).toMatchObject({ message: "Change cancelled.", confirmation: { status: "cancelled" } });
    expect(await db.calendarEvent.count()).toBe(0);

    // The calendar route's own time rules apply to proposals.
    const invalid = await ada.send("post", "/api/ai/chat", { body: { message: "Add a bad one" } });
    expect(invalid.body).toMatchObject({ message: "That end time is before the start.", confirmation: null });
    expect(JSON.stringify(ai.calls[3]?.messages.at(-1))).toContain("End the event after it starts.");
  });

  it("applies a confirmed calendar event", async () => {
    const ai = new ScriptedAi([
      () => ({ role: "assistant", content: null, tool_calls: [call("b", "create_manual_event", { title: "Office hours", start: "2026-12-02", end: "2026-12-03", all_day: true })] }),
    ]);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    const res = await ada.send("post", "/api/ai/chat", { body: { message: "Add office hours Dec 2" } });
    await ada.send("post", "/api/ai/chat/confirm", { body: { confirmation_id: res.body.confirmation.id, action: "confirm" } });
    const event = await db.calendarEvent.findFirstOrThrow();
    expect(event).toMatchObject({ title: "Office hours", allDay: true, busy: false, sourceId: null });
  });

  it("proposes recurring, zoned class events with the calendar's own checks, and they expand", async () => {
    const weekly = { title: "Lecture", start: "2026-10-26T09:00", end: "2026-10-26T10:15", time_zone: "America/New_York", event_type: "class", recurrence_rule: "FREQ=WEEKLY;BYDAY=MO;COUNT=3" };
    const ai = new ScriptedAi([
      () => ({ role: "assistant", content: null, tool_calls: [call("a", "create_manual_event", { ...weekly, recurrence_rule: "FREQ=HOURLY" })] }),
      say("That rule isn't allowed."),
      () => ({ role: "assistant", content: null, tool_calls: [call("b", "create_manual_event", weekly)] }),
    ]);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    const refused = await ada.send("post", "/api/ai/chat", { body: { message: "Add my lecture hourly" } });
    expect(refused.body.confirmation).toBeNull();
    expect(JSON.stringify(ai.calls[1]?.messages.at(-1))).toContain("recurrence_rule");
    const res = await ada.send("post", "/api/ai/chat", { body: { message: "Add my Monday lecture" } });
    const details = JSON.stringify(res.body.confirmation.details);
    expect(details).toContain("FREQ=WEEKLY;COUNT=3;BYDAY=MO;WKST=MO");
    await ada.send("post", "/api/ai/chat/confirm", { body: { confirmation_id: res.body.confirmation.id, action: "confirm" } });
    const listed = (await ada.send("get", "/api/calendar/events?from=2026-10-25T00:00:00Z&to=2026-11-20T00:00:00Z")).body;
    // 9:00 in New York on each Monday, before and after the DST change on 1 November.
    expect(listed.map((event: { start: string }) => event.start)).toEqual(["2026-10-26T13:00:00.000Z", "2026-11-02T14:00:00.000Z", "2026-11-09T14:00:00.000Z"]);
    expect(listed[0]).toMatchObject({ event_type: "class", time_zone: "America/New_York" });
  });
});

describe("AI task summaries and estimates", () => {
  it("summarizes and estimates in the background, reuses the cache, and re-estimates on request", async () => {
    const ai = new InsightAi();
    const { app, services } = appWith(ai);
    const ada = await adaOn(app);
    const [task] = (await ada.send("get", "/api/tasks")).body;
    expect(task.remaining_basis).toBe("default");

    expect((await ada.send("get", `/api/ai/tasks/${task.id}/summary`)).body).toEqual({ status: "pending", summary: null });
    await services.aiJobs.whenIdle();
    expect((await ada.send("get", `/api/ai/tasks/${task.id}/summary`)).body).toEqual({ status: "ready", summary: "Build a responsive page. See" });
    expect([ai.summaries, ai.estimates]).toEqual([1, 1]);
    const estimated = (await ada.send("get", `/api/tasks/${task.id}`)).body;
    expect(estimated).toMatchObject({ remaining_basis: "ai", total_minutes: 95, remaining_minutes: 95 });

    // Cached: asking again makes no new call.
    await ada.send("get", `/api/ai/tasks/${task.id}/summary`);
    await services.aiJobs.whenIdle();
    expect([ai.summaries, ai.estimates]).toEqual([1, 1]);

    // The student's own estimate wins over the AI's.
    const own = await ada.send("patch", `/api/tasks/${task.id}`, { body: { estimated_minutes: 200 } });
    expect(own.body).toMatchObject({ remaining_basis: "estimate", total_minutes: 200 });

    expect((await ada.send("post", `/api/tasks/${task.id}/reestimate`)).status).toBe(202);
    await services.aiJobs.whenIdle();
    expect(ai.estimates).toBe(2);

    const bob = await bobOn(app);
    expect((await bob.send("get", `/api/ai/tasks/${task.id}/summary`)).status).toBe(404);
    expect((await bob.send("post", `/api/tasks/${task.id}/reestimate`)).status).toBe(404);
  });

  it("shows nothing without AI and keeps plain text only", async () => {
    const { app } = appWith(null);
    const ada = await adaOn(app);
    const [task] = (await ada.send("get", "/api/tasks")).body;
    expect((await ada.send("get", `/api/ai/tasks/${task.id}/summary`)).body).toEqual({ status: "unavailable", summary: null });
    expect((await ada.send("post", `/api/tasks/${task.id}/reestimate`)).status).toBe(503);
    expect(cleanSummary("<p>Read <a href='x'>this</a></p>  http://x.y/z")).toBe("Read this");
    expect(cleanSummary("   ")).toBeNull();
  });

  it("gives up on an input after two failed attempts", async () => {
    const failing: AiProvider = { model: "m", source: "server", complete: async () => ({ role: "assistant", content: "not json" }) };
    const { app, services } = appWith(failing);
    const ada = await adaOn(app);
    const [task] = (await ada.send("get", "/api/tasks")).body;
    await ada.send("get", `/api/ai/tasks/${task.id}/summary`);
    await services.aiJobs.whenIdle();
    await ada.send("get", `/api/ai/tasks/${task.id}/summary`);
    await services.aiJobs.whenIdle();
    expect((await ada.send("get", `/api/ai/tasks/${task.id}/summary`)).body).toEqual({ status: "failed", summary: null });
  });
});

