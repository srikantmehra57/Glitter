import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { DiffLines } from "./DiffLines";
import type { DiffLine } from "../lib/diff";

const lines: DiffLine[] = [
  { type: "hunk", text: "@@ -1,2 +1,2 @@" },
  { type: "ctx", text: " keep", oldLine: 1, newLine: 1 },
  { type: "del", text: "-old", oldLine: 2 },
  { type: "add", text: "+new", newLine: 2 },
];

describe("DiffLines comments", () => {
  it("offers a comment button on numbered lines only when the caller takes comments", () => {
    const onComment = vi.fn();
    const view = render(<DiffLines lines={lines} onComment={onComment} />);
    expect(screen.getAllByRole("button")).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Comment on removed line 2" }));
    expect(onComment).toHaveBeenLastCalledWith(lines[2]);
    view.rerender(<DiffLines lines={lines} mode="split" onComment={onComment} />);
    fireEvent.click(screen.getByRole("button", { name: "Comment on line 2" }));
    expect(onComment).toHaveBeenLastCalledWith(lines[3]);
    view.rerender(<DiffLines lines={lines} />);
    expect(screen.queryByRole("button")).toBeNull();
  });
});
