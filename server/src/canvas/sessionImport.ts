// Reads a Canvas browser session the student pasted: a raw Cookie header, "Cookie: …", or a request
// copied from the browser's developer tools as cURL (bash, or cmd with ^ escapes). The text is only
// parsed, never run. Error messages never repeat any of the pasted text.

/** At most this much pasted text is read (a copied cURL request with many headers is a few KB). */
export const MAX_SESSION_IMPORT = 131_072;

const COOKIE_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const CONTROL = /[\x00-\x1f\x7f]/;

export class SessionImportError extends Error {}

/** cmd's "Copy as cURL": ^ escapes the next character and ^ at a line end continues the line. */
function cmdUnescape(value: string): string {
  return value.replace(/\^[\r\n]+\s*/g, " ").replace(/\^(.)/gs, "$1");
}

const ANSI_C: Record<string, string> = { n: "\n", r: "\r", t: "\t", "\\": "\\", "'": "'", '"': '"', "?": "?", a: "\x07", b: "\b", e: "\x1b", f: "\f", v: "\v" };

/** Splits like a POSIX shell (quotes, backslashes, $'…' strings), without expanding anything. */
export function shellSplit(input: string): string[] {
  const words: string[] = [];
  let word: string | null = null;
  const push = (text: string) => (word = (word ?? "") + text);
  for (let i = 0; i < input.length; i += 1) {
    const char = input[i] as string;
    if (/\s/.test(char)) {
      if (word !== null) words.push(word);
      word = null;
    } else if (char === "\\") {
      const next = input[i + 1];
      if (next === undefined) throw new SessionImportError("The copied cURL request is incomplete.");
      i += 1;
      if (next !== "\n") push(next);
      else if (word === null) word = null;
    } else if (char === "'") {
      const end = input.indexOf("'", i + 1);
      if (end < 0) throw new SessionImportError("The copied cURL request has an unclosed quote.");
      push(input.slice(i + 1, end));
      i = end;
    } else if (char === "$" && input[i + 1] === "'") {
      let text = "";
      let j = i + 2;
      for (; j < input.length && input[j] !== "'"; j += 1) {
        if (input[j] !== "\\") {
          text += input[j];
          continue;
        }
        const code = input[j + 1] ?? "";
        const hex = code === "x" ? /^[0-9a-fA-F]{1,2}/.exec(input.slice(j + 2)) : code === "u" ? /^[0-9a-fA-F]{1,4}/.exec(input.slice(j + 2)) : null;
        if (hex) {
          text += String.fromCharCode(parseInt(hex[0], 16));
          j += 1 + hex[0].length;
        } else {
          text += ANSI_C[code] ?? `\\${code}`;
          j += 1;
        }
      }
      if (j >= input.length) throw new SessionImportError("The copied cURL request has an unclosed quote.");
      push(text);
      i = j;
    } else if (char === '"') {
      let text = "";
      let j = i + 1;
      for (; j < input.length && input[j] !== '"'; j += 1) {
        if (input[j] === "\\" && /["\\$`\n]/.test(input[j + 1] ?? "")) {
          if (input[j + 1] !== "\n") text += input[j + 1];
          j += 1;
        } else {
          text += input[j];
        }
      }
      if (j >= input.length) throw new SessionImportError("The copied cURL request has an unclosed quote.");
      push(text);
      i = j;
    } else {
      push(char);
    }
  }
  if (word !== null) words.push(word);
  return words;
}

/** The Cookie header(s) of a copied cURL request: -b/--cookie values and -H "Cookie: …" headers. */
function curlCookieHeader(command: string): string | null {
  const tokens = shellSplit(cmdUnescape(command));
  const headers: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    let kind: "header" | "cookie" | null = null;
    let argument: string | undefined;
    if (["-H", "--header", "-b", "--cookie"].includes(token)) {
      if (index + 1 >= tokens.length) throw new SessionImportError("The copied cURL request is incomplete.");
      kind = token === "-H" || token === "--header" ? "header" : "cookie";
      argument = tokens[++index];
    } else if (token.startsWith("--header=")) [kind, argument] = ["header", token.slice(9)];
    else if (token.startsWith("--cookie=")) [kind, argument] = ["cookie", token.slice(9)];
    else if (token.startsWith("-H") && token.length > 2) [kind, argument] = ["header", token.slice(2)];
    else if (token.startsWith("-b") && token.length > 2) [kind, argument] = ["cookie", token.slice(2)];
    if (!argument) continue;
    if (kind === "cookie") headers.push(argument);
    else if (kind === "header" && /^cookie:/i.test(argument)) headers.push(argument.slice(argument.indexOf(":") + 1).trim());
  }
  const joined = headers.filter((part) => part.trim()).join("; ");
  return joined || null;
}

/** Cookie name → value. Throws SessionImportError with a message safe to show. */
export function parseSessionImport(input: unknown): Map<string, string> {
  if (typeof input !== "string" || !input.trim()) throw new SessionImportError("Paste the Cookie header or the copied cURL request.");
  if (input.length > MAX_SESSION_IMPORT) throw new SessionImportError("That is too long to be a Canvas session (128 KB at most).");
  const value = input.trim();
  let header: string | null;
  if (/^curl(\.exe)?(\s|\^)/i.test(value)) header = curlCookieHeader(value);
  else if (/^cookie:/i.test(value)) header = value.slice(value.indexOf(":") + 1).trim();
  else if (value.includes("=") && !/[\r\n]/.test(value)) header = value;
  else header = null;
  if (!header) throw new SessionImportError("No Cookie header was found. Copy the request as cURL (bash) and paste all of it.");
  if (CONTROL.test(header)) throw new SessionImportError("The Canvas cookies are malformed.");
  const cookies = new Map<string, string>();
  for (const part of header.split(";")) {
    if (!part.trim()) continue;
    const separator = part.indexOf("=");
    const name = separator < 0 ? "" : part.slice(0, separator).trim();
    if (!name || !COOKIE_NAME.test(name)) throw new SessionImportError("The Canvas cookies are malformed.");
    let cookie = part.slice(separator + 1).trim();
    if (cookie.length >= 2 && cookie.startsWith('"') && cookie.endsWith('"')) cookie = cookie.slice(1, -1);
    cookies.set(name, cookie);
  }
  if (cookies.size === 0) throw new SessionImportError("No Canvas cookies were found.");
  return cookies;
}

/**
 * Cookies the Auth Broker hands over: non-empty names without separators or control characters, each
 * name plus value at most 16 KB. Returns null when any cookie breaks a rule.
 */
export function brokerCookies(input: Record<string, string>): Map<string, string> | null {
  const cookies = new Map<string, string>();
  for (const [name, value] of Object.entries(input)) {
    if (!name || /[\r\n;\x00]/.test(name + value) || name.length + value.length > 16_384) return null;
    cookies.set(name, value);
  }
  return cookies;
}
