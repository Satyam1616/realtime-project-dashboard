import { useEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /** Widen for forms that would otherwise feel cramped. */
  wide?: boolean;
}

/**
 * A dialog with the three behaviours people expect and most hand-rolled modals
 * miss: Escape closes it, a backdrop click closes it, and focus moves inside
 * on open so the keyboard does not stay behind the overlay.
 *
 * Rendered through a portal so a modal opened from inside a scrolling panel is
 * not clipped by that panel's `overflow`.
 */
export const Modal = ({ title, onClose, children, footer, wide }: ModalProps): React.JSX.Element => {
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);

    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';

    // The first focusable control, or the panel itself for a read-only dialog.
    const focusable = panel.current?.querySelector<HTMLElement>(
      'input, select, textarea, button:not([data-autofocus-skip])',
    );
    (focusable ?? panel.current)?.focus();

    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        // `mousedown` on the backdrop itself — not a click that merely *ended*
        // there after a drag-select inside the dialog.
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        ref={panel}
        tabIndex={-1}
        style={wide ? { maxWidth: 720 } : undefined}
      >
        <div className="modal-header">
          <h2>{title}</h2>
          <button
            type="button"
            className="btn btn-ghost btn-icon"
            onClick={onClose}
            aria-label="Close"
            data-autofocus-skip
          >
            ✕
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-footer">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
};
