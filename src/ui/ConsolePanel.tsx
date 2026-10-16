import { useState } from 'react';
import { revealPosition } from '@/editor/navigation';
import type { Diagnostic, MemoryView, SafetyEvent, SafetyKind } from '@/engine/types';
import { MemoryTab } from '@/ui/MemoryTab';
import {
  ProblemsTab,
  copyTextToClipboard,
  formatDiagnosticsForClipboard,
} from '@/ui/ProblemsTab';
import { useAppStore } from '@/state/store';
import type { ConsoleTab, OutputLine } from '@/state/store';

export {
  formatDiagnosticForClipboard,
  formatDiagnosticsForClipboard,
  copyTextToClipboard,
} from '@/ui/ProblemsTab';

const TABS: readonly { readonly id: ConsoleTab; readonly label: string }[] = [
  { id: 'output', label: 'Output' },
  { id: 'problems', label: 'Problems' },
  { id: 'runtime', label: 'Runtime' },
  { id: 'memory', label: 'Memory' },
  { id: 'stdin', label: 'Stdin' },
];

/** Short label for a safety event, so the list reads as a table. */
const SAFETY_LABELS: Readonly<Record<SafetyKind, string>> = {
  'uninitialized-read': 'uninitialized',
  'division-by-zero': 'divide by zero',
  'null-dereference': 'null deref',
  'out-of-bounds': 'out of bounds',
  leak: 'not freed',
  'runtime-error': 'runtime error',
};

interface ConsoleToolsProps {
  readonly activeTab: ConsoleTab;
  readonly diagnosticsCount: number;
  readonly onClearOutput: () => void;
  readonly onCopyProblems?: () => void;
  readonly copiedProblems?: boolean;
}

/**
 * @brief Renders the right-aligned tools in the console tab bar (copy and clear buttons).
 * @param props Component properties for console tools.
 * @return Rendered console tools JSX element.
 */
function ConsoleTools(props: ConsoleToolsProps) {
  const { activeTab, diagnosticsCount, onClearOutput, onCopyProblems, copiedProblems } = props;
  const showCopy = activeTab === 'problems' && diagnosticsCount > 0 && onCopyProblems;
  return (
    <div className="console__tools">
      {showCopy ? (
        <button
          type="button"
          className="btn btn--copy-console"
          aria-label="Sao chép danh sách lỗi"
          onClick={onCopyProblems}
          title="Sao chép toàn bộ lỗi trong tab Problems"
        >
          {copiedProblems ? '✓ Đã chép' : '📋 Sao chép lỗi'}
        </button>
      ) : null}
      <button type="button" className="btn" onClick={onClearOutput} title="Xoá output">
        Clear
      </button>
    </div>
  );
}

interface ConsoleTabsHeaderProps {
  readonly activeTab: ConsoleTab;
  readonly diagnosticsCount: number;
  readonly safetyCount: number;
  readonly onSelectTab: (tab: ConsoleTab) => void;
  readonly onClearOutput: () => void;
  readonly onCopyProblems?: () => void;
  readonly copiedProblems?: boolean;
}

/**
 * @brief Renders the tab navigation bar with problem/safety badges and tool buttons.
 * @param props Component properties for tab header.
 * @return The rendered tabs header JSX element.
 */
function ConsoleTabsHeader(props: ConsoleTabsHeaderProps) {
  const {
    activeTab,
    diagnosticsCount,
    safetyCount,
    onSelectTab,
    onClearOutput,
    onCopyProblems,
    copiedProblems,
  } = props;
  return (
    <div className="console__tabs">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          className={tab.id === activeTab ? 'console__tab console__tab--active' : 'console__tab'}
          onClick={() => onSelectTab(tab.id)}
        >
          {tab.label}
          {tab.id === 'problems' && diagnosticsCount > 0 ? (
            <span className="console__tab-badge">{diagnosticsCount}</span>
          ) : null}
          {tab.id === 'runtime' && safetyCount > 0 ? (
            <span className="console__tab-badge">{safetyCount}</span>
          ) : null}
        </button>
      ))}

      <ConsoleTools
        activeTab={activeTab}
        diagnosticsCount={diagnosticsCount}
        onClearOutput={onClearOutput}
        onCopyProblems={onCopyProblems}
        copiedProblems={copiedProblems}
      />
    </div>
  );
}

interface StdinTabProps {
  readonly stdin: string;
  readonly onStdinChange: (val: string) => void;
}

/**
 * @brief Renders the standard input host textarea for feeding interactive stdin.
 * @param props Component properties for stdin tab.
 * @return The rendered stdin editor JSX element.
 */
function StdinTab(props: StdinTabProps) {
  const { stdin, onStdinChange } = props;
  return (
    <div className="stdin-host">
      <textarea
        value={stdin}
        spellCheck={false}
        aria-label="Standard input"
        placeholder={
          'Nội dung này được đưa vào stdin của chương trình khi bấm Run.\nscanf/getline sẽ đọc từ đây (M2).'
        }
        onChange={(event) => onStdinChange(event.target.value)}
      />
    </div>
  );
}

interface RuntimeTabProps {
  readonly safety: readonly SafetyEvent[];
  readonly engineLabel: string;
}

/**
 * @brief Renders runtime safety diagnostics reported by the execution engine.
 * @param props Component properties for runtime tab.
 * @return The rendered runtime safety JSX element.
 */
