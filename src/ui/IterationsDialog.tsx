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

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Iterations of line ${line}`}
      onClick={onClose}
    >
      <div className="modal" onClick={(event) => event.stopPropagation()}>
        <div className="modal__header">
          <span className="modal__title">
            Line {line} · {table.rows.length} iteration{table.rows.length === 1 ? '' : 's'}
          </span>
          <button type="button" className="btn" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modal__body">
          {table.rows.length === 0 ? (
            <div className="empty-state">Dòng này chưa chạy lần nào.</div>
          ) : (
            <table className="watch-table">
              <thead>
                <tr>
                  <th scope="col">#</th>
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
          Bấm một dòng để xem state của iteration đó trong pane Watch
          {table.truncated ? ' · một số biến không hiển thị hết' : ''}
        </div>
      </div>
    </div>
  );
}
