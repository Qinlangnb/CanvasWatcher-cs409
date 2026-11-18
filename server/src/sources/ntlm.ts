// NTLMv2 client messages (MS-NLMP) for course websites behind IIS Windows authentication.
// Only the client side of the HTTP handshake is implemented: Type 1 (negotiate), parsing the
// server's Type 2 (challenge) and Type 3 (authenticate). No signing or sealing: HTTP auth needs neither.
import { createHmac, randomBytes } from "node:crypto";

export interface NtlmCredential {
  username: string;
  password: string;
  /** Windows domain; `DOMAIN\user` and `user@domain` usernames are split by `splitNtlmUsername`. */
  domain?: string;
}

export class NtlmError extends Error {
  constructor(readonly code: "NTLM_BAD_CHALLENGE") {
    super(code);
  }
}

const FLAG_UNICODE = 0x00000001;
const FLAG_REQUEST_TARGET = 0x00000004;
const FLAG_NTLM = 0x00000200;
const FLAG_ALWAYS_SIGN = 0x00008000;
const FLAG_EXTENDED_SESSION_SECURITY = 0x00080000;
const FLAG_TARGET_INFO = 0x00800000;
const FLAG_128 = 0x20000000;
const FLAG_56 = 0x80000000;

const NEGOTIATE_FLAGS =
  FLAG_UNICODE | FLAG_REQUEST_TARGET | FLAG_NTLM | FLAG_ALWAYS_SIGN | FLAG_EXTENDED_SESSION_SECURITY | FLAG_128 | FLAG_56;

const SIGNATURE = Buffer.from("NTLMSSP\0", "latin1");
const AV_EOL = 0x0000;
const AV_TIMESTAMP = 0x0007;
/** Upper bound for a challenge message; real ones are a few hundred bytes. */
const MAX_CHALLENGE_BYTES = 8_192;

// ---------------------------------------------------------------------------------------------
// MD4 (RFC 1320). OpenSSL 3 ships MD4 only in the legacy provider, so Node usually lacks it.
// NTOWF is the sole user; it is never used for anything that needs collision resistance.

function rotl(value: number, shift: number): number {
  return (value << shift) | (value >>> (32 - shift));
}

export function md4(input: Uint8Array): Buffer {
  const length = input.length;
  const padded = Buffer.alloc((((length + 8) >> 6) + 1) * 64);
  padded.set(input);
  padded[length] = 0x80;
  // Message length in bits, little-endian 64-bit.
  padded.writeUInt32LE((length * 8) >>> 0, padded.length - 8);
  padded.writeUInt32LE(Math.floor(length / 0x20000000), padded.length - 4);

  let a = 0x67452301;
  let b = 0xefcdab89;
  let c = 0x98badcfe;
  let d = 0x10325476;
  const x = new Array<number>(16);
  const f = (p: number, q: number, r: number) => (p & q) | (~p & r);
  const g = (p: number, q: number, r: number) => (p & q) | (p & r) | (q & r);
  const h = (p: number, q: number, r: number) => p ^ q ^ r;

  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) x[i] = padded.readUInt32LE(offset + i * 4);
    const word = (i: number) => x[i] ?? 0;
    const [aa, bb, cc, dd] = [a, b, c, d];
    for (const i of [0, 4, 8, 12]) {
      a = rotl((a + f(b, c, d) + word(i)) | 0, 3);
      d = rotl((d + f(a, b, c) + word(i + 1)) | 0, 7);
      c = rotl((c + f(d, a, b) + word(i + 2)) | 0, 11);
      b = rotl((b + f(c, d, a) + word(i + 3)) | 0, 19);
    }
    for (const i of [0, 1, 2, 3]) {
      a = rotl((a + g(b, c, d) + word(i) + 0x5a827999) | 0, 3);
      d = rotl((d + g(a, b, c) + word(i + 4) + 0x5a827999) | 0, 5);
      c = rotl((c + g(d, a, b) + word(i + 8) + 0x5a827999) | 0, 9);
      b = rotl((b + g(c, d, a) + word(i + 12) + 0x5a827999) | 0, 13);
    }
    for (const i of [0, 2, 1, 3]) {
      a = rotl((a + h(b, c, d) + word(i) + 0x6ed9eba1) | 0, 3);
      d = rotl((d + h(a, b, c) + word(i + 8) + 0x6ed9eba1) | 0, 9);
      c = rotl((c + h(d, a, b) + word(i + 4) + 0x6ed9eba1) | 0, 11);
      b = rotl((b + h(c, d, a) + word(i + 12) + 0x6ed9eba1) | 0, 15);
    }
    a = (a + aa) | 0;
    b = (b + bb) | 0;
    c = (c + cc) | 0;
    d = (d + dd) | 0;
  }
  const out = Buffer.alloc(16);
  out.writeInt32LE(a, 0);
  out.writeInt32LE(b, 4);
  out.writeInt32LE(c, 8);
  out.writeInt32LE(d, 12);
  return out;
}

