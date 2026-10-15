import { Fragment, useState } from 'react';
import type { VarNode } from '@/engine/types';
import { ANALYSIS_DEBOUNCE_MS, useAppStore } from '@/state/store';
import { IterationsDialog } from '@/ui/IterationsDialog';
import { buildIterationTable, hasIterations } from '@/ui/iterationTable';
import { overallTone, pillClass, watchStatusLabel } from '@/ui/status';
import { selectWatchView } from '@/ui/watchSelect';
import { timelinePositionLabel } from '@/ui/timeline';

function VarRows({ nodes, depth }: { readonly nodes: readonly VarNode[]; readonly depth: number }) {
  return (
    <>
      {nodes.map((node, index) => (
        <Fragment key={`${node.scope}/${node.name}/${index}`}>
          <tr>
            <td className="watch-table__name" style={{ paddingLeft: 8 + depth * 14 }}>
              {node.name}
            </td>
            <td
              className={
                node.changed ? 'watch-table__value watch-table__value--changed' : 'watch-table__value'
              }
              title={node.value}
            >
              {node.value}
            </td>
            <td className="watch-table__type">{node.type}</td>
          </tr>
          {node.children && node.children.length > 0 ? (
            <VarRows nodes={node.children} depth={depth + 1} />
          ) : null}
        </Fragment>
      ))}
    </>
  );
}

