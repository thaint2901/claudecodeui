# Kế hoạch điều tra hiệu năng frontend (chuyển cảnh giật/lag)

**Ngày:** 2026-07-25
**Trạng thái:** DRAFT — chờ user chốt scope + orchestration
**Bối cảnh:** user báo "hiệu năng chuyển cảnh khá tệ, giật, lag, không mượt" khi verify PR #5 trên localhost:5173.
**Giả định của user:** đây có thể là vấn đề **system design**, ảnh hưởng mọi task tương lai → cần điều tra ở mức kiến trúc, không chỉ vá chỗ đau.

---

## 0. Ba câu hỏi tách bạch (không được trộn)

| # | Câu hỏi | Tiêu chí hoàn thành |
|---|---------|---------------------|
| Q1 | **Đo:** Cái gì chậm, chậm bao nhiêu ms, ở kịch bản nào? | Mỗi kịch bản có số liệu p50/p95 trên cả dev build và prod build |
| Q2 | **Quy nguyên nhân:** Mỗi ms thuộc về nguyên nhân nào? Cái nào là lỗi cục bộ, cái nào là kiến trúc? | Bảng ablation: "gỡ nguyên nhân X ⇒ giảm Y ms ở kịch bản Z" — bằng thực nghiệm, không suy luận |
| Q3 | **Chặn tái diễn:** Cơ chế nào khiến task tương lai không lặp lại lỗi này? | Guardrail chạy được (lint rule / perf budget test / skill đo lại) + tài liệu invariant |

Q1 không có Q2 = vá mù. Q2 không có Q3 = 3 tháng nữa lặp lại.

---

## 1. Kiểm kê công cụ thực tế (đã verify, không phỏng đoán)

### 1.1 Browser tooling

| Công cụ | Trạng thái | Dùng vào việc gì |
|---------|-----------|------------------|
| **Chrome DevTools MCP** (`chrome-devtools-mcp@1.6.0`, cài local cho project này) | ✅ Có | **Nhạc trưởng đo đạc.** `performance_start_trace` / `performance_stop_trace` / `performance_analyze_insight` cho flame chart thật + tách Scripting/Style/Layout/Paint. `emulate` cho CPU throttling 4x/6x. `lighthouse_audit` cho TBT/LCP. `take_heapsnapshot` cho nghi ngờ leak. |
| **Playwright MCP** | ✅ Có | **Driver tương tác xác định.** Click/type theo kịch bản có thể lặp lại, `browser_evaluate` để cắm `PerformanceObserver` + đếm frame, `browser_network_requests`. |
| **Google Chrome** `/usr/bin/google-chrome` | ✅ Có | Backend cho cả hai MCP trên |
| **Vercel Agent Browser** | ❌ Không có | `agent-browser` không có trên PATH; `@vercel/agent-browser` trả 404 trên npm registry. Agent `e2e-runner` có nhắc tới nó nhưng không cài được → **loại khỏi kế hoạch** |
| **Claude Chrome** (extension, code.claude.com/docs/en/chrome) | ⚠️ Ngoài tầm | Là extension gắn vào Chrome thật của user, không điều khiển được từ background job này. **Chỉ hữu ích nếu user muốn tự tay reproduce** trên máy mình — không đưa vào pipeline tự động |
| **React Profiler / react-scan** | ⚠️ Cần dựng | Không có sẵn. Cần dev-only instrumentation để **đếm số render mỗi component** — đây là bằng chứng quyết định cho H1–H3 |

### 1.2 Skill / command sẵn có liên quan

- **Skills user-level:** `strategic-compact`, `context7-mcp`, `configure-ecc`, `learned`
- **Skills ECC** (`~/.claude/.agents/skills/`, 34 cái): liên quan nhất là `frontend-patterns` (có mục performance optimization), `verification-loop`, `eval-harness`, `agent-introspection-debugging`, `deep-research`, `tdd-workflow`
- **Skills project** (`/home/thaint/projects/claudecodeui/.claude/skills/`, 13 cái): `frontend-patterns`, `verification-loop`, `tdd-workflow`, `baseline-ui`, `improve-ui`, `coding-standards`, `deep-research`, ...
- **Commands** (79 cái ở `~/.claude/commands/`): `/quality-gate`, `/verify`, `/e2e`, `/code-review`, `/harness-audit`, `/loop-start`, `/orchestrate`, `/multi-workflow`, `/checkpoint`, `/skill-create`
- **Agents chuyên biệt:** `performance-optimizer`, `typescript-reviewer`, `e2e-runner`, `architect`, `code-reviewer`
- **Rules dự án:** `.claude/rules/performance.md` — **đã có sẵn ngân sách**: INP < 200ms, TBT < 200ms, LCP < 2.5s, CLS < 0.1, JS app page < 300kb gzip

> **Khoảng trống lớn nhất:** không có skill/command nào để **đo lại hiệu năng theo cách lặp lại được**. Mọi phiên sau sẽ phải dựng lại harness từ đầu → đó chính là deliverable Q3.

### 1.3 goal / schedule / loop / batch / workflow — có cần không?

| Cơ chế | Có dùng? | Lý do |
|--------|----------|-------|
| **Workflow** (fan-out nhiều agent) | ⚠️ Có điều kiện | Hữu ích cho *chuẩn bị* ablation song song, **KHÔNG dùng cho khâu đo** (xem §4.3) |
| **loop / schedule / cron** | ❌ Không | Không có việc chờ hệ thống ngoài (CI, deploy, queue). Thêm vào chỉ là nghi thức thừa |
| **batch** | ✅ Có, ở dạng script | Batch = vòng lặp kịch bản trong 1 tiến trình đo tuần tự, không phải batch agent |

---

## 2. Nguyên nhân nghi vấn (từ phân tích tĩnh — mỗi cái là 1 giả thuyết khả bác bỏ)

