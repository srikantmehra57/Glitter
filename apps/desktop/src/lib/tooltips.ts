/**
 * CSS tooltips (`data-tooltip`, `data-tip` in styles.css) show on hover. Once
 * the control is clicked the label has done its job, and left showing it would
 * sit over whatever the click opened. This marks the clicked element until the
 * pointer leaves it; the stylesheet hides a marked element's label.
 */
export function installTooltipDismissal(): () => void {
  const onDown = (event: PointerEvent) => {
    const target = (event.target as Element | null)?.closest?.("[data-tooltip], [data-tip]");
    if (!target) return;
    target.setAttribute("data-tip-dismissed", "");
    const leave = () => { target.removeAttribute("data-tip-dismissed"); target.removeEventListener("pointerleave", leave); };
    target.addEventListener("pointerleave", leave);
  };
  document.addEventListener("pointerdown", onDown, true);
  return () => document.removeEventListener("pointerdown", onDown, true);
}
