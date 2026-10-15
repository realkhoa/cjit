import { revealPosition } from '@/editor/navigation';
import type { MemoryView, SafetyEvent, SafetyKind } from '@/engine/types';
import { chainEndLabel, chainSummary, formatAddress, hexDump } from '@/ui/memoryFormat';
import { ProblemsTab } from '@/ui/ProblemsTab';
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

interface ConsoleTabsHeaderProps {
  readonly activeTab: ConsoleTab;
  readonly diagnosticsCount: number;
  readonly safetyCount: number;
  readonly onSelectTab: (tab: ConsoleTab) => void;
  readonly onClearOutput: () => void;
}

/**
 * @brief Renders the tab navigation bar with problem/safety badges and tool buttons.
 * @param props Component properties for tab header.
 * @return The rendered tabs header JSX element.
 */
function ConsoleTabsHeader(props: ConsoleTabsHeaderProps) {
  const { activeTab, diagnosticsCount, safetyCount, onSelectTab, onClearOutput } = props;
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

      <div className="console__tools">
        <button type="button" className="btn" onClick={onClearOutput} title="Xoá output">
          Clear
        </button>
      </div>
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

/**
 * @brief Renders the empty memory state message when no structures or blocks are allocated.
 * @param props Properties containing engine label.
 * @return Empty memory hint JSX element.
 */
function EmptyMemoryHint(props: { readonly engineLabel: string }) {
  const { engineLabel } = props;
  const hint = engineLabel.toLowerCase().includes('clang')
    ? 'Engine clang không mô hình hoá memory: nó biên dịch và chạy thật, ' +
      'còn khối nhớ nằm trong module wasm. Chuyển sang fast engine để xem cấu trúc dữ liệu.'
    : 'Chương trình chưa cấp phát gì bằng malloc/new, ' +
      'và không có con trỏ nào trỏ tới struct — nên chưa có gì để vẽ.';
  return (
    <div className="console__body">
      <span className="console__hint">{hint}</span>
    </div>
  );
}

interface MemoryChainsSectionProps {
  readonly chains: MemoryView['chains'];
}

/**
 * @brief Renders the list of tracked pointer chains.
 * @param props Properties for pointer chains.
 * @return Rendered pointer chains JSX element.
 */
function MemoryChainsSection(props: MemoryChainsSectionProps) {
  const { chains } = props;
  return (
    <>
      {chains.map((chain) => (
        <div key={`chain-${chain.name}`} className="memory__chain">
          <div className="memory__title" title={chainEndLabel(chain.end)}>
            {chainSummary(chain)}
          </div>
          {chain.nodes.map((node, index) => (
            <div key={`${chain.name}-${node.address}`} className="memory__node">
              <span className="memory__address">{formatAddress(node.address)}</span>
              <span className="memory__fields">
                {node.fields.map((field) => `${field.name} = ${field.value}`).join(', ')}
              </span>
              {index === chain.nodes.length - 1 ? (
                <span className="memory__end">→ {chainEndLabel(chain.end)}</span>
              ) : null}
            </div>
          ))}
        </div>
      ))}
    </>
  );
}

interface MemoryBlocksSectionProps {
  readonly blocks: MemoryView['blocks'];
  readonly truncated: boolean;
}

/**
 * @brief Renders allocated heap memory blocks with hex dump.
 * @param props Properties for memory blocks.
 * @return Rendered memory blocks JSX element.
 */
function MemoryBlocksSection(props: MemoryBlocksSectionProps) {
  const { blocks, truncated } = props;
  if (blocks.length === 0) return null;
  return (
    <div className="memory__blocks">
      <div className="memory__title">
        Bộ nhớ chương trình đã cấp phát (malloc/new)
        {truncated ? ' · đã lược bớt' : ''}
      </div>
      {blocks.map((block) => (
        <div key={`block-${block.address}`} className="memory__block">
          <div className="memory__block-head">
            {formatAddress(block.address)} · {block.size} byte
            {block.truncated ? ' (chỉ hiện phần đầu)' : ''}
          </div>
          {hexDump(block.address, block.bytes).map((row) => (
            <div key={`${block.address}-${row.address}`} className="memory__row">
              <span className="memory__address">{row.address}</span>
              <span className="memory__hex">{row.hex}</span>
              <span className="memory__ascii">{row.ascii}</span>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

interface MemoryTabProps {
  readonly memory: MemoryView;
  readonly engineLabel: string;
}

/**
 * @brief Renders the memory visualizer tab body showing linked structures and allocated blocks.
 * @param props Component properties for memory tab.
 * @return The rendered memory visualizer JSX element.
 */
function MemoryTab(props: MemoryTabProps) {
  const { memory, engineLabel } = props;
  if (memory.chains.length === 0 && memory.blocks.length === 0) {
    return <EmptyMemoryHint engineLabel={engineLabel} />;
  }

  return (
    <div className="console__body">
      <div className="memory">
        <MemoryChainsSection chains={memory.chains} />
        <MemoryBlocksSection blocks={memory.blocks} truncated={memory.truncated} />
      </div>
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

/**
 * @brief Console panel rendering stdout/stderr, compilation problems, runtime safety, memory visualizer, and stdin.
 * @return The rendered console JSX element.
 */
export function ConsolePanel() {
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

  return (
    <>
      <ConsoleTabsHeader
        activeTab={consoleTab}
        diagnosticsCount={diagnostics.length}
        safetyCount={safety.length}
        onSelectTab={setConsoleTab}
        onClearOutput={clearOutput}
      />

      {consoleTab === 'stdin' ? (
        <StdinTab stdin={stdin} onStdinChange={setStdin} />
      ) : consoleTab === 'problems' ? (
        <ProblemsTab diagnostics={diagnostics} />
      ) : consoleTab === 'memory' ? (
        <MemoryTab memory={memory} engineLabel={engineLabel} />
      ) : consoleTab === 'runtime' ? (
        <RuntimeTab safety={safety} engineLabel={engineLabel} />
      ) : (
        <OutputTab output={output} />
      )}
    </>
  );
}
