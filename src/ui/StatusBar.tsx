import { useAppStore } from '@/state/store';
import { dotClass, overallLabel, overallTone } from '@/ui/status';
import { useInstall } from '@/ui/useInstall';

/**
 * @brief Renders the left-hand section of the status bar.
 * @details Displays the aggregate health tone dot, execution/analysis status label,
 * storage quota warnings, watch detail information, and trash count.
 * @return The rendered left status bar items JSX element.
 */
function StatusBarLeft() {
  const runState = useAppStore((state) => state.runState);
  const analysisState = useAppStore((state) => state.analysisState);
  const watch = useAppStore((state) => state.watch);
  const storageWarning = useAppStore((state) => state.storageWarning);
  const trash = useAppStore((state) => state.trash);
  const tone = overallTone(runState, analysisState, watch.status);

  return (
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
  );
}

/**
 * @brief Renders the PWA installation, reload update, and network offline indicators.
 * @details Displays interactive buttons for application install and service worker update
 * readiness, as well as an offline status tag if network access is lost.
 * @return The rendered PWA actions JSX fragment.
 */
function StatusBarPwaActions() {
  const { canInstall, updateReady, offline, install, applyUpdate } = useInstall();

  return (
    <>
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
    </>
  );
}

/**
 * @brief Renders the right-hand section of the status bar.
 * @details Displays PWA actions, live editor cursor coordinates (Ln, Col, Sel),
 * source language mode, and active watch evaluation engine.
 * @return The rendered right status bar items JSX element.
 */
function StatusBarRight() {
  const watch = useAppStore((state) => state.watch);
  const cursor = useAppStore((state) => state.cursor);
  const language = useAppStore((state) => state.language);

  return (
    <div className="statusbar__right">
      <StatusBarPwaActions />
      <span className="statusbar__item">
        Ln {cursor.line}, Col {cursor.column}
      </span>
      {cursor.selected > 0 ? <span className="statusbar__item">Sel {cursor.selected}</span> : null}
      <span className="statusbar__item">{language === 'c' ? 'C' : 'C++'}</span>
      <span
        className="statusbar__item statusbar__item--wide"
        title="Engine đã tạo ra giá trị trong pane Watch"
      >
        watch: {watch.engineLabel}
      </span>
    </div>
  );
}

/**
 * @brief Renders the application footer status bar.
 * @details Displays operational states, diagnostics tone, storage alerts, trash file
 * count, PWA lifecycle actions (install, update, offline status), live cursor positions
 * (Ln, Col, Sel), source language mode (C / C++), and active variable watch engine indicator.
 * Static non-actionable labels (Spaces, UTF-8, LF) are omitted to conserve status bar width.
 * @return The rendered footer status bar JSX element.
 */
export function StatusBar() {
  return (
    <footer className="statusbar">
      <StatusBarLeft />
      <StatusBarRight />
    </footer>
  );
}
