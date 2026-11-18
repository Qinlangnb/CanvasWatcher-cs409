// Readable blocks for downloaded course files, in the same shape as Canvas rich text blocks, so
// a syllabus found in a website page, a .docx or a .txt reads the same way. PDF text needs a PDF
// engine and is not extracted here.
import { inflateRawSync } from "node:zlib";
import { htmlBlocks, type Block } from "../../canvas/richText.js";
import { extensionOf, isZipContainer } from "./integrity.js";

const MAX_BLOCKS = 2_000;
const MAX_XML_BYTES = 20 * 1024 * 1024;
const MAX_SPAN = 50;

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

/** One stored or deflated entry of a ZIP archive, or null. Sizes are capped against zip bombs. */
export function readZipEntry(archive: Buffer, name: string, maxBytes = MAX_XML_BYTES): Buffer | null {
  if (!isZipContainer(archive)) return null;
  let end = -1;
  for (let at = archive.length - 22; at >= Math.max(0, archive.length - 22 - 65_535); at--) {
    if (archive.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  }
  const count = archive.readUInt16LE(end + 10);
  let at = archive.readUInt32LE(end + 16);
  for (let index = 0; index < count && at + 46 <= archive.length; index++) {
    if (archive.readUInt32LE(at) !== 0x02014b50) return null;
    const method = archive.readUInt16LE(at + 10);
    const compressedSize = archive.readUInt32LE(at + 20);
    const size = archive.readUInt32LE(at + 24);
    const nameLength = archive.readUInt16LE(at + 28);
    const extraLength = archive.readUInt16LE(at + 30);
    const commentLength = archive.readUInt16LE(at + 32);
    const local = archive.readUInt32LE(at + 42);
    const entryName = archive.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    at += 46 + nameLength + extraLength + commentLength;
    if (entryName !== name) continue;
    if (size > maxBytes || local + 30 > archive.length || archive.readUInt32LE(local) !== 0x04034b50) return null;
    const dataStart = local + 30 + archive.readUInt16LE(local + 26) + archive.readUInt16LE(local + 28);
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    try {
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
    } catch {
      return null;
    }
    return null;
  }
  return null;
}

function decodeXml(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_entity, code: string) => {
    if (code[0] === "#") {
      const point = code[1]?.toLowerCase() === "x" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(point) && point > 0 && point <= 0x10ffff ? String.fromCodePoint(point) : "";
    }
    return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[code.toLowerCase()] ?? "";
  });
}

function paragraphText(xml: string): string {
  const parts: string[] = [];
  for (const match of xml.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:(tab|br)\b[^>]*\/>/g)) {
    parts.push(match[1] !== undefined ? decodeXml(match[1]) : " ");
  }
  return clean(parts.join(""));
}

/** Top-level elements of a WordprocessingML container, nesting-aware for `w:tbl`/`w:tr`/`w:tc`/`w:p`. */
function topLevel(xml: string, tags: readonly string[]): { tag: string; body: string; open: string }[] {
  const result: { tag: string; body: string; open: string }[] = [];
  const pattern = /<(\/?)w:(p|tbl|tr|tc)\b([^>]*?)(\/?)>/g;
  let depth = 0;
  let current: { tag: string; start: number; open: string } | null = null;
  for (const match of xml.matchAll(pattern)) {
    const [whole, closing, tag = "", , selfClosing] = match;
    const index = match.index ?? 0;
    if (selfClosing) {
      if (depth === 0 && tags.includes(tag)) result.push({ tag, body: "", open: whole });
      continue;
    }
    if (!closing) {
      if (depth === 0 && tags.includes(tag)) current = { tag, start: index + whole.length, open: whole };
      depth++;
    } else {
      depth--;
      if (depth === 0 && current && current.tag === tag) {
        result.push({ tag, body: xml.slice(current.start, index), open: current.open });
        current = null;
      }
      if (depth < 0) depth = 0;
    }
  }
  return result;
}

function tableBlock(rows: string[][], headerRows: number): Block | null {
  let grid = rows.map((row) => row.map(clean)).filter((row) => row.some(Boolean));
  if (!grid.length) return null;
  const width = Math.max(...grid.map((row) => row.length));
  grid = grid.map((row) => [...row, ...Array<string>(width - row.length).fill("")]);
  const keep = [...Array(width).keys()].filter((column) => grid.some((row) => row[column]));
  grid = grid.map((row) => keep.map((column) => row[column] ?? ""));
  return { type: "table", rows: grid, header_rows: grid.length > 1 ? Math.min(headerRows, grid.length - 1) : 0, row_headers: false };
}

export function docxBlocks(content: Buffer): Block[] {
  const document = readZipEntry(content, "word/document.xml");
  if (!document) return [];
  const xml = document.toString("utf8");
  const body = /<w:body\b[^>]*>([\s\S]*)<\/w:body>/.exec(xml)?.[1] ?? "";
  const blocks: Block[] = [];
  for (const element of topLevel(body, ["p", "tbl"])) {
    if (blocks.length >= MAX_BLOCKS) break;
    if (element.tag === "p") {
      const text = paragraphText(element.body);
      const level = /<w:pStyle\b[^>]*w:val="Heading(\d)"/.exec(element.body)?.[1];
      if (text) blocks.push(level ? { type: "heading", level: Number(level), text } : { type: "text", text });
      continue;
    }
    const grid: string[][] = [];
    for (const tr of topLevel(element.body, ["tr"])) {
      const row: string[] = [];
      for (const tc of topLevel(tr.body, ["tc"])) {
        const span = Math.min(Math.max(Number(/<w:gridSpan\b[^>]*w:val="(\d+)"/.exec(tc.body)?.[1] ?? 1), 1), MAX_SPAN);
        const merge = /<w:vMerge\b([^>]*)\/?>/.exec(tc.body);
        let text = topLevel(tc.body, ["p"]).map((p) => paragraphText(p.body)).join(" ");
        // A continued vertical merge repeats the cell above.
        if (merge && !/w:val="restart"/.test(merge[1] ?? "") && grid.length) text = grid[grid.length - 1]?.[row.length] ?? text;
        for (let i = 0; i < span; i++) row.push(text);
      }
      grid.push(row);
    }
    const header = /<w:tblHeader\b/.test(element.body) || grid.length > 1 ? 1 : 0;
    const block = tableBlock(grid, header);
    if (block) blocks.push(block);
  }
  return blocks;
}

export function textBlocks(text: string | null | undefined): Block[] {
  return (text ?? "")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map(clean)
    .filter(Boolean)
    .slice(0, MAX_BLOCKS)
    .map((value) => ({ type: "text" as const, text: value }));
}

/** Blocks for a file's bytes, or null when its type carries no text we can read. */
export function fileBlocks(content: Buffer, filename: string, mimeType?: string | null): Block[] | null {
  const extension = extensionOf(filename);
  const mime = (mimeType ?? "").toLowerCase();
  try {
    if (extension === ".docx" || mime.includes("wordprocessingml")) return docxBlocks(content);
    if (extension === ".html" || extension === ".htm" || mime === "text/html") return htmlBlocks(content.toString("utf8"));
    if (extension === ".txt" || extension === ".md" || mime.startsWith("text/plain")) return textBlocks(content.toString("utf8"));
  } catch {
    return [];
  }
  return null;
}
