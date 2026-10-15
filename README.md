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
| **M2** | Interpreter thật (memory model, con trỏ, struct, malloc, printf/scanf), Run → console stdout/stderr/exit code, budget chống treo | ✅ xong |
| **C++** | Fast engine tự resolve `iostream`/`vector`/`string`/`algorithm`/template/range-for — không đẩy sang clang-wasm | ✅ xong |
| M3 | Watch: giá trị theo **dòng con trỏ**, **timeline scrub**, highlight giá trị đổi, **modal từng iteration** | ✅ xong |
| M4 | Execution chạy trong **Web Worker** (UI không bao giờ đơ), cancel = terminate worker | ✅ xong |
| M5 | IntelliSense sâu: signature help, go-to-definition (kể cả nhảy vào header), outline + breadcrumb theo symbol | ✅ xong |
| M6 | **Share link** ✅ · **Settings** ✅ · **Command palette** ✅ · workspace nhiều file ✅ · còn: size tuning | 🟡 gần xong |
| M7 | `clang + lld` WASM: **Run biên dịch C/C++ thật (kèm libc++/STL)**; preview vẫn fast | ✅ xong |
| **Mobile** | UI cho mobile: dưới 880px chuyển thành 1 pane + tab bar | ✅ xong |

### UI mobile

Dưới **880px** (điện thoại, cửa sổ hẹp) layout 3 cột không còn đọc được, nên đổi thành **một pane mỗi lúc** với
tab bar ở dưới: **Files · Code · Watch · Output**.

- **Mọi pane vẫn được mount**, chỉ pane đang chọn là `display: flex` — nên Monaco **giữ nguyên undo history và vị
  trí scroll** khi bạn xem pane khác, thay vì bị dựng lại từ đầu.
- Tab mang thông tin chỉ hữu ích khi bạn đang nhìn pane khác: chấm nhấp nháy khi đang phân tích (Watch), chấm
  vàng khi đang chạy (Code), **badge số lỗi** (Output).
- Bấm **Run** trên điện thoại thì tự chuyển sang tab Output — chạy là để xem kết quả.
- Editor trên điện thoại: **tắt minimap và sticky scroll** (tốn chỗ vô ích), **bật word wrap** (không phải cuộn
  ngang để đọc hết dòng), và gọi `layout()` khi pane hiện lại (Monaco bị `display:none` thì cần đo lại).
- `.app` dùng `100dvh` (kèm fallback `100vh`) để **tab bar không bị thanh URL che**.
- Toolbar cuộn ngang thay vì xuống dòng; bỏ pill trang trí và các mục status bar phụ; **modal full-width**
  (`min-width: 420px` sẽ tràn màn hình 390px); vùng chạm 28px (icon), 38px (dòng file), 46px (tab).
- Ngưỡng 880px nằm **một chỗ duy nhất** (`MOBILE_MAX_WIDTH`) và được cả JS lẫn CSS dùng, có test chặn hai bên
  lệch nhau.

### Phân chia engine

| Việc | Engine | Vì sao |
|---|---|---|
| Pane Watch, inline values, timeline, modal iteration | **fast** (front-end engine) | phải cập nhật sau mỗi 1s; build clang không thể chạy mỗi giây |
| Problems, suggestion, signature help, go-to-def | **fast** | cùng một lần phân tích, không cần compiler |
| **Run / F5** | **clang + lld (WebAssembly)** | biên dịch C/C++ thật, kèm libc++ |

`WATCH_ENGINE_ID = 'fast'` là hằng số, không phải lựa chọn: pane phải chỉ có đúng một engine khả thi. Dropdown
trên toolbar chỉ chọn engine cho **Run**. Nếu clang không chạy được (chưa tải toolchain, hoặc worker bị chặn),
Run **tự fallback về fast engine và ghi rõ lý do** trong console — không bao giờ im lặng giả vờ đã build bằng clang.

### M7: clang + lld + libc++ trong browser

Pipeline: `clang.wasm` biên dịch → `wasm-ld` link với `libc++`/`libc++abi`/`libc` + `crt1.o` → chạy module wasm
vừa tạo, stdout đổ về console. Chạy trong **worker riêng** nên editor không đơ, và **Stop = terminate worker**
(build wasm đồng bộ nên không thể "xin dừng").

- **Diagnostics thật**: lỗi của clang được parse thành diagnostic có dòng/cột → hiện trong **Problems** và thành
  marker trong editor. Lỗi nằm trong header hệ thống thì gắn nhãn `<vector>` chứ không gán sai sang file của bạn.
