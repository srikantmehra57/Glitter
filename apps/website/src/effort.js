// 03 — a rebuild of the app's reasoning-effort gauge, wired to the particle ring.

// TIER_COPY verbatim from apps/desktop/src/lib/effort.ts (ultra excluded — the
// composer vocabulary tops out at Max).
const TIERS = [
  { id: "none", label: "None", short: "None", blurb: "Answers straight away, no reasoning" },
  { id: "minimal", label: "Minimal", short: "Min", blurb: "A glance before acting" },
  { id: "low", label: "Low", short: "Low", blurb: "Quick, light reasoning" },
  { id: "medium", label: "Medium", short: "Med", blurb: "Balanced speed and depth" },
  { id: "high", label: "High", short: "High", blurb: "Thinks it through before acting" },
  { id: "xhigh", label: "Extra high", short: "XHigh", blurb: "Careful, multi-step reasoning" },
  { id: "max", label: "Max", short: "Max", blurb: "Everything it's got. Slowest, deepest." },
];
const DEFAULT = 4; // High: the tier the model starts on, marked by the dashed line
const BARS = 5;

const flame = (size) =>
  `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>`;

export function initEffort() {
  const pop = document.getElementById("effort-pop");
  const section = document.getElementById("dial");
  const scrubber = document.getElementById("scrubber");
  if (!pop || !scrubber) return;
  const nameEl = document.getElementById("effort-name");
  const blurbEl = document.getElementById("effort-blurb");
  const shortEl = document.getElementById("effort-short");
  const meterEl = document.getElementById("effort-meter");
  const ends = [...pop.querySelectorAll("[data-end]")];

  const max = TIERS.length - 1;
  let index = DEFAULT;
  let pos = index;
  let dragging = false;
  let detent = index;

  pop.style.setProperty("--at", DEFAULT / max);
  const bars = Array.from({ length: BARS }, (_, i) => {
    const bar = document.createElement("i");
    bar.style.height = `${5 + i * 2.5}px`;
    meterEl.appendChild(bar);
    return bar;
  });

  const isPeak = (i) => i === max;

  function paint() {
    pop.style.setProperty("--pos", pos / max);
    ends[0]?.classList.toggle("active", Math.round(pos) === 0);
    ends[1]?.classList.toggle("active", Math.round(pos) === max);
  }

  function preview() {
    const level = Math.round(pos);
    const tier = TIERS[level] ?? TIERS[index];
    const peak = isPeak(level);
    nameEl.innerHTML = `${peak ? flame(26) : ""}${tier.label}`;
    blurbEl.textContent = tier.blurb;
    shortEl.innerHTML = `${peak ? flame(14) : ""}${tier.short}`;
    meterEl.hidden = peak;
    const filled = Math.round((level / max) * (BARS - 1)) + 1;
    bars.forEach((bar, i) => bar.classList.toggle("on", i < filled));
    pop.classList.toggle("peak", peak);
    section?.classList.toggle("peak", peak);
    // retrigger the tier-in animation
    nameEl.style.animation = "none";
    void nameEl.offsetWidth;
    nameEl.style.animation = "";
  }

  function apply(i) {
    index = Math.min(max, Math.max(0, i));
    pos = index;
    detent = index;
    scrubber.setAttribute("aria-valuenow", String(index));
    scrubber.setAttribute("aria-valuetext", TIERS[index].label);
    window.museScene?.setEffort(index / max);
    paint();
    preview();
  }

  const commit = (next) => apply(Math.round(next));

  const fromPointer = (clientX) => {
    const rect = scrubber.getBoundingClientRect();
    if (!rect.width) return pos;
    return Math.min(max, Math.max(0, ((clientX - rect.left) / rect.width) * max));
  };
  const scrubTo = (next) => {
    pos = next;
    const nearest = Math.round(next);
    if (nearest !== detent) {
      detent = nearest;
      preview();
    }
    paint();
  };

  scrubber.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    scrubber.setPointerCapture(event.pointerId);
    dragging = true;
    scrubber.classList.add("dragging");
    scrubTo(fromPointer(event.clientX));
  });
  scrubber.addEventListener("pointermove", (event) => {
    if (dragging) scrubTo(fromPointer(event.clientX));
  });
  scrubber.addEventListener("pointerup", (event) => {
    if (!dragging) return;
    dragging = false;
    scrubber.classList.remove("dragging");
    commit(fromPointer(event.clientX));
  });
  scrubber.addEventListener("pointercancel", () => {
    dragging = false;
    scrubber.classList.remove("dragging");
    apply(index);
  });
  scrubber.addEventListener("wheel", (event) => {
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : -event.deltaY;
    if (Math.abs(delta) < 4) return;
    event.preventDefault();
    commit(index + (delta > 0 ? 1 : -1));
  });
  scrubber.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" || event.key === "ArrowUp" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowDown" ? -1 : 0;
    if (step) {
      event.preventDefault();
      commit(index + step);
    } else if (event.key === "Home") {
      event.preventDefault();
      commit(0);
    } else if (event.key === "End") {
      event.preventDefault();
      commit(max);
    }
  });

  // The two ends, as on a gauge: each is also a shortcut to that tier.
  ends.forEach((button) => button.addEventListener("click", () => commit(button.dataset.end === "first" ? 0 : max)));

  apply(index);
}