export function WatchPane() {
  const watch = useAppStore((state) => state.watch);
  const runState = useAppStore((state) => state.runState);
  const analysisState = useAppStore((state) => state.analysisState);
  const cursorLine = useAppStore((state) => state.cursor.line);

  const [openLocals, setOpenLocals] = useState(true);
  const [openStack, setOpenStack] = useState(true);
  const [iterationsOpen, setIterationsOpen] = useState(false);

  // The selected moment lives in the store, not here: the editor highlights the
  // line that moment came from, so both panes have to agree on it.
  const mode = useAppStore((state) => state.watchMode);
  const historyIndex = useAppStore((state) => state.timelineIndex);
  const setMode = useAppStore((state) => state.setWatchMode);
  const setHistoryIndex = useAppStore((state) => state.setTimelineIndex);
  const stepTimeline = useAppStore((state) => state.stepTimeline);
  const timelinePlaying = useAppStore((state) => state.timelinePlaying);
  const toggleTimelinePlayback = useAppStore((state) => state.toggleTimelinePlayback);

  const tone = overallTone(runState, analysisState, watch.status);
  const view = selectWatchView(watch, { mode, cursorLine, historyIndex });
  const cursorIterations = buildIterationTable(watch.history, cursorLine);

  const lastHistoryIndex = Math.max(watch.history.length - 1, 0);

  const enterTimeline = (): void => {
    setMode('timeline');
    // Start at the most recent moment; the user scrubs back from there.
    setHistoryIndex(lastHistoryIndex);
  };

  return (
    <>
      <div className="pane__header">
        <span className="pane__title">Watch</span>

        <div className="segmented" role="group" aria-label="Watch scope">
          <button
            type="button"
            className={mode === 'cursor' ? 'segmented__item segmented__item--active' : 'segmented__item'}
            onClick={() => setMode('cursor')}
            title="Giá trị của biến tại dòng con trỏ đang đứng"
          >
            At cursor
          </button>
          <button
            type="button"
            className={mode === 'timeline' ? 'segmented__item segmented__item--active' : 'segmented__item'}
            onClick={enterTimeline}
            title="Tua lại lịch sử thực thi theo từng lần gán biến"
          >
            Timeline
          </button>
          <button
            type="button"
            className={mode === 'final' ? 'segmented__item segmented__item--active' : 'segmented__item'}
            onClick={() => setMode('final')}
            title="Giá trị sau khi chương trình chạy xong"
          >
            Final
          </button>
        </div>

        <span className={pillClass(tone)} title={watch.detail}>
          {watchStatusLabel(watch.status)}
        </span>
      </div>

      {mode === 'timeline' ? (
        <div className="timeline">
          <div className="timeline__transport" role="group" aria-label="Timeline playback">
            <button
              type="button"
              className="icon-btn"
              onClick={() => setHistoryIndex(0)}
              disabled={watch.history.length === 0}
              aria-label="First moment"
              title="Về mốc đầu tiên"
            >
              ⏮
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => stepTimeline(-1)}
              disabled={watch.history.length === 0}
              aria-label="Step back"
              title="Lùi một mốc (Shift+F10)"
            >
              ◀
            </button>
            <button
              type="button"
              className={timelinePlaying ? 'icon-btn icon-btn--active' : 'icon-btn'}
              onClick={toggleTimelinePlayback}
              disabled={watch.history.length === 0}
              aria-label={timelinePlaying ? 'Pause playback' : 'Play timeline'}
              title={
                timelinePlaying
                  ? 'Tạm dừng'
                  : 'Tự chạy qua các mốc đã ghi (Ctrl+F10). Đây là replay bản ghi, không phải dừng chương trình đang chạy.'
              }
            >
              {timelinePlaying ? '⏸' : '▶'}
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => stepTimeline(1)}
              disabled={watch.history.length === 0}
              aria-label="Step forward"
              title="Tiến một mốc (F10)"
            >
              ▶
            </button>
            <button
              type="button"
              className="icon-btn"
              onClick={() => setHistoryIndex(lastHistoryIndex)}
              disabled={watch.history.length === 0}
              aria-label="Last moment"
              title="Tới mốc cuối cùng"
            >
              ⏭
            </button>
          </div>

          <input
            type="range"
            className="timeline__slider"
            min={0}
            max={lastHistoryIndex}
            step={1}
            value={Math.min(historyIndex, lastHistoryIndex)}
            disabled={watch.history.length === 0}
            aria-label="Execution timeline"
            onChange={(event) => setHistoryIndex(Number.parseInt(event.target.value, 10))}
          />
          <span className="timeline__position">
            {timelinePositionLabel(watch.history.length, historyIndex)}
          </span>
        </div>
      ) : null}

      <div className="watch__context" title={view.label}>
        <span className="watch__context-line">
          {view.line === null ? 'final' : `Ln ${view.line}`}
        </span>
        <span>{view.label}</span>
        {hasIterations(cursorIterations) ? (
          <button
            type="button"
            className="chip"
            onClick={() => setIterationsOpen(true)}
            title="Xem dữ liệu của từng vòng lặp tại dòng này"
          >
            ⟳ {cursorIterations.rows.length} iteration
            {cursorIterations.rows.length === 1 ? '' : 's'} · Ln {cursorIterations.loopLine}
          </button>
        ) : null}
        {view.changedCount > 0 ? (
          <span className="watch__changed-count">{view.changedCount} changed</span>
        ) : null}
      </div>

      {iterationsOpen ? (
        <IterationsDialog
          line={cursorLine}
          history={watch.history}
          onSelect={(index) => {
            setMode('timeline');
            setHistoryIndex(index);
            setIterationsOpen(false);
          }}
          onClose={() => setIterationsOpen(false)}
        />
      ) : null}

      <div className="pane__body">
        <section className="watch__section">
          <button
            type="button"
            className="watch__section-head"
            aria-expanded={openLocals}
            onClick={() => setOpenLocals((open) => !open)}
          >
            <span className="watch__caret">{openLocals ? '▾' : '▸'}</span>
            {mode === 'timeline' ? 'Locals at step' : mode === 'cursor' ? 'Locals at cursor' : 'Locals (final)'}
            <span className="watch__count">{view.vars.length}</span>
          </button>

          {openLocals ? (
            view.vars.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__title">{view.label}</div>
                <div>{watch.detail || 'Chưa có giá trị biến nào để hiển thị.'}</div>
              </div>
            ) : (
              <table className="watch-table">
                <thead>
                  <tr>
                    <th scope="col">Name</th>
                    <th scope="col">Value</th>
                    <th scope="col">Type</th>
                  </tr>
                </thead>
                <tbody>
                  <VarRows nodes={view.vars} depth={0} />
                </tbody>
              </table>
            )
          ) : null}
        </section>

        <section className="watch__section">
          <button
            type="button"
            className="watch__section-head"
            aria-expanded={openStack}
            onClick={() => setOpenStack((open) => !open)}
          >
            <span className="watch__caret">{openStack ? '▾' : '▸'}</span>
            Call stack
            <span className="watch__count">{watch.frames.length}</span>
          </button>

          {openStack ? (
            watch.frames.length === 0 ? (
              <div className="empty-state">Chưa có frame nào được ghi nhận.</div>
            ) : (
              <table className="watch-table">
                <tbody>
                  {watch.frames.map((frame, index) => (
                    <tr key={`${frame.function}/${index}`}>
                      <td className="watch-table__name">{frame.function}</td>
                      <td className="watch-table__scope">line {frame.line}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )
          ) : null}
        </section>
      </div>

      <div className="watch__footer">
        realtime debounce {ANALYSIS_DEBOUNCE_MS} ms · {watch.engineLabel} · {watch.steps} steps ·{' '}
        {watch.elapsedMs} ms · {watch.lineStates.length} line snapshots · {watch.history.length} history steps
        {watch.truncated ? ' · truncated (cap hit)' : ''}
      </div>
    </>
  );
}
