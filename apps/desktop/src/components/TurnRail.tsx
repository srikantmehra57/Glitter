import { useEffect, useMemo, useState } from "react";
import { groupAgentRuns } from "../lib/agent";
import type { Thread } from "../lib/types";

const find = (root: HTMLElement, key: string, value: string) => root.querySelector<HTMLElement>(`[data-${key}="${CSS.escape(value)}"]`);

/**
 * The thread's prompts as a rail at the edge of the transcript: one dash per
 * message you sent, opening on hover or focus into a list to jump back to.
 */
export function TurnRail({ thread, scroller }: { thread: Thread; scroller: React.RefObject<HTMLDivElement | null> }) {
  const turns = useMemo(() => thread.items.flatMap((item) => (item.kind === "userMessage" ? [{ id: item.itemId, text: (item.text ?? "").trim().split("\n")[0] }] : [])), [thread.items]);
  const [active, setActive] = useState(turns.length - 1);

  // The current prompt is the last one whose message has scrolled to the top of the view.
  useEffect(() => {
    const root = scroller.current;
    if (!root) return;
    let frame = 0;
    const measure = () => {
      frame = 0;
      const top = root.getBoundingClientRect().top + 96;
      let at = -1;
      turns.forEach((turn, index) => { const node = find(root, "item", turn.id); if (node && node.getBoundingClientRect().top <= top) at = index; });
      // Messages far off screen are placeholders, so "none above" only means the first when it is on screen.
      if (at >= 0) setActive(at);
      else if (turns[0] && find(root, "item", turns[0].id)) setActive(0);
    };
    const onScroll = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => { root.removeEventListener("scroll", onScroll); if (frame) cancelAnimationFrame(frame); };
  }, [turns, scroller]);

  if (turns.length < 2) return null;

  const jump = (id: string, index: number) => {
    const root = scroller.current;
    if (!root) return;
    setActive(index);
    // A run scrolled far away is only a placeholder: scroll to that first, then look for the message again.
    let runId: string | undefined;
    let tries = 0;
    const reveal = () => {
      const message = find(root, "item", id);
      if (message) { root.scrollTop += message.getBoundingClientRect().top - root.getBoundingClientRect().top - 20; return; }
      runId ??= groupAgentRuns(thread.items).find((run) => run.steps.some((step) => step.id === id))?.id;
      if (!runId) return;
      (find(root, "virtual-run", runId) ?? find(root, "run", runId))?.scrollIntoView({ block: "start" });
      if (tries++ < 30) requestAnimationFrame(reveal);
    };
    reveal();
  };

  return (
    <nav className="turn-rail" aria-label="Messages in this thread">
      <ol>
        {turns.map((turn, index) => {
          const label = turn.text || `Message ${index + 1}`;
          return (
            <li key={turn.id}>
              <button type="button" className={index === active ? "active" : ""} aria-current={index === active ? "true" : undefined} aria-label={`Go to message ${index + 1}: ${label}`} onClick={() => jump(turn.id, index)}>
                <i aria-hidden="true" />
                <span>{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
