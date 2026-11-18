// Checks that a downloaded course file is what its name says. Protected sites often answer a
// PDF link with a 200 HTML login page; storing that as "Lecture04.pdf" would hide the failure.
import { createHash } from "node:crypto";

const OFFICE_EXTENSIONS = new Set([".docx", ".pptx", ".xlsx"]);
const ZIP_EXTENSIONS = new Set([...OFFICE_EXTENSIONS, ".zip"]);
const OLE_EXTENSIONS = new Set([".doc", ".ppt", ".xls"]);
const OLE_SIGNATURE = Buffer.from("d0cf11e0a1b11ae1", "hex");

export const MIME_EXTENSIONS: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ".xlsx",
  "application/zip": ".zip",
};

export type IntegrityStatus = "VALID" | "INVALID_DOWNLOAD";

export interface IntegrityResult {
  valid: boolean;
  status: IntegrityStatus;
  detectedExtension: string | null;
  reason: string | null;
}

function lastSegment(url: string): string {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    path = url.split(/[?#]/, 1)[0] ?? "";
  }
  const name = path.slice(path.lastIndexOf("/") + 1);
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

export function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1 ? name.slice(dot).toLowerCase() : "";
}

export function urlExtension(url: string): string {
  return extensionOf(lastSegment(url));
}

function looksLikeHtml(content: Buffer): boolean {
  const prefix = content.subarray(0, 1024).toString("latin1").trimStart().toLowerCase();
  return ["<!doctype html", "<html", "<head", "<body"].some((start) => prefix.startsWith(start));
}

/** Like Python's zipfile.is_zipfile: an end-of-central-directory record within the last 64 KiB. */
export function isZipContainer(content: Buffer): boolean {
  const start = Math.max(0, content.length - 22 - 65_535);
  for (let at = content.length - 22; at >= start; at--) {
    if (content.readUInt32LE(at) === 0x06054b50) {
      const commentLength = content.readUInt16LE(at + 20);
      const directorySize = content.readUInt32LE(at + 12);
      const directoryOffset = content.readUInt32LE(at + 16);
      return at + 22 + commentLength <= content.length && directoryOffset + directorySize <= at;
    }
  }
  return false;
}

const invalid = (reason: string, detectedExtension: string | null = null): IntegrityResult => ({
  valid: false,
  status: "INVALID_DOWNLOAD",
  detectedExtension,
  reason,
});

export function validateCourseFile(
  content: Buffer,
  options: { url: string; filename?: string | null; mimeType?: string | null; expectedLength?: number | null; httpStatus?: number | null },
): IntegrityResult {
  if (options.httpStatus != null && (options.httpStatus < 200 || options.httpStatus >= 300)) {
    return invalid(`http_status_${options.httpStatus}`);
  }
  if (content.length === 0) return invalid("empty_response");
  if (options.expectedLength != null && options.expectedLength !== content.length) {
    return invalid(`content_length_mismatch:${options.expectedLength}!=${content.length}`);
  }
  const extension = urlExtension(options.url) || extensionOf(options.filename ?? "");
  let detected: string | null = null;
  if (content.subarray(0, 5).toString("latin1") === "%PDF-") detected = ".pdf";
  else if (content.subarray(0, 2).toString("latin1") === "PK") detected = ".zip";
  else if (content.subarray(0, 8).equals(OLE_SIGNATURE)) detected = ".ole";
  else if (looksLikeHtml(content)) detected = ".html";

  const expectedBinary = extension === ".pdf" || ZIP_EXTENSIONS.has(extension) || OLE_EXTENSIONS.has(extension);
  if (detected === ".html" && expectedBinary) return invalid("html_response_disguised_as_binary", detected);
  if (extension === ".pdf" && detected !== ".pdf") return invalid("invalid_pdf_signature", detected);
  if (ZIP_EXTENSIONS.has(extension)) {
    if (!isZipContainer(content)) return invalid("invalid_zip_container", detected);
    detected = extension;
  }
  if (OLE_EXTENSIONS.has(extension) && detected !== ".ole") return invalid("invalid_ole_signature", detected);
  if (options.mimeType?.toLowerCase() === "text/html" && expectedBinary) return invalid("html_content_type_for_binary", detected);
  return { valid: true, status: "VALID", detectedExtension: detected ?? (extension || null), reason: null };
}

/** A file name safe on every OS: no `<>:"/\|?*` or control characters, at most 240 characters. */
export function safeFilename(url: string, suggested?: string | null, mimeType?: string | null): string {
  const raw = suggested || lastSegment(url) || "download";
  let value = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").replace(/^[ .]+|[ .]+$/g, "");
  const extension = urlExtension(url) || MIME_EXTENSIONS[(mimeType ?? "").toLowerCase()] || "";
  if (extension && !extensionOf(value)) value += extension;
  return value.slice(0, 240) || `download${extension}`;
}

export function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}
