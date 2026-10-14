import { useAppStore } from '@/state/store';
import { PANE_LABELS, PANE_ORDER } from '@/ui/responsive';

/**
 * Pane switcher for the narrow layout.
 *
 * On a phone the editor, the watch pane and the console cannot share the screen,
 * so they become tabs. Each tab carries only information that is useful while you
 * are looking at a different pane: whether the analysis is running, whether the
 * program is running, and how many problems are waiting.
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
            <span className="mobile-tab__label">{PANE_LABELS[id]}</span>

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
          </button>
        );
      })}
    </nav>
  );
}
