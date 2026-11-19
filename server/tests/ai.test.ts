import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { AiProvider, AssistantMessage, ChatMessage, ToolSpec } from "../src/ai/provider.js";
import { AiError, OpenAiCompatibleProvider } from "../src/ai/provider.js";
import { createApp } from "../src/app.js";
import { createServices } from "../src/services.js";
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
  readonly calls: { messages: ChatMessage[]; tools: ToolSpec[] }[] = [];
  constructor(private readonly steps: Step[]) {}
  async complete(messages: ChatMessage[], tools: ToolSpec[]): Promise<AssistantMessage> {
    this.calls.push({ messages: structuredClone(messages), tools });
    const step = this.steps[this.calls.length - 1];
    if (!step) throw new Error("no scripted reply left");
    return step(messages, tools);
  }
}

const call = (id: string, name: string, args: object = {}) => ({ id, type: "function" as const, function: { name, arguments: JSON.stringify(args) } });

function appWith(ai: AiProvider | null) {
  const services = createServices({ config, db, logger, canvas: fakeCanvas.factory, ai });
  return { app: createApp({ config, db, logger, services }), services };
}

/** Ada, synced from the fake Canvas, signed in on a browser of `app`. */
async function adaOn(app: ReturnType<typeof appWith>["app"]): Promise<Browser> {
  seedCourse(fakeCanvas);
  fakeCanvas.syllabusBodies.set("101", "<h2>Grading</h2><p>MPs 40%, Midterm 25%, Final 35%. Final grades: A 90, B 80, C 70, D 60.</p>");
  const assignment = fakeCanvas.assignments.get("101")?.[0];
  if (assignment) assignment.submission = { workflow_state: "graded", submitted_at: new Date().toISOString(), score: 92, grade: "92" };
  await connectCanvas(await signUp());
  const browser = new Browser(app);
  expect((await browser.signIn()).status).toBe(201);
  return browser;
}

describe("used time and scores", () => {
  it("keeps the time used and works out what is left from the pace", async () => {
    seedCourse(fakeCanvas);
    const ada = await signUp();
    await connectCanvas(ada);
    const [task] = (await ada.send("get", "/api/tasks")).body;
    expect(task).toMatchObject({ spent_minutes: 0, remaining_basis: "default", remaining_minutes: 120 });

    const used = await ada.send("patch", `/api/tasks/${task.id}`, { body: { spent_minutes: 90 } });
    expect(used.body).toMatchObject({ spent_minutes: 90, remaining_basis: "default", remaining_minutes: 120 });
    // 90 minutes for 30% means about 210 more for the other 70%.
    const paced = await ada.send("patch", `/api/tasks/${task.id}`, { body: { progress: 30 } });
    expect(paced.body).toMatchObject({ remaining_basis: "pace", remaining_minutes: 210 });
    const estimated = await ada.send("patch", `/api/tasks/${task.id}`, { body: { spent_minutes: 0, estimated_minutes: 200 } });
    expect(estimated.body).toMatchObject({ remaining_basis: "estimate", remaining_minutes: 140 });

    const bad = await ada.send("patch", `/api/tasks/${task.id}`, { body: { spent_minutes: -5 } });
    expect(bad.status).toBe(422);
  });

  it("stores the Canvas score and gives one task's description", async () => {
    seedCourse(fakeCanvas);
    const assignment = fakeCanvas.assignments.get("101")?.[0];
    if (assignment) assignment.submission = { workflow_state: "graded", submitted_at: new Date().toISOString(), score: 18.5, grade: "18.5", excused: false };
    const ada = await signUp();
    await connectCanvas(ada);
    const [task] = (await ada.send("get", "/api/tasks?status=all")).body;
    expect(task).toMatchObject({ score: 18.5, grade: "18.5", excused: false });
    const detail = await ada.send("get", `/api/tasks/${task.id}`);
    expect(detail.body.description).toBe("Build a responsive page.");
  });
});

