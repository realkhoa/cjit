import { useState } from 'react';
import { ENGINE_ORDER, getEngine } from '@/engine/registry';
import type { EngineId } from '@/engine/types';
import { EXAMPLES } from '@/examples/sample';
import { useAppStore } from '@/state/store';
import { SettingsDialog } from '@/ui/SettingsDialog';

export function Toolbar() {
  const runState = useAppStore((state) => state.runState);
  const engineId = useAppStore((state) => state.engineId);
  const run = useAppStore((state) => state.run);
  const stop = useAppStore((state) => state.stop);
  const clearOutput = useAppStore((state) => state.clearOutput);
  const loadExample = useAppStore((state) => state.loadExample);
  const setEngineId = useAppStore((state) => state.setEngineId);
  const inlineValues = useAppStore((state) => state.settings.inlineValues);
  const debounceMs = useAppStore((state) => state.settings.debounceMs);
  const toggleInlineValues = useAppStore((state) => state.toggleInlineValues);
  const shareLink = useAppStore((state) => state.shareLink);
  const path = useAppStore((state) => state.path);

  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shareState, setShareState] = useState<'idle' | 'copied' | 'failed'>('idle');

  const running = runState === 'running';

  const handleShare = (): void => {
    void shareLink().then((outcome) => {
      setShareState(outcome.ok ? 'copied' : 'failed');
      setTimeout(() => setShareState('idle'), 2500);
    });
  };

  return (
    <div className="toolbar">
      <div className="toolbar__group">
        <button
          type="button"
          className="btn btn--primary"
          onClick={() => void run()}
          disabled={running}
          title="Build và chạy chương trình (F5)"
        >
          ▶ Run <span className="btn__key">F5</span>
        </button>
        <button
          type="button"
          className="btn"
          onClick={stop}
          disabled={!running}
          title="Dừng chương trình đang chạy, kể cả vòng lặp vô hạn (Shift+F5)"
        >
          ■ Stop
        </button>
      </div>

      <div className="toolbar__sep" />

      <div className="toolbar__group">
        <label className="toolbar__label" htmlFor="engine-select">
          Run engine
        </label>
        <select
          id="engine-select"
          className="select"
          value={engineId}
          onChange={(event) => setEngineId(event.target.value as EngineId)}
          title="Engine cho nút Run/F5. clang + lld biên dịch C/C++ thật bằng WebAssembly (lần đầu tải ~58 MB toolchain, sau đó browser cache lại). Pane Watch luôn dùng fast engine vì build clang không thể chạy mỗi giây."
        >
          {ENGINE_ORDER.map((id) => (
            <option key={id} value={id}>
              {getEngine(id).label}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__sep" />

      <div className="toolbar__group">
        <label className="toolbar__label" htmlFor="example-select">
          Example
        </label>
        <select
          id="example-select"
          className="select"
          value={path}
          onChange={(event) => {
            const chosen = EXAMPLES.find((example) => example.path === event.target.value);
            if (chosen) loadExample(chosen.path, chosen.language, chosen.code);
          }}
        >
          {EXAMPLES.map((example) => (
            <option key={example.path} value={example.path}>
              {example.path}
            </option>
          ))}
        </select>
      </div>

      <div className="toolbar__sep" />

      <button type="button" className="btn" onClick={clearOutput} title="Xoá nội dung console">
        Clear console
      </button>

      <button
        type="button"
        className={inlineValues ? 'btn btn--toggled' : 'btn'}
        onClick={toggleInlineValues}
        aria-pressed={inlineValues}
        title="Hiện/ẩn giá trị biến ngay sau mỗi dòng code đã chạy"
      >
        Inline values
      </button>

      <button
        type="button"
        className={shareState === 'copied' ? 'btn btn--toggled' : 'btn'}
        onClick={handleShare}
        title="Copy link chia sẻ chứa toàn bộ workspace (mã hoá trong URL, không gửi lên server)"
      >
        {shareState === 'copied' ? 'Link copied' : shareState === 'failed' ? 'Link too long' : 'Share link'}
      </button>

      <button
        type="button"
        className={settingsOpen ? 'btn btn--toggled' : 'btn'}
        onClick={() => setSettingsOpen((open) => !open)}
        aria-expanded={settingsOpen}
        title="Settings (font, debounce, minimap, reset workspace)"
      >
        ⚙ Settings
      </button>

      {settingsOpen ? <SettingsDialog onClose={() => setSettingsOpen(false)} /> : null}

      <div className="titlebar__spacer" />

      <span
        className="pill"
        title="Pane Watch, inline values và timeline luôn do fast engine tính (clang không thể build mỗi giây). Chỉ nút Run mới dùng clang."
      >
        watch: fast · debounce {debounceMs} ms
      </span>
    </div>
  );
}
