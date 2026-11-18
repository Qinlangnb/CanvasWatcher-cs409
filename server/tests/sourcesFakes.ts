// Test doubles for the website fetcher: an in-memory transport that behaves like IIS with
// Windows authentication (NTLM state bound to the connection, Type 3 checked against a password).
import { createHmac, randomBytes } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import type { HttpConnection, HttpTransport, RawResponse, RequestLimits } from "../src/sources/website/http.js";
import { TransportError } from "../src/sources/website/http.js";
import { ntowfv2 } from "../src/sources/ntlm.js";

export interface FakeReply {
  status: number;
  headers?: IncomingHttpHeaders;
  body?: string | Buffer;
}

export interface FakeRequest {
  url: string;
  connection: number;
  authorization: string | undefined;
}

export interface FakeSiteOptions {
  /** Anonymous replies by URL; unknown URLs are 404. */
  pages?: Record<string, FakeReply | ((url: string) => FakeReply)>;
  /** URLs behind Windows authentication. */
  protectedUrl?: (url: string) => boolean;
  /** What the server sends on an anonymous request to a protected URL. */
  challengeHeader?: string;
  /** Accepted credential (domain is part of the username, `DOMAIN\user`). */
  account?: { username: string; password: string };
  /** Reply after a successful handshake. */
  protectedReply?: (url: string) => FakeReply;
  delayMs?: number;
}

function verifyType3(message: Buffer, serverChallenge: Buffer, account: { username: string; password: string }): boolean {
  const field = (index: number) => {
    const at = 12 + index * 8;
    const offset = message.readUInt32LE(at + 4);
    return message.subarray(offset, offset + message.readUInt16LE(at));
  };
  const nt = field(1);
  const domain = field(2).toString("utf16le");
  const user = field(3).toString("utf16le");
  const expected = domain ? `${domain}\\${user}` : user;
  if (expected.toLowerCase() !== account.username.toLowerCase()) return false;
  const proof = createHmac("md5", ntowfv2(account.password, user, domain))
    .update(serverChallenge)
    .update(nt.subarray(16))
    .digest();
  return proof.equals(nt.subarray(0, 16));
}

function challengeMessage(serverChallenge: Buffer): Buffer {
  const info = Buffer.from("02000c00" + Buffer.from("SCHOOL", "utf16le").toString("hex") + "00000000", "hex");
  const message = Buffer.alloc(48 + info.length);
  Buffer.from("NTLMSSP\0", "latin1").copy(message, 0);
  message.writeUInt32LE(2, 8);
  message.writeUInt32LE(48, 16);
  message.writeUInt32LE(0xe2898215, 20);
  serverChallenge.copy(message, 24);
  message.writeUInt16LE(info.length, 40);
  message.writeUInt16LE(info.length, 42);
  message.writeUInt32LE(48, 44);
  info.copy(message, 48);
  return message;
}

export function fakeSite(options: FakeSiteOptions) {
  const requests: FakeRequest[] = [];
  let connections = 0;
  let authorizedInFlight = 0;
  let maxAuthorizedInFlight = 0;
  const transport: HttpTransport = {
    open(): HttpConnection {
      const id = ++connections;
      let serverChallenge: Buffer | null = null;
      let closed = false;
      return {
        async get(url: string, headers: Record<string, string>, limits: RequestLimits): Promise<RawResponse> {
          if (closed) throw new TransportError("network_error");
          const authorization = headers.Authorization;
          requests.push({ url, connection: id, authorization });
          const counted = authorization !== undefined;
          if (counted) authorizedInFlight++;
          maxAuthorizedInFlight = Math.max(maxAuthorizedInFlight, authorizedInFlight);
          try {
            if (options.delayMs) await new Promise((resolve) => setTimeout(resolve, options.delayMs));
            const reply = handle(url, authorization);
            const body = Buffer.isBuffer(reply.body) ? reply.body : Buffer.from(reply.body ?? "");
            if (body.length > limits.maxBytes) throw new TransportError("response_too_large");
            return { url, status: reply.status, headers: reply.headers ?? {}, body };
          } finally {
            if (counted) authorizedInFlight--;
          }
        },
        close() {
          closed = true;
        },
      };

      function handle(url: string, authorization: string | undefined): FakeReply {
        if (!options.protectedUrl?.(url)) {
          const page = options.pages?.[url];
          return typeof page === "function" ? page(url) : page ?? { status: 404 };
        }
        const unauthorized: FakeReply = { status: 401, headers: { "www-authenticate": options.challengeHeader ?? "NTLM" } };
        const match = /^(NTLM|Negotiate) (.+)$/.exec(authorization ?? "");
        if (!match?.[2] || !options.account) return unauthorized;
        const message = Buffer.from(match[2], "base64");
        const type = message.readUInt32LE(8);
        if (type === 1) {
          serverChallenge = randomBytes(8);
          return { status: 401, headers: { "www-authenticate": `${match[1]} ${challengeMessage(serverChallenge).toString("base64")}` } };
        }
        // The Type 3 must arrive on the connection that received the challenge.
        if (type !== 3 || !serverChallenge || !verifyType3(message, serverChallenge, options.account)) return unauthorized;
        serverChallenge = null;
        return options.protectedReply?.(url) ?? { status: 200, headers: { "content-type": "text/html" }, body: "protected" };
      }
    },
  };
  return {
    transport,
    requests,
    /** Most requests carrying an Authorization header that were in flight at once. */
    get maxAuthorizedInFlight() {
      return maxAuthorizedInFlight;
    },
    get connections() {
      return connections;
    },
  };
}
