import { useEffect } from 'react';
import { useAppStore } from '@/state/store';
import { isTimelineAtEnd, stepTimeline } from '@/ui/timeline';
import { PLAYBACK_INTERVAL_MS } from '@/ui/timeline';

/**
 * Drives timeline playback.
 *
 * Mounted once by the app shell rather than inside the Watch pane, so playing keeps
 * working while another pane is on screen (on a phone the Watch pane can be hidden)
 * and so the command palette can start it from the editor.
 *
 * It walks the recording and stops at the end - it never blocks the program, which
 * has already finished by the time there is a history to play.
 */
export function useTimelinePlayback(): void {
  const playing = useAppStore((state) => state.timelinePlaying);

  useEffect(() => {
    if (!playing) return undefined;

    const timer = setInterval(() => {
      const { watch, timelineIndex } = useAppStore.getState();
      const historyLength = watch.history.length;

      if (historyLength === 0 || isTimelineAtEnd(historyLength, timelineIndex)) {
        useAppStore.setState({ timelinePlaying: false });
        return;
      }

      useAppStore.setState({ timelineIndex: stepTimeline(historyLength, timelineIndex, 1) });
    }, PLAYBACK_INTERVAL_MS);

    return () => clearInterval(timer);
  }, [playing]);
}
