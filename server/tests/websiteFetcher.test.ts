import http from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { ntlmExchange, probeWebsite, ResourceFetcher, WebsiteProbeError, type AuthRule } from "../src/sources/website/fetcher.js";
import { DEFAULT_LIMITS, nodeTransport } from "../src/sources/website/http.js";
import { inAuthScope, normalizedHttpUrl, normalizedProbeUrl, protectedPrefix, websiteNtlmScope } from "../src/sources/website/scope.js";
import { canonicalizeUrl, contentHash, normalizeText } from "../src/sources/website/normalize.js";
import { fakeSite } from "./sourcesFakes.js";

const BASE = "https://courses.example.edu/test101/fall/";
const ACCOUNT = { username: "SCHOOL\\student", password: "test-only-secret" };
const RULE: AuthRule = { pathPrefix: "/test101/fall/", baseUrl: BASE, credentialId: "site" };

describe("auth scope", () => {
  it.each([
    "https://evil.example/test101/fall/secure/a",
    "http://courses.example.edu/test101/fall/secure/a",
    "https://courses.example.edu:444/test101/fall/secure/a",
    BASE + "../other/a",
    BASE + "%2e%2e/other/a",
    BASE + "%252e%252e/other/a",
    BASE + "secure/../../other/a",
    BASE + "secure\\a",
    BASE + "secure//a",
    BASE + "./a",
    BASE + "a\nb",
    "https://courses.example.edu/test101/fall-other/a",
    "https://user:password@courses.example.edu/test101/fall/a",
  ])("rejects %s", (url) => {
    expect(inAuthScope(url, BASE, "/test101/fall/")).toBe(false);
  });

  it("accepts the prefix itself, its children and an explicit default port", () => {
    expect(inAuthScope("https://courses.example.edu/test101/fall", BASE, "/test101/fall/")).toBe(true);
    expect(inAuthScope(BASE + "secure/a.pdf?x=1", BASE, "/test101/fall/")).toBe(true);
    expect(inAuthScope("https://COURSES.example.edu:443/test101/fall/a", BASE, "/test101/fall/")).toBe(true);
    expect(inAuthScope(BASE + "secure-other/a", BASE, "/test101/fall/secure")).toBe(false);
  });

  it("normalizes base and probe URLs", () => {
    expect(normalizedHttpUrl(" https://Site.Example/course/ ")).toBe("https://site.example/course");
    for (const bad of ["ftp://x/", "https://u:p@x/", "https://x/?a=1", "https://x/#f", "https://x\\y/"]) {
      expect(() => normalizedHttpUrl(bad)).toThrow();
    }
    expect(normalizedProbeUrl("https://Site.Example/c/p?page=2#top")).toBe("https://site.example/c/p?page=2");
    for (const bad of [
      "http://site.example/c/p",
      "https://site.example/c/p?access_token=x",
      "https://site.example/c/p?X-Amz-Signature=x",
      "https://site.example/c/p?sid=1",
      "https://site.example/" + "a".repeat(600),
    ]) {
      expect(() => normalizedProbeUrl(bad)).toThrow();
    }
  });

  it("defaults to the course directory and keeps explicit scopes inside it", () => {
    expect(websiteNtlmScope("https://site.example/course")).toEqual({ scope: "/course/", target: "https://site.example/course" });
    expect(websiteNtlmScope("https://site.example/c/index.html").scope).toBe("/c/");
    expect(websiteNtlmScope("https://site.example/course", "course/secure").scope).toBe("/course/secure/");
    for (const [base, prefix, probe] of [
      ["http://site.example/course", null, null],
      ["https://site.example/course", "/", null],
      ["https://site.example/course", null, "https://evil.example/test"],
      ["https://site.example/course", null, "https://site.example/course/%2e%2e/test"],
      ["https://site.example/course", "https://outside.example/x", null],
    ] as const) {
      expect(() => websiteNtlmScope(base, prefix, probe)).toThrow();
    }
    expect(protectedPrefix("  ")).toBe("");
  });
});

describe("normalizer", () => {
  it("canonicalizes URLs and text", () => {
    expect(normalizeText(" hello\n  world ")).toBe("hello world");
    expect(canonicalizeUrl("/x//file.pdf?utm_source=a&b=2&a=1#part", "HTTPS://Example.EDU/course/")).toBe(
      "https://example.edu/x/file.pdf?a=1&b=2",
    );
    expect(contentHash({ b: 2, a: 1 }, "x   y")).toBe(contentHash({ a: 1, b: 2 }, "x y"));
  });
});

function fetcherFor(site: ReturnType<typeof fakeSite>, credential = true) {
  return new ResourceFetcher({ transport: site.transport, credentials: (id) => (credential && id === "site" ? ACCOUNT : null) });
}

