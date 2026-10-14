import type { WatchHistoryEntry } from '@/engine/types';
import { buildIterationTable } from '@/ui/iterationTable';

/**
 * Dialog listing every recorded iteration of one line.
 *
 * Clicking a row selects that moment in the watch pane's timeline, so the modal
 * is a way *into* the data rather than a dead end.
 */

export interface IterationsDialogProps {
  readonly line: number;
  readonly history: readonly WatchHistoryEntry[];
  readonly onSelect: (historyIndex: number) => void;
  readonly onClose: () => void;
}

export function IterationsDialog({ line, history, onSelect, onClose }: IterationsDialogProps) {
  const table = buildIterationTable(history, line);
  const title =
    table.loopLine === null
      ? `Line ${line} is not inside a loop`
      : `Loop on line ${table.loopLine} · ${table.rows.length} iteration${
          table.rows.length === 1 ? '' : 's'
        }${table.depth > 1 ? ` · nested depth ${table.depth}` : ''}`;

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Iterations of the loop on line ${table.loopLine ?? line}`}
      onClick={onClose}
    >
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <span className="modal__title">{title}</span>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal__body">
          {table.rows.length === 0 ? (
            <div className="empty-state">
              Dòng này không nằm trong vòng lặp nào đã chạy, hoặc vòng lặp chưa chạy lần nào.
            </div>
          ) : (
            <table className="watch-table">
              <thead>
                <tr>
                  <th scope="col">iter</th>
                  <th scope="col">global</th>
                  <th scope="col">step</th>
                  {table.columns.map((column) => (
                    <th key={column} scope="col">
                      {column}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {table.rows.map((row) => (
                  <tr
                    key={row.historyIndex}
                    className="modal__row"
                    title="Xem state này trong pane Watch"
                    onClick={() => onSelect(row.historyIndex)}
                  >
                    <td className="watch-table__name">{row.iteration}</td>
                    <td className="watch-table__scope">
                      {row.globalIteration}/{table.globalTotal}
                    </td>
                    <td className="watch-table__scope">{row.step}</td>
                    {row.cells.map((cell) => (
                      <td
                        key={`${row.historyIndex}/${cell.name}`}
                        className={
                          cell.changed
                            ? 'watch-table__value watch-table__value--changed'
                            : 'watch-table__value'
                        }
                      >
                        {cell.value}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="modal__footer">
          Mỗi dòng là một vòng lặp (state sau khi vòng đó chạy xong) · cột <code>global</code> là thứ tự
          vòng lặp trong toàn bộ lần chạy · bấm một dòng để xem trong pane Watch
          {table.truncated ? ' · một số biến không hiển thị hết' : ''}
        </div>
      </div>
    </div>
  );
}
