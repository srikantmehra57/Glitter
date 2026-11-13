/** Browser-safe protocol shared by the Node bridge and the desktop renderer. */
export const BROWSER_ACTIONS = ["open", "navigate", "state", "snapshot", "screenshot", "click", "type", "key", "scroll", "back", "forward", "reload", "wait", "console", "resize", "setStreaming", "close"] as const;
export type BrowserAction = (typeof BROWSER_ACTIONS)[number];
export type BrowserViewport = { width: number; height: number };
export type BrowserControlInput = {
  action: BrowserAction;
  url?: string;
  selector?: string;
  ref?: string;
  text?: string;
  key?: string;
  x?: number;
  y?: number;
  deltaX?: number;
  deltaY?: number;
  ms?: number;
  width?: number;
  height?: number;
  stream?: boolean;
};
export type BrowserImage = { type: "image"; mediaType: "image/jpeg"; data: string };
export type BrowserState = {
  status: "ready" | "closed" | "error";
  url: string;
  title: string;
  viewport: BrowserViewport;
  error?: string;
};
export type BrowserStateEvent = BrowserState & { workspaceRoot: string; reveal?: boolean };
export type BrowserFrame = { workspaceRoot: string; mediaType: "image/jpeg"; data: string; url: string; sequence: number };
export type BrowserControlResult = { state: BrowserState; text: string; image?: BrowserImage };
export type BrowserEvent = "browserState" | "browserFrame";
