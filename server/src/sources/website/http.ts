// Minimal GET transport on node:http(s). Redirects are never followed here: callers see every
// 3xx and decide. A "connection" owns a dedicated keep-alive agent, so NTLM (which authenticates
// the TCP connection, not the request) can run its handshake on one socket.
import http from "node:http";
import https from "node:https";
import type { IncomingHttpHeaders } from "node:http";

export interface RawResponse {
  url: string;
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

export type TransportErrorCode = "timeout" | "network_error" | "response_too_large" | "unsupported_scheme";

export class TransportError extends Error {
  constructor(readonly code: TransportErrorCode) {
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

/** Real sockets. `ca` is for deployments behind a private CA; certificates are always verified. */
export function nodeTransport(options: { ca?: string | Buffer } = {}): HttpTransport {
  return {
    open({ maxSockets }) {
      const agents = {
        "http:": new http.Agent({ keepAlive: true, maxSockets }),
        "https:": new https.Agent({ keepAlive: true, maxSockets, ...(options.ca ? { ca: options.ca } : {}) }),
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
            const module = protocol === "https:" ? https : http;
            let settled = false;
            const fail = (code: TransportErrorCode) => {
              if (settled) return;
              settled = true;
              clearTimeout(timer);
              request.destroy();
              reject(new TransportError(code));
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
                if (Number.isFinite(declared) && declared > limits.maxBytes) {
                  fail("response_too_large");
                  return;
                }
                const chunks: Buffer[] = [];
                let size = 0;
                response.on("data", (chunk: Buffer) => {
                  size += chunk.length;
                  if (size > limits.maxBytes) fail("response_too_large");
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
            request.on("error", () => fail("network_error"));
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
