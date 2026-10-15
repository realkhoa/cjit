/**
 * Quick symbol descriptor.
 */
export interface QuickKey {
  readonly label: string;
  readonly text: string;
}

/**
 * Standard list of quick C++ syntax keys for mobile touch typing.
 */
export const C_PLUS_PLUS_QUICK_KEYS: readonly QuickKey[] = [
  { label: 'Tab', text: '  ' },
  { label: '{', text: '{' },
  { label: '}', text: '}' },
  { label: '(', text: '(' },
  { label: ')', text: ')' },
  { label: ';', text: ';' },
  { label: '::', text: '::' },
  { label: '->', text: '->' },
  { label: '<', text: '<' },
  { label: '>', text: '>' },
  { label: '"', text: '"' },
  { label: '=', text: '=' },
  { label: '&', text: '&' },
  { label: '*', text: '*' },
  { label: '!', text: '!' },
];

/**
 * Properties for the MobileAccessoryBar component.
 */
export interface MobileAccessoryBarProps {
  /** Optional custom insert callback. */
  readonly onInsertText?: (text: string) => void;
}

/**
 * Horizontal quick-key accessory bar docked under the mobile code editor.
 *
 * Allows single-tap insertion of common C++ symbols that are otherwise
 * awkward to reach on standard on-screen smartphone keyboards.
 *
 * @param props Component properties.
 * @returns Accessory bar JSX element.
 */
export function MobileAccessoryBar({ onInsertText }: MobileAccessoryBarProps) {
  const handleKeyClick = (key: QuickKey) => {
    if (onInsertText) {
      onInsertText(key.text);
      return;
    }
    // Fallback: Dispatch synthetic key event or custom event for Monaco
    window.dispatchEvent(new CustomEvent('cjit-insert-key', { detail: { text: key.text } }));
  };

  return (
    <div className="mobile-accessory-bar" role="toolbar" aria-label="C++ Quick Keys">
      <div className="mobile-accessory-bar__scroll">
        {C_PLUS_PLUS_QUICK_KEYS.map((key) => (
          <button
            key={key.label}
            type="button"
            className="mobile-accessory-btn"
            onClick={() => handleKeyClick(key)}
            title={`Chèn ${key.label}`}
          >
            {key.label}
          </button>
        ))}
      </div>
    </div>
  );
}
