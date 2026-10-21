import { describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { createRef } from "react";
import { TurnRail } from "./TurnRail";
import type { Thread } from "../lib/types";

const thread = (prompts: string[]): Thread => ({
  sessionId: "s1",
  workspacePath: "/repo",
  title: "Work",
  updatedAt: new Date().toISOString(),
  status: "idle",
  unread: false,
  opened: true,
  items: prompts.flatMap((text, index) => [
    { itemId: `u${index}`, turnId: `t${index}`, kind: "userMessage", status: "completed", text },
    { itemId: `a${index}`, turnId: `t${index}`, kind: "agentMessage", status: "completed", text: "Done." },
  ]) as Thread["items"],
});

/** A scroller holding one message element per prompt, each 400px below the last. */
function scrollerFor(count: number) {
  const ref = createRef<HTMLDivElement>() as { current: HTMLDivElement };
  const root = document.createElement("div");
  root.getBoundingClientRect = () => ({ top: 0, bottom: 600, height: 600 }) as DOMRect;
  for (let index = 0; index < count; index += 1) {
    const message = document.createElement("article");
    message.dataset.item = `u${index}`;
    message.getBoundingClientRect = () => ({ top: index * 400 - root.scrollTop }) as DOMRect;
    root.append(message);
  }
  ref.current = root;
  return ref;
}

describe("TurnRail", () => {
  it("lists each prompt by its first line and jumps to the one chosen", () => {
    const scroller = scrollerFor(3);
    render(<TurnRail thread={thread(["Add a layout", "Fix the sidebar\nand the dock", ""])} scroller={scroller} />);
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual(["Add a layout", "Fix the sidebar", "Message 3"]);
    fireEvent.click(screen.getByRole("button", { name: "Go to message 2: Fix the sidebar" }));
    // The message lands just under the top of the view.
    expect(scroller.current.scrollTop).toBe(380);
    expect(buttons[1]).toHaveAttribute("aria-current", "true");
  });

  it("stays out of the way until a thread has more than one prompt", () => {
    const { container } = render(<TurnRail thread={thread(["Only one"])} scroller={scrollerFor(1)} />);
    expect(container).toBeEmptyDOMElement();
  });
});
