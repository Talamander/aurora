// Focus handling for modal sheets: focus moves in on open, Tab stays inside, focus returns on close.
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  // Read the opener during the first render: an autoFocus field inside the dialog takes focus
  // before effects run, which would otherwise make the dialog its own opener.
  const openerRef = useRef<HTMLElement | null>(typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null));
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const opener = openerRef.current;
    // Elements with tabIndex -1 (listbox options driven by arrow keys) are not Tab stops.
    const items = () => [...el.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null && n.tabIndex >= 0);
    if (!el.contains(document.activeElement)) {
      el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const list = items();
      if (!list.length) return;
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    el.addEventListener('keydown', onKey);
    return () => {
      el.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, []);
  return ref;
}