describe("AI Chat", () => {
  it("is off without a key", async () => {
    const { app } = appWith(null);
    const ada = await adaOn(app);
    expect((await ada.send("get", "/api/ai")).body).toEqual({ enabled: false, model: null, source: null });
    const res = await ada.send("post", "/api/ai/chat", { body: { message: "Hi" } });
    expect(res.status).toBe(503);
    expect(res.body.code).toBe("AI_DISABLED");
  });

  it("looks up courses, scores and the syllabus with tools, then answers", async () => {
    const ai = new ScriptedAi([
      () => ({ role: "assistant", content: null, tool_calls: [call("a", "list_courses")] }),
      (messages) => {
        const courses = JSON.parse((messages.at(-1) as { content: string }).content);
        const id = courses.courses[0].id;
        return {
          role: "assistant",
          content: null,
          reasoning_content: "Need the syllabus and the grades.",
          tool_calls: [call("b", "get_course_syllabus", { course_id: id }), call("c", "list_tasks", { course_id: id, status: "all" })],
        };
      },
      () => ({ role: "assistant", content: "MP 1 got **92/100**; MPs are 40% of the grade." }),
    ]);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    expect((await ada.send("get", "/api/ai")).body).toEqual({ enabled: true, model: "scripted", source: "server" });

    const res = await ada.send("post", "/api/ai/chat", {
      body: { message: "How am I doing in CS 409?", page: { path: "/today", course_id: null } },
    });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ message: "MP 1 got **92/100**; MPs are 40% of the grade.", tools_used: ["list_courses", "get_course_syllabus", "list_tasks"], confirmation: null });
    expect(res.body.tool_results).toEqual([expect.objectContaining({ title: "CS 409 syllabus", route: expect.stringMatching(/^\/courses\/\d+$/) })]);

    const [first, , third] = ai.calls;
    expect(first?.tools.map((tool) => tool.function.name)).toEqual(
      expect.arrayContaining(["list_courses", "list_tasks", "get_task", "get_course_syllabus", "list_calendar_events"]),
    );
    expect((first?.messages[0] as { content: string }).content).toContain("America/Chicago");
    const results = third?.messages.filter((message) => message.role === "tool").map((message) => (message as { content: string }).content) ?? [];
    expect(results.join("\n")).toContain("Final grades: A 90, B 80");
    expect(results.join("\n")).toContain('"score":92');
    // The reasoning is sent back on the round after the tool call, as DeepSeek requires.
    expect(third?.messages.some((message) => message.role === "assistant" && message.reasoning_content === "Need the syllabus and the grades.")).toBe(true);
  });

  it("returns bad tool arguments to the model and stops looking after the round limit", async () => {
    const steps: Step[] = Array.from({ length: 8 }, (_, index) => () => ({
      role: "assistant",
      content: null,
      tool_calls: [call(`x${index}`, index === 0 ? "get_task" : "list_courses", index === 0 ? { task_id: "nope" } : {})],
    }));
    steps.push((_messages, tools) => {
      expect(tools).toEqual([]);
      return { role: "assistant", content: "Here is what I found." };
    });
    const ai = new ScriptedAi(steps);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    const res = await ada.send("post", "/api/ai/chat", { body: { message: "Look around" } });
    expect(res.body.message).toBe("Here is what I found.");
    const second = ai.calls[1]?.messages.find((message) => message.role === "tool") as { content: string };
    expect(second.content).toContain("task_id");
  });

  it("only sees the signed-in user's data", async () => {
    const ai = new ScriptedAi([
      () => ({ role: "assistant", content: null, tool_calls: [call("a", "list_tasks", { status: "all" })] }),
      () => ({ role: "assistant", content: "Nothing." }),
    ]);
    const { app } = appWith(ai);
    await adaOn(app);
    const bob = new Browser(app);
    await bob.send("post", "/api/users", { body: { username: "bob", email: "bob@example.com", password: "test-password-123" } });
    await bob.send("post", "/api/ai/chat", { body: { message: "My tasks?" } });
    const result = ai.calls[1]?.messages.find((message) => message.role === "tool") as { content: string };
    expect(JSON.parse(result.content)).toEqual({ count: 0, tasks: [] });
  });

  it("maps provider failures to a fixed message", async () => {
    const ai = new ScriptedAi([
      () => {
        throw new AiError("rate_limited", "The AI service is busy. Try again in a minute.");
      },
    ]);
    const { app } = appWith(ai);
    const ada = await adaOn(app);
    const res = await ada.send("post", "/api/ai/chat", { body: { message: "Hi" } });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ code: "AI_RATE_LIMITED" });
  });

  it("rejects an empty message", async () => {
    const { app } = appWith(new ScriptedAi([]));
    const ada = await adaOn(app);
    const res = await ada.send("post", "/api/ai/chat", { body: { message: "   " } });
    expect(res.status).toBe(422);
  });
});

describe("OpenAI-compatible provider", () => {
  it("sends the model, messages and tools and reads tool calls back", async () => {
    let sent: { url: string; body: Record<string, unknown>; auth: string | null } | null = null;
    const fetchImpl: typeof fetch = async (input, init) => {
      sent = {
        url: String(input),
        body: JSON.parse(String(init?.body)),
        auth: new Headers(init?.headers).get("Authorization"),
      };
      return new Response(
        JSON.stringify({ choices: [{ message: { content: null, tool_calls: [call("t1", "list_courses")], reasoning_content: "hmm" } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    };
    const provider = new OpenAiCompatibleProvider({ baseUrl: "https://ai.example.com/v1", apiKey: "test-key", model: "m1" }, fetchImpl);
    const reply = await provider.complete([{ role: "user", content: "Hi" }], []);
    expect(reply).toEqual({ role: "assistant", content: null, tool_calls: [call("t1", "list_courses")], reasoning_content: "hmm" });
    expect(sent).toMatchObject({ url: "https://ai.example.com/v1/chat/completions", auth: "Bearer test-key", body: { model: "m1", stream: false } });
    expect(sent!.body).not.toHaveProperty("tools");
  });

  it("turns HTTP errors into fixed kinds", async () => {
    const answer = (status: number) => new OpenAiCompatibleProvider({ baseUrl: "https://ai.example.com/v1", apiKey: "k", model: "m" }, async () => new Response("{}", { status }));
    await expect(answer(401).complete([], [])).rejects.toMatchObject({ kind: "auth" });
    await expect(answer(429).complete([], [])).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(answer(500).complete([], [])).rejects.toMatchObject({ kind: "unavailable" });
  });
});
