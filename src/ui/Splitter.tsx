import { useRef, useState } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, PointerEvent as ReactPointerEvent } from 'react';

export interface SplitterProps {
  /** `vertical` is a vertical bar dragged horizontally; `horizontal` the reverse. */
  readonly orientation: 'vertical' | 'horizontal';
  readonly onDelta: (deltaPx: number) => void;
  readonly label: string;
}

const KEYBOARD_STEP_PX = 16;
const KEYBOARD_STEP_FAST_PX = 48;

export function Splitter({ orientation, onDelta, label }: SplitterProps) {
  const [dragging, setDragging] = useState(false);
  const lastPosition = useRef(0);

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    lastPosition.current = orientation === 'vertical' ? event.clientX : event.clientY;
    setDragging(true);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (!dragging) return;
    const position = orientation === 'vertical' ? event.clientX : event.clientY;
    const delta = position - lastPosition.current;
    lastPosition.current = position;
    if (delta !== 0) onDelta(delta);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    setDragging(false);
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    const step = event.shiftKey ? KEYBOARD_STEP_FAST_PX : KEYBOARD_STEP_PX;
    const forward = orientation === 'vertical' ? 'ArrowRight' : 'ArrowDown';
    const backward = orientation === 'vertical' ? 'ArrowLeft' : 'ArrowUp';

    if (event.key === forward) {
      onDelta(step);
      event.preventDefault();
    } else if (event.key === backward) {
      onDelta(-step);
      event.preventDefault();
    }
  };

  return (
    <div
      className={`splitter splitter--${orientation}${dragging ? ' splitter--dragging' : ''}`}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={orientation === 'vertical' ? 'vertical' : 'horizontal'}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={endDrag}
      onPointerCancel={endDrag}
      onKeyDown={handleKeyDown}
    />
  );
}
