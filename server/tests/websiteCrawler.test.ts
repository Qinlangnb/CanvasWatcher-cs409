import { readFileSync } from "node:fs";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { blocksText } from "../src/canvas/richText.js";
import { crawlWebsite, WebsiteCrawler } from "../src/sources/website/crawler.js";
import { docxBlocks, fileBlocks, readZipEntry, textBlocks } from "../src/sources/website/documents.js";
import { ResourceFetcher } from "../src/sources/website/fetcher.js";
import { isZipContainer, safeFilename, validateCourseFile } from "../src/sources/website/integrity.js";
import { fakeSite, type FakeReply } from "./sourcesFakes.js";

const fixture = (name: string) => readFileSync(new URL(`./fixtures/sources/${name}`, import.meta.url));
const ACCOUNT = { username: "SCHOOL\\student", password: "test-only-secret" };
const BASE = "https://courses.example.edu/test101/fa26/";
const html = (body: string | Buffer): FakeReply => ({ status: 200, headers: { "content-type": "text/html" }, body });
const pdf: FakeReply = { status: 200, headers: { "content-type": "application/pdf" }, body: fixture("fake_protected.pdf") };

/** A minimal ZIP writer (deflate) for building test .docx files. */
function zip(entries: Record<string, string>): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name);
    const data = deflateRawSync(Buffer.from(text));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(Buffer.byteLength(text), 22);
    local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(8, 10);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(Buffer.byteLength(text), 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, nameBytes, data);
    centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
