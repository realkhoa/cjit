import { useCallback } from 'react';
import { ConsolePanel } from '@/ui/ConsolePanel';
import { EditorPane } from '@/ui/EditorPane';
import { Explorer } from '@/ui/Explorer';
import { MobileTabs } from '@/ui/MobileTabs';
import { Splitter } from '@/ui/Splitter';
import { StatusBar } from '@/ui/StatusBar';
import { TitleBar } from '@/ui/TitleBar';
import { Toolbar } from '@/ui/Toolbar';
import { WatchPane } from '@/ui/WatchPane';
import { useIsMobile } from '@/ui/useIsMobile';
import { useTimelinePlayback } from '@/ui/useTimelinePlayback';
import { useAppStore } from '@/state/store';
import {
  MAX_BOTTOM_PERCENT,
  MAX_RIGHT_PERCENT,
  MIN_BOTTOM_PERCENT,
  MIN_RIGHT_PERCENT,
  percentFromDelta,
} from '@/util/layout';

function viewportExtent(axis: 'width' | 'height'): number {
  if (typeof window === 'undefined') return 0;
  return axis === 'width' ? window.innerWidth : window.innerHeight;
}

export function App() {
  const rightPercent = useAppStore((state) => state.rightPercent);
  const bottomPercent = useAppStore((state) => state.bottomPercent);
  const explorerWidth = useAppStore((state) => state.explorerWidth);
  const mobilePane = useAppStore((state) => state.mobilePane);
  const setRightPercent = useAppStore((state) => state.setRightPercent);
  const setBottomPercent = useAppStore((state) => state.setBottomPercent);
  const setExplorerWidth = useAppStore((state) => state.setExplorerWidth);
  const isMobile = useIsMobile();
  // Playback is driven from the shell, so it keeps running whichever pane is shown.
  useTimelinePlayback();

  // Negative sign: dragging the divider right/up makes the fixed pane smaller.
  const handleRightDelta = useCallback(
    (deltaPx: number) => {
      const current = useAppStore.getState().rightPercent;
      setRightPercent(
        percentFromDelta(current, -deltaPx, viewportExtent('width'), MIN_RIGHT_PERCENT, MAX_RIGHT_PERCENT),
      );
    },
    [setRightPercent],
  );

  const handleBottomDelta = useCallback(
    (deltaPx: number) => {
      const current = useAppStore.getState().bottomPercent;
      setBottomPercent(
        percentFromDelta(
          current,
          -deltaPx,
          viewportExtent('height'),
          MIN_BOTTOM_PERCENT,
          MAX_BOTTOM_PERCENT,
        ),
      );
    },
    [setBottomPercent],
  );

  // The explorer is a fixed width in pixels, so the delta applies directly.
  const handleExplorerDelta = useCallback(
    (deltaPx: number) => {
      setExplorerWidth(useAppStore.getState().explorerWidth + deltaPx);
    },
    [setExplorerWidth],
  );

  // Narrow layout: one pane at a time, chosen with the tab bar. Every pane stays
  // mounted and the inactive ones are hidden with CSS, so the editor keeps its
  // undo history and scroll position while you look at something else.
  if (isMobile) {
    return (
      <div className="app" data-layout="mobile">
        <TitleBar />
        <Toolbar />

        <main className="workspace workspace--mobile">
          <aside className="pane" data-pane="files" data-active={mobilePane === 'files'}>
            <Explorer />
          </aside>
          <div
            className="pane pane--editor"
            data-pane="code"
            data-active={mobilePane === 'code'}
          >
            <EditorPane />
          </div>
          <div className="pane" data-pane="watch" data-active={mobilePane === 'watch'}>
            <WatchPane />
          </div>
          <div className="pane" data-pane="console" data-active={mobilePane === 'console'}>
            <ConsolePanel />
          </div>
        </main>

        <MobileTabs />
        <StatusBar />
      </div>
    );
  }

  return (
    <div className="app">
      <TitleBar />
      <Toolbar />

      <main className="workspace">
        <div
          className="workspace__row"
          style={{ height: `calc(${100 - bottomPercent}% - var(--vs-splitter))` }}
        >
          <aside className="pane" style={{ flex: `0 0 ${explorerWidth}px` }}>
            <Explorer />
          </aside>

          <Splitter orientation="vertical" label="Resize explorer" onDelta={handleExplorerDelta} />

          <div className="workspace__split">
            <div
              className="pane pane--editor"
              style={{ flex: `0 0 calc(${100 - rightPercent}% - var(--vs-splitter))` }}
            >
              <EditorPane />
            </div>

            <Splitter orientation="vertical" label="Resize watch pane" onDelta={handleRightDelta} />

            <div className="pane" style={{ flex: '1 1 auto' }}>
              <WatchPane />
            </div>
          </div>
        </div>

        <Splitter orientation="horizontal" label="Resize console" onDelta={handleBottomDelta} />

        <div className="pane" style={{ height: `${bottomPercent}%`, flex: '0 0 auto' }}>
          <ConsolePanel />
        </div>
      </main>

      <StatusBar />
    </div>
  );
}
