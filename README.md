# C/C++ Studio

Editor C/C++ chạy **hoàn toàn trên client** (không backend), deploy được lên **GitHub Pages**.

- Pane trái: editor C/C++ với suggestion.
- Pane phải: giá trị biến của chương trình khi nó **thực sự chạy**, cập nhật realtime sau khi ngừng gõ 1 giây.
- Dưới cùng: console nhận stdout/stderr khi bấm **Run**.
- Look & feel: Visual Studio 2022 Dark.

## Trạng thái

| M | Nội dung | Trạng thái |
|---|---|---|
| **M0** | Skeleton Vite+TS+React, layout 3 pane resizable, theme VS 2022 Dark, engine contract, debounce controller, CI deploy | ✅ xong |
| **M1** | Preprocessor + lexer + parser + symbol table; markers, Problems, completion & hover theo scope | ✅ xong |
| M2 | Evaluator/interpreter + Run → console stdout/stderr/exit code, worker + budget | ⏳ |
| M3 | Watch engine: snapshot biến, expand struct/array, changed-value, timeline, call stack | ⏳ |
| M4 | Chạy pipeline debounce trong Web Worker, cancel giữa chừng | ⏳ |
| M5 | IntelliSense sâu: signature help, go-to-def, completion theo member/`.h` | ⏳ (đã có bản cơ bản ở M1) |
| M6 | Polish: examples, share URL, settings, command palette, size tuning | ⏳ |
| M7 | `clang + lld` WASM: build C++ thật với libc++/STL | ⏳ |

### M1 có gì

- **Lexer**: C/C++ tokenizer đầy đủ vị trí, escape, pp-number, line continuation, cờ `atLineStart` cho preprocessor.
- **Preprocessor**: `#include` (header built-in), `#define` object/function-like/variadic, `#` và `##`, `#undef`, `#if/#ifdef/#ifndef/#elif/#else/#endif` với evaluator biểu thức hằng, `defined`, `__LINE__`/`__FILE__`, `#error`/`#warning`.
- **Parser**: khai báo, declarator (pointer/array/function/function-pointer), struct/union/enum/typedef, toàn bộ statement, biểu thức đủ precedence, init list; **error recovery** (không bao giờ throw, luôn tiến, resync `;`/`}`) vì nó chạy mỗi 1 giây khi bạn đang gõ dở.
- **C++ degradation trung thực**: `template`, `class`, `namespace`, `std::vector<int>`, `std::string`, range-based for… mỗi thứ được báo **một** warning/info nói rõ "không thực thi được trên fast engine, Run dùng clang-wasm" và một node bị skip — không có bão lỗi giả. Sample C++ mặc định: **0 error**.
- **Symbol table**: scope thật theo offset (local/param/block/for/global), member của struct, enumerator, typedef → completion và hover **theo context**.
- **UI**: squiggle từ diagnostics (chỉ áp cho file đang mở), Problems tab, breadcrumb hiện số diagnostics, hover hiện type + scope.

### Implicit headers và `bits/stdc++.h`

Mặc định engine nạp sẵn toàn bộ C surface, nên **không cần viết `#include`**:

```c
int main(void) {
    printf("hello\n");   // chạy được ngay, không cần #include <stdio.h>
    return 0;
}
```

`#include <bits/stdc++.h>` (và `<stdc++.h>`) được nhận là header built-in và map sang C surface. Nó **không** mang theo C++ STL — điều đó được nói rõ bằng một info diagnostic, vì `vector`/`string`/`iostream` không thể thực thi trên fast engine và giả vờ ngược lại sẽ tạo ra giá trị biến sai.

Tắt implicit headers bằng `analyzeSource(code, file, { implicitHeaders: false })`.

## Quyết định kiến trúc

Yêu cầu "realtime 1s" và "clang/C++ thật" **không thể cùng nằm trên một đường**, nên app có hai engine:

| Engine | Dùng cho | Vì sao |
|---|---|---|
| `clang-wasm` | **Run / F5** | Biên dịch C++ thật (libc++/STL). Nặng (toolchain + sysroot hàng chục MB) và chậm, nên không thể chạy mỗi lần gõ phím. |
| `fast` | **Pane Watch realtime** | Preprocessor + parser + evaluator nhẹ, đủ nhanh để chạy sau mỗi lần debounce 1s, và biết chính xác mọi biến ở mọi bước. |

Mọi kết quả đều mang theo engine đã tạo ra nó, và engine chưa hoàn thiện trả về trạng thái
`unsupported` kèm lý do cụ thể. **Không có giá trị biến nào được bịa ra** — pane Watch hiển thị
"engine not wired" cho tới khi M1–M3 xong.

Trong M0, engine là stub (`src/engine/placeholderEngine.ts`) nhưng **toàn bộ contract, registry,
pipeline debounce và layout đã là thật**: khi M1–M3 đăng ký engine thật, UI không phải sửa.

## Chạy local

```bash
npm install
npm run dev        # http://localhost:5173
npm run typecheck
npm test
npm run build
npm run preview    # xem thử đúng artifact sẽ deploy
```

## Deploy lên GitHub Pages

`vite.config.ts` dùng `base: './'` nên mọi URL asset là tương đối — cùng một build chạy đúng ở
`https://<user>.github.io/<repo>/` mà không phải sửa config.

1. Tạo repo rỗng trên GitHub rồi push nhánh `main`:

   ```bash
   git init -b main
   git add .
   git commit -m "M0: editor shell, VS 2022 dark theme, engine contract, Pages CI"
   git remote add origin https://github.com/<user>/<repo>.git
   git push -u origin main
   ```

2. Trong repo: **Settings → Pages → Source = GitHub Actions**.
3. Workflow `.github/workflows/deploy.yml` sẽ typecheck, test, build, upload artifact và deploy.
   Theo dõi ở tab **Actions**; URL nằm ở job `Deploy`.

Lưu ý: GitHub Pages không set được header `COOP/COEP`, nên dự án **không dùng**
`SharedArrayBuffer`/pthreads. Mọi engine chạy single-threaded trong Web Worker để có thể
`terminate()` khi code vào vòng lặp vô hạn.

## Cấu trúc

```
src/
├─ engine/      contract (Engine, WatchSnapshot) + registry + stub engine
├─ state/       store (zustand), debounce + cancel, persistence
├─ ui/          TitleBar, Toolbar, EditorPane, WatchPane, ConsolePanel, StatusBar, Splitter
│  └─ theme/    tokens.css (palette), app.css (layout), monacoTheme.ts
├─ editor/      monaco setup, completion provider, navigation
├─ worker/      postMessage protocol (dùng từ M4)
├─ examples/    chương trình mẫu
└─ util/        geometry helpers (có unit test)
```

## Test

`npm test` — hiện có: clamp/percent cho splitter, và timing contract của debounce (chỉ phân tích
bản mới nhất, abort pass đang chạy khi có input mới, cancel, flush).

Kế hoạch: golden test cho interpreter so với `gcc` thật (M2), Playwright e2e cho luồng gõ code →
1s → pane Watch cập nhật, và Run → console đúng stdout.
