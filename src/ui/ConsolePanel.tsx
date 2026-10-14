import { revealPosition } from '@/editor/navigation';
import { useAppStore } from '@/state/store';
import type { ConsoleTab } from '@/state/store';

const TABS: readonly { readonly id: ConsoleTab; readonly label: string }[] = [
  { id: 'output', label: 'Output' },
  { id: 'problems', label: 'Problems' },
  { id: 'stdin', label: 'Stdin' },
];

export function ConsolePanel() {
  const output = useAppStore((state) => state.output);
  const diagnostics = useAppStore((state) => state.watch.diagnostics);
  const consoleTab = useAppStore((state) => state.consoleTab);
  const setConsoleTab = useAppStore((state) => state.setConsoleTab);
  const clearOutput = useAppStore((state) => state.clearOutput);
  const stdin = useAppStore((state) => state.stdin);
  const setStdin = useAppStore((state) => state.setStdin);

  return (
    <>
      <div className="console__tabs">
        {TABS.map((tab) => (
          <button
            key={tab.id}
            type="button"
            className={tab.id === consoleTab ? 'console__tab console__tab--active' : 'console__tab'}
            onClick={() => setConsoleTab(tab.id)}
          >
            {tab.label}
            {tab.id === 'problems' && diagnostics.length > 0 ? (
              <span className="console__tab-badge">{diagnostics.length}</span>
            ) : null}
          </button>
        ))}

        <div className="console__tools">
          <button type="button" className="btn" onClick={clearOutput} title="Xoá output">
            Clear
          </button>
        </div>
      </div>

      {consoleTab === 'stdin' ? (
        <div className="stdin-host">
          <textarea
            value={stdin}
            spellCheck={false}
            aria-label="Standard input"
            placeholder={
              'Nội dung này được đưa vào stdin của chương trình khi bấm Run.\nscanf/getline sẽ đọc từ đây (M2).'
            }
            onChange={(event) => setStdin(event.target.value)}
          />
        </div>
      ) : consoleTab === 'problems' ? (
        <div className="console__body">
          {diagnostics.length === 0 ? (
            <span className="console__hint">
              Không có chẩn đoán nào. Lỗi biên dịch và cảnh báo sẽ hiện ở đây, bấm vào một dòng để nhảy
              tới đúng vị trí trong editor.
            </span>
          ) : (
            <div className="problems">
              {diagnostics.map((diagnostic, index) => (
                <button
                  key={`${diagnostic.startLine}:${diagnostic.startColumn}:${index}`}
                  type="button"
                  className={`problem problem--${diagnostic.severity}`}
                  onClick={() => revealPosition(diagnostic.startLine, diagnostic.startColumn)}
                >
                  <span className="problem__seat">
                    {diagnostic.severity === 'error' ? 'error' : diagnostic.severity} ·{' '}
                    {diagnostic.source}:{diagnostic.startLine}:{diagnostic.startColumn}
                  </span>
                  <span className="problem__msg">{diagnostic.message}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="console__body">
          {output.length === 0 ? (
            <span className="console__hint">
              Bấm ▶ Run (F5) để build và chạy chương trình. stdout sẽ xuất hiện ở đây theo thời gian
              thực; stderr hiển thị màu đỏ.
            </span>
          ) : (
            output.map((entry) => (
              <div key={entry.id} className={`console__line--${entry.kind}`}>
                {entry.text}
              </div>
            ))
          )}
        </div>
      )}
    </>
  );
}
