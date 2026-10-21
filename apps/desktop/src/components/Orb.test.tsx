import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render } from "@testing-library/react";
import { Orb } from "./Orb";

vi.mock("thinking-orbs", () => ({
  ThinkingOrb: ({ size = 64 }: { size?: number }) => <canvas width={size} height={size} />,
}));

const originalContext = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, "getContext");
const context = {
  fillRect: vi.fn(), clearRect: vi.fn(), drawImage: vi.fn(), putImageData: vi.fn(),
  getImageData: vi.fn(() => ({ data: new Uint8ClampedArray([0, 0, 0, 0, 20, 20, 20, 255]) })),
  fillStyle: "",
};
const frames = new Map<number, FrameRequestCallback>();
const motion = { matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() };
let frameId = 0;

function paintFrame() {
  act(() => {
    const pending = [...frames.values()];
    frames.clear();
    for (const callback of pending) callback(500);
  });
}

describe("orb tint lifecycle", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    frames.clear();
    motion.matches = true;
    Object.defineProperty(HTMLCanvasElement.prototype, "getContext", { configurable: true, value: () => context });
    vi.stubGlobal("matchMedia", vi.fn(() => motion));
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => { frames.set(++frameId, callback); return frameId; });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalContext) Object.defineProperty(HTMLCanvasElement.prototype, "getContext", originalContext);
  });

  it("copies a static frame for reduced motion, repaints a new selection and cleans up subscriptions", () => {
    const view = render(<Orb state="working" size={64} />);
    paintFrame();
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(context.putImageData).toHaveBeenCalledOnce();
    expect(view.container.querySelector(".orb-tint")).toHaveAttribute("width", "64");
    expect(frames.size).toBe(0);
    view.rerender(<Orb state="shaping" size={20} />);
    paintFrame();
    expect(context.putImageData).toHaveBeenCalledTimes(2);
    expect(view.container.querySelector(".orb-tint")).toHaveAttribute("width", "20");
    expect(frames.size).toBe(0);
    view.unmount();
    expect(motion.removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    expect(frames.size).toBe(0);
  });

  it("stops copying frames when paused and resumes when unpaused", () => {
    motion.matches = false;
    const view = render(<Orb state="weaving" size={20} />);
    paintFrame();
    expect(frames.size).toBe(1);
    view.rerender(<Orb state="weaving" size={20} paused />);
    paintFrame();
    expect(frames.size).toBe(0);
    view.rerender(<Orb state="weaving" size={20} />);
    paintFrame();
    expect(frames.size).toBe(1);
    view.unmount();
    expect(frames.size).toBe(0);
  });
});