| ID | Giả thuyết | Bằng chứng tĩnh | Loại |
|----|-----------|-----------------|------|
| **H1** | `WebSocketContext` gọi `setLatestMessage(event)` mỗi frame WS, và `latestMessage` nằm trong context value ⇒ mọi consumer re-render theo tần suất frame | `WebSocketContext.tsx:84`, `:170`; consumers `AppContent.tsx:55`, `ChatInterface.tsx:56`, `SessionLockContext.tsx:32`; **chỉ** `TaskMasterContext.tsx:61` thực sự đọc | 🏛️ Kiến trúc |
| **H2** | `onEditPrompt` là arrow inline ⇒ phá `React.memo` của **mọi** message row | `ChatInterface.tsx:627` → `ChatMessagesPane.tsx:300` | 🐞 Regression PR #5 |
| **H3** | `Markdown` không memo ⇒ mỗi re-render chạy lại remark+rehype+katex+Prism | `Markdown.tsx:186` (export hàm thường) | 🏛️ Kiến trúc |
| **H4** | `useEffect` **không có deps** đọc `scrollHeight`/`scrollTop` ⇒ forced sync layout mỗi render | `useChatSessionState.ts:762-766` | 🐞 Cục bộ |
| **H5** | Vòng `requestAnimationFrame` tới 60 frame (đọc `scrollHeight` + ghi `scrollTop`) khi mở session + `setTimeout(scrollToBottom, 50)` | `useChatSessionState.ts:472-503`, `:774` | 🐞 Cục bộ |
| **H6** | CSS transition toàn cục trên `div/span/p/li/td...` + `transition: all` cho `button/a/input` ⇒ style recalc storm khi chèn subtree lớn | `index.css:187-206` | 🏛️ Kiến trúc |
| **H7** | `react-syntax-highlighter` dùng bản `Prism` full (toàn bộ ngôn ngữ), không nằm trong `manualChunks` | `Markdown.tsx:6`; `vite.config.js:52-64` | 🏛️ Kiến trúc |
| **H8** | Không có windowing; `INITIAL_VISIBLE_MESSAGES = 100`. `content-visibility: auto` giảm paint nhưng **không** giảm chi phí render JS | `useChatSessionState.ts:14`; `index.css:591-595` | 🏛️ Kiến trúc |
| **H9** | Poll `runningSessions` mỗi 5s ⇒ `AppContent` re-render định kỳ ⇒ lan xuống toàn cây | `AppContent.tsx:133-139` | 🏛️ Kiến trúc |
| **H10** | Mỗi lần chuyển session bắn 4 request nối tiếp (messages, token-usage, **branches** ← mới từ PR #5, session-lock refresh) | `useChatSessionState.ts:587`, `:743`; `ChatInterface.tsx:197`, `:476` | 🐞 Cục bộ |
| **H11** | Store `notify` → `setTick` ⇒ mọi mutation re-render **toàn bộ** `ChatInterface` (không có selector granularity) | `useSessionStore.ts:437-441` | 🏛️ Kiến trúc |
| **H12** | `React.StrictMode` render đôi + bundle dev chưa minify ⇒ **khuếch đại giả** mọi con số đo trên 5173 | `main.jsx:18` | 🧪 Nhiễu đo |

**H12 là lý do bắt buộc phải đo cả prod build** — nếu không sẽ tối ưu nhầm chỗ.

---

## 2.5. Baseline đã đo (2026-07-25, DEV 5173) — và điều nó BÁC BỎ

Đo trên 2 session thật: A = 754 tin, B = 407 tin. 3 lần chạy mỗi tương tác.

| Tương tác | longTask (số) | longTask tổng | longTask max | frame > 50ms |
|---|---|---|---|---|
| Chuyển session (754 ↔ 407 tin) | 4–6 | 319–531 ms | 111–137 ms | 6–9 |
| Chuyển tab Files → Chat (**không đổi dữ liệu**) | 4–5 | 242–381 ms | 63–135 ms | 7–8 |
| Gõ 25 ký tự vào composer | **0–1** | **0–54 ms** | 54 ms | 3–5 |
| Chuyển nhánh (fixture 4 tin) | **0** | **0 ms** | 0 | 1–2 |

**Phát hiện đảo ngược giả thuyết:**

1. **Chỉ 7–14 row được render**, dù session có 407 hay 754 tin (`domNodesInPane` = 138–263). Trang mặc định fetch `limit=20` → sau grouping còn ~7–14 `ChatMessage`. ⇒ **H8 không đúng ở trạng thái mặc định**, và chi phí của H2/H3 bị giới hạn ở ~10 row chứ không phải 100.
2. **Gõ phím là tương tác MƯỢT NHẤT** (0–1 long task) — ngược hoàn toàn với dự đoán "worst case" của H2. H2 vẫn là defect thật, nhưng **tác động thực tế nhỏ** ở trạng thái mặc định.
3. **Chuyển tab Files→Chat, không hề đổi dữ liệu, vẫn tốn 242–381 ms long task** ≈ ngang với chuyển session. ⇒ jank bám vào **mount/unmount cây component**, KHÔNG bám vào kích thước danh sách tin nhắn. Đây là hướng điều tra mới, chưa có giả thuyết nào phủ.
4. **Request `/messages` mất 423 ms** (chậm nhất trong 4 request của một lần chuyển session; `token-usage` 159 ms, `branches` 13 ms, `lock-status` 29 ms). ⇒ Một phần đáng kể "cảm giác chậm khi chuyển cảnh" là **độ trễ server**, không phải render. H10 đúng về số request nhưng sai về thủ phạm — `branches` (thêm bởi PR #5) chỉ tốn 13 ms.
5. **Không phát hiện scroll thrash** (20 mẫu `scrollTop` sau chuyển session đều bằng nhau) ⇒ H5 chưa có bằng chứng. Cảnh báo: 100 ms đầu không lấy được mẫu.
6. **Không có request trùng lặp**; poll `sessions/running` đúng 5 s một nhịp (H9 xác nhận về cơ chế, chưa xác nhận về tác hại).
7. Heap không tăng đơn điệu qua ~10 lần chuyển session ⇒ chưa thấy dấu hiệu leak (mẫu nhỏ, không phải bằng chứng vắng mặt).

**Chưa đo được (khoảng trống lớn nhất):**
- **S6 — jank khi đang stream response.** Đây mới là nơi H1 (context fan-out mỗi frame WS) lộ diện. Chưa có số nào.
- **Sau khi bấm "load all messages"** (mount hàng trăm row) — nơi H2/H3/H8 mới thật sự cắn.
- **Prod build** — toàn bộ bảng trên là DEV, có StrictMode render đôi.
- **4–6 long task đó THỰC SỰ là gì.** Đo hiện tại chỉ đếm được số lượng/độ dài, không biết bên trong là parse markdown, style recalc, hay layout. **Bắt buộc cần flame chart** (Chrome DevTools MCP trace) — chưa dùng tới.

**Lỗi phương pháp cần sửa ở vòng sau:**
- `elapsedMs` đo qua MCP round-trip bị thổi phồng gấp nhiều lần → **bỏ metric này**, thay bằng đo trong trang: `PerformanceObserver` với `entryTypes: ['event']` (INP thật) hoặc mốc `performance.mark` đặt ngay trong handler.
- `frameP50/P95 = 17/18 ms` ở **mọi** lần chạy vì cửa sổ 3 s chủ yếu là idle → percentile bị pha loãng vô nghĩa. Chỉ `frameMax` và `framesOver50ms` là dùng được. Vòng sau phải cắt cửa sổ đo bám sát tương tác.
- Không có session nào vừa **lớn** vừa **có nhánh** → S4 chưa test được trường hợp thật. Cần tự tạo fixture.

**Xếp lại ưu tiên sau baseline:**

| Ưu tiên | Hướng | Lý do |
|---|---|---|
| 🔴 1 | Flame chart cho 4–6 long task ở chuyển session **và** chuyển tab | Là jank đo được, nhưng nguyên nhân còn là hộp đen |
| 🔴 2 | Đo S6 (đang stream) — H1 | Giả thuyết kiến trúc nặng nhất, chưa có dữ liệu |
| 🟠 3 | 423 ms của `/messages` (server-side) | Chiếm phần lớn độ trễ cảm nhận, hoàn toàn nằm ngoài React |
| 🟠 4 | Chi phí mount/unmount khi chuyển tab | Bằng chứng cho thấy đây mới là trục chính, chưa có giả thuyết |
| 🟡 5 | H2 + H3 (memo) | Defect thật nhưng tác động đo được nhỏ ở trạng thái mặc định; chỉ nặng sau "load all" / khi stream |
| 🟡 6 | H6 CSS transition toàn cục | Chỉ kiểm chứng được qua flame chart (Style recalc) |
| ⚪ 7 | H5, H8, H9, H10 | Baseline chưa ủng hộ; giữ lại nhưng hạ ưu tiên |

---

## 2.6. T1 — Flame chart (2026-07-25, DEV): số THẬT và các giả thuyết bị bác bỏ

Chrome DevTools MCP **attach được dưới WSL2**. Nhưng phát hiện một cạm bẫy phương pháp: **bật trace làm phồng native frame ~2,6–3×**. Mọi kết luận dưới đây lấy từ instrumentation trong trang ở chế độ **không trace**.

### Số thật (untraced)

| Kịch bản | click → frame thứ 2 | long task | DOM mutation |
|---|---|---|---|
| Chat → Files | 61.6 ms | **1 × 56 ms** | 43 (31 thêm, 5 xoá) |
| Files → Chat | 66.1 ms | **1 × 56 ms** | **13 (3 thêm, 3 xoá)** |
| Idle 13 s | — | **0** | **0** |

> ⚠️ **Đính chính baseline §2.5:** con số "4–6 long task, 319–531 ms" là do cửa sổ đo 3 s gom cả hoạt động không liên quan. Chi phí thật của một lần chuyển cảnh là **~62–66 ms với đúng MỘT long task 56 ms**, không phải 300–500 ms. Vấn đề nhỏ hơn ~5× so với baseline gợi ý — nhưng vẫn vượt ngưỡng 50 ms đã chốt.

### Tỉ trọng thời gian (từ trace, tỉ lệ dùng được dù giá trị tuyệt đối phồng)

| Thành phần | Session switch | Files → Chat |
|---|---|---|
| nativeDom | 56% | 54% |
| React core | 26% | 29% |
| validation dev-only | 8% | 8% |
| **code `/src/` của app** | **4%** | **2%** |
| GC | 3% | 4% |

Entry point cả ba trace đều là **một** `TimerFire → FunctionCall` (React work loop) ⇒ **một commit React duy nhất**, không phải nhiều đợt render chồng nhau. Phân loại T2: Scripting 145 / Style 10.7 / Layout 8.1 / Paint 0.

### Xác nhận / bác bỏ

| Giả thuyết | Kết luận | Bằng chứng |
|---|---|---|
| **Re-render lãng phí toàn cây** | ✅ **THỦ PHẠM CHÍNH (~70%)** | Long task 56 ms mà chỉ sinh **3 node thêm / 3 node xoá**. Khi chỉ đổi cờ tab, các frame `/src/` được sample gồm `SidebarProjectItem`, `SidebarSessionItem`, `SidebarProjectSessions`, `MainContentTitle`, `TokenUsageSummary`, `FileTree`, `useVoiceAvailable`, `useGitActions`, `useSlashCommands`, `useFileMentions` — **toàn bộ cây app render lại vì một boolean** |
| **H4** forced reflow | ✅ **XÁC NHẬN (~14%)** | `useEffect` không deps đọc `scrollHeight`+`scrollTop`: **3.2 ms** (Chat→Files), **9.0 ms** (Files→Chat) |
| **H12** overhead dev | ✅ Xác nhận, mức vừa (8%) | `validateProperty`, `warnUnknownProperties`, `updatedAncestorInfo`, `isCustomComponent` |
| `removeChild` 68–81 ms | ❌ **ARTIFACT của trace** | Bọc `Node.prototype.removeChild` khi không trace: **5 lời gọi, 0.2–1.3 ms** |
| **H6** CSS transition toàn cục | ❌ Bác bỏ | Benchmark 900 node: 0.7–0.9 ms (có) vs 0.6 ms (tắt) → chênh ~0.2 ms |
| **H3** markdown / **H7** Prism | ❌ Không xuất hiện — **nhưng chưa kết luận được** | Không frame `remark/micromark/rehype/katex/refractor/prism` nào. **Cảnh báo: cả 2 session test đều có `pre` = 0** ⇒ H7 chưa từng được test với code block thật |
| **H8** kích thước danh sách | ❌ Bác bỏ lần nữa | 7–11 row, 135–263 node |
| **H9** poll 5 s | ❌ **Bác bỏ** | 13 s idle: 0 long task, 0 mutation, 0 lần đọc `scrollHeight` |

### Trả lời câu "unmount hay mount hay relayout?"

**Không cái nào.** `display:none → block` **không** đắt (Layout chỉ 1.0–8.1 ms, Paint 0). Chat→Files mount FileTree: Style 19.5 ms, 31 node thêm. Files→Chat unmount FileTree: **chỉ 3 node bị xoá**. Chi phí nằm ở **React reconcile toàn cây tạo ra gần như không thay đổi DOM nào** — làm rất nhiều việc để không đổi gì.

### Ý nghĩa kiến trúc

Code ứng dụng chỉ chiếm **2–4%** thời gian ⇒ **logic không chậm; số lượng component bị render lại mới là vấn đề**. Đây đúng là vấn đề system design như user nghi ngờ, nhưng trục chính **không phải** H1/H2/H3 như phân tích tĩnh dự đoán, mà là: **state đặt quá cao trong cây + thiếu biên memo ⇒ mọi thay đổi state ở root re-render toàn app.**

### Lưu ý kỹ thuật
- Fork trích dẫn `useChatSessionState.ts:563` cho chỗ forced reflow; thực tế dòng đó là **765** (worktree) / **757** (main checkout). Nội dung phát hiện đúng, số dòng cần xác minh lại lúc sửa.
- Artifact còn lại: `perf-traces/` trong worktree, **28 MB, untracked** — phải xoá trước khi commit.

---

## 2.7. T2 — Đo lúc stream + lấp khoảng trống H7: TÌM RA VIÊN ĐẠN

Session mới `fed796ab` trong `fork-smoke` (1 run Claude thật), bắt được WebSocket instance qua React fiber để đếm chính xác frame WS.

### Biến số thật KHÔNG phải trạng thái stream — mà là số token Prism

| | INP median | INP max | proc max | long task |
|---|---|---|---|---|
| Gõ phím **khi đang stream** (1–2 code block hiển thị) | 192 ms | 208 ms | 178 ms | 87 (4,1/s) |
| Gõ phím **lúc idle** (5 block / **2026 token span**) | **496 ms** | **536 ms** | **518 ms** | 11 |

Idle *tệ hơn* stream — nghịch lý này chính là manh mối: lúc đo stream mới có ít code block, lúc idle đã render đủ 5 block.

### Bằng chứng quyết định — 1 phím, session 5 code block

- `keypress` processing **494 ms**, `input` 493 ms
- **0 mutation callback, 0 mutation record** trong `.chat-messages-pane`

⇒ React render lại toàn bộ cây tin nhắn, dựng lại ~2000 element, commit ra **đúng 0 thay đổi DOM**. 494 ms lãng phí hoàn toàn.

### CDP Profiler attribution (1 phím)

| Bucket | self ms | % chi phí active |
|---|---|---|
| `createElement @ react-syntax-highlighter.js:1337` | **424,8** | — |
| **prism/refractor (tổng)** | **442,3** | **86%** |
| react core | 44,0 | 8,5% |
| markdown/remark | 21,9 | 4,2% |
| katex | 0,2 | ~0 |
| **code `/src/` của app** | **0,0** | **0%** |

`matchGrammar` (tokenizer Prism) chỉ **4,2 ms** ⇒ **không phải tokenize, mà là dựng lại ~2000 React element mỗi render.**

### Scaling theo số code block (đối chứng cùng lần chạy)

| Tương tác | Session 0 code block (4 row) | Session 5 block / 2026 span (2 row) |
|---|---|---|
| Chuyển vào session | **0 long task** | **5 task, tổng 2.574 ms**, max 597 ms |
| Chat → Files | 0 | 1060 ms → 517 ms |
| Files → Chat | 0 | 582 ms → 515 ms |
| 1 phím | 0 | **494 ms** |
| Mutation DOM | — | 0–1 |

**2 row đắt gấp bội 4 row** ⇒ số message không liên quan; số token Prism mới là biến số. Nhất quán với T1 (session `pre`=0 chỉ tốn 56–66 ms).

### Kết luận giả thuyết

| H | Kết luận |
|---|---|
| **H7** Prism | ✅ **VIÊN ĐẠN — 86% chi phí.** Nhưng cơ chế khác hẳn giả thuyết ban đầu: không phải bundle to, mà là `createElement` dựng lại ~2000 element mỗi render |
| **H2** memo vỡ (`onEditPrompt` inline) | ✅ **CÒ SÚNG** — 0 mutation DOM chứng minh render lãng phí lan tới mọi row |
| **H3** Markdown không memo | ✅ Xác nhận — 21,9 ms/lần, nhỏ, nhưng là đường dẫn tới CodeBlock |
| **H1** WS context fan-out | ❌ **BÁC BỎ là nguyên nhân chính** — WS chỉ **~2 frame/s** (44 frame/21 s), idle sau stream = 0 long task. Fan-out là cò súng phụ, không phải viên đạn |
| **H8** kích thước danh sách | ❌ Bác bỏ lần thứ ba |

### Đối chiếu ngưỡng đã chốt

| Ngưỡng | Thực tế | Kết quả |
|---|---|---|
| INP < 200 ms | **496 ms** | ❌ vượt 2,5× |
| Long task đơn lẻ < 50 ms | **494–1060 ms** | ❌ vượt 10–21× |
| TBT < 200 ms | 18.262 ms bị block trong 21 s | ❌ |

### Chưa đo được
- "Load all messages" — nút chỉ hiện trong overlay khi cuộn lên đỉnh, chưa click được từ default view
- Session 407/754 tin của nexus-e có `pre` = 0 ở default view nên không tái hiện chi phí Prism ở đó
- Prod build; số render mỗi component (cần React Profiler)

### Mô hình nhân quả sau T1 + T2

```
state đổi ở root (tab / keystroke / WS frame)
        ↓  [thiếu biên memo — T1: ~70% chi phí là reconcile vô ích]
re-render lan tới mọi message row
        ↓  [H2 onEditPrompt inline + H3 Markdown không memo]
mỗi CodeBlock dựng lại từ đầu
        ↓  [H7 — react-syntax-highlighter createElement, 86%]
~2000 React element được tạo lại → commit ra 0 thay đổi DOM
```

Chặn ở **bất kỳ** tầng nào cũng cắt được chi phí; chặn ở tầng dưới cùng (memo hoá CodeBlock) là rẻ và an toàn nhất, chặn ở tầng trên (biên memo) mới là giải pháp kiến trúc.

---

## 2.8. T5 — Ablation: tổ hợp nhỏ nhất đạt ngưỡng

Đo trên instance riêng **5174/3002** dựng từ worktree (không đụng 5173 của user). Session `fed796ab`: **2 row / 5 code block / 2035 span**. Median 3 lần, untraced.

| Biến thể | M1 gõ phím | M2 vào session (tổng/max/task) | M3 Chat→Files | M3 Files→Chat |
|---|---|---|---|---|
| **BASELINE** | **474 ms** | **2358 / 504 / 5** | **494 ms** | **493 ms** |
| A1 (`useCallback` cho `onEditPrompt`) | **0** (−474) | 2357 / 503 / 5 | 504 (+10) | 498 (+5) |
| A1+A2 | 0 | **542 / 542 / 1** (−1816) | **0** | **0** |
| **A2 một mình** | **0** | **544 / 544 / 1** | **0** | **0** |
| A1+A2+A3 | 0 | 544 / 544 / 1 | 0 | 0 |
| A1+A2+A3+A4 | 0 | 542 / 542 / 1 | 0 | 0 |

### Kết luận ablation

- **Tổ hợp nhỏ nhất = A2 (`React.memo(Markdown)`)** — một dòng, đạt hết ngưỡng ở M1 và M3, cắt M2 từ 5 task xuống 1.
- **A1 xoá 474 ms khi chưa có A2**, nhưng 0 ms khi đã có A2 ⇒ đúng là cò súng như giả thuyết, chỉ bị A2 che phía sau. Vẫn nên giữ: nó là regression của PR #5 và là tuyến phòng thủ đúng chỗ.
- **A1 một mình KHÔNG chạm được M2/M3** — vì `renderBranchSwitcher` cũng đổi identity qua `switchBranch` → phụ thuộc `onNavigateToSession`, một **arrow inline tại `AppContent.tsx:255`**. Chuyển tab/session làm `AppContent` render lại nên row vẫn vỡ memo.
- **A4 (bỏ forced reflow): delta = 0** (542 vs 544, trong nhiễu) ⇒ **đã khôi phục nguyên trạng**, không phá logic scroll-anchor để đổi lấy nhiễu đo. H4 tuy có thật nhưng **không đáng sửa**.
- **A3 (memo `HighlightedCode`) chưa đo được lợi ích** — A2 bail sớm hơn nên CodeBlock không bao giờ render lại. Cơ chế của A3 nhắm vào **đường streaming** (mỗi delta đổi content ⇒ memo A2 trượt, nhưng `raw` của block đã hoàn tất không đổi ⇒ vẫn hit). Cần một run streaming để xác nhận.

### 541 ms còn lại của M2 là gì

Đối chứng cùng lần chạy: vào session **0 code block = 58 ms**, session **5 code block = 541 ms**. Đó là **lần dựng Prism đầu tiên**, không phải render lãng phí (chỉ còn 1 task). Tỉ lệ với khối lượng code, không tỉ lệ với số message. **Vẫn vượt ngưỡng 50 ms** → cần quyết định kiến trúc (T6 đo prod để biết độ lớn thật).

### Chẩn đoán re-render toàn cây (đã truy đủ chuỗi, CHƯA sửa)

1. `activeTab` sống ở **`useProjectsState.ts:387`** — tức ở **gốc app**, không phải trong MainContent
2. `handleSessionSelect` (`:873-897`) có **`activeTab` trong deps**, chỉ để quyết định có nhảy về tab chat
3. `sidebarSharedProps` (`useMemo`, `:1043-1084`) có `handleSessionSelect` trong deps ⇒ **đổi tab làm cả gói prop của sidebar mất identity**
4. `Sidebar`, `SidebarContent`, `SidebarProjectItem`, `SidebarSessionItem`, `MainContentTitle` — **không cái nào có `React.memo`**
5. Bonus: bên trong chính object memo đó còn 2 arrow inline `onShowSettings` / `onCloseSettings` (`:1059`, `:1062`)

Khớp chính xác với danh sách frame T1 quan sát được.

### Smoke test — đạt toàn bộ
Code block vẫn highlight (5 `<pre>`, 2035 span); đổi theme sáng↔tối màu token đổi đúng ⇒ khoá `isDarkMode` của A3 chính xác; ✏️ edit-prompt prefill đúng, message đầu vẫn ẩn ✏️; branch switcher 1/2 ↔ 2/2 đổi URL và nội dung đúng; `tsc --noEmit` sạch, eslint sạch.

### File đã sửa (uncommitted)
- `src/components/chat/view/ChatInterface.tsx` — A1: tách `handleEditPrompt` thành `useCallback([startEditSentPrompt])`, đặt **sau** `useChatComposerState` để tránh TDZ
- `src/components/chat/view/subcomponents/Markdown.tsx` — A2: `React.memo(MarkdownImpl)`; A3: tách `HighlightedCode = React.memo(...)` theo `(raw, language, isDarkMode)`

`perf-traces/` 28 MB đã xoá. Còn sót `perf-not-logged-in.png` untracked từ lần đo đầu bị chặn login.

### Cảnh báo phương pháp
M1 dùng proxy `native value setter + input event` thay phím thật (466–475 ms vs 501–513 ms khi bấm thật, lệch ~7%) — hợp lệ để so **delta**, không phải số tuyệt đối của thao tác người dùng.

---

## 2.9. T6 — PROD vs DEV: độ lớn thật

Session `fed796ab` (2 row / 5 code block / 2026 span), median 3 lần.

| Phép đo | DEV baseline | DEV + fix | PROD baseline | **PROD + fix** |
|---|---|---|---|---|
| M1 gõ 1 phím | 474 ms | 0 | **252 ms** | **3 ms** / 0 long task |
| M2 vào session code-heavy | 2358 / 5 task | 544 / 1 | **1200 / 5 task** | **275 ms / 1 task** |
| M2-đối chứng (0 code block) | — | — | **0** | **0** |
| M3 Chat→Files | 494 ms | 0 | **246 ms** | **0** |
| M3 Files→Chat | 493 ms | 0 | **248 ms** | **0** |

**Hệ số DEV→PROD đồng đều ~2×** (1,87–2,01×) — đúng bằng StrictMode render đôi, **không có yếu tố nào khác giấu trong dev**. Nghĩa là mọi kết luận đo trên dev đều chuyển sang prod theo tỉ lệ, chỉ cần chia đôi.

### Trả lời câu hỏi trung tâm

> **Ở prod sau fix, 541 ms → 275 ms. Vẫn vượt ngưỡng 50 ms 5,5 lần ⇒ CÓ, đáng làm kiến trúc cho Prism.**

Bằng chứng nó thuần tuý là Prism chứ không phải khung: **M2-đối chứng (0 code block) = 0 long task ở cả hai build**. Mật độ ≈ **0,136 ms/span**; session test mới 2026 span, một phiên coding thật dễ gấp nhiều lần.

Profiler prod: JS self-time 280 ms, **~200 ms (71%)** nằm ở vùng minified kề `useInlineStyles`/`codeTagProps`/`startingLineNumber` — nhất quán với `createElement @ react-syntax-highlighter.js:1337` mà T2 định danh trên bản chưa minify. (Prod đã mangle tên ⇒ bằng chứng mức *vùng*, danh tính chính xác dựa vào T2.)

### Bundle + cold load

| Chunk | raw | gzip |
|---|---|---|
| `index-*.js` (**chứa prism/refractor**) | 2762,98 kB | 837,59 kB |
| `vendor-codemirror` | 659,62 kB | 230,22 kB |
| `vendor-xterm` | 396,80 kB | 98,99 kB |
| `vendor-react` | 160,78 kB | 52,51 kB |
| CSS | 202,55 kB | 35,51 kB |

- 🔴 **Server prod KHÔNG bật nén.** `curl -H "Accept-Encoding: gzip"` trả `Content-Length: 2762978`, không có `Content-Encoding`. Transfer JS thực đo **3887 kB**. Bật compression middleware: 2698 → 833 kB (**−69%**) — **món lời rẻ nhất, độc lập hoàn toàn với mọi việc khác**.
- Tổng JS gzip ~1219 kB vs ngân sách **300 kB** ⇒ vượt ~4×.
- Fix gần như không thêm byte nào (2762,84 → 2762,98 kB).

| Cold load `/session/fed796ab` | LCP | FCP | TBT |
|---|---|---|---|
| PROD + fix | 992–1104 ms ✅ | 296–360 ms ✅ | **238–366 ms** ❌ |
| PROD baseline | 992 ms ✅ | 268–412 ms ✅ | **~1862 ms** ❌❌ |

Đối chiếu `.claude/rules/performance.md`: LCP ✅ · **INP ✅ với fix (3 ms)** / ❌ baseline (252 ms) · TBT ❌ cả hai · JS bundle ❌.

### Không đo được
- Cold load baseline phải khử trùng lặp bằng cách chia đôi (init script còn sót) ⇒ chỉ báo xu hướng, không phải số chuẩn
- Tên symbol prod bị mangle ⇒ quy kết Prism ở mức vùng
- Event Timing giao muộn theo lô: 2/3 lần chạy M1 baseline không kịp entry ⇒ ở đó long task là số tin được
- **Lợi ích của A3 trên đường streaming vẫn chưa đo**

---

## 2.10. T7b — Đối chuẩn ChatGPT web (cùng máy, cùng Chrome, untraced)

### Gõ phím lúc idle, cùng 5 code block — phím THẬT, không phải proxy

| | event > 16 ms | INP median | INP max | long task | mutation |
|---|---|---|---|---|---|
| **ChatGPT** (694 span) | **0** | **< 16 ms** | < 16 ms | **0** | **0** |
| **App mình, chưa fix** (2026 span) | 15 | **1.456 ms** | **2.448 ms** | 12 / tổng 5.748 ms | **0** |
| **App mình, sau A2** | — | **3 ms** | — | 0 | 0 |

> 🔴 **ĐÍNH CHÍNH LÊN:** Playwright **timeout 5 s** khi gõ 29 ký tự vào app chưa fix — gõ không kịp hết. Số thật với phím thật là **INP median 1.456 ms**, tệ hơn nhiều con số 474 ms mà T5 đo bằng proxy `native value setter`, vì event thật phải xếp hàng sau long task. **Vấn đề nghiêm trọng hơn mọi báo cáo trước đó.** Sau A2: **3 ms — ngang hoặc tốt hơn ChatGPT.**

### Hình dạng DOM: lợi thế cấu trúc của họ

| | thư viện | span/dòng code |
|---|---|---|
| ChatGPT (hội thoại lớn, 46 block) | **CodeMirror 6** | **2,83** |
| ChatGPT (chat ẩn danh, 5 block) | CodeMirror 6 | 4,66 |
| **App mình** | Prism/refractor | **10,34** |

App mình đẻ ra **nhiều hơn 2,2–3,7× span mỗi dòng**. Prism tạo span cho gần như mọi token kể cả dấu câu; CodeMirror để phần lớn text ở dạng text node trần.

### ChatGPT lúc đang stream (1 prompt, 5 block, cửa sổ 42 s)
- Long task: **5 cái, tổng 587 ms, max 214 ms** ≈ **0,12 task/giây**
- Mutation: **762 node thêm / chỉ 32 node xoá** ⇒ **append thuần**, không thay subtree, không đụng lại nội dung đã hoàn tất
- Gõ phím **trong lúc** stream: proc median 37 ms / max 154 ms

### Cuộn trang share 46 code block
DOM **không đổi** khi cuộn (13.325 node, 46 editor) ⇒ **ChatGPT KHÔNG virtualize**.
Điểm app mình **hơn họ**: message row có `content-visibility: auto` + `contain`; ChatGPT là `visible`/`none`.

### Kết luận giả thuyết: **ĐÚNG**
Độ mượt của ChatGPT đến từ **không vẽ lại nội dung đã hoàn tất** — đúng cùng đòn bẩy với A2. Nhưng họ **còn có lợi thế cấu trúc** mà A2 không mua được: ít hơn 2,2–3,7× span nhờ CodeMirror thay Prism — lợi thế này chỉ lộ ra ở chi phí **dựng lần đầu**.

### Khuyến nghị Bậc 2: **hạ ưu tiên, không bỏ**
1. Đòn bẩy chính đã lấy bằng A2: **3 ms vs ChatGPT < 16 ms** ở tương tác lặp lại.
2. 275 ms còn lại là ca **mở lại session cũ** — ChatGPT gần như không có ca này: mỗi block của họ dựng đúng một lần lúc stream ra, 587 ms được **trải mỏng trên 42 s** thay vì dồn một cục.
3. Nếu làm: **(b) HTML string** cắt 71% khối lượng, **(c) highlight async** bám mô hình "trải mỏng" của ChatGPT hơn. Số liệu cho thấy vấn đề là *cả hai*: dựng **bao nhiêu node** và dựng **lúc nào**.

### Không đo được
- **Claude.ai share**: tải được (không bị chặn) nhưng link công khai duy nhất tìm thấy không có code block nào
- **Bundle/transfer của ChatGPT**: bị chặn cross-origin (thiếu `Timing-Allow-Origin`)
- **Span/dòng ở mốc GIỮA lúc stream** ⇒ **không kết luận được** họ tô màu ngay từng chunk hay hoãn tới khi block xong
- Kết luận "append-only" dựa trên tỉ lệ 762/32 — suy luận mạnh, không phải bằng chứng trực tiếp theo từng block

---

## 11. TỔNG HỢP & MENU QUYẾT ĐỊNH (T7)

### Kết quả đã đạt được với 2 file sửa

| | PROD trước | PROD sau | |
|---|---|---|---|
| Gõ phím (INP) | 252 ms ❌ | **3 ms** ✅ | −98,8% |
| Chuyển tab | 246–248 ms ❌ | **0** ✅ | −100% |
| Vào session code-heavy | 1200 ms / 5 task ❌ | **275 ms / 1 task** ❌ | −77% |
| TBT cold load | ~1862 ms ❌ | 238–366 ms ❌ | −80% |

### Bậc 0 — Chốt ngay (đã đo, đã smoke, 2 file)
`A1` useCallback `onEditPrompt` + `A2` `React.memo(Markdown)` + `A3` memo `HighlightedCode`. Gộp PR #5.
Rủi ro: thấp. A3 chưa đo được lợi ích nhưng vô hại và nhắm đường streaming.

### Bậc 1 — Món lời rẻ nhất, độc lập scope
Bật **compression middleware** cho Express prod: transfer −69%. Ngoài phạm vi "chat view" nhưng là 1 dòng và ảnh hưởng toàn app + deploy a30.

### Bậc 2 — Prism 275 ms (cần quyết định kiến trúc)
| Phương án | Cắt được gì | Chi phí | Đánh giá |
|---|---|---|---|
| **(b) Đổi renderer → HTML string** (`Prism.highlight` + `dangerouslySetInnerHTML`, hoặc custom `renderer`) | **Thẳng 71% của 275 ms** — diệt đúng nguyên nhân dựng element | ~1 file | ⭐ Khuyến nghị |
| (a) `PrismLight` + `registerLanguage` | Bundle/TBT khi load; **KHÔNG** giảm 275 ms (số element không đổi) | ~1 file + danh sách ngôn ngữ | Bổ trợ cho (b) |
| (c) Highlight async trong `requestIdleCallback` | INP tốt nhưng có nháy plain→highlighted | vừa | Chỉ nếu (b) không đủ |
| (d) Chỉ highlight block trong viewport | Tốt cho session rất dài | cao | Để sau |

### Bậc 3 — Re-render toàn cây (kiến trúc, nay đã hạ nhiệt)
`useCallback` cho `onNavigateToSession` (`AppContent.tsx:255`) · bỏ `activeTab` khỏi deps `handleSessionSelect` (`useProjectsState.ts:873`) · `React.memo` cho `Sidebar*`/`MainContentTitle` · cân nhắc hạ `activeTab` xuống `MainContent`.

**Lưu ý trung thực:** sau A2, chi phí này đã **không còn vượt ngưỡng** ở chat view (prod ước ~28 ms). Nó là **rủi ro tiềm ẩn** — bất kỳ component đắt tiền nào thêm vào dưới cây đều thừa hưởng lại chi phí — chứ không còn là lỗi cấp bách.

### Bậc 4 — Guardrail (Q3)
Perf budget test Playwright (M1/M2/M3 với ngưỡng) · lint rule cho biên list-row · **skill `perf-profile`** đóng gói recipe đo · gotchas vào CLAUDE.md · ghi `.claude/IMPLEMENTATION_NOTES.md`.

### Bậc 5 — Bundle 4× ngân sách
Code-splitting thật (`react-syntax-highlighter`, `katex`, codemirror, xterm theo route/lazy). Workstream riêng, ngoài scope chat view.

---

## 3. Ma trận đo (Q1)

### 3.1 Ba chiều

**Build:**
- `DEV` — Vite 5173 + StrictMode (đúng thứ user đang nhìn thấy)
- `PROD` — `npm run build` + serve, không StrictMode-double-render, có minify (đúng thứ end-user nhận)

**Kịch bản:**

| ID | Kịch bản | Vì sao quan trọng |
|----|----------|-------------------|
| S1 | Chuyển session (session nhỏ, < 20 tin) | Baseline |
| S2 | Chuyển session (session lớn, 200+ tin, nhiều code block) | Trường hợp xấu của H3/H7/H8 |
| S3 | Chuyển tab Chat ↔ Files ↔ Chat | `display:none` → `block` ⇒ relayout toàn bộ DOM chat |
| S4 | Chuyển nhánh `< 1/2 >` | Đường đi mới của PR #5 |
| S5 | Gõ 25 ký tự vào composer (không gửi) | Test trực diện H2 — mỗi keystroke re-render bao nhiêu? |
| S6 | **Trong lúc đang stream response** | Trường hợp xấu nhất: H1 × H2 × H3 cộng hưởng |
| S7 | Cold load (F5) | Bundle/TBT/LCP — đối chiếu ngân sách `.claude/rules/performance.md` |

**CPU throttle:** `1x` (máy user) và `4x` (khuếch đại tín hiệu, mô phỏng máy yếu)

### 3.2 Metric mỗi lần chạy

- **Cảm nhận:** thời gian từ input → paint kế tiếp (INP-like); số frame > 50ms; frame p95/max
- **Trace breakdown:** Scripting / Style recalc / Layout / Paint / Composite (ms) — từ Chrome DevTools trace
- **React:** số commit, số render mỗi component (cần instrumentation §4.1)
- **DOM:** số node trong `.chat-messages-pane`, số `.chat-message`, số `<pre>`
- **Network:** số request + thời lượng mỗi lần chuyển session (soi request trùng lặp)
- **Bộ nhớ:** `usedJSHeapSize` trước/sau 10 lần chuyển session (soi leak)

**Quy tắc:** 5 lần chạy/ô, bỏ lần đầu (warm-up), báo **median + p95**. Không bao giờ báo 1 lần chạy.

---

## 4. Phương pháp quy nguyên nhân (Q2) — ablation có kiểm soát

### 4.1 Dựng instrumentation (bắt buộc trước khi đo)

1. **Đếm render:** thêm `react-scan` (script dev-only) **hoặc** một HOC `<Profiler>` bọc `ChatMessagesPane`/`MessageComponent` ghi `onRender` vào `window.__renderStats`. Chỉ trong nhánh đo, **không merge**.
2. **Harness prod:** build worktree → chạy instance riêng cổng `3002` (backend) / static `dist` — **tuyệt đối không đụng service systemd `cloudcli-dev` trên 5173/3001**.
3. **Dữ liệu chuẩn:** một session "béo" cố định (200+ tin, nhiều code block) trong project scratch `/home/thaint/fork-smoke` để mọi lần đo dùng chung một input.
4. **Script đo:** một file JS duy nhất (arm collectors → thao tác → thu số) dùng lại cho mọi ô của ma trận. Đây chính là hạt giống của skill `perf-profile` ở Q3.

### 4.2 Ablation: mỗi giả thuyết một nhánh riêng

Với mỗi H trong H1…H11: tạo worktree riêng, áp **đúng một** thay đổi tối thiểu, build, đo lại S2/S5/S6, ghi delta.

Kết quả là bảng quyết định:

```
| Giả thuyết | Thay đổi tối thiểu | Δ S2 (ms) | Δ S5 (ms) | Δ S6 (ms) | Rủi ro | Kích thước diff |
```

Chỉ những dòng có Δ đáng kể mới lên PR. **Không sửa cái gì chưa chứng minh được bằng số.**

### 4.3 ⚠️ Ràng buộc then chốt: KHÔNG song song hoá khâu đo

Đo hiệu năng trên cùng một máy mà chạy song song nhiều browser/agent ⇒ tranh CPU ⇒ **số liệu vô nghĩa**. Do đó:

- **Song song được:** chuẩn bị code ablation (mỗi agent một worktree, tự chạy typecheck/build), phân tích tài liệu, viết doc
- **Bắt buộc tuần tự:** mọi lần chạy trace/đo, một tiến trình tại một thời điểm, máy im lặng

Đây là lý do một Workflow "fan-out 12 agent cùng đo" sẽ **sai về mặt phương pháp**.

---

## 5. Đầu ra system design (Q2 → thiết kế)

1. **Bản đồ "ai được phép re-render ở tần suất nào"** — phân tầng: frame WS (chỉ store slot đang xem) / tương tác người dùng / định kỳ. Hiện tại tầng 1 đang chạm tới toàn cây.
2. **Tách context:** event-bus (`subscribe`, identity ổn định vĩnh viễn) tách khỏi state (`latestMessage`, `isConnected`). Consumer chỉ cần bus thì không bao giờ re-render.
3. **Invariant biên danh sách:** *mọi prop truyền xuống row của list phải ổn định tham chiếu* — kèm cách cưỡng chế bằng lint.
4. **Mô hình cập nhật streaming:** gộp frame WS theo rAF/animation-frame batching thay vì commit từng frame vào store.
5. **Chiến lược danh sách dài:** windowing thật (`react-virtuoso`/`@tanstack/virtual`) so với `content-visibility` hiện tại — quyết định dựa trên số đo S2, và phải tương thích với logic scroll-anchor (H4/H5) vốn rất nhạy.
6. **Ngân sách chi phí render** cho tree chat, viết vào `.claude/rules/performance.md`.

## 6. Guardrail (Q3)

1. **Lint:** đánh giá `eslint-plugin-react-perf` / `react/jsx-no-bind` giới hạn phạm vi `src/components/chat/view/**`. Phải đo tỉ lệ false-positive trước khi bật.
2. **Perf budget test:** script Playwright chạy S2/S5/S6, fail nếu vượt ngưỡng (ví dụ tổng long-task > X ms). Chạy tay hoặc gắn CI.
3. **Skill `perf-profile` cho project** — đóng gói toàn bộ recipe: mint JWT → dựng instance prod cổng riêng → chạy ma trận → xuất bảng. Để phiên sau đo lại trong 1 lệnh.
4. **CLAUDE.md gotchas:** ghi lại (a) bẫy context fan-out, (b) invariant prop ổn định ở list row, (c) bắt buộc đo prod build chứ không phải 5173.
5. **Ghi vào `.claude/IMPLEMENTATION_NOTES.md`** các quyết định và đánh đổi.

---

## 7. Phương án thực thi

### Option A — Tuần tự, tôi chủ trì + vài subagent *(khuyến nghị)*

```
1. Tôi: dựng harness (prod build, session béo, script đo, instrumentation)   ~30ph
2. 1 subagent sonnet: chạy ma trận DEV+PROD × S1-S7 × throttle, tuần tự      ~40ph
3. 3-4 subagent song song: chuẩn bị ablation H1,H2,H3,H6 trong worktree riêng ~20ph
4. Tôi: chạy đo ablation TUẦN TỰ, lập bảng delta                              ~40ph
5. Tôi: viết design doc + guardrail + PR                                      ~30ph
```
- **Ưu:** đúng phương pháp, chi phí thấp, tôi kiểm soát biến số
- **Nhược:** wall-clock ~2.5–3h
- **Token ước tính:** ~150–300k

### Option B — Workflow fan-out

Chỉ hợp lý ở khâu *chuẩn bị* và *tổng hợp*, khâu đo vẫn phải tuần tự trong một agent. Thực chất là Option A có thêm lớp điều phối.
- **Ưu:** nhanh hơn ~30-40% ở bước chuẩn bị ablation
- **Nhược:** chi phí token gấp 3-5 lần, rủi ro agent chạy build song song làm nhiễu chính phép đo của agent khác
- **Token ước tính:** ~600k–1M
- **Cần user opt-in tường minh**

### Option C — Chỉ vá nhanh

Sửa H2 (1 dòng `useCallback`) + H3 (`memo(Markdown)`) rồi đo lại. ~30 phút. Có thể lấy lại phần lớn độ mượt nhưng **không trả lời Q2/Q3** — vấn đề kiến trúc còn nguyên.

---

## 8. Rủi ro & cách kiểm soát

| Rủi ro | Kiểm soát |
|--------|-----------|
| Số đo trên WSL2 + Chrome software-GPU không đại diện máy user | Chỉ tin **delta tương đối** giữa các nhánh, không tin số tuyệt đối. Ghi rõ cấu hình trong báo cáo |
| Chrome DevTools MCP có thể không attach được dưới WSL2 | Fallback: Playwright + `PerformanceObserver` + CDP trace thủ công (đã chạy được ở lần đo baseline) |
| Đo trên dev build rồi kết luận sai | Ma trận bắt buộc có cột PROD |
| Đụng vào instance systemd của user | Mọi thứ chạy trên cổng 3002/5174, không bao giờ `systemctl` hay `kill` 5173/3001 |
| Kịch bản S6 cần chạy agent thật ⇒ ghi vào DB/transcript thật | Chỉ chạy trong project scratch `/home/thaint/fork-smoke` |
| Tối ưu quá đà, phá logic scroll-anchor vốn mong manh | Mỗi ablation là một thay đổi tối thiểu, có smoke test kèm |

---

## 9bis. QUYẾT ĐỊNH ĐÃ CHỐT (2026-07-25)

| # | Quyết định | Nội dung |
|---|-----------|----------|
| 1 | **Phạm vi** | Chỉ **chat view**. Sidebar / terminal / git panel nằm ngoài, trừ khi bằng chứng chỉ thẳng vào chúng |
| 2 | **Mức can thiệp** | **Chưa chốt — cần bằng chứng trước.** Đo và quy nguyên nhân xong mới trình phương án kiến trúc kèm số liệu để user quyết |
| 3 | **Thực thi** | **Tuần tự.** Mỗi task giao cho một **fork agent** (kế thừa context, tránh context overflow ở phiên chính). Một fork tại một thời điểm — kỷ luật đo bắt buộc (§4.3) |
| 4 | **PR** | Gộp fix vào **PR #5** (cùng trọng tâm chat view) |
| 5 | **Ngưỡng** | Tái dùng ngân sách sẵn có trong `.claude/rules/performance.md`: **INP < 200 ms**, **TBT < 200 ms**. Bổ sung ràng buộc riêng cho tương tác chat: **không long task đơn lẻ > 50 ms** — đây là ngưỡng mắt người cảm nhận thành "khựng", và baseline đang vi phạm (111–137 ms) |

### Sổ theo dõi task (tuần tự, mỗi dòng một fork)

| # | Task | Ưu tiên | Trạng thái |
|---|------|---------|-----------|
| T1 | Flame chart 4–6 long task: chuyển session + chuyển tab (2 chiều) | 🔴1 | ĐANG CHẠY |
| T2 | Đo S6 — jank khi đang stream response (kiểm chứng H1) | 🔴2 | chờ |
| T3 | Điều tra 423 ms của `GET /messages` (server-side) | 🟠3 | chờ |
| T4 | Bóc tách chi phí mount/unmount khi chuyển tab (nếu T1 chưa kết luận đủ) | 🟠4 | chờ |
| T5 | Đo sau "load all messages" + ablation H2/H3 | 🟡5 | chờ |
| T6 | Đối chiếu PROD build với DEV (loại nhiễu StrictMode) | — | chờ |
| T7 | Tổng hợp bằng chứng → trình phương án kiến trúc để user quyết (QĐ #2) | — | chờ |
| T8 | Triển khai fix đã duyệt vào PR #5 + guardrail (Q3) | — | chờ |

---

## 9. Câu hỏi cần user chốt trước khi chạy *(đã trả lời — xem §9bis)*

1. **Phạm vi:** chỉ chat view, hay cả sidebar/terminal/git panel?
2. **Mức can thiệp:** chấp nhận thay đổi kiến trúc (tách context, batch WS, windowing) hay chỉ muốn fix tối thiểu để hết giật?
3. **Phương án thực thi:** A (khuyến nghị) / B (workflow, tốn token) / C (vá nhanh)?
4. **Quan hệ với PR #5:** fix H2 (regression của PR #5) gộp vào PR #5 hay tách PR riêng?
5. **Ngưỡng chấp nhận:** dùng luôn ngân sách trong `.claude/rules/performance.md` (INP < 200ms, TBT < 200ms) hay đặt ngưỡng riêng cho tương tác chat?
