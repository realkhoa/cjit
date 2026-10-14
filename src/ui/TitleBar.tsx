import { useAppStore } from '@/state/store';

function hostLabel(): string {
  if (typeof window === 'undefined') return '';
  return `${window.location.host}${window.location.pathname}`;
}

export function TitleBar() {
  const path = useAppStore((state) => state.path);

  return (
    <header className="titlebar">
      <div className="titlebar__brand">
        <span className="titlebar__logo">C+</span>
        <span>C/C++ Studio</span>
      </div>
      <span className="titlebar__path">
        {hostLabel()} · {path}
      </span>
      <div className="titlebar__spacer" />
      <span className="pill" title="Toàn bộ quá trình biên dịch và thực thi chạy trong browser">
        client-only · no backend
      </span>
    </header>
  );
}
