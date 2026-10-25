import { useEffect, useRef } from "react";
import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useModalDialog } from "../lib/dialogFocus";
import { usePresence, useRetained } from "../lib/presence";
import { useAppStore } from "../lib/store";

export function ImageViewer() {
  const open = useAppStore((state) => state.viewer);
  // Drawn from the last image while the overlay fades out.
  const viewer = useRetained(open);
  const { mounted, closing } = usePresence(Boolean(open));
  const closeViewer = useAppStore((state) => state.closeViewer);
  const stepViewer = useAppStore((state) => state.stepViewer);
  const dialog = useRef<HTMLDialogElement>(null);
  useModalDialog(Boolean(open), dialog);
  useEffect(() => {
    if (open) dialog.current?.querySelector<HTMLButtonElement>(".viewer-close")?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || open.images.length < 2) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowRight") stepViewer(1);
      else if (event.key === "ArrowLeft") stepViewer(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, stepViewer]);
  if (!mounted || !viewer) return null;
  const current = viewer.images[viewer.index];
  if (!current) return null;
  const multiple = viewer.images.length > 1;
  return (
    <dialog
      ref={dialog}
      className={`viewer-overlay${closing ? " closing" : ""}`}
      aria-modal="true"
      aria-label={current.name || "Image preview"}
      aria-hidden={!open}
      onCancel={(event) => { event.preventDefault(); closeViewer(); }}
      onClose={closeViewer}
      onMouseDown={(event) => { if (event.target === event.currentTarget) closeViewer(); }}
    >
      <figure className="viewer-frame">
        <img src={`data:${current.mediaType};base64,${current.base64Data}`} alt={current.name} />
        <figcaption className="viewer-bar">
          <span className="viewer-name" title={current.name}>{current.name}</span>
          {multiple ? <span className="viewer-count">{viewer.index + 1} of {viewer.images.length}</span> : null}
        </figcaption>
      </figure>
      {multiple ? (
        <>
          <button type="button" className="viewer-nav prev" aria-label="Previous image" onClick={() => stepViewer(-1)}><ChevronLeft size={20} aria-hidden="true" /></button>
          <button type="button" className="viewer-nav next" aria-label="Next image" onClick={() => stepViewer(1)}><ChevronRight size={20} aria-hidden="true" /></button>
        </>
      ) : null}
      <button type="button" className="viewer-close" aria-label="Close preview" onClick={closeViewer}><X size={16} aria-hidden="true" /></button>
    </dialog>
  );
}