function RuntimeTab(props: RuntimeTabProps) {
  const { safety, engineLabel } = props;
  if (safety.length === 0) {
    const hint = engineLabel.toLowerCase().includes('clang')
      ? 'Engine clang chỉ build và chạy: nó không kiểm tra an toàn lúc chạy. ' +
        'Chuyển sang fast engine để thấy các vấn đề runtime.'
      : 'Không thấy vấn đề runtime nào: biến chưa khởi tạo, chia 0, deref null, ' +
        'truy cập ngoài vùng nhớ, và bộ nhớ chưa free sẽ hiện ở đây.';
    return (
      <div className="console__body">
        <span className="console__hint">{hint}</span>
      </div>
    );
  }

  return (
    <div className="console__body">
      <div className="problems">
        {safety.map((event, index) => (
          <button
            key={`${event.kind}:${event.line}:${index}`}
            type="button"
            className={`problem problem--${event.severity}`}
            onClick={() => (event.line > 0 ? revealPosition(event.line, 1) : undefined)}
            title={event.line > 0 ? 'Nhảy tới dòng này' : 'Không gắn với một dòng cụ thể'}
          >
            <span className="problem__seat">
              {SAFETY_LABELS[event.kind]} · {event.line > 0 ? `Ln ${event.line}` : 'no line'}
            </span>
            <span className="problem__msg">{event.message}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

interface OutputTabProps {
  readonly output: readonly OutputLine[];
}

/**
 * @brief Renders the standard output/error stream lines.
 * @param props Component properties for output tab.
 * @return The rendered output stream JSX element.
 */
function OutputTab(props: OutputTabProps) {
  const { output } = props;
  if (output.length === 0) {
    return (
      <div className="console__body">
        <span className="console__hint">
          Bấm ▶ Run (F5) để build và chạy chương trình. stdout sẽ xuất hiện ở đây theo thời gian
          thực; stderr hiển thị màu đỏ.
        </span>
      </div>
    );
  }

  return (
    <div className="console__body">
      {output.map((entry) => (
        <div key={entry.id} className={`console__line--${entry.kind}`}>
          {entry.text}
        </div>
      ))}
    </div>
  );
}

interface ConsoleActiveTabProps {
  readonly consoleTab: ConsoleTab;
  readonly stdin: string;
  readonly onStdinChange: (val: string) => void;
  readonly diagnostics: readonly Diagnostic[];
  readonly memory: MemoryView;
  readonly engineLabel: string;
  readonly safety: readonly SafetyEvent[];
  readonly output: readonly OutputLine[];
}

/**
 * @brief Renders the active console tab body content.
 * @param props Component properties for active tab.
 * @return Rendered active tab body JSX element.
 */
function ConsoleActiveTab(props: ConsoleActiveTabProps) {
  const {
    consoleTab,
    stdin,
    onStdinChange,
    diagnostics,
    memory,
    engineLabel,
    safety,
    output,
  } = props;
  if (consoleTab === 'stdin') {
    return <StdinTab stdin={stdin} onStdinChange={onStdinChange} />;
  }
  if (consoleTab === 'problems') {
    return <ProblemsTab diagnostics={diagnostics} />;
  }
  if (consoleTab === 'memory') {
    return <MemoryTab memory={memory} engineLabel={engineLabel} />;
  }
  if (consoleTab === 'runtime') {
    return <RuntimeTab safety={safety} engineLabel={engineLabel} />;
  }
  return <OutputTab output={output} />;
}

/**
 * @brief Selects all state values and actions needed for the console panel.
 * @return An object containing store state and action dispatches.
 */
function useConsoleStore() {
  const output = useAppStore((state) => state.output);
  const diagnostics = useAppStore((state) => state.watch.diagnostics);
  const safety = useAppStore((state) => state.watch.safety);
  const memory = useAppStore((state) => state.watch.memory);
  const engineLabel = useAppStore((state) => state.watch.engineLabel);
  const consoleTab = useAppStore((state) => state.consoleTab);
  const setConsoleTab = useAppStore((state) => state.setConsoleTab);
  const clearOutput = useAppStore((state) => state.clearOutput);
  const stdin = useAppStore((state) => state.stdin);
  const setStdin = useAppStore((state) => state.setStdin);
  return {
    output,
    diagnostics,
    safety,
    memory,
    engineLabel,
    consoleTab,
    setConsoleTab,
    clearOutput,
    stdin,
    setStdin,
  };
}

/**
 * @brief Console panel rendering stdout/stderr, compilation problems, runtime safety, memory visualizer, and stdin.
 * @return The rendered console JSX element.
 */
export function ConsolePanel() {
  const store = useConsoleStore();
  const [copiedProblems, setCopiedProblems] = useState(false);

  const handleCopyProblems = () => {
    void copyTextToClipboard(formatDiagnosticsForClipboard(store.diagnostics)).then((ok) => {
      if (ok) {
        setCopiedProblems(true);
        window.setTimeout(() => setCopiedProblems(false), 2000);
      }
    });
  };

  return (
    <>
      <ConsoleTabsHeader
        activeTab={store.consoleTab}
        diagnosticsCount={store.diagnostics.length}
        safetyCount={store.safety.length}
        onSelectTab={store.setConsoleTab}
        onClearOutput={store.clearOutput}
        onCopyProblems={handleCopyProblems}
        copiedProblems={copiedProblems}
      />
      <ConsoleActiveTab
        consoleTab={store.consoleTab}
        stdin={store.stdin}
        onStdinChange={store.setStdin}
        diagnostics={store.diagnostics}
        memory={store.memory}
        engineLabel={store.engineLabel}
        safety={store.safety}
        output={store.output}
      />
    </>
  );
}
