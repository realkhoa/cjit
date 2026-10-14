import { useAppStore } from '@/state/store';
import { dotClass, overallLabel, overallTone } from '@/ui/status';

export function StatusBar() {
  const runState = useAppStore((state) => state.runState);
  const analysisState = useAppStore((state) => state.analysisState);
  const watch = useAppStore((state) => state.watch);
  const cursor = useAppStore((state) => state.cursor);
  const language = useAppStore((state) => state.language);

  const tone = overallTone(runState, analysisState, watch.status);

  return (
    <footer className="statusbar">
      <div className="statusbar__left">
        <span className={dotClass(tone)} aria-hidden="true" />
        <span>{overallLabel(runState, analysisState)}</span>
        <span className="statusbar__detail" title={watch.detail}>
          {watch.detail}
        </span>
      </div>

      <div className="statusbar__right">
        <span className="statusbar__item">
          Ln {cursor.line}, Col {cursor.column}
        </span>
        {cursor.selected > 0 ? <span className="statusbar__item">Sel {cursor.selected}</span> : null}
        <span className="statusbar__item">Spaces: 4</span>
        <span className="statusbar__item">UTF-8</span>
        <span className="statusbar__item">LF</span>
        <span className="statusbar__item">{language === 'c' ? 'C' : 'C++'}</span>
        <span className="statusbar__item" title="Engine đã tạo ra giá trị trong pane Watch">
          watch: {watch.engineLabel}
        </span>
      </div>
    </footer>
  );
}