// ---------------------------------------------------------------------------------------------

const utf16 = (value: string) => Buffer.from(value, "utf16le");
const hmacMd5 = (key: Uint8Array, ...parts: Uint8Array[]) => {
  const mac = createHmac("md5", key);
  for (const part of parts) mac.update(part);
  return mac.digest();
};

/** Accepts `DOMAIN\user` and `user@domain` as users type them into a Windows prompt. */
export function splitNtlmUsername(credential: NtlmCredential): { user: string; domain: string } {
  if (credential.domain !== undefined) return { user: credential.username, domain: credential.domain };
  const slash = credential.username.indexOf("\\");
  if (slash > 0) return { domain: credential.username.slice(0, slash), user: credential.username.slice(slash + 1) };
  return { user: credential.username, domain: "" };
}

export function ntowfv1(password: string): Buffer {
  return md4(utf16(password));
}

/** NTOWFv2: HMAC-MD5 keyed by the MD4 password hash over UPPER(user) + domain, both UTF-16LE. */
export function ntowfv2(password: string, user: string, domain: string): Buffer {
  return hmacMd5(ntowfv1(password), utf16(user.toUpperCase() + domain));
}

export interface ChallengeMessage {
  flags: number;
  serverChallenge: Buffer;
  targetName: string;
  /** Raw AV_PAIR list; echoed into the NTLMv2 response blob unchanged. */
  targetInfo: Buffer;
  /** MsvAvTimestamp when the server sent one (FILETIME, 8 bytes). */
  timestamp: Buffer | null;
}

export function negotiateMessage(): Buffer {
  const message = Buffer.alloc(32);
  SIGNATURE.copy(message, 0);
  message.writeUInt32LE(1, 8);
  message.writeUInt32LE(NEGOTIATE_FLAGS >>> 0, 12);
  // Empty domain and workstation security buffers (length 0, offset 32).
  message.writeUInt32LE(32, 20);
  message.writeUInt32LE(32, 28);
  return message;
}

function securityBuffer(message: Buffer, at: number): Buffer {
  if (at + 8 > message.length) throw new NtlmError("NTLM_BAD_CHALLENGE");
  const length = message.readUInt16LE(at);
  const offset = message.readUInt32LE(at + 4);
  if (offset + length > message.length) throw new NtlmError("NTLM_BAD_CHALLENGE");
  return message.subarray(offset, offset + length);
}

export function parseChallengeMessage(message: Buffer): ChallengeMessage {
  if (message.length < 32 || message.length > MAX_CHALLENGE_BYTES || !message.subarray(0, 8).equals(SIGNATURE)) {
    throw new NtlmError("NTLM_BAD_CHALLENGE");
  }
  if (message.readUInt32LE(8) !== 2) throw new NtlmError("NTLM_BAD_CHALLENGE");
  const flags = message.readUInt32LE(20);
  const serverChallenge = Buffer.from(message.subarray(24, 32));
  const name = securityBuffer(message, 12);
  const targetName = flags & FLAG_UNICODE ? name.toString("utf16le") : name.toString("latin1");
  const targetInfo = message.length >= 48 && flags & FLAG_TARGET_INFO ? Buffer.from(securityBuffer(message, 40)) : Buffer.alloc(0);
  let timestamp: Buffer | null = null;
  // Walk the AV pairs to validate them and find the server timestamp.
  for (let at = 0; at + 4 <= targetInfo.length; ) {
    const id = targetInfo.readUInt16LE(at);
    const length = targetInfo.readUInt16LE(at + 2);
    if (at + 4 + length > targetInfo.length) throw new NtlmError("NTLM_BAD_CHALLENGE");
    if (id === AV_EOL) break;
    if (id === AV_TIMESTAMP && length === 8) timestamp = Buffer.from(targetInfo.subarray(at + 4, at + 12));
    at += 4 + length;
  }
  return { flags, serverChallenge, targetName, targetInfo, timestamp };
}

/** Windows FILETIME: 100 ns ticks since 1601-01-01, little-endian. */
export function fileTime(date: Date): Buffer {
  const ticks = (BigInt(date.getTime()) + 11_644_473_600_000n) * 10_000n;
  const out = Buffer.alloc(8);
  out.writeBigUInt64LE(ticks);
  return out;
}