- **stdin** hoạt động (`scanf` đọc từ tab Stdin).
- Lần Run đầu tải ~58 MB toolchain (console báo trước); sau đó browser cache.
- Giới hạn: clang **8.0.1** → C++14 đầy đủ, C++17 một phần (`std::optional`, `string_view` không có); không có
  `-pthread`/COOP-COEP nên không có đa luồng thật.

**Verify**: `tests/clangRuntime.test.ts` chạy **clang thật** trong CI (compile + run C, C++ STL + template,
báo lỗi thật, `scanf`) và được skip khi chưa tải toolchain. `tests/clangEngine.test.ts` kiểm tra hợp đồng của
engine — trong đó có test khẳng định **`watch()` không bao giờ chạm vào clang**, đúng như thiết kế.

**C và C++ (kèm STL) thật sự biên dịch và chạy được**, verify bằng `npm run smoke:clang` (chạy cả trong CI):

```
[PASS] main.c:      c: total=30                                   wasm 30 KB
[PASS] main.cpp:    sorted: 1 3 5 9 / sum = 18                    wasm 611 KB
                    (iostream + vector + string + algorithm + function template)
[PASS] modern.cpp:  c++14: 3 rows=2                               wasm 602 KB
                    (lambda, auto, emplace_back, std::pair)
```

