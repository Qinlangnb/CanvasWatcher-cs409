import { describe, expect, it } from "vitest";
import { CanvasClient, CanvasError } from "../src/canvas/client.js";
import { CanvasAddressError, canvasOrigin } from "../src/canvas/hosts.js";
import { changeSummary, changedFields, htmlToText, taskType } from "../src/canvas/normalize.js";
import { SecretBox } from "../src/security/secretBox.js";

const ALLOWED = ["canvas.illinois.edu", "*.instructure.com"];

describe("canvasOrigin", () => {
  it("reduces a pasted Canvas page to its https origin", () => {
    expect(canvasOrigin("https://canvas.illinois.edu/courses/1/assignments?x=1", ALLOWED)).toBe("https://canvas.illinois.edu");
    expect(canvasOrigin("  canvas.illinois.edu  ", ALLOWED)).toBe("https://canvas.illinois.edu");
    expect(canvasOrigin("https://school.instructure.com/", ALLOWED)).toBe("https://school.instructure.com");
  });

  it.each([
    ["http://canvas.illinois.edu"],
    ["https://canvas.illinois.edu:8443"],
    ["https://user@canvas.illinois.edu"],
    ["https://localhost"],
    ["https://169.254.169.254"],
    ["https://instructure.com.evil.example"],
    ["https://evilinstructure.com"],
    ["not a url at all"],
  ])("refuses %s", (input) => {
    expect(() => canvasOrigin(input, ALLOWED)).toThrow(CanvasAddressError);
  });
});

describe("SecretBox", () => {
  const box = new SecretBox(Buffer.alloc(32, 1));

  it("opens what it sealed for the same context", () => {
    const sealed = box.seal("token-value", "user-a");
    expect(sealed).not.toContain("token-value");
    expect(box.open(sealed, "user-a")).toBe("token-value");
  });

  it("refuses another context, another key or a tampered value", () => {
    const sealed = box.seal("token-value", "user-a");
    expect(() => box.open(sealed, "user-b")).toThrow();
    expect(() => new SecretBox(Buffer.alloc(32, 2)).open(sealed, "user-a")).toThrow();
    const parts = sealed.split(".");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => box.open(parts.join("."), "user-a")).toThrow();
  });
});

describe("normalize", () => {
  it("turns Canvas HTML into readable text", () => {
    expect(htmlToText("<p>Read <b>chapter&nbsp;3</b> &amp; 4</p><script>x()</script><p>Due &#8212; Friday</p>")).toBe(
      "Read chapter 3 & 4\nDue — Friday",
    );
    expect(htmlToText(null)).toBe("");
  });

  it("guesses task types like the legacy backend", () => {
    expect(taskType("Final Project Proposal")).toBe("project");
    expect(taskType("Midterm 1")).toBe("exam");
    expect(taskType("Quiz 3")).toBe("exam");
    expect(taskType("Reading response")).toBe("reading");
    expect(taskType("HW 4")).toBe("homework");
    expect(taskType("MP 1: Layout")).toBe("assignment");
  });

  it("names changed fields in summaries", () => {
    const fields = changedFields({ title: "A", due_at: "x", points_possible: 10 }, { title: "A", due_at: "y", points_possible: 20 });
    expect(fields).toEqual(["due_at", "points_possible"]);
    expect(changeSummary("ASSIGNMENT", "UPDATED", "HW 3", ["due_at"])).toBe('Due date changed for "HW 3"');
    expect(changeSummary("ASSIGNMENT", "UPDATED", "HW 3", fields)).toBe('Due date and points changed for "HW 3"');
    expect(changeSummary("FILE", "CREATED", "notes.pdf")).toBe("New file: notes.pdf");
    expect(changeSummary("ANNOUNCEMENT", "CREATED", "Exam room")).toBe('New announcement: "Exam room"');
  });
});

describe("CanvasClient", () => {
  const ORIGIN = "https://canvas.example.edu";

  function client(handler: (url: URL, attempt: number) => Response | Promise<Response>) {
    let attempt = 0;
    const calls: string[] = [];
    const fetchImpl: typeof fetch = async (input) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      return handler(url, attempt++);
    };
    return { calls, canvas: new CanvasClient({ baseUrl: ORIGIN, token: "t", fetch: fetchImpl, retryDelayMs: 1 }) };
  }

  it("follows Link pagination and asks for 100 rows a page", async () => {
    const { calls, canvas } = client((url) =>
      url.searchParams.get("page") === "2"
        ? Response.json([{ id: 3 }])
        : Response.json([{ id: 1 }, { id: 2 }], { headers: { link: `<${ORIGIN}/api/v1/courses?page=2>; rel="next"` } }),
    );
    await expect(canvas.courses()).resolves.toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("per_page=100");
  });

  it("will not follow pagination to another site", async () => {
    const { canvas } = client(() =>
      Response.json([{ id: 1 }], { headers: { link: '<https://evil.example/api/v1/courses?page=2>; rel="next"' } }),
    );
    await expect(canvas.courses()).rejects.toMatchObject({ kind: "BAD_RESPONSE" });
  });

  it("retries throttled and failing requests, then succeeds", async () => {
    const { calls, canvas } = client((_url, attempt) =>
      attempt === 0
        ? new Response("Rate Limit Exceeded", { status: 403 })
        : attempt === 1
          ? new Response("oops", { status: 502 })
          : Response.json({ id: 7, name: "Ada" }),
    );
    await expect(canvas.self()).resolves.toEqual({ id: 7, name: "Ada" });
    expect(calls).toHaveLength(3);
  });

  it("reports a rejected token without retrying", async () => {
    const { calls, canvas } = client(() => new Response("{}", { status: 401 }));
    const error = await canvas.self().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(CanvasError);
    expect(error).toMatchObject({ kind: "TOKEN_REJECTED", status: 401 });
    expect(calls).toHaveLength(1);
  });

  it("reports an unreachable Canvas after its retries", async () => {
    const { calls, canvas } = client(() => {
      throw new TypeError("fetch failed");
    });
    await expect(canvas.self()).rejects.toMatchObject({ kind: "UNREACHABLE" });
    expect(calls).toHaveLength(3);
  });
});