const DOCX = zip({
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": `<w:document ${W}><w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Grading</w:t></w:r></w:p>
    <w:tbl><w:tr><w:tc><w:p><w:r><w:t>Item</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Weight</w:t></w:r></w:p></w:tc></w:tr>
    <w:tr><w:tc><w:p><w:r><w:t>Final exam</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>40%</w:t></w:r></w:p></w:tc></w:tr></w:tbl>
    <w:p><w:r><w:t xml:space="preserve">Late work &amp; makeups</w:t></w:r></w:p>
  </w:body></w:document>`,
});

function schedulePages(protectedUrl: (url: string) => boolean) {
  return fakeSite({
    account: ACCOUNT,
    protectedUrl,
    protectedReply: (url) => (url.endsWith(".pdf") ? pdf : html(fixture("protected_office_hours.html"))),
    pages: {
      "https://courses.example.edu/test101/fa26": { status: 301, headers: { location: BASE } },
      [BASE]: html(fixture("public_schedule.html")),
      [BASE + "course-description.html"]: html("<html><head><title>About</title></head><body><h2>Grading</h2><p>Homework 30%</p></body></html>"),
    },
  });
}

describe("website crawler", () => {
  it("records protected pages as pending AUTH_REQUIRED when no password is stored", async () => {
    const site = schedulePages((url) => url.includes("/secure/"));
    const fetcher = new ResourceFetcher({ transport: site.transport });
    const result = await crawlWebsite(
      { name: "Test site", baseUrl: BASE, authRules: [{ pathPrefix: "/test101/fa26/secure/", credentialId: "site" }] },
      fetcher,
    );
    expect(result.pages.map((page) => page.url)).toEqual([BASE, BASE + "course-description.html"]);
    expect(result.pages[0]?.title).toBe("TEST 101 Schedule");
    expect(result.pages[1]?.blocks[0]).toEqual({ type: "heading", level: 2, text: "Grading" });
    expect(result.pending).toEqual([
      expect.objectContaining({ url: BASE + "secure/office-hours.html", itemType: "website_page", state: "AUTH_REQUIRED", credentialId: "site" }),
      expect.objectContaining({ url: BASE + "secure/lecture-01.pdf", itemType: "website_file", state: "AUTH_REQUIRED", errorCode: "credential_not_loaded" }),
    ]);
    expect(result.health).toBe("AUTH_REQUIRED");
  });

  it("fetches protected pages and validated files with a credential, retrying pending URLs as seeds", async () => {
    const site = schedulePages((url) => url.includes("/secure/"));
    const fetcher = new ResourceFetcher({ transport: site.transport, credentials: () => ACCOUNT });
    const result = await crawlWebsite(
      {
        name: "Test site",
        baseUrl: BASE,
        maxDepth: 0,
        authRules: [{ pathPrefix: "/test101/fa26/secure/", credentialId: "site" }],
        retryUrls: [BASE + "secure/lecture-01.pdf", "https://evil.example/test101/fa26/x"],
      },
      fetcher,
    );
    expect(result.pages.map((page) => page.url)).toEqual([BASE]);
    expect(result.files).toHaveLength(1);
    const [file] = result.files;
    expect(file).toMatchObject({ filename: "lecture-01.pdf", credentialId: "site", integrity: { valid: true, status: "VALID" } });
    expect(file?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(file?.content?.subarray(0, 5).toString()).toBe("%PDF-");
    expect(result.health).toBe("HEALTHY");
    expect(site.requests.some((request) => request.url.includes("evil"))).toBe(false);
  });

  it("asks for a stored file conditionally and keeps it when the site answers 304", async () => {
    const lecture = BASE + "secure/lecture-01.pdf";
    const site = fakeSite({
      account: ACCOUNT,
      protectedUrl: (url) => url.includes("/secure/"),
      protectedReply: (_url, headers) =>
        headers["If-None-Match"] === '"v1"' ? { status: 304, headers: { etag: '"v1"' } } : { ...pdf, headers: { ...pdf.headers, etag: '"v2"' } },
      pages: { [BASE]: html('<a href="secure/lecture-01.pdf">Lecture 1</a> <a href="secure/lecture-02.pdf">Lecture 2</a>') },
    });
    const fetcher = new ResourceFetcher({ transport: site.transport, credentials: () => ACCOUNT });
    const result = await crawlWebsite(
      {
        name: "Test site",
        baseUrl: BASE,
        authRules: [{ pathPrefix: "/test101/fa26/secure/", credentialId: "site" }],
        knownFiles: new Map([[lecture, { etag: '"v1"', lastModified: null }]]),
      },
      fetcher,
    );
    expect(result.skipped).toEqual([lecture]);
    expect(result.files.map((file) => file.url)).toEqual([BASE + "secure/lecture-02.pdf"]);
    expect(result.files[0]?.etag).toBe('"v2"');
    expect(result.health).toBe("HEALTHY");
    // The anonymous try and both NTLM legs all carried the validator; an unknown file carried none.
    const asked = site.requests.filter((request) => request.url === lecture);
    expect(asked.length).toBe(3);
    expect(asked.every((request) => request.headers["If-None-Match"] === '"v1"')).toBe(true);
    expect(site.requests.filter((request) => request.url.endsWith("lecture-02.pdf")).some((request) => "If-None-Match" in request.headers)).toBe(false);
  });

  it("follows the redirect of a slashless seed and resolves links against the final URL", async () => {
    const site = schedulePages(() => false);
    const result = await crawlWebsite(
      { name: "Test site", baseUrl: "https://courses.example.edu/test101/fa26", maxDepth: 1, includePatterns: ["description"] },
      new ResourceFetcher({ transport: site.transport }),
    );
    expect(result.pages.map((page) => page.url)).toEqual(["https://courses.example.edu/test101/fa26", BASE + "course-description.html"]);
  });

  it("canonicalizes links, keeps to the allowed paths and flags login pages posing as files", async () => {
    const site = fakeSite({
      pages: {
        "https://site.example/": html(fixture("course_page.html")),
        "https://site.example/files/Lecture04.pdf": html("<!doctype html><html>Please sign in</html>"),
        "https://site.example/files/HW2-solutions.pdf": pdf,
      },
    });
    const result = await crawlWebsite(
      { name: "Site", baseUrl: "https://site.example/", excludePatterns: ["reading"] },
      new ResourceFetcher({ transport: site.transport }),
    );
    expect(site.requests.map((request) => request.url)).toEqual([
      "https://site.example/",
      "https://site.example/files/Lecture04.pdf",
      "https://site.example/files/HW2-solutions.pdf",
    ]);
    const login = result.files.find((file) => file.url.endsWith("Lecture04.pdf"));
    expect(login?.integrity).toMatchObject({ valid: false, reason: "html_response_disguised_as_binary" });
    expect(login?.content).toBeNull();
    expect(result.health).toBe("DEGRADED");
    expect(result.errors).toEqual(["invalid_download"]);
  });

  it("stops at the path limit and reports truncation", async () => {
    const site = fakeSite({ pages: { [BASE]: html('<a href="a.html">a</a><a href="b.html">b</a>'), [BASE + "a.html"]: html("a") } });
    const result = await crawlWebsite({ name: "Site", baseUrl: BASE, pathLimit: 2 }, new ResourceFetcher({ transport: site.transport }));
    expect(result.pages).toHaveLength(2);
    expect(result).toMatchObject({ truncated: true, health: "DEGRADED", errors: ["discovery_limit_reached"] });
  });

  it("treats a missing page as discovered, other failures as degraded", async () => {
    const site = fakeSite({
      pages: {
        [BASE]: html('<a href="gone.html">gone</a><a href="broken.html">broken</a><a href="../other/">out</a><a href="x\\y.html">bs</a>'),
        [BASE + "broken.html"]: { status: 500 },
      },
    });
    const result = await crawlWebsite({ name: "Site", baseUrl: BASE }, new ResourceFetcher({ transport: site.transport }));
    expect(result.pending.map((row) => [row.url, row.state, row.errorCode])).toEqual([
      [BASE + "gone.html", "DISCOVERED", "not_found"],
      [BASE + "broken.html", "FAILED", "http_500"],
    ]);
    expect(result.health).toBe("DEGRADED");
    expect(site.requests).toHaveLength(3);
  });

  it("picks the most specific auth rule and never one for another host or adjacent path", () => {
    const crawler = new WebsiteCrawler(
      {
        name: "Site",
        baseUrl: BASE,
        authRules: [
          { pathPrefix: "/test101/fa26/", credentialId: "course" },
          { pathPrefix: "/test101/fa26/secure", credentialId: "secure" },
        ],
      },
      new ResourceFetcher({ transport: fakeSite({}).transport }),
    );
    expect(crawler.authRuleFor(BASE + "secure/a")?.credentialId).toBe("secure");
    expect(crawler.authRuleFor(BASE + "secure-other/a")?.credentialId).toBe("course");
    expect(crawler.authRuleFor("https://evil.example/test101/fa26/secure/a")).toBeNull();
    expect(crawler.allowed("https://courses.example.edu/test101/other")).toBe(false);
    expect(crawler.allowed("http://courses.example.edu/test101/fa26/a")).toBe(false);
  });
});

describe("file integrity", () => {
  it("accepts real PDF, Office and OLE files and rejects HTML in disguise", () => {
    expect(validateCourseFile(Buffer.from("%PDF-1.7\nbody"), { url: "https://example.test/a.pdf" }).valid).toBe(true);
    const disguised = validateCourseFile(Buffer.from("<!DOCTYPE html><html>401 Unauthorized</html>"), {
      url: "https://example.test/a.pdf",
      mimeType: "text/html",
    });
    expect(disguised).toMatchObject({ valid: false, status: "INVALID_DOWNLOAD" });
    expect(validateCourseFile(DOCX, { url: "https://example.test/notes.docx" })).toMatchObject({ valid: true, detectedExtension: ".docx" });
    expect(validateCourseFile(Buffer.from("PK broken"), { url: "https://example.test/notes.docx" }).reason).toBe("invalid_zip_container");
    const ole = Buffer.concat([Buffer.from("d0cf11e0a1b11ae1", "hex"), Buffer.alloc(8)]);
    expect(validateCourseFile(ole, { url: "https://example.test/old.doc" }).valid).toBe(true);
    expect(validateCourseFile(Buffer.from("text"), { url: "https://example.test/old.ppt" }).reason).toBe("invalid_ole_signature");
    expect(validateCourseFile(Buffer.from("%PDF-1"), { url: "https://example.test/a.pdf", expectedLength: 99 }).reason).toMatch(/^content_length_mismatch/);
    expect(validateCourseFile(Buffer.alloc(0), { url: "https://example.test/a.pdf" }).reason).toBe("empty_response");
    expect(validateCourseFile(Buffer.from("%PDF-1"), { url: "https://example.test/a.pdf", httpStatus: 206 }).valid).toBe(true);
    expect(validateCourseFile(Buffer.from("%PDF-1"), { url: "https://example.test/a.pdf", httpStatus: 302 }).reason).toBe("http_status_302");
    expect(validateCourseFile(Buffer.from("<html>"), { url: "https://example.test/page" }).valid).toBe(true);
    expect(isZipContainer(DOCX)).toBe(true);
  });

  it("makes safe file names", () => {
    expect(safeFilename("https://example.test/files/HW%201%3F.pdf")).toBe("HW 1_.pdf");
    expect(safeFilename("https://example.test/download", null, "application/pdf")).toBe("download.pdf");
    expect(safeFilename("https://example.test/", 'a<b>:"c', null)).toBe("a_b___c");
    expect(safeFilename("https://example.test/" + "x".repeat(300) + ".pdf").length).toBe(240);
  });
});

describe("document blocks", () => {
  it("reads .docx headings, tables and text", () => {
    expect(blocksText(docxBlocks(DOCX)).split("\n")).toEqual(["# Grading", "Item: Final exam | Weight: 40%", "Late work & makeups"]);
    expect(readZipEntry(DOCX, "missing.xml")).toBeNull();
    expect(docxBlocks(Buffer.from("not a zip"))).toEqual([]);
  });

  it("dispatches by type", () => {
    expect(textBlocks("a\n\n b  c ")).toEqual([{ type: "text", text: "a" }, { type: "text", text: "b c" }]);
    expect(fileBlocks(Buffer.from("<h1>T</h1>"), "x.html")).toEqual([{ type: "heading", level: 1, text: "T" }]);
    expect(fileBlocks(Buffer.from("x"), "x.pdf")).toBeNull();
    expect(fileBlocks(DOCX, "x.docx")?.length).toBe(3);
  });
});
