import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { SelectMenu } from "./SelectMenu";
import { menuPosition } from "../lib/menuPosition";

const options = [
  { value: "auto", label: "Automatic" },
  { value: "disabled", label: "Unavailable", disabled: true },
  { value: "weaving", label: "Weaving" },
];

describe("select menu overlays", () => {
  it("positions within an offset and scaled dialog's padding box", () => {
    render(<dialog open aria-label="Settings"><SelectMenu id="animation" value="auto" placeholder="Animation" options={options} onChange={vi.fn()} /></dialog>);
    const dialog = screen.getByRole("dialog");
    const trigger = screen.getByRole("button", { name: "Animation" });
    Object.defineProperties(dialog, {
      offsetWidth: { value: 800 }, offsetHeight: { value: 600 },
      clientWidth: { value: 798 }, clientHeight: { value: 598 },
      clientLeft: { value: 1 }, clientTop: { value: 1 },
    });
    vi.spyOn(dialog, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 50, 1600, 1200));
    vi.spyOn(trigger, "getBoundingClientRect").mockReturnValue(new DOMRect(1000, 550, 500, 68));
    const scrollHeight = vi.spyOn(Element.prototype, "scrollHeight", "get").mockReturnValue(100);
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toHaveStyle({ position: "absolute", left: "449px", top: "143px", width: "250px" });
    scrollHeight.mockRestore();
  });

  it("escapes a modal's clipping container while keeping selection and keyboard focus in the modal", () => {
    const onChange = vi.fn();
    render(<dialog open aria-label="Settings"><div data-testid="scroller" style={{ overflow: "hidden" }}>
      <SelectMenu id="animation" value="auto" placeholder="Animation" options={options} onChange={onChange} />
    </div></dialog>);
    const trigger = screen.getByRole("button", { name: "Animation" });
    fireEvent.click(trigger);
    const menu = screen.getByRole("listbox");
    expect(screen.getByRole("dialog")).toContainElement(menu);
    expect(screen.getByTestId("scroller")).not.toContainElement(menu);
    const automatic = within(menu).getByRole("option", { name: "Automatic" });
    expect(automatic).toHaveFocus();
    fireEvent.keyDown(automatic, { key: "ArrowDown" });
    const weaving = within(menu).getByRole("option", { name: "Weaving" });
    expect(weaving).toHaveFocus();
    fireEvent.pointerDown(weaving);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.keyDown(weaving, { key: "Enter" });
    expect(onChange).toHaveBeenCalledWith("weaving");
    expect(screen.queryByRole("listbox")).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it("dismisses on outside clicks and anchor scrolling, while options remain scrollable", () => {
    render(<div><div data-testid="scroller"><SelectMenu id="animation" placeholder="Animation" options={options} onChange={vi.fn()} /></div><button>Outside</button></div>);
    const trigger = screen.getByRole("button", { name: "Animation" });
    let top = 100;
    vi.spyOn(trigger, "getBoundingClientRect").mockImplementation(() => new DOMRect(100, top, 240, 34));
    fireEvent.click(trigger);
    fireEvent.scroll(screen.getByRole("listbox"));
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(screen.getByRole("listbox"), "a queued scroll at the same anchor position keeps the menu open").toBeInTheDocument();
    top -= 24;
    fireEvent.scroll(screen.getByTestId("scroller"));
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(trigger);
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("returns focus on Escape and respects a disabled fieldset", () => {
    const view = render(<fieldset><SelectMenu id="animation" placeholder="Animation" options={options} onChange={vi.fn()} /></fieldset>);
    const trigger = screen.getByRole("button", { name: "Animation" });
    fireEvent.click(trigger);
    fireEvent.keyDown(screen.getByRole("option", { name: "Automatic" }), { key: "Escape" });
    expect(trigger).toHaveFocus();
    expect(screen.queryByRole("listbox")).toBeNull();
    view.rerender(<fieldset disabled><SelectMenu id="animation" placeholder="Animation" options={options} onChange={vi.fn()} /></fieldset>);
    fireEvent.keyDown(trigger, { key: "ArrowDown" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("menu positioning", () => {
  const bounds = { left: 100, right: 900, top: 50, bottom: 650 };

  it("opens above a low trigger instead of clipping beneath the dialog", () => {
    expect(menuPosition({ left: 200, right: 600, top: 550, bottom: 588 }, { width: 400, height: 340 }, bounds, true))
      .toEqual({ left: 200, top: 204, width: 400, maxHeight: 340 });
  });

  it("opens below a high trigger even when the preferred side is above", () => {
    expect(menuPosition({ left: 200, right: 600, top: 80, bottom: 118 }, { width: 400, height: 340 }, bounds, false))
      .toEqual({ left: 200, top: 124, width: 400, maxHeight: 340 });
  });

  it("constrains a long menu's height and clamps it away from the right edge", () => {
    const position = menuPosition({ left: 800, right: 890, top: 330, bottom: 368 }, { width: 400, height: 340 }, bounds, true);
    expect(position).toEqual({ left: 492, top: 374, width: 400, maxHeight: 268 });
    expect(position.top + position.maxHeight).toBeLessThan(bounds.bottom);
  });

  it("fits narrow windows and preserves right alignment when there is room", () => {
    expect(menuPosition({ left: 150, right: 190, top: 80, bottom: 118 }, { width: 400, height: 100 }, { left: 0, right: 200, top: 0, bottom: 300 }, true))
      .toEqual({ left: 8, top: 124, width: 184, maxHeight: 100 });
    expect(menuPosition({ left: 600, right: 800, top: 80, bottom: 118 }, { width: 340, height: 100 }, bounds, true, true).left).toBe(460);
  });
});
