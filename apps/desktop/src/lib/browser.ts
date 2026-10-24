export type BrowserViewport = { width: number; height: number };
export type BrowserRect = { left: number; top: number; width: number; height: number };
export type BrowserPoint = { x: number; y: number; scale: number };

/** Map a pointer through an object-fit: contain frame into browser CSS pixels. */
export function browserPoint(clientX: number, clientY: number, rect: BrowserRect, viewport: BrowserViewport): BrowserPoint | null {
  if (!(rect.width > 0 && rect.height > 0 && viewport.width > 0 && viewport.height > 0)) return null;
  const scale = Math.min(rect.width / viewport.width, rect.height / viewport.height);
  if (!(scale > 0 && Number.isFinite(scale))) return null;
  const width = viewport.width * scale;
  const height = viewport.height * scale;
  const left = rect.left + (rect.width - width) / 2;
  const top = rect.top + (rect.height - height) / 2;
  const x = (clientX - left) / scale;
  const y = (clientY - top) / scale;
  if (x < 0 || y < 0 || x >= viewport.width || y >= viewport.height) return null;
  return { x: Math.min(viewport.width - 1, Math.floor(x)), y: Math.min(viewport.height - 1, Math.floor(y)), scale };
}

/** The address field accepts a host shorthand, but native IPC receives a full URL. */
export function normalizeBrowserAddress(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Enter a local server or web address.");
  const hostWithPort = /^[^/?:]+:\d+(?:[/?#]|$)/.test(trimmed);
  const candidate = !hostWithPort && /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed) ? trimmed : `http://${trimmed}`;
  const url = new URL(candidate);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Browser supports only http:// and https:// addresses.");
  if (url.username || url.password) throw new Error("Browser addresses cannot contain credentials.");
  return url.href;
}
