import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ImageViewer } from "./ImageViewer";
import { useAppStore } from "../lib/store";
import { resetStore, seedStore } from "../test/store";

const images = [
  { name: "one.png", mediaType: "image/png", base64Data: "AA==" },
  { name: "two.png", mediaType: "image/png", base64Data: "AA==" },
];

describe("ImageViewer", () => {
  beforeEach(resetStore);

  it("contains focus in a native dialog and restores the opener on Escape", async () => {
    const opener = document.createElement("button");
    document.body.append(opener);
    opener.focus();
    seedStore({ viewer: { images, index: 0 } });
    render(<ImageViewer />);

    const dialog = screen.getByRole("dialog", { name: "one.png" }) as HTMLDialogElement;
    expect(dialog).toBeInstanceOf(HTMLDialogElement);
    expect(dialog.open).toBe(true);
    const close = screen.getByRole("button", { name: "Close preview" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent(dialog, new Event("cancel", { cancelable: true }));
    expect(useAppStore.getState().viewer).toBeNull();
    dialog.close();
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("moves between images with the arrow keys", () => {
    seedStore({ viewer: { images, index: 0 } });
    render(<ImageViewer />);
    const dialog = screen.getByRole("dialog", { name: "one.png" }) as HTMLDialogElement;
    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("dialog", { name: "two.png" })).toBeInTheDocument();
    expect(screen.getByText("2 of 2")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByRole("dialog", { name: "one.png" })).toBeInTheDocument();
  });
});
