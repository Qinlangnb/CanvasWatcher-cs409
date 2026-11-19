// The link a task card opens. Only stored, stable http(s) pages qualify: no credentials, query or
// fragment (signed or expiring links), no API paths, no download or preview endpoints.

export function safeTaskUrl(value: string | null | undefined): string | null {
  const text = value?.trim();
  if (!text || /[\x00-\x1f\\]/.test(text)) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || !url.hostname) return null;
  if (url.username || url.password || url.search || url.hash || text.includes("?") || text.includes("#")) return null;
  let path: string;
  try {
    path = decodeURIComponent(url.pathname).toLowerCase();
  } catch {
    return null;
  }
  if (path.startsWith("/api/")) return null;
  if (path.split("/").some((part) => part === "download" || part === "preview")) return null;
  return text;
}
