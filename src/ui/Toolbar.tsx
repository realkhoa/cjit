import { ENGINE_ORDER, getEngine } from '@/engine/registry';
import type { EngineId } from '@/engine/types';
import { EXAMPLES } from '@/examples/sample';
import { ANALYSIS_DEBOUNCE_MS, useAppStore } from '@/state/store';

export function Toolbar() {
  const runState = useAppStore((state) => state.runState);
  const engineId = useAppStore((state) => state.engineId);
  const run = useAppStore((state) => state.run);
  const stop = useAppStore((state) => state.stop);
  const clearOutput = useAppStore((state) => state.clearOutput);
  const loadExample = useAppStore((state) => state.loadExample);
  const setEngineId = useAppStore((state) => state.setEngineId);
  const path = useAppStore((state) => state.path);

  const running = runState === 'running';

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
          Engine
        </label>
        <select
          id="engine-select"
          className="select"
          value={engineId}
          onChange={(event) => setEngineId(event.target.value as EngineId)}
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

      <div className="titlebar__spacer" />

      <span className="pill" title="Pane phải phân tích lại sau khi bạn ngừng gõ">
        watch debounce {ANALYSIS_DEBOUNCE_MS} ms
      </span>
    </div>
  );
}
