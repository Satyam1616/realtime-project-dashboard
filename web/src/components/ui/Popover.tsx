import { useEffect, useRef, type ReactNode } from 'react';

/**
 * Dismiss-on-outside-click + Escape, shared by the user menu and the
 * notification tray.
 *
 * Bound on `mousedown` rather than `click`: a `click` listener fires after the
 * trigger's own handler has already re-opened the popover, which produces a
 * panel that cannot be closed by clicking its own button.
 */
export const useDismiss = (open: boolean, onClose: () => void): React.RefObject<HTMLDivElement | null> => {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: MouseEvent): void => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, onClose]);

  return ref;
};

export const Popover = ({
  open,
  onClose,
  trigger,
  children,
  className,
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
}): React.JSX.Element => {
  const ref = useDismiss(open, onClose);

  return (
    <div className="popover-anchor" ref={ref}>
      {trigger}
      {open ? <div className={`popover${className ? ` ${className}` : ''}`}>{children}</div> : null}
    </div>
  );
};
