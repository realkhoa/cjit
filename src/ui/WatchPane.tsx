import { Fragment, useState } from 'react';
import type { VarNode } from '@/engine/types';
import { ANALYSIS_DEBOUNCE_MS, useAppStore } from '@/state/store';
import { overallTone, pillClass, watchStatusLabel } from '@/ui/status';

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

  const [openLocals, setOpenLocals] = useState(true);
  const [openStack, setOpenStack] = useState(true);

  const tone = overallTone(runState, analysisState, watch.status);

  return (
    <>
      <div className="pane__header">
        <span className="pane__title">Watch</span>
        <span className={pillClass(tone)} title={watch.detail}>
          {watchStatusLabel(watch.status)}
        </span>
      </div>

      <div className="pane__body">
        <section className="watch__section">
          <button
            type="button"
            className="watch__section-head"
            aria-expanded={openLocals}
            onClick={() => setOpenLocals((open) => !open)}
          >
            <span className="watch__caret">{openLocals ? '▾' : '▸'}</span>
            Locals &amp; globals
            <span className="watch__count">{watch.vars.length}</span>
          </button>

          {openLocals ? (
            watch.vars.length === 0 ? (
              <div className="empty-state">
                <div className="empty-state__title">{watchStatusLabel(watch.status)}</div>
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
                  <VarRows nodes={watch.vars} depth={0} />
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
        realtime debounce {ANALYSIS_DEBOUNCE_MS} ms · engine: {watch.engineLabel} · {watch.steps} steps ·{' '}
        {watch.elapsedMs} ms · history {watch.historyLength}
        {watch.truncated ? ' · truncated (cap hit)' : ''}
      </div>
    </>
  );
}
