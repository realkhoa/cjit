// @vitest-environment jsdom
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { MobileAccessoryBar, C_PLUS_PLUS_QUICK_KEYS } from '@/ui/MobileAccessoryBar';

describe('MobileAccessoryBar component', () => {
  afterEach(cleanup);

  it('renders standard C++ quick keys', () => {
    render(<MobileAccessoryBar />);
    for (const item of C_PLUS_PLUS_QUICK_KEYS) {
      expect(screen.getByText(item.label)).toBeDefined();
    }
  });

  it('calls onInsertText callback when a symbol button is clicked', () => {
    const onInsert = vi.fn();
    render(<MobileAccessoryBar onInsertText={onInsert} />);
    const semiBtn = screen.getByText(';');
    fireEvent.click(semiBtn);
    expect(onInsert).toHaveBeenCalledWith(';');
  });

  it('inserts Tab symbol when Tab is clicked', () => {
    const onInsert = vi.fn();
    render(<MobileAccessoryBar onInsertText={onInsert} />);
    const tabBtn = screen.getByText('Tab');
    fireEvent.click(tabBtn);
    expect(onInsert).toHaveBeenCalledWith('  ');
  });
});
