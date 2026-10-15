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

**Toolchain được cache trong IndexedDB, không phải HTTP cache.** GitHub Pages trả `Cache-Control: max-age=600`
cho các file này, nên reload sau 10 phút là phải revalidate, và entry 31 MB có thể bị browser evict bất cứ lúc
nào → mỗi lần reload trang là một lần tải lại 58 MB. Thay vào đó, lần chạy đầu tiên ghi toolchain vào
**IndexedDB** (`cjit-toolchain`) và mọi lần load sau đọc từ đó: **0 network request** (có test assert đúng điều
này qua IndexedDB thật), không TTL, không revalidate, và Run vẫn chạy được khi mạng chậm/mất mạng. Kèm theo:

- **Version key** (`TOOLCHAIN_CACHE_VERSION`) — đổi toolchain thì cache cũ bị xoá hẳn, không trộn file cũ/mới.
- **Xin persistent storage** (`navigator.storage.persist()`, best-effort) để 58 MB không bị evict khi hết đĩa.
- **Suy giảm mềm**: IndexedDB bị chặn/quota/hết chỗ (private mode) thì tự động quay về tải qua mạng, không lỗi.
- Console nói rõ mỗi lần: `Toolchain: N file từ IndexedDB trong máy, M tải mới`.

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

**File mới trong project là một module**: bắt đầu bằng **`#pragma once`** và **không có `main`** — vì project chỉ
được có một entry point, nên trước đây tạo file mới là làm hỏng build của cả project (link trùng `main`). Muốn một
chương trình nữa thì tự thêm `main`. `#pragma once` được fast engine **thực thi đúng ngữ nghĩa**: file có nó thì
được splice **một lần** dù đi vào bằng đường nào; file không có nó thì được include **mỗi lần được gọi tên** — đúng
như C, và **khớp với clang** (engine kia phải đồng ý, nếu không thì hai engine dạy hai thói quen khác nhau).

**Các file trong workspace nhìn thấy nhau.** `#include "util.h"` resolve theo đúng cách compiler làm: **thư mục
của file đang include trước**, rồi tới workspace root (đóng vai include path); include-once, đi theo được chuỗi
header, và token của file được include mang **đúng path của nó** nên symbol/lỗi/go-to-definition đều trỏ về file
bạn viết. Không tìm thấy thì báo đúng tên file chứ không nói chung chung.

**Run biên dịch cả project**: mọi file trong workspace được ghi vào filesystem của compiler (có tạo thư mục cha —
`memfs` không tự tạo, thiếu bước này clang trap `unreachable`), **mỗi translation unit được compile riêng rồi link
chung** với nhau. Nên `main.cpp` + `util.h` + `util.cpp`, hay `src/main.cpp` + `src/util.h`, hay project C trộn,
đều chạy như trên máy. Cả fast engine (pane Watch realtime) và clang đều dùng chung đường này.

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

### Memory & pointer view (tab `Memory`)

Tab **Memory** trong console vẽ thứ mà bảng biến không vẽ được:

- **Chuỗi con trỏ**: mỗi biến con trỏ tới struct được **đi theo từng node**, in ra `head → 2 node → NULL` và
  từng node kèm field (`0x1000  value = 1, next = 0x1010`). Đây là hình mà mọi khoá C vẽ lên bảng — linked list.
- **Kết thúc walk luôn được nói ra**: `NULL`, `cycle — trỏ quay lại node đã đi qua`, hay
  `… dừng ở giới hạn số node`. Một sơ đồ im lặng dừng lại sẽ khiến người học tưởng list đã hết, nên nó không im lặng.
- **Hex dump** các block chương trình **tự cấp phát** (`malloc`/`new`): địa chỉ, byte, cột ASCII.

Giới hạn (bounded, để không làm ngập UI): 4 chain, 8 node/chain, 8 block, 96 byte/block, 6 field/node.
Với clang thì tab ghi rõ engine đó **không mô hình hoá memory** (khối nhớ nằm trong module wasm) — không hiển thị
gì cả thay vì hiển thị sai.

Sửa kèm hai bug thật mà việc này phơi ra:

- **`struct Node { struct Node *next; };` không parse được** — member kiểu `struct X *` bị tưởng là nested struct
  definition và bị nuốt mất, nên **linked list không viết được** trừ khi có `typedef` đứng trước (đó là lý do lọt
  lưới). Giờ mọi member đi qua đường specifier chuẩn, và nested definition *có/không* declarator đều parse đúng.
  Nested definition vẫn được cảnh báo rõ ràng vì fast engine không layout nó (chương trình sẽ fail lúc chạy —
  đã kiểm chứng) và cảnh báo nói luôn cách sửa: khai báo ở file scope, hoặc Run bằng clang.
- **Leak báo sai cho mọi chương trình**: `builtinAlloc` dùng chung cho cả `malloc` của user lẫn buffer nội bộ của
  interpreter (string literal, vector, argv), nên chương trình `int main(void){ return 0; }` cũng "rò rỉ". Giờ chỉ
  cấp phát do chương trình yêu cầu mới tính.

### Console: 4 tab, gồm Runtime issues

`Output` · `Problems` · **`Runtime`** · `Stdin`. Tab **Runtime** gom những gì chương trình làm mà compiler chấp
nhận nhưng debugger sẽ dừng lại:

| Loại | Ví dụ |
|---|---|
| `uninitialized` | đọc biến chưa khởi tạo — **không** làm chương trình dừng, nên trước đây chỉ là một warning trôi mất |
| `divide by zero` | chia 0, kèm dòng xảy ra |
| `null deref` | deref con trỏ null |
| `out of bounds` | truy cập ngoài vùng nhớ (lỗi từ tầng memory, có địa chỉ, không có dòng) |
| `not freed` | byte cấp phát chưa `free` khi chương trình kết thúc (mức `info`, không phải lỗi) |

Bấm một dòng để nhảy tới đúng chỗ trong editor. Sửa luôn một **false positive cũ**: pane Watch đọc giá trị của mọi
biến để hiển thị, và việc đọc đó bị tính là *chương trình* đọc biến chưa khởi tạo — nên `int x; x = 5;` bị báo oan.
Giờ đường đọc để hiển thị không tính là đọc của chương trình, nên báo cáo chỉ nói về những lần đọc thật.

Khi Run bằng **clang**, tab ghi rõ engine đó chỉ build và chạy, **không kiểm tra an toàn lúc chạy** — để một báo
cáo trống không bị hiểu là "chương trình đã được kiểm tra và sạch".

### Không mất dữ liệu — và sao lưu ra file

Mọi đường có thể phá file đều đã được làm cho hoàn tác được:

| Đường | Hành vi |
|---|---|
| Đổi example (dropdown cũ) | dropdown đã **xoá**; hành động nền chỉ **mở thành file mới** |
| Mở **share link** | **thêm** file vào workspace (trùng tên → tên trống), không thay thế |
| Xoá file | vào **Trash** (giữ nguyên nội dung); Explorer có **Restore**, restore không bao giờ ghi đè |
| **Reset workspace** | file cũ **vẫn nằm trong Trash** |
| **Empty trash** | hành động **duy nhất** không hoàn tác được, và nó hỏi trước |
| Browser từ chối lưu (hết dung lượng / private mode) | cảnh báo ở **status bar** + console, tự tắt khi lưu được lại |

Trash giữ tối đa **20 entry**. Rủi ro còn lại — browser xoá cả `localStorage` (clear site data, evict, private
mode) — thì không gì *trong* app cứu được, nên **Settings → Sao lưu / phục hồi**:

- `Export workspace…` tải toàn bộ workspace (kể cả file đang trong Trash) thành một file JSON
  `cjit-workspace-YYYY-MM-DD.json`.
- `Import backup…` **thêm** các file đó vào workspace hiện tại — **không thay thế**; trùng tên thì lấy tên trống,
  tên không hợp lệ bị bỏ qua và **đếm ra** trong thông báo. Backup sai định dạng, rỗng, sai version hoặc quá lớn
  thì bị từ chối kèm lý do cụ thể.

### Tải thành quả build về máy

Sau khi Run bằng clang + lld thành công, toolbar có **`⬇ .wasm`** và **`⬇ .o`**: file `.wasm` đã link và object
file của file đang mở, tên chuẩn hoá (`main.cpp` → `main.wasm`, `main.o`). Artifact được lấy **theo yêu cầu**
(một round trip riêng trong worker) chứ không gửi kèm mỗi lần Run — không ai phải trả 600 KB cho một file họ có
thể không cần. File header thì nút `.o` bị tắt kèm lý do, và engine fast thì báo thẳng là không tạo ra file.

### M3: đọc dữ liệu chương trình

- **Timeline như một debugger (replay)**: trong chế độ Timeline có transport `⏮ ◀ ▶/⏸ ▶ ⏭` — step tiến/lùi
  (clamp ở hai đầu, không wrap), play tự chạy qua các mốc rồi **dừng ở cuối**, và `3/12` cho biết đang ở đâu.
  Phím tắt **F10 / Shift+F10 / Ctrl+F10** (play-pause) cùng command palette; mọi nút đều disabled khi chưa có
  history. Editor vẫn highlight + cuộn tới dòng của mốc đang chọn.
  Nói cho đúng: đây là **replay bản ghi** — chương trình đã chạy xong, ta đi lại qua những gì interpreter đã ghi
  lại, **không phải** dừng một tiến trình đang chạy. Nhãn trong palette ghi rõ "recorded moment".
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
  Khi kéo timeline, **editor highlight và tự cuộn tới dòng đã sinh ra state đó** — pane nói *giá trị là gì*, editor
  nói *chương trình đang ở đâu*. Chỉ chế độ timeline làm việc này: ở `At cursor` thì Monaco đã có highlight dòng
  con trỏ, còn `Final` là kết quả chứ không phải một thời điểm.
- **Tên bị shadow giữa các scope**: nếu một tên cùng lúc tồn tại ở nhiều scope (ví dụ `int total = sum(nums);`
  ở `main` và `T total{}` đang tích luỹ trong template `sum`), pane hiển thị binding **trong cùng đang sống**.
  Trước đây nó key theo `scope::tên` nên giữ cả hai, và UI lấy cái ngoài → modal iteration báo `total = 0` cho
  mọi vòng trong khi interpreter cộng đúng.
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
giới này được ghi ra thay vì che đi. Quoted include thì **đã hỗ trợ**: file trong workspace được splice như header
built-in (kèm include-once và giới hạn độ sâu lồng).

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