describe("resource fetcher", () => {
  it.each([
    [200, "", 0],
    [401, "Basic", 0],
    [401, "NTLM", 2],
    [401, "Negotiate", 2],
    [401, 'Basic realm="ntlm"', 0],
  ])("status %i with challenge %j sends %i authorized requests", async (status, challenge, authorized) => {
    const site = fakeSite({
      account: ACCOUNT,
      challengeHeader: challenge,
      protectedUrl: () => status === 401 && challenge !== "Basic" && challenge !== 'Basic realm="ntlm"',
      pages: { [BASE + "a"]: { status, headers: { "www-authenticate": challenge } } },
    });
    const result = await fetcherFor(site).fetch(BASE + "a", RULE);
    expect(site.requests.filter((request) => request.authorization).length).toBe(authorized);
    expect(result.authenticated).toBe(authorized > 0);
    if (authorized) {
      expect(result.status).toBe("ok");
      expect(site.requests.at(-1)?.authorization?.startsWith(challenge)).toBe(true);
    }
  });

  it("runs the handshake on one dedicated connection and reuses it per credential", async () => {
    const site = fakeSite({ account: ACCOUNT, protectedUrl: (url) => url.includes("/secure/") });
    const fetcher = fetcherFor(site);
    expect((await fetcher.fetch(BASE + "secure/a", RULE)).status).toBe("ok");
    expect((await fetcher.fetch(BASE + "secure/b", RULE)).status).toBe("ok");
    const authorized = site.requests.filter((request) => request.authorization);
    expect(new Set(authorized.map((request) => request.connection)).size).toBe(1);
    expect(authorized[0]?.connection).not.toBe(site.requests[0]?.connection);
  });

  it("reports a wrong password as auth_failed", async () => {
    const site = fakeSite({ account: { ...ACCOUNT, password: "other" }, protectedUrl: () => true });
    const result = await fetcherFor(site).fetch(BASE + "a", RULE);
    expect(result.status).toBe("auth_failed");
  });

  it("never sends a password outside the scope, over http, or without a loaded credential", async () => {
    const site = fakeSite({ account: ACCOUNT, protectedUrl: () => true });
    const fetcher = fetcherFor(site);
    expect((await fetcher.fetch("https://evil.example/test101/fall/a", RULE)).error).toBe("auth_scope_rejected");
    const plain = await fetcher.fetch("http://courses.example.edu/test101/fall/a", { ...RULE, baseUrl: BASE.replace("https", "http") });
    expect(plain.error).toBe("auth_scope_rejected");
    const missing = await fetcherFor(site, false).fetch(BASE + "a", RULE);
    expect(missing).toMatchObject({ status: "auth_required", error: "credential_not_loaded" });
    expect(site.requests.filter((request) => request.authorization)).toEqual([]);
  });

  it("does not let an anonymous redirect carry the password elsewhere", async () => {
    const site = fakeSite({
      account: ACCOUNT,
      protectedUrl: (url) => !url.startsWith(BASE),
      pages: {
        [BASE]: { status: 302, headers: { location: "https://evil.example/steal" } },
        [BASE + "x"]: { status: 302, headers: { location: "/other/private" } },
      },
    });
    const fetcher = fetcherFor(site);
    expect((await fetcher.fetch(BASE, RULE)).error).toBe("redirect_out_of_scope");
    // Same origin is followed anonymously, but the 401 there is outside the credential's scope.
    expect((await fetcher.fetch(BASE + "x", RULE)).error).toBe("auth_scope_rejected");
    expect(site.requests.filter((request) => request.authorization)).toEqual([]);
  });

  it("never follows a redirect on the authenticated connection", async () => {
    const site = fakeSite({
      account: ACCOUNT,
      protectedUrl: () => true,
      protectedReply: () => ({ status: 302, headers: { location: "https://evil.example/steal" } }),
    });
    const result = await fetcherFor(site).fetch(BASE + "a", RULE);
    expect(result).toMatchObject({ status: "error", error: "http_302", authenticated: true });
    expect(site.requests.some((request) => request.url.includes("evil"))).toBe(false);
  });

  it("follows same-origin redirects anonymously and reports the final URL", async () => {
    const site = fakeSite({
      pages: {
        "https://courses.example.edu/test101/fall": { status: 301, headers: { location: "/test101/fall/" } },
        [BASE]: { status: 200, headers: { "content-type": "text/html; charset=utf-8", etag: '"1"' }, body: "<p>x</p>" },
      },
    });
    const result = await fetcherFor(site).fetch("https://courses.example.edu/test101/fall");
    expect(result).toMatchObject({ status: "ok", url: BASE, contentType: "text/html", etag: '"1"' });
  });

  it("limits NTLM work to three handshakes at once across credentials", async () => {
    const site = fakeSite({ account: ACCOUNT, protectedUrl: (url) => url.includes("/secure/"), delayMs: 5 });
    const fetcher = new ResourceFetcher({ transport: site.transport, credentials: () => ACCOUNT });
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, index) => fetcher.fetch(BASE + `secure/${index}`, { ...RULE, credentialId: `c${index}` })),
    );
    expect(results.every((result) => result.status === "ok")).toBe(true);
    const authorizedConnections = new Set(site.requests.filter((r) => r.authorization).map((r) => r.connection));
    expect(authorizedConnections.size).toBe(8);
    expect(site.maxAuthorizedInFlight).toBe(3);
  });
});

