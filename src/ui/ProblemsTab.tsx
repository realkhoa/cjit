import { useState } from 'react';
import { revealPosition } from '@/editor/navigation';
import type { Diagnostic } from '@/engine/types';

/**
 * @brief Formats a single diagnostic into standard compiler output format.
 * @details Formats as `source:line:column: severity: message`.
 * @param d The diagnostic object to format.
 * @return Formatted single-line diagnostic string.
 */
export function formatDiagnosticForClipboard(d: Diagnostic): string {
  return `${d.source}:${d.startLine}:${d.startColumn}: ${d.severity}: ${d.message}`;
}

/**
 * @brief Formats an array of diagnostics into a multi-line newline-delimited string.
 * @param ds Array of diagnostics to format.
 * @return Newline-delimited string of all formatted diagnostics.
 */
export function formatDiagnosticsForClipboard(ds: readonly Diagnostic[]): string {
  return ds.map(formatDiagnosticForClipboard).join('\n');
}

/**
 * @brief Copies text to the system clipboard with browser fallback.
 * @param text The text string to copy.
 * @return A promise resolving to true if copied successfully, false otherwise.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (
    typeof navigator !== 'undefined' &&
    navigator.clipboard &&
    typeof navigator.clipboard.writeText === 'function'
  ) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Fall through to DOM fallback
    }
  }

  try {
    const textArea = document.createElement('textarea');
    textArea.value = text;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    textArea.style.top = '-999999px';
    document.body.appendChild(textArea);
    textArea.focus();
    textArea.select();
    const successful = document.execCommand('copy');
    document.body.removeChild(textArea);
    return successful;
  } catch {
    return false;
  }
}

interface ProblemItemProps {
  readonly diagnostic: Diagnostic;
  readonly index: number;
  readonly isCopied: boolean;
  readonly onCopySingle: (diagnostic: Diagnostic, index: number) => void;
}

/**
 * @brief Renders a single diagnostic row with location, severity, message, and copy button.
 * @param props Component properties for the diagnostic row.
 * @return The rendered problem row JSX element.
 */
function ProblemItem(props: ProblemItemProps) {
  const { diagnostic, index, isCopied, onCopySingle } = props;
  const locationLabel = `${diagnostic.source}:${diagnostic.startLine}:${diagnostic.startColumn}`;
  return (
    <div className={`problem problem--${diagnostic.severity}`}>
      <div className="problem__content">
        <button
          type="button"
          className="problem__jump-btn"
          onClick={() => revealPosition(diagnostic.startLine, diagnostic.startColumn)}
          title={`Nhảy tới dòng ${diagnostic.startLine}:${diagnostic.startColumn} trong code`}
        >
          {locationLabel}
        </button>
        <span className="problem__seat">
          {diagnostic.severity === 'error' ? 'error' : diagnostic.severity}
        </span>
        <span className="problem__msg">{diagnostic.message}</span>
      </div>
      <button
        type="button"
        className="problem__copy-btn"
        aria-label={`Sao chép lỗi dòng ${diagnostic.startLine}:${diagnostic.startColumn}`}
        title={`Sao chép lỗi dòng ${diagnostic.startLine}:${diagnostic.startColumn}`}
        onClick={() => onCopySingle(diagnostic, index)}
      >
        {isCopied ? '✓' : '📋'}
      </button>
    </div>
  );
}

interface ProblemsToolbarProps {
  readonly count: number;
  readonly copiedAll: boolean;
  readonly onCopyAll: () => void;
}

/**
 * @brief Renders the toolbar atop the problems tab with count and copy all button.
 * @param props Component properties for the toolbar.
 * @return The rendered toolbar JSX element.
 */
function ProblemsToolbar(props: ProblemsToolbarProps) {
  const { count, copiedAll, onCopyAll } = props;
  return (
    <div className="problems__toolbar">
      <span className="problems__count">
        {count} {count === 1 ? 'vấn đề' : 'vấn đề'}
      </span>
      <button
        type="button"
        className="btn btn--small problems__copy-btn"
        onClick={onCopyAll}
        title="Sao chép tất cả lỗi ra clipboard"
      >
        {copiedAll ? '✓ Đã sao chép' : '📋 Sao chép tất cả'}
      </button>
    </div>
  );
}

interface RawTextConsoleProps {
  readonly rawText: string;
  readonly lineCount: number;
}

/**
 * @brief Renders a selectable text console for manually copying error text with mouse or keyboard.
 * @param props Component properties containing raw formatted diagnostics text.
 * @return The rendered textarea JSX element.
 */