export interface NtlmV2Response {
  ntChallengeResponse: Buffer;
  lmChallengeResponse: Buffer;
  ntProofStr: Buffer;
  sessionBaseKey: Buffer;
}

/** NTLMv2 responses (MS-NLMP 3.3.2). `timestamp` and `clientChallenge` are injectable for tests. */
export function ntlmV2Response(
  responseKey: Buffer,
  serverChallenge: Buffer,
  targetInfo: Buffer,
  timestamp: Buffer,
  clientChallenge: Buffer,
): NtlmV2Response {
  const temp = Buffer.concat([
    Buffer.from([1, 1, 0, 0, 0, 0, 0, 0]),
    timestamp,
    clientChallenge,
    Buffer.alloc(4),
    targetInfo,
    Buffer.alloc(4),
  ]);
  const ntProofStr = hmacMd5(responseKey, serverChallenge, temp);
  return {
    ntProofStr,
    ntChallengeResponse: Buffer.concat([ntProofStr, temp]),
    lmChallengeResponse: Buffer.concat([hmacMd5(responseKey, serverChallenge, clientChallenge), clientChallenge]),
    sessionBaseKey: hmacMd5(responseKey, ntProofStr),
  };
}

export interface AuthenticateOptions {
  workstation?: string;
  /** Test hooks; production uses random bytes and the server's (or local) time. */
  clientChallenge?: Buffer;
  now?: Date;
}

export function authenticateMessage(
  challenge: ChallengeMessage,
  credential: NtlmCredential,
  options: AuthenticateOptions = {},
): Buffer {
  const { user, domain } = splitNtlmUsername(credential);
  const key = ntowfv2(credential.password, user, domain);
  const clientChallenge = options.clientChallenge ?? randomBytes(8);
  const timestamp = challenge.timestamp ?? fileTime(options.now ?? new Date());
  const response = ntlmV2Response(key, challenge.serverChallenge, challenge.targetInfo, timestamp, clientChallenge);
  // With a server timestamp the LMv2 response must be zeros (MS-NLMP 3.1.5.1.2).
  const lm = challenge.timestamp ? Buffer.alloc(24) : response.lmChallengeResponse;
  const unicode = (challenge.flags & FLAG_UNICODE) !== 0;
  const encode = (value: string) => (unicode ? utf16(value) : Buffer.from(value, "latin1"));
  const fields = [lm, response.ntChallengeResponse, encode(domain), encode(user), encode(options.workstation ?? ""), Buffer.alloc(0)];
  const header = 64;
  const message = Buffer.alloc(header + fields.reduce((sum, field) => sum + field.length, 0));
  SIGNATURE.copy(message, 0);
  message.writeUInt32LE(3, 8);
  let offset = header;
  fields.forEach((field, index) => {
    const at = 12 + index * 8;
    message.writeUInt16LE(field.length, at);
    message.writeUInt16LE(field.length, at + 2);
    message.writeUInt32LE(offset, at + 4);
    field.copy(message, offset);
    offset += field.length;
  });
  const flags = (NEGOTIATE_FLAGS & challenge.flags) | (unicode ? FLAG_UNICODE : 0);
  message.writeUInt32LE(flags >>> 0, 60);
  return message;
}

export type AuthScheme = "NTLM" | "Negotiate";

/** The scheme a 401 offers, preferring raw NTLM; `Basic realm="ntlm"` is not an NTLM challenge. */
export function detectAuthScheme(header: string | string[] | undefined): AuthScheme | null {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  const schemes = new Set(
    values.flatMap((value) => value.split(",")).map((part) => part.trim().split(/\s+/, 1)[0]?.toLowerCase() ?? ""),
  );
  if (schemes.has("ntlm")) return "NTLM";
  if (schemes.has("negotiate")) return "Negotiate";
  return null;
}

/** The base64 Type 2 token from a `WWW-Authenticate: NTLM <token>` header, if any. */
export function challengeToken(header: string | string[] | undefined, scheme: AuthScheme): Buffer | null {
  const values = Array.isArray(header) ? header : header ? [header] : [];
  for (const value of values.flatMap((entry) => entry.split(","))) {
    const [name, token] = value.trim().split(/\s+/, 2);
    if (name?.toLowerCase() === scheme.toLowerCase() && token && /^[A-Za-z0-9+/]+={0,2}$/.test(token)) {
      return Buffer.from(token, "base64");
    }
  }
  return null;
}
