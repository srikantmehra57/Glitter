import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useRef } from "react";
import { Collapse, Presence } from "./Presence";
import { useModalDialog } from "../lib/dialogFocus";
import { EXIT_MS } from "../lib/presence";

function Dialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const node = useRef<HTMLDialogElement>(null);
  useModalDialog(open, node);
  return <dialog ref={node} aria-label="Probe" onClose={onClose} />;
}

/** jsdom has no matchMedia, which usePresence treats as "do not wait on animation". */
function allowMotion(reduced = false) {
  vi.stubGlobal("matchMedia", vi.fn(() => ({ matches: reduced })));
}

describe("Presence and Collapse", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

  it("keeps a section mounted with its closing class for one exit, then removes it", () => {
    allowMotion();
    const { rerender, container } = render(<Collapse open>{() => <p>Steps</p>}</Collapse>);
    expect(container.firstElementChild).toHaveClass("reveal");
    expect(container.firstElementChild).not.toHaveClass("closing");
    rerender(<Collapse open={false}>{() => <p>Steps</p>}</Collapse>);
    // The same render that closes it already carries the exit class: no blank frame.
    expect(screen.getByText("Steps")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("reveal", "closing");
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(screen.queryByText("Steps")).toBeNull();
  });

  it("stays open when reopened during the exit", () => {
    allowMotion();
    const { rerender, container } = render(<Collapse open>{() => <p>Steps</p>}</Collapse>);
    rerender(<Collapse open={false}>{() => <p>Steps</p>}</Collapse>);
    rerender(<Collapse open>{() => <p>Steps</p>}</Collapse>);
    expect(container.firstElementChild).not.toHaveClass("closing");
    act(() => { vi.advanceTimersByTime(EXIT_MS * 2); });
    expect(screen.getByText("Steps")).toBeInTheDocument();
  });

  it("removes content at once under reduced motion, and for sections that must not animate", () => {
    allowMotion(true);
    const reduced = render(<Presence open><p>Dialog</p></Presence>);
    reduced.rerender(<Presence open={false}><p>Dialog</p></Presence>);
    expect(screen.queryByText("Dialog")).toBeNull();
    reduced.unmount();

    allowMotion();
    const restored = render(<Collapse open animate={false}>{() => <p>Restored</p>}</Collapse>);
    expect(restored.container.firstElementChild).not.toHaveClass("reveal");
    restored.rerender(<Collapse open={false} animate={false}>{() => <p>Restored</p>}</Collapse>);
    expect(screen.queryByText("Restored")).toBeNull();
  });

  it("closes a dialog at once but leaves it drawn for one exit, without echoing the close", () => {
    allowMotion();
    const onClose = vi.fn();
    const { rerender, container } = render(<Dialog open onClose={onClose} />);
    const node = container.querySelector("dialog")!;
    expect(node).toHaveAttribute("open");
    rerender(<Dialog open={false} onClose={onClose} />);
    // Closed for focus and inertness straight away; only the pixels linger.
    expect(node).not.toHaveAttribute("open");
    expect(node).toHaveAttribute("data-closing");
    // The close the app asked for must not come back through the dialog's own handler.
    node.dispatchEvent(new Event("close"));
    expect(onClose).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(EXIT_MS); });
    expect(node).not.toHaveAttribute("data-closing");
    // A close the browser starts on its own still reaches the handler.
    node.dispatchEvent(new Event("close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("drops the closing state when a dialog is reopened mid-exit", () => {
    allowMotion();
    const { rerender, container } = render(<Dialog open onClose={() => {}} />);
    const node = container.querySelector("dialog")!;
    rerender(<Dialog open={false} onClose={() => {}} />);
    rerender(<Dialog open onClose={() => {}} />);
    expect(node).toHaveAttribute("open");
    expect(node).not.toHaveAttribute("data-closing");
  });

  it("builds nothing for a closed section", () => {
    const build = vi.fn(() => <p>Hidden</p>);
    render(<Collapse open={false}>{build}</Collapse>);
    expect(build).not.toHaveBeenCalled();
  });
});
