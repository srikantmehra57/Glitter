import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserPane } from "./BrowserPane";
import { bridge } from "../lib/bridge";
import { resetStore, seedStore } from "../test/store";
import { useAppStore } from "../lib/store";
import type { BrowserControlResult } from "../lib/types";

vi.mock("../lib/bridge", async (importOriginal) => ({ ...await importOriginal(), bridge: vi.fn() }));

const mockedBridge = vi.mocked(bridge);
const ready = (url: string): BrowserControlResult => ({ state: { status: "ready", url, title: "Fixture", viewport: { width: 800, height: 600 } }, text: "Ready" });
const closed: BrowserControlResult = { state: { status: "closed", url: "", title: "", viewport: { width: 800, height: 600 } }, text: "Closed" };

describe("BrowserPane", () => {
  let url = "http://localhost:3000/";
  beforeEach(() => {
    resetStore();
    url = "http://localhost:3000/";
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ = {};
    mockedBridge.mockReset();
    mockedBridge.mockImplementation(async (method, params = {}) => {
      if (method === "browserClose") return closed;
      if (method === "browserOpen" && typeof params.url === "string") url = params.url;
      return ready(url);
    });
    seedStore({
      workspaces: [{ id: "w", path: "/repo", name: "repo", grantId: "g" }],
      selectedWorkspaceId: "w",
      preview: false,
      browserOpen: true,
      browserState: ready(url).state,
      browserFrame: { workspaceRoot: "/repo", mediaType: "image/jpeg", data: "aW1n", url, sequence: 1 },
    });
  });
  afterEach(() => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  });

  it("starts the live stream only while open and stops it with the captured grant", async () => {
    const view = render(<BrowserPane />);
    await waitFor(() => expect(mockedBridge).toHaveBeenCalledWith("browserControl", { action: "setStreaming", stream: true, grantId: "g" }));
    view.unmount();
    await waitFor(() => expect(mockedBridge).toHaveBeenCalledWith("browserControl", { action: "setStreaming", stream: false, grantId: "g" }));
  });

  it("normalizes the address and opens the typed local URL", async () => {
    render(<BrowserPane />);
    await waitFor(() => expect(useAppStore.getState().browserBusy).toBe(false));
    const input = screen.getByRole("textbox", { name: "Browser address" });
    fireEvent.change(input, { target: { value: "localhost:4321" } });
    fireEvent.click(screen.getByRole("button", { name: "Go" }));
    await waitFor(() => expect(mockedBridge).toHaveBeenCalledWith("browserOpen", expect.objectContaining({ url: "http://localhost:4321/", grantId: "g" })));
  });

  it("maps pointer input through the rendered frame and forwards keyboard input", async () => {
    const { container } = render(<BrowserPane />);
    const viewport = container.querySelector(".browser-viewport")!;
    viewport.getBoundingClientRect = () => ({ left: 100, top: 50, width: 400, height: 300, right: 500, bottom: 350, x: 100, y: 50, toJSON: () => ({}) }) as DOMRect;
    fireEvent.click(viewport, { clientX: 300, clientY: 200 });
    await waitFor(() => expect(mockedBridge).toHaveBeenCalledWith("browserControl", { action: "click", x: 400, y: 300, grantId: "g" }));
    const keyboard = screen.getByRole("textbox", { name: "Type into the shared browser" });
    fireEvent.change(keyboard, { target: { value: "Hi" } });
    await waitFor(() => expect(mockedBridge).toHaveBeenCalledWith("browserControl", { action: "type", text: "Hi", grantId: "g" }));
    fireEvent.keyDown(keyboard, { key: "Enter" });
    await waitFor(() => expect(mockedBridge).toHaveBeenCalledWith("browserControl", { action: "key", key: "Enter", grantId: "g" }));
  });

  it("closes the shared browser from its header", async () => {
    render(<BrowserPane />);
    fireEvent.click(screen.getByRole("button", { name: "Close browser" }));
    await waitFor(() => expect(useAppStore.getState().browserOpen).toBe(false));
    expect(mockedBridge).toHaveBeenCalledWith("browserClose", { grantId: "g" });
  });

  it("explains when the desktop browser is unavailable", () => {
    delete (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
    render(<BrowserPane />);
    expect(screen.getAllByText(/needs the desktop app/).length).toBeGreaterThan(0);
    expect(mockedBridge).not.toHaveBeenCalled();
  });
});