Toolchain (`~58 MB`) **không commit vào git**: `npm run toolchain` tải `clang`, `lld`, `sysroot.tar`, `memfs`,
`shared.js` (nguồn [binji/wasm-clang](https://github.com/binji/wasm-clang), Apache-2.0 + LLVM license, có kèm
file license). CI tải trước khi build nên site tự phục vụ toolchain từ origin của chính nó — Run không phụ thuộc
CDN bên thứ ba.

Hai điều đáng ghi lại vì đã tốn công tìm:

- `sysroot.tar` **có sẵn libc++**: 195 header trong `include/c++/v1/` (`vector`, `string`, `iostream`…) cùng
  `libc++.a`, `libc++abi.a`, `libc.a`, `libm.a`, `crt1.o` trong `lib/wasm32-wasi/`.
- Gọi `wasm-ld` **trực tiếp** (như runtime mẫu làm) thì phải tự nêu
  `lib/clang/8.0.1/lib/wasi/libclang_rt.builtins-wasm32.a`, nếu không sẽ lỗi
  `undefined symbol: __lttf2` khi link bất kỳ object nào của libc++ (clang driver tự thêm archive này, gọi tay thì không).

Giới hạn: clang **8.0.1** (2019) → C++14 đầy đủ, C++17 một phần (`std::optional`, `string_view` không có).

**Phân chia engine (đúng như thiết kế):** pane Watch / inline values / timeline / Problems **luôn** dùng fast
engine (`WATCH_ENGINE_ID = 'fast'`) vì preview phải phản hồi sau 1 giây; chỉ **Run (F5)** mới dùng clang. Trong
lúc toolchain chưa nạp xong, Run tự fallback về fast engine và **nói rõ** trong console.

- **Share link**: nút *Share link* mã hoá **toàn bộ workspace** (mọi file) vào **URL fragment** — fragment không
  được gửi lên server nên app vẫn thuần client. Payload được **deflate-raw** rồi **base64url** (marker `1`/`0` cho
  biết có nén hay không); mở link là workspace được nạp lại. Mọi thứ đến từ link được coi là **không tin cậy**:
  tên file phải hợp lệ, tối đa 50 file và 512KB code, link >60k ký tự thì từ chối kèm lý do.
- **Settings** (⚙ trên toolbar): cỡ chữ editor, debounce của pane Watch (đổi là áp dụng ngay), minimap, inline
  values, và **Reset workspace** (có xác nhận). Tất cả được lưu cùng workspace.
- **Command palette**: `Ctrl+Shift+P` (hoặc `F1`) do Monaco cung cấp; các lệnh của app được đăng ký dưới dạng
  *editor actions* nên có mặt trong đó: Run (F5), Stop, New file, Toggle inline values, Copy share link,
  Reset workspace.

### Workspace nhiều file, lưu trong browser

Explorer ở cột trái quản lý danh sách file; mọi thứ được lưu vào `localStorage` và tự khôi phục khi mở lại:

- **Tạo / mở / đổi tên / xoá file** (`＋`, bấm đôi để đổi tên, nút 🗑 hỏi xác nhận tại chỗ). Tên file được kiểm tra:
  rỗng, ký tự lạ, thiếu extension, extension không hỗ trợ, trùng tên, `..` — mỗi lỗi có message riêng, và tên trùng thì
  tự thêm số (`main.c` → `main2.c`).
- **Ngôn ngữ suy ra từ extension** (`.c/.h` → C, `.cpp/.cc/.cxx/.hpp/...` → C++), Monaco đổi chế độ theo file.
- **Tab strip** hiện mọi file đang mở; mỗi file giữ code riêng, engine phân tích đúng file đang mở.
- **Lưu trữ**: `cjit.files.v2` trong localStorage (ghi debounce 400ms). Workspace một-file kiểu cũ
  (`cjit.workspace.v1`) được **migrate** tự động, suy ra `main.c`/`main.cpp` từ nội dung — không mất code của bạn.
  Nếu localStorage đầy, việc lưu thất bại một cách im lặng nhưng không làm hỏng state trong bộ nhớ.
- File cuối cùng **không xoá được** (nút bị disable và nói rõ lý do), vì workspace rỗng thì không còn chỗ để gõ.

### M5: IntelliSense

- **Signature help**: tự hiện khi gõ `(` hoặc `,`, biết đang ở tham số thứ mấy — tính từ **range của từng argument**
  nên đúng cả với call lồng nhau và tham số kiểu function pointer (đếm dấu phẩy sẽ sai).
- **Go to definition**: nhảy tới khai báo của biến/hàm/struct; với `printf` thì mở **`<stdio.h>` như một document thật**
  (monaco standalone không có `registerTextModelContentProvider`, nên model được tạo theo nhu cầu và cache lại).
- **Breadcrumb theo symbol thật**: `main.cpp › sum › for` — lấy từ document symbols, không phải text.
- **Outline** (Ctrl+Shift+O) gồm hàm/biến/typedef/struct (kèm member)/enum (kèm enumerator).
- **`#include <`** gợi ý toàn bộ header mà engine biết.
- **Hover** thêm giá trị mà biến có **tại dòng đang trỏ**.

### M3: đọc dữ liệu chương trình

- **Inline value overlay**: sau mỗi dòng đã chạy, Monaco hiện `// total = 6` ngay cuối dòng. Dòng nào **tạo
  ra/thay đổi** biến thì hiện đúng biến đó (tối đa 3 tên + `(+k)`); dòng không đổi gì (`printf`, `return`,
  `if`) thì hiện **biến đang trong scope**, mờ hơn — nên hầu như dòng nào cũng đọc được giá trị, giống inline
  values của debugger. Bật/tắt bằng nút **Inline values**. Dòng chưa chạy thì không có gì (không bịa).
- **Container hiển thị dạng `[value, value, ...]`**: `std::vector` và mảng C hiện **phần tử**, không phải
  `std::vector<int> @ 0x1f40` (địa chỉ là chi tiết nội bộ của interpreter, không nói gì về dữ liệu). Tối đa
  **20 phần tử**, phần còn lại được **đếm ra** (`[0, 1, ..., 19, +5 more]`) nên danh sách dài không bao giờ trông
  như đã hết. `char[N]` hiện như chuỗi (`"abc"`) vì đó là điều C muốn nói; `vector<string>` hiện `["alpha", "beta"]`;
  `vector<char>` hiện `['h', 'i']` (không kèm mã số); lồng nhau được (`[[1, 2], [3]]`, sâu tối đa 3 tầng).
- **Watch pane 3 chế độ**: `At cursor` (mặc định, state tại dòng con trỏ), `Timeline` (scrub qua từng lần gán
  biến *và* từng vòng lặp, nhãn `iteration 2 of the loop on line 3`), `Final` (state sau khi chạy xong).
- **Highlight giá trị đổi**: biến vừa đổi (hoặc vừa xuất hiện) được tô đỏ, kèm bộ đếm `n changed`.
- **Modal iteration theo VÒNG LẶP**: interpreter ghi một entry cho mỗi **vòng lặp** (`for`/`while`/`do-while`/
  range-for) — state sau khi vòng đó chạy xong, kèm số vòng của chính nó, độ sâu lồng nhau và tập dòng mà vòng
  đó đã chạy. Khi con trỏ nằm trong vòng lặp, pane hiện chip `⟳ N iterations · Ln 3`; modal hiện mỗi vòng một
  dòng với 3 cột chỉ số: `iter` (số vòng của loop đó), `global` (thứ tự vòng lặp trong **toàn bộ** lần chạy,
  dạng `3/8`) và `step`. Vòng lặp lồng nhau thì chọn **vòng trong cùng** theo `depth`. Bấm một dòng để nhảy
  thẳng vào state đó trong timeline. Vòng bị `break` cắt ngang thì không tính là một vòng hoàn chỉnh.

### M4: không bao giờ đơ tab

Engine chạy trong **Web Worker**: một `while(1)` chỉ treo worker, không treo editor. Vì worker thực thi đồng
bộ nên **cancel = terminate worker** (không thể "nhờ" nó dừng). Hai worker riêng biệt — một cho realtime, một
cho Run — nên gõ phím không giết Run và Run không chặn pane realtime. Parse vẫn chạy ở main thread (vài ms) để
completion/hover/marker luôn mượt; worker là nguồn chân lý cho **giá trị**. Môi trường không có Worker thì tự
fallback về engine in-process, và engine crash được hiện lên status bar chứ không im lặng.

### M2: chương trình chạy thật

Interpreter tree-walking với **memory model thật** (Uint8Array phẳng + cấp phát/free first-fit), nên `&x`,
số học con trỏ, array, struct, `malloc`/`free` và struct assignment hành xử như C chứ không phải như các
trường hợp đặc biệt:

- **Kiểu**: `char/short/int/long`, `unsigned`, `float/double`, `_Bool`, enum, con trỏ, array (kể cả `[]` suy
  độ dài từ initializer), struct/union với layout căn chỉnh thật (`sizeof(struct {int x; int y;})` = 8).
- **Điều khiển**: if/else, for, while, do-while, switch có fall-through, break/continue, goto/label, đệ quy.
- **Thư viện**: `printf` family (cờ/width/precision/`*`/mọi conversion), `scanf`/`sscanf`, chuỗi, `malloc`
  family, `mem*`, `atoi/atof/strtol`, `qsort` (gọi comparator của bạn), math, ctype, `assert`.
- **An toàn**: budget step + wall-clock → `budget`/`timeout` thay vì treo tab; chia 0, null deref, out of
  memory, đọc biến chưa khởi tạo đều được báo **kèm số dòng**, không bao giờ trả giá trị giả.

### C++ được resolve ngay trong fast engine

Trước đây `<iostream>`, `<vector>`, `<string>` và `template` chỉ hiện ghi chú "cần clang-wasm". Giờ chúng
chạy thật, không còn diagnostic nào:

- `std::cout` / `std::cerr` / `std::endl` với chuỗi `<<` (đúng thứ tự, không mất nhánh trước).
- `std::vector<T>`: `{}` init, `push_back`, `[]`, `size`, `at`, `front/back`, `begin/end`, `resize`, range-for.
  Vector mang descriptor kiểu phần tử của chính nó, nên `std::vector<T>` bên trong template vẫn chạy đúng.
- `std::string`: khởi tạo từ literal, `+`, `size`, `substr`, `c_str`, `find`, in bằng `<<`.
- `std::sort` (có/không comparator), `std::reverse`, `std::min/max/abs/swap`, `std::to_string`, `std::stoi/stod`.
- `template <typename T>` được parse thành hàm thật; `T` là kiểu động, `T total{}` **suy ra kiểu từ lần gán
  đầu tiên** — nên cùng một template chạy đúng cho cả `vector<int>` và `vector<double>`.
- `<cstdio>`/`<cstring>`/`<cmath>`… map về header C tương ứng, kèm khai báo thật.
- Vẫn báo trung thực (một lần) với thứ không thể thực thi: `class`, `namespace` — vì bỏ qua chúng âm thầm sẽ
  làm sai kết quả.

### Watch: giá trị tại dòng con trỏ

Pane Watch mặc định hiển thị giá trị mà biến có **tại dòng con trỏ đang đứng** (state lần đầu dòng đó chạy
xong — giống breakpoint), và có toggle sang `Final` để xem state sau khi chương trình kết thúc. Nếu dòng con
trỏ chưa từng chạy, pane nói rõ và lùi về dòng gần nhất trước đó.

### Giới hạn đã biết (sẽ do M7/clang giải quyết)

Số nguyên 64-bit giữ độ chính xác của `double`; `class`/`namespace`/`STL` đầy đủ (map, set, template class,
exception) chưa thực thi được; chưa có I/O file. Đây là ranh giới của fast engine, và nó luôn nói ra thay vì
đoán.

Parser của fast engine cũng chưa nhận `std::vector<std::vector<int>>` viết liền (cần `> >`) và init list lồng
nhau (`{{1, 2}, {3}}`) — **Run bằng clang thì nhận cả hai**. Pane Watch là để xem nhanh trong lúc gõ, nên ranh
giới này được ghi ra thay vì che đi.

**Một bug thật đã lộ ra khi làm phần hiển thị container**: `std::vector<std::string>` lưu phần tử dưới dạng
**ký tự thô của literal** thay vì một string object, nên khi đọc lại thì 8 byte đầu của `"alpha"` bị hiểu là con
trỏ và làm **crash toàn bộ watch snapshot** (`invalid memory access at 0x6168706c61`). Đã sửa: phần tử
`std::string` được tạo bằng `createString` như mọi nơi khác, và có test cho cả `{"alpha", "beta"}` lẫn
`push_back` lúc chạy.

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
