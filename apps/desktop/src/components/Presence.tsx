import type { ReactNode } from "react";
import { usePresence } from "../lib/presence";

/** Keeps its children mounted for one exit after `open` turns false, so they can animate out. */
export function Presence({ open, children }: { open: boolean; children: ReactNode }) {
  const { mounted } = usePresence(open);
  return mounted ? <>{children}</> : null;
}

/**
 * A section that grows open and shrinks closed. The content is a function so a
 * closed section builds nothing. Pass `animate={false}` for content that is
 * restored rather than opened by the user (a virtual list remounting an open
 * group must not shift the scroll).
 */
export function Collapse({ open, animate = true, children }: { open: boolean; animate?: boolean; children: () => ReactNode }) {
  const { mounted, closing } = usePresence(open, animate ? undefined : 0);
  if (!mounted) return null;
  return <div className={animate ? `reveal${closing ? " closing" : ""}` : undefined}><div>{children()}</div></div>;
}
