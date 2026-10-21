import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";
import { menuPosition } from "../lib/menuPosition";
import { EXIT_FAST_MS, usePresence } from "../lib/presence";

export type SelectMenuOption = {
  value: string;
  label: string;
  description?: string;
  disabled?: boolean;
  icon?: ReactNode;
  tone?: "danger";
};

type SelectMenuProps = {
  id: string;
  value?: string;
  placeholder: string;
  options: SelectMenuOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  icon?: ReactNode;
  label?: string;
  heading?: string;
  className?: string;
  ariaLabel?: string;
};

function firstEnabled(options: SelectMenuOption[]) {
  return options.findIndex((option) => !option.disabled);
}

function lastEnabled(options: SelectMenuOption[]) {
  for (let index = options.length - 1; index >= 0; index -= 1) {
    if (!options[index].disabled) return index;
  }
  return -1;
}

export function SelectMenu({
  id,
  value,
  placeholder,
  options,
  onChange,
  disabled = false,
  icon,
  label,
  heading,
  className = "",
  ariaLabel,
}: SelectMenuProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listboxId = `${useId()}-listbox`;
  const [open, setOpen] = useState(false);
  const pop = usePresence(open, EXIT_FAST_MS);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [position, setPosition] = useState<(ReturnType<typeof menuPosition> & { position: "absolute" | "fixed" }) | null>(null);
  const selectedIndex = options.findIndex((option) => option.value === value);
  const selected = selectedIndex >= 0 ? options[selectedIndex] : undefined;

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node) && !popoverRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const root = rootRef.current;
    const trigger = triggerRef.current;
    const popover = popoverRef.current;
    if (!root || !trigger || !popover) return;
    let anchorAtPosition = trigger.getBoundingClientRect();
    const update = () => {
      const style = getComputedStyle(root);
      const rect = trigger.getBoundingClientRect();
      anchorAtPosition = rect;
      const modal = root.closest("dialog");
      const modalRect = modal?.getBoundingClientRect();
      // Frosted and animated dialogs establish their own containing block.
      // Portal within their focus scope, using padding-box coordinates rather
      // than feeding viewport coordinates to a fixed descendant.
      const scaleX = modal && modalRect && modal.offsetWidth ? modalRect.width / modal.offsetWidth : 1;
      const scaleY = modal && modalRect && modal.offsetHeight ? modalRect.height / modal.offsetHeight : 1;
      const localX = (value: number) => modal && modalRect ? (value - modalRect.left) / scaleX - modal.clientLeft + modal.scrollLeft : value;
      const localY = (value: number) => modal && modalRect ? (value - modalRect.top) / scaleY - modal.clientTop + modal.scrollTop : value;
      const anchor = { left: localX(rect.left), right: localX(rect.right), top: localY(rect.top), bottom: localY(rect.bottom) };
      const bounds = modal
        ? { left: modal.scrollLeft, top: modal.scrollTop, right: modal.scrollLeft + modal.clientWidth, bottom: modal.scrollTop + modal.clientHeight }
        : { left: 0, top: 0, right: window.innerWidth, bottom: window.innerHeight };
      const naturalWidth = Math.min(Number.parseFloat(style.getPropertyValue("--select-max-width")) || 340,
        Math.max(220, popover.offsetWidth));
      const width = style.getPropertyValue("--select-match-width").trim() === "true"
        ? anchor.right - anchor.left : Math.max(anchor.right - anchor.left, naturalWidth);
      setPosition({ ...menuPosition(anchor, { width, height: Math.min(340, popover.scrollHeight) }, bounds,
        style.getPropertyValue("--select-side").trim() === "bottom", style.getPropertyValue("--select-align").trim() === "right"), position: modal ? "absolute" : "fixed" });
    };
    const dismissOnScroll = (event: Event) => {
      // Scrolling the options is fine; scrolling their anchor dismisses the
      // overlay so it cannot float over an unrelated part of the settings.
      if (popover.contains(event.target as Node)) return;
      const current = trigger.getBoundingClientRect();
      // Focus/click can queue a scroll event before the menu opens. Keep the
      // menu when it was already positioned at the anchor's final location.
      if (current.left !== anchorAtPosition.left || current.top !== anchorAtPosition.top) setOpen(false);
    };
    update();
    window.addEventListener("resize", update);
    document.addEventListener("scroll", dismissOnScroll, true);
    return () => {
      window.removeEventListener("resize", update);
      document.removeEventListener("scroll", dismissOnScroll, true);
    };
  }, [open, options]);

  useEffect(() => {
    if (!open || !position) return;
    const index = activeIndex >= 0 ? activeIndex : firstEnabled(options);
    if (index >= 0) {
      const option = optionRefs.current[index];
      const popover = popoverRef.current;
      option?.focus({ preventScroll: true });
      // scrollIntoView also scrolls the enclosing dialog, detaching the menu
      // from its trigger. Scroll only the options' own viewport instead.
      if (option && popover) {
        const row = option.getBoundingClientRect();
        const view = popover.getBoundingClientRect();
        if (row.top < view.top) popover.scrollTop -= view.top - row.top;
        else if (row.bottom > view.bottom) popover.scrollTop += row.bottom - view.bottom;
      }
    }
  }, [activeIndex, open, options, position]);

  const close = () => {
    setOpen(false);
    triggerRef.current?.focus();
  };

  const openMenu = (direction: 1 | -1 = 1) => {
    if (disabled || triggerRef.current?.matches(":disabled") || !options.some((option) => !option.disabled)) return;
    const start = selectedIndex >= 0 && !options[selectedIndex].disabled
      ? selectedIndex
      : direction === 1 ? firstEnabled(options) : lastEnabled(options);
    setActiveIndex(start);
    setPosition(null);
    setOpen(true);
  };

  const move = (from: number, direction: 1 | -1) => {
    if (!options.length) return from;
    for (let offset = 1; offset <= options.length; offset += 1) {
      const index = (from + direction * offset + options.length * 2) % options.length;
      if (!options[index].disabled) return index;
    }
    return from;
  };

  const choose = (option: SelectMenuOption) => {
    if (option.disabled || triggerRef.current?.matches(":disabled")) return;
    onChange(option.value);
    close();
  };

  return (
    <div ref={rootRef} className={`select-menu ${className}`.trim()}>
      <button
        ref={triggerRef}
        id={id}
        type="button"
        className="select-trigger"
        disabled={disabled}
        aria-label={ariaLabel ?? label ?? placeholder}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={(event) => {
          if (event.key === "ArrowDown") {
            event.preventDefault();
            openMenu(1);
          } else if (event.key === "ArrowUp") {
            event.preventDefault();
            openMenu(-1);
          } else if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            if (!open) openMenu();
          } else if (event.key === "Escape" && open) {
            event.preventDefault();
            close();
          }
        }}
      >
        {icon}
        {label ? <span className="selector-label">{label}</span> : null}
        <span className={`select-value ${selected ? "" : "placeholder"}`.trim()}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronDown className="select-chevron" size={12} aria-hidden="true" data-open={open || undefined} />
      </button>
      {pop.mounted ? createPortal(
        <div className={`select-menu select-menu-overlay ${className}`.trim()}>
        <div ref={popoverRef} id={listboxId} className={`select-menu-popover${pop.closing ? " closing" : ""}`} role="listbox" aria-label={ariaLabel ?? label ?? placeholder} style={position ?? { visibility: "hidden" }}>
          {heading ? <div className="menu-heading" aria-hidden="true">{heading}</div> : null}
          {options.map((option, index) => (
            <button
              key={option.value}
              ref={(node) => { optionRefs.current[index] = node; }}
              type="button"
              role="option"
              className={`select-option ${index === activeIndex ? "active" : ""} ${option.tone ?? ""}`.trim()}
              aria-selected={index === selectedIndex}
              disabled={option.disabled}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => choose(option)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex(move(index, event.key === "ArrowDown" ? 1 : -1));
                } else if (event.key === "Home") {
                  event.preventDefault();
                  setActiveIndex(firstEnabled(options));
                } else if (event.key === "End") {
                  event.preventDefault();
                  setActiveIndex(lastEnabled(options));
                } else if (event.key === "Enter" || event.key === " ") {
                  event.preventDefault();
                  choose(option);
                } else if (event.key === "Escape") {
                  event.preventDefault();
                  // close already returns focus to the trigger.
                  close();
                } else if (event.key === "Tab") {
                  // Dismiss and return to the trigger. The option is about to
                  // unmount, so without this Tab drops the keyboard user onto
                  // <body> and out of the composer. Prevention is deliberate:
                  // the browser would otherwise advance from a node React has
                  // not removed yet, which lands somewhere unpredictable.
                  event.preventDefault();
                  setOpen(false);
                  triggerRef.current?.focus();
                }
              }}
            >
              {option.icon ? <span className="option-icon" aria-hidden="true">{option.icon}</span> : null}
              <span className="option-copy">
                <span>{option.label}</span>
                {option.description ? <small>{option.description}</small> : null}
              </span>
              {index === selectedIndex ? <Check size={14} className="option-check" aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
        </div>,
        // Keep the menu inside a modal's focus scope and native top layer,
        // while escaping the scroll containers that clip inline popovers.
        rootRef.current?.closest("dialog") ?? document.body,
      ) : null}
    </div>
  );
}