describe("probeWebsite", () => {
  const SITE = "https://site.example/course/";
  function probeSite(options: { protectedLink?: boolean; password?: string } = {}) {
    return fakeSite({
      account: { ...ACCOUNT, password: options.password ?? ACCOUNT.password },
      protectedUrl: (url) => url.endsWith("/private"),
      pages: {
        "https://site.example/course": {
          status: 200,
          headers: { "content-type": "text/html" },
          body:
            options.protectedLink === false
              ? "public"
              : '<a href="https://evil.example/private">ignore</a><a href="/course/private">actual</a>',
        },
      },
    });
  }
  const config = { baseUrl: SITE, authenticationMethod: "ntlm" as const };

  it("verifies through a real in-scope link and never visits other origins", async () => {
    const site = probeSite();
    const result = await probeWebsite(config, ACCOUNT, { transport: site.transport });
    expect(result).toMatchObject({ verified: true, publicOnly: false, probeUrl: "https://site.example/course/private" });
    expect(site.requests.every((request) => !request.url.includes("evil"))).toBe(true);
    expect(site.requests.filter((request) => !request.authorization).length).toBe(2);
  });

  it("fails a wrong password", async () => {
    const site = probeSite({ password: "different" });
    await expect(probeWebsite(config, ACCOUNT, { transport: site.transport })).rejects.toThrow(/Protected access/);
  });

  it("reports a public-only site honestly", async () => {
    const site = probeSite({ protectedLink: false });
    const result = await probeWebsite(config, ACCOUNT, { transport: site.transport });
    expect(result).toMatchObject({ verified: false, publicOnly: true });
    expect(site.requests.length).toBe(1);
  });

  it("checks public sites without credentials and rejects bad configuration", async () => {
    const site = probeSite();
    const result = await probeWebsite({ baseUrl: SITE, authenticationMethod: "none" }, null, { transport: site.transport });
    expect(result.message).toBe("Public website reachable.");
    await expect(probeWebsite({ ...config, baseUrl: "http://site.example/course" }, ACCOUNT, { transport: site.transport })).rejects.toBeInstanceOf(
      WebsiteProbeError,
    );
    await expect(probeWebsite(config, { username: " ", password: "x" }, { transport: site.transport })).rejects.toThrow("Username");
  });
});

describe("node transport on real sockets", () => {
  let server: http.Server | null = null;
  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve) ?? resolve(null));
    server = null;
  });

  async function listen(handler: http.RequestListener): Promise<string> {
    server = http.createServer(handler);
    server.keepAliveTimeout = 5_000;
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  it("returns redirects instead of following them and enforces size and time limits", async () => {
    const origin = await listen((request, response) => {
      if (request.url === "/redirect") response.writeHead(302, { location: "http://evil.example/" }).end();
      else if (request.url === "/big") response.end(Buffer.alloc(2_000));
      else if (request.url === "/slow") setTimeout(() => response.end("late"), 500);
      else response.end("ok");
    });
    const connection = nodeTransport().open({ maxSockets: 1 });
    try {
      expect((await connection.get(origin + "/redirect", {}, DEFAULT_LIMITS)).status).toBe(302);
      await expect(connection.get(origin + "/big", {}, { ...DEFAULT_LIMITS, maxBytes: 1_000 })).rejects.toThrow("response_too_large");
      await expect(connection.get(origin + "/slow", {}, { ...DEFAULT_LIMITS, timeoutMs: 50 })).rejects.toThrow("timeout");
      await expect(connection.get("ftp://x/", {}, DEFAULT_LIMITS)).rejects.toThrow("unsupported_scheme");
    } finally {
      connection.close();
    }
  });

  it("keeps the NTLM handshake on one keep-alive socket", async () => {
    const sockets = new Map<Socket, number>();
    const site = fakeSite({ account: ACCOUNT, protectedUrl: () => true });
    // Each real socket maps to one fake connection, so the fake checks socket binding for us.
    const fakeConnections = new Map<Socket, ReturnType<typeof site.transport.open>>();
    const origin = await listen(async (request, response) => {
      const socket = request.socket;
      if (!sockets.has(socket)) sockets.set(socket, sockets.size + 1);
      if (!fakeConnections.has(socket)) fakeConnections.set(socket, site.transport.open({ maxSockets: 1 }));
      const headers: Record<string, string> = request.headers.authorization ? { Authorization: request.headers.authorization } : {};
      const reply = await fakeConnections.get(socket)!.get("https://fake" + request.url, headers, DEFAULT_LIMITS);
      response.writeHead(reply.status, reply.headers as http.OutgoingHttpHeaders).end(reply.body);
    });
    const connection = nodeTransport().open({ maxSockets: 1 });
    try {
      const result = await ntlmExchange(connection, origin + "/secure", "NTLM", ACCOUNT, DEFAULT_LIMITS);
      expect(result).toMatchObject({ status: "ok", authenticated: true });
      expect(sockets.size).toBe(1);
    } finally {
      connection.close();
    }
  });
});