function RawTextConsole(props: RawTextConsoleProps) {
  const { rawText, lineCount } = props;
  const rows = Math.min(8, Math.max(3, lineCount));
  return (
    <div className="problems__raw-wrapper">
      <div className="problems__raw-label">
        <span>Văn bản lỗi (chọn & copy tay bằng chuột / phím tắt):</span>
      </div>
      <textarea
        readOnly
        spellCheck={false}
        className="problems__textarea"
        value={rawText}
        rows={rows}
        aria-label="Văn bản chẩn đoán lỗi"
        placeholder="Chưa có chẩn đoán lỗi."
      />
    </div>
  );
}

/**
 * @brief Renders the empty state hint when there are no compilation problems.
 * @return Empty state hint JSX element.
 */
function EmptyProblemsView() {
  return (
    <div className="console__body">
      <span className="console__hint">
        Không có chẩn đoán nào. Lỗi biên dịch và cảnh báo sẽ hiện ở đây, bấm vào một dòng để nhảy
        tới đúng vị trí trong editor.
      </span>
    </div>
  );
}

interface ProblemsListProps {
  readonly diagnostics: readonly Diagnostic[];
  readonly copiedIndex: number | null;
  readonly onCopySingle: (diagnostic: Diagnostic, index: number) => void;
}

/**
 * @brief Renders the list of diagnostic items.
 * @param props Component properties for the list.
 * @return Rendered list of problem rows.
 */
function ProblemsList(props: ProblemsListProps) {
  const { diagnostics, copiedIndex, onCopySingle } = props;
  return (
    <div className="problems__list">
      {diagnostics.map((diagnostic, index) => (
        <ProblemItem
          key={`${diagnostic.startLine}:${diagnostic.startColumn}:${index}`}
          diagnostic={diagnostic}
          index={index}
          isCopied={copiedIndex === index}
          onCopySingle={onCopySingle}
        />
      ))}
    </div>
  );
}

interface ProblemsActiveViewProps {
  readonly diagnostics: readonly Diagnostic[];
  readonly rawText: string;
  readonly copiedAll: boolean;
  readonly copiedIndex: number | null;
  readonly onCopyAll: () => void;
  readonly onCopySingle: (diagnostic: Diagnostic, index: number) => void;
}

/**
 * @brief Renders active problems tab layout with toolbar, raw text console, and list.
 * @param props Component properties for active problems view.
 * @return Active problems JSX element.
 */
function ProblemsActiveView(props: ProblemsActiveViewProps) {
  const { diagnostics, rawText, copiedAll, copiedIndex, onCopyAll, onCopySingle } = props;
  return (
    <div className="console__body">
      <div className="problems">
        <ProblemsToolbar
          count={diagnostics.length}
          copiedAll={copiedAll}
          onCopyAll={onCopyAll}
        />
        <RawTextConsole rawText={rawText} lineCount={diagnostics.length} />
        <ProblemsList
          diagnostics={diagnostics}
          copiedIndex={copiedIndex}
          onCopySingle={onCopySingle}
        />
      </div>
    </div>
  );
}

export interface ProblemsTabProps {
  readonly diagnostics: readonly Diagnostic[];
}

/**
 * @brief Renders problems tab body with toolbar, selectable raw text console, and interactive list.
 * @param props Component properties containing the diagnostics array.
 * @return The rendered problems list JSX element.
 */
export function ProblemsTab(props: ProblemsTabProps) {
  const { diagnostics } = props;
  const [copiedAll, setCopiedAll] = useState(false);
  const [copiedIndex, setCopiedIndex] = useState<number | null>(null);

  const handleCopyAll = () => {
    void copyTextToClipboard(formatDiagnosticsForClipboard(diagnostics)).then((ok) => {
      if (ok) {
        setCopiedAll(true);
        window.setTimeout(() => setCopiedAll(false), 2000);
      }
    });
  };

  const handleCopySingle = (diagnostic: Diagnostic, index: number) => {
    void copyTextToClipboard(formatDiagnosticForClipboard(diagnostic)).then((ok) => {
      if (ok) {
        setCopiedIndex(index);
        window.setTimeout(() => setCopiedIndex(null), 2000);
      }
    });
  };

  if (diagnostics.length === 0) {
    return <EmptyProblemsView />;
  }

  return (
    <ProblemsActiveView
      diagnostics={diagnostics}
      rawText={formatDiagnosticsForClipboard(diagnostics)}
      copiedAll={copiedAll}
      copiedIndex={copiedIndex}
      onCopyAll={handleCopyAll}
      onCopySingle={handleCopySingle}
    />
  );
}
