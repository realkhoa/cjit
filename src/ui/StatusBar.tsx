import { useAppStore } from '@/state/store';
import { dotClass, overallLabel, overallTone } from '@/ui/status';
import { useInstall } from '@/ui/useInstall';

export function StatusBar() {
  const runState = useAppStore((state) => state.runState);
  const analysisState = useAppStore((state) => state.analysisState);
  const watch = useAppStore((state) => state.watch);
  const cursor = useAppStore((state) => state.cursor);
  const language = useAppStore((state) => state.language);
  const storageWarning = useAppStore((state) => state.storageWarning);
  const trash = useAppStore((state) => state.trash);
  const { canInstall, updateReady, offline, install, applyUpdate } = useInstall();

  const tone = overallTone(runState, analysisState, watch.status);

  return (
    <footer className="statusbar">
      <div className="statusbar__left">
        <span className={dotClass(tone)} aria-hidden="true" />
        <span>{overallLabel(runState, analysisState)}</span>
        {storageWarning ? (
          // Loud on purpose: the app works fine while failing to save, which is
          // exactly how work gets lost.
          <span className="statusbar__warning" role="status" title={storageWarning}>
            ⚠ {storageWarning}
          </span>
        ) : (
          <span className="statusbar__detail" title={watch.detail}>
            {watch.detail}
          </span>
        )}
        {trash.length > 0 ? (
          <span className="statusbar__item statusbar__item--wide" title="File đã xoá, lấy lại được ở Explorer">
            trash: {trash.length}
          </span>
        ) : null}
      </div>

      <div className="statusbar__right">
        {/* Install and update offers live where the app's state already is: visible,
            but out of the way of the code. */}
        {updateReady ? (
          <button
            type="button"
            className="statusbar__action statusbar__action--update"
            onClick={applyUpdate}
            title="Bản mới đã tải xong; reload để dùng"
          >
            ⟳ Có bản mới — Reload
          </button>
        ) : null}
        {canInstall ? (
          <button
            type="button"
            className="statusbar__action"
            onClick={() => void install()}
            title="Cài C/C++ Studio thành app, chạy offline sau lần tải đầu"
          >
            ⬇ Cài đặt app
          </button>
        ) : null}
        {offline ? (
          <span className="statusbar__item statusbar__item--offline" title="Không có mạng: phần đã cache vẫn chạy">
            offline
          </span>
        ) : null}
        <span className="statusbar__item">
          Ln {cursor.line}, Col {cursor.column}
        </span>
        {cursor.selected > 0 ? <span className="statusbar__item">Sel {cursor.selected}</span> : null}
        <span className="statusbar__item statusbar__item--wide">Spaces: 4</span>
        <span className="statusbar__item statusbar__item--wide">UTF-8</span>
        <span className="statusbar__item statusbar__item--wide">LF</span>
        <span className="statusbar__item">{language === 'c' ? 'C' : 'C++'}</span>
        <span
          className="statusbar__item statusbar__item--wide"
          title="Engine đã tạo ra giá trị trong pane Watch"
        >
          watch: {watch.engineLabel}
        </span>
      </div>
    </footer>
  );
}
