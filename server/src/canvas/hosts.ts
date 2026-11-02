/** The user typed a Canvas address the server will not contact. `message` is shown to them. */
export class CanvasAddressError extends Error {}

export function isAllowedHost(host: string, patterns: string[]): boolean {
  return patterns.some((pattern) => (pattern.startsWith("*.") ? host.endsWith(pattern.slice(1)) : host === pattern));
}

/**
 * Reduces what the user pasted (any Canvas page URL or a bare host name) to an https origin on an
 * allowed host. The API sends the user's token to this origin, so nothing else is accepted.
 */
export function canvasOrigin(input: string, allowedHosts: string[]): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
  } catch {
    throw new CanvasAddressError("Enter your school's Canvas address, for example https://canvas.illinois.edu.");
  }
  if (url.protocol !== "https:") {
    throw new CanvasAddressError("The Canvas address must start with https://.");
  }
  if (url.username || url.password || url.port) {
    throw new CanvasAddressError("Enter the Canvas address without a user name or port number.");
  }
  const host = url.hostname.toLowerCase();
  if (!isAllowedHost(host, allowedHosts)) {
    throw new CanvasAddressError(`${host} is not a supported Canvas site. Supported: ${allowedHosts.join(", ")}.`);
  }
  return url.origin;
}
