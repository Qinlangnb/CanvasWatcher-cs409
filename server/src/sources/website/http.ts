// Minimal GET transport on node:http(s). Redirects are never followed here: callers see every
// 3xx and decide. A "connection" owns a dedicated keep-alive agent, so NTLM (which authenticates
// the TCP connection, not the request) can run its handshake on one socket.
import { lookup as dnsLookup, type LookupAddress } from "node:dns";
import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import { BlockList, isIP, type LookupFunction } from "node:net";

export interface RawResponse {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type TransportErrorCode = "timeout" | "network_error" | "response_too_large" | "unsupported_scheme" | "address_not_allowed";

/** What arrived before a response was cut off for being over `maxBytes`: enough to list a file without its bytes. */
export interface OversizedResponse {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  /** Content-Length when the server sent one. */
  declaredBytes: number | null;
}

export class TransportError extends Error {
  constructor(
    readonly code: TransportErrorCode,
    /** Set with `response_too_large`. */
    readonly response: OversizedResponse | null = null,
  ) {
    super(code);
  }
}

export interface RequestLimits {
  /** Whole request, connect to last byte. */
  timeoutMs: number;
  maxBytes: number;
}

export interface HttpConnection {
  get(url: string, headers: Record<string, string>, limits: RequestLimits): Promise<RawResponse>;
  close(): void;
}

export interface HttpTransport {
  /** `maxSockets: 1` pins every request of this connection to one keep-alive socket. */
  open(options: { maxSockets: number }): HttpConnection;
}

export const DEFAULT_LIMITS: RequestLimits = { timeoutMs: 30_000, maxBytes: 50 * 1024 * 1024 };

const USER_AGENT = "CanvasWatcher course-website reader";

// Addresses a user-entered website must never make this server reach: loopback, private networks,
// link-local (cloud metadata), carrier-grade NAT, multicast and reserved ranges.
const PRIVATE = new BlockList();
for (const [net, prefix] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) PRIVATE.addSubnet(net, prefix, "ipv4");
for (const [net, prefix] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const) {
  PRIVATE.addSubnet(net, prefix, "ipv6");
}

/** True for an address in a private, loopback, link-local or reserved range (IPv4-mapped IPv6 included). */
export function isPrivateAddress(address: string): boolean {
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address)?.[1];
  if (mapped) return PRIVATE.check(mapped, "ipv4");
  const family = isIP(address);
  if (family === 0) return true;
  return PRIVATE.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** A DNS lookup that refuses names resolving to a private address (checked on every connect). */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (error, addresses: LookupAddress[]) => {
    if (error) return callback(error, "", 0);
    const blocked = addresses.length === 0 || addresses.some((entry) => isPrivateAddress(entry.address));
    if (blocked) return callback(Object.assign(new Error("address_not_allowed"), { code: "EADDRNOTALLOWED" }), "", 0);
    if (options.all) return (callback as unknown as (err: null, list: LookupAddress[]) => void)(null, addresses);
    const first = addresses[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
};

export interface NodeTransportOptions {
  /** Extra CA certificates; certificates are always verified. */
  ca?: string | Buffer;
  /** Lets requests reach private and loopback addresses (development only). */
  allowPrivate?: boolean;
}

/** Real sockets. Unless `allowPrivate`, every connection is checked against private address ranges. */
export function nodeTransport(options: NodeTransportOptions = {}): HttpTransport {
  const guard = options.allowPrivate ? {} : { lookup: publicLookup };
  return {
    open({ maxSockets }) {
      const agents = {
        "http:": new http.Agent({ keepAlive: true, maxSockets, ...guard }),
        "https:": new https.Agent({ keepAlive: true, maxSockets, ...guard, ...(options.ca ? { ca: options.ca } : {}) }),
      };
      return {
        get(url, headers, limits) {
          return new Promise<RawResponse>((resolve, reject) => {
            const target = new URL(url);
            const protocol = target.protocol;
            if (protocol !== "http:" && protocol !== "https:") {
              reject(new TransportError("unsupported_scheme"));
              return;
            }
            // Literal IP hosts skip DNS, so they are checked here.
            const literal = target.hostname.replace(/^\[|\]$/g, "");
            if (!options.allowPrivate && isIP(literal) && isPrivateAddress(literal)) {
              reject(new TransportError("address_not_allowed"));
              return;
            }
            const module = protocol === "https:" ? https : http;
            let settled = false;
            const fail = (code: TransportErrorCode, oversized: OversizedResponse | null = null) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              request.destroy();
              reject(new TransportError(code, oversized));
            };
            const request = module.request(
              target,
              {
                method: "GET",
                agent: agents[protocol],
                headers: { "User-Agent": USER_AGENT, Accept: "*/*", ...headers },
              },
              (response) => {
                const declared = Number(response.headers["content-length"]);
                const oversized: OversizedResponse = {
                  url,
                  status: response.statusCode ?? 0,
                  headers: response.headers,
                  declaredBytes: response.headers["content-length"] !== undefined && Number.isFinite(declared) ? declared : null,
                };
                if (Number.isFinite(declared) && declared > limits.maxBytes) {
                  fail("response_too_large", oversized);
                  return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                response.on("data", (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > limits.maxBytes) fail("response_too_large", oversized);
                  else chunks.push(chunk);
                });
                response.on("end", () => {
                  if (settled) return;
                  settled = true;
                  clearTimeout(timer);
                  resolve({ url, status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) });
                });
                response.on("error", () => fail("network_error"));
              },
            );
            const timer = setTimeout(() => fail("timeout"), limits.timeoutMs);
            request.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "EADDRNOTALLOWED" ? "address_not_allowed" : "network_error"));
            request.end();
          });
        },
        close() {
          agents["http:"].destroy();
          agents["https:"].destroy();
        },
      };
    },
  };
}

export function header(headers: IncomingHttpHeaders, name: string): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}
