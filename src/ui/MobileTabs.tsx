import { useAppStore } from '@/state/store';
import { PANE_LABELS, PANE_ORDER, type PaneId } from '@/ui/responsive';

/**
 * Tab icon component for the mobile navigation bar.
 *
 * @param props Props containing the pane identifier.
 * @returns SVG icon element.
 */
function TabIcon({ id }: { readonly id: PaneId }) {
  switch (id) {
    case 'files':
      return (
        <svg className="mobile-tab__svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M14.5 3H7.71l-.85-.85L6.51 2h-5l-.5.5v11l.5.5h13l.5-.5v-10l-.5-.5zm-.5 10H2V3h4.29l.86.85.35.15H14v9z" />
        </svg>
      );
    case 'code':
      return (
        <svg className="mobile-tab__svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M4.7 4.3L1.4 7.6v.8l3.3 3.3.7-.7L2.8 8.4l2.6-2.6-.7-.7zm6.6 0l-.7.7 2.6 2.6-2.6 2.6.7.7 3.3-3.3v-.8l-3.3-3.3zM9.3 2.5L6.1 13.5h1.2l3.2-11H9.3z" />
        </svg>
      );
    case 'watch':
      return (
        <svg className="mobile-tab__svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0zm-.82 4.39l3.46 3.46.71-.71-3.46-3.46a5.5 5.5 0 1 0-.71.71z" />
        </svg>
      );
    case 'console':
      return (
        <svg className="mobile-tab__svg" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true">
          <path d="M14.5 2h-13l-.5.5v11l.5.5h13l.5-.5v-11l-.5-.5zm-.5 11H2V3h12v10zM4.15 5.15l2.5 2.5v.7l-2.5 2.5-.7-.7L5.59 8 3.45 5.85l.7-.7zM8 10h4v1H8v-1z" />
        </svg>
      );
  }
}

/**
 * Pane switcher for the narrow mobile layout.
 *
 * Renders touch-optimized bottom tabs with SVG icons, real-time analysis/run
 * status dots, and problem count badges.
 *
 * @returns Mobile tabs JSX navigation bar.
 */
export function MobileTabs() {
  const pane = useAppStore((state) => state.mobilePane);
  const setMobilePane = useAppStore((state) => state.setMobilePane);
  const analyzing = useAppStore((state) => state.analysisState === 'analyzing');
  const runState = useAppStore((state) => state.runState);
  const diagnostics = useAppStore((state) => state.watch.diagnostics.length);

  return (
    <nav className="mobile-tabs" role="tablist" aria-label="Panes">
      {PANE_ORDER.map((id) => {
        const active = pane === id;
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={active}
            className={active ? 'mobile-tab mobile-tab--active' : 'mobile-tab'}
            onClick={() => setMobilePane(id)}
          >
            <span className="mobile-tab__icon-wrapper">
              <TabIcon id={id} />
              {id === 'watch' && analyzing ? (
                <span className="mobile-tab__dot" title="Đang phân tích" />
              ) : null}
              {id === 'code' && runState === 'running' ? (
                <span className="mobile-tab__dot mobile-tab__dot--busy" title="Đang chạy" />
              ) : null}
              {id === 'console' && diagnostics > 0 ? (
                <span className="mobile-tab__badge" title={`${diagnostics} problem(s)`}>
                  {diagnostics > 99 ? '99+' : diagnostics}
                </span>
              ) : null}
            </span>

            <span className="mobile-tab__label">{PANE_LABELS[id]}</span>
          </button>
        );
      })}
    </nav>
  );
}
