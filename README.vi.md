# codex-router

Plugin cho Claude Code: giao việc (mặc định **chỉ đọc**) cho [Codex CLI](https://github.com/openai/codex) để tốn ít quota Claude hơn, và cho biết mỗi phiên chia Claude và Codex bao nhiêu phần trăm.

[English](README.md) · Tiếng Việt

> **Trạng thái: v0.1, còn sớm.** Mới viết và thử trên một máy Windows 11, tab Code của Claude Desktop (engine Claude Code 2.1.330) và Codex CLI 0.163. Các script Node đã thử từ đầu đến cuối. Tool `codex_delegate` chưa ai ngoài tác giả dùng, và giao diện chip mới chỉ được xem bằng mắt trên đúng một máy đó. Có thể còn thô.

## Có gì trong plugin

- **Tool `codex_delegate`.** Claude gọi với một tầng độ khó (`easy`, `medium`, `hard`) và một prompt tự đủ ý. Codex trả lời, kết quả kèm một dòng số token. Luật giao việc nằm ngay trong mô tả của tool, nên bạn không cần sửa `CLAUDE.md`.
- **Chip `Claude % · Codex %`** ở chân khung nhập, cùng dòng với ô chọn model và effort. Bấm vào để mở thẻ phía trên ô nhập với bảng theo từng model (token mới, cache, số lần) và, bên phải bảng, hai dòng: tỷ lệ khi tính cả token đọc cache, và số phiên trước đã cộng vào. Dưới tiêu đề của thẻ có bốn công tắc và nút **✕** để đóng: **Codex bật / tắt** tắt Codex ở **mọi** phiên cùng lúc, **Ưu tiên Codex** bảo Claude giao Codex nhiều việc hơn, kể cả việc khó (xem bên dưới), **Tự tắt ≤20%** cho hạn mức tự tắt Codex (xem bên dưới), và **Đọc / Sửa** cho Codex sửa file trong phiên này (xem [An toàn](#an-toàn); mặc định chỉ đọc). Dưới bảng, thẻ hiện **hạn mức Codex còn lại**: một thanh cho mốc 5 giờ, một thanh cho cả tuần, kèm thời gian đến khi đặt lại. Bấm **✕** hoặc bấm lại chip để đóng thẻ.
- **Ưu tiên Codex.** Khi công tắc **Ưu tiên Codex** bật, mỗi tin bạn gửi kèm một ghi chú ẩn ngắn cho Claude (lời bạn viết không bị đổi; ghi chú chỉ kèm khi Codex đang bật): giao Codex mọi việc đọc, tìm, phân tích hay soạn nháp tách được, từ khoảng 1k token trở lên, kể cả việc khó bằng mức hard. Claude vẫn quyết định, tự sửa file (trừ khi đã bật Sửa) và kiểm lại các dòng Codex dẫn. Tốn thêm khoảng 90 token mỗi tin, và các lần giao thêm sẽ dùng hạn mức Codex nhanh hơn.
- **Tự tạm dừng, có công tắc riêng.** Khi hạn mức 5 giờ còn **từ 20% trở xuống**, công tắc **Codex** trong thẻ tự chuyển sang **tắt** và `codex_delegate` không gửi gì cho Codex, để bạn giữ lại một phần dùng riêng. Claude tự làm việc đó. Hạn mức đặt lại thì công tắc tự bật lại. Công tắc **Tự tắt ≤20%** bên cạnh quyết định việc này có xảy ra không: tắt nó đi thì Codex không bao giờ bị tắt vì hạn mức, bạn dùng được đến hết (cũng là cách ép dùng khi đang tạm dừng, ví dụ vừa đổi tài khoản Codex). Công tắc Codex do chính bạn tắt thì plugin không bao giờ tự bật lại. Đổi mức 20 bằng tuỳ chọn `reserve_percent` (0 = không canh). Số liệu lấy từ file phiên Codex tự ghi (`~/.codex/sessions`), nên mới đến mức lần chạy Codex gần nhất trên máy này, từ app Codex, CLI hay plugin.
- **Chữ mờ cạnh chip** khi Codex chưa đăng nhập (`(chưa đăng nhập)`) hoặc chưa cài (`(chưa cài Codex)`), kiểm tra mỗi phút bằng `codex login status`. Việc kiểm tra này không gửi gì cho model.
- **Lệnh `/codex-router`**, in cùng bảng chi tiết đó vào khung chat.
- **Lệnh `/codex-history`**, in lịch sử đã lưu theo ngày và theo phiên. Số liệu mỗi phiên được lưu vào `~/.claude/codex-router/history/<mã-phiên>.json`, ghi lại khi phiên chạy (tối đa 10 giây một lần). Phiên được tiếp tục hoặc chuyển sang thư mục khác chỉ tính một lần.
- **Sổ ghi cục bộ** `~/.claude/codex-router/ledger.jsonl`, mỗi lần gọi Codex một dòng JSON.

## Cách chia việc cho Codex

Không có bộ định tuyến tự động. Claude tự quyết định, dựa trên mô tả của tool:

1. **Claude đọc luật** trong mô tả `codex_delegate`. Nó được dặn **giao mặc định** mọi việc chủ yếu là đọc hoặc soạn nháp mà nó sẽ tốn hơn khoảng 3k token: khám phá hoặc tìm kiếm repo, lần theo cách một chức năng chạy, tóm tắt file, log hoặc diff dài, phân loại lỗi, review diff, so sánh phương án, soạn code hoặc test dưới dạng *chữ* để nó tự áp dụng.
2. **Nó chọn tầng** và viết prompt tự đủ ý (Codex không thấy cuộc trò chuyện).
3. **Plugin chạy lần gọi:** `node bin/codex-delegate.mjs` đổi tầng thành model và effort, chạy `codex exec --json` trong thư mục dự án, đọc số token từ luồng sự kiện, ghi một dòng vào sổ rồi trả câu trả lời cuối của Codex kèm dòng footer.
4. **Claude kiểm tra kết quả** với file thật trước khi dựa vào, và tự làm mọi việc sửa file.

| Tầng | Model mặc định | Effort | Dùng cho |
| --- | --- | --- | --- |
| `easy` | `gpt-6-luna` | low | tìm kiếm, liệt kê, tóm tắt file hoặc log dài, trích dữ liệu, soạn nháp đơn giản |
| `medium` | `gpt-6.2-astra` | medium | giải thích code nhiều file, review diff vừa, soạn nháp tính năng hoặc test |
| `hard` | `gpt-6.2-sol` | high | bug khó, phân tích kiến trúc, thuật toán phức tạp, review diff lớn |

Claude được dặn **không** giao (trừ khi bạn bật chế độ ghi): việc sửa file, câu trả lời ngắn, quyết định và kiến trúc, việc nhạy cảm về bảo mật, việc cần tool riêng của nó, và hành động khó hoàn tác (push, gửi tin, xoá, chi tiền).

Mỗi lần gọi Codex tốn cố định khoảng 20k token input, nên mô tả tool dặn Claude gom nhiều câu hỏi nhỏ vào một lần gọi. Vì Claude là bên quyết định, nó có thể giao ít hơn bạn muốn; cứ bảo nó giao nếu bạn muốn nhiều hơn.

## An toàn

- **Mặc định Codex chỉ đọc.** Script chạy `-s read-only`, và mọi prompt bắt đầu bằng một dòng dặn Codex không tạo, sửa, di chuyển hay xoá file, nếu cần thay đổi thì ghi thành patch trong câu trả lời. Đã kiểm tra bằng cách bảo Codex tạo một file: nó từ chối và thư mục vẫn trống.
- **Chỉ bạn mới cho Codex sửa được.** Công tắc trong thẻ của chip bật chế độ ghi cho đúng phiên đó: script khi đó chạy `-s workspace-write` (Codex chỉ ghi được trong thư mục dự án, không có mạng) và dặn Codex sửa nhỏ, tập trung, không xoá file, không chạy `git commit`/`push`/`reset`, và liệt kê những gì đã đổi. Công tắc được lưu thành file `~/.claude/codex-router/write-mode/<mã-phiên>.txt`, script đọc ở mỗi lần gọi. Tool không có tham số nào cho việc này nên Claude không tự bật được. Footer mỗi câu trả lời có `mode=read-only` hoặc `mode=write`; ở chế độ ghi Claude được dặn chỉ giao việc sửa nhỏ, rõ ràng, rồi chạy `git diff`, tự xem từng thay đổi và chạy test. Nên bật khi đang làm trong repo git có cây làm việc sạch, để thay đổi không ưng chỉ cần `git checkout` là lùi lại.
- **Kết quả của Codex là bản nháp chưa kiểm chứng.** Claude được dặn mở các dòng Codex trích dẫn và kiểm tra hàm, đường dẫn nó nêu có thật không trước khi dùng hoặc báo lại cho bạn.
- **Trên Windows script từ chối `" % & | < > ^` và dấu huyền** trong model, effort và thư mục, vì `codex` là shim `.cmd` cần chạy qua shell. Bản thân prompt đi qua stdin nên chứa gì cũng được.
- **Quyền riêng tư:** những gì Codex đọc sẽ rời máy bạn qua OpenAI. Đừng dùng plugin cho dự án không được phép làm vậy. Claude được dặn không đưa bí mật vào prompt.

## Yêu cầu

- **Claude Code có hỗ trợ mô-đun plugin.** Tab Code của Claude Desktop, hoặc CLI, engine từ **2.1.330 trở lên**. (Lệnh `claude` trong `PATH` có thể cũ hơn bản app Desktop đóng kèm; phiên bản của app mới là cái tính.)
- **Node.js 18 trở lên** trong `PATH`.
- **Codex CLI trong `PATH` và đã đăng nhập:**

  ```
  npm i -g @openai/codex
  codex login
  ```

- **Model mà tài khoản Codex của bạn dùng được.** Có tài khoản không dùng được hết các model CLI liệt kê; xem [Xử lý lỗi](#xử-lý-lỗi).

## Cài đặt

**Claude Desktop (app).** Bấm dấu **+** cạnh khung nhập, chọn **Plugins**, **Add marketplace**, nhập `beeknoee/codex-router`, rồi **Add plugin** và chọn `codex-router`. Mở một phiên mới.

**Terminal.** `/plugin` không chạy trong app Desktop, nên dùng shell:

```
claude plugin marketplace add beeknoee/codex-router
claude plugin install codex-router@codex-router
```

Lệnh này cài ở phạm vi user; plugin sẽ nạp ở mọi phiên bạn mở sau đó, kể cả các phiên Desktop trên cùng máy.

**Từ thư mục trên máy** (để thử trước khi đưa lên GitHub, hoặc để phát triển):

```
claude plugin marketplace add "D:\duong-dan\codex-router"
claude plugin install codex-router@codex-router
```

hoặc chỉ cho một phiên: `claude --plugin-dir "D:\duong-dan\codex-router"`.

**Repo private** chỉ cài được cho người đọc được repo trên GitHub và máy đã có sẵn thông tin đăng nhập git cho github.com (khoá SSH, hoặc `gh auth login` rồi `gh auth setup-git`).

## Cấu hình

Model và mức suy luận của từng tầng là các tuỳ chọn của plugin: `easy_model`, `easy_effort`, `medium_model`, `medium_effort`, `hard_model`, `hard_effort`. Đặt trong màn hình cài đặt của plugin, hoặc ngay lúc cài:

```
claude plugin install codex-router@codex-router --config medium_model=gpt-6-astra --config medium_effort=medium
```

Hãy dùng model mà `codex` của chính bạn chạy được. Cách kiểm nhanh: `codex exec -m <model> "hi"`.

## Cách dùng

1. Mở phiên trong dự án bất kỳ và làm việc như thường. Muốn thì bảo Claude dùng Codex (`giao việc phân loại log cho Codex`), hoặc cứ để nó tự quyết.
2. Nhìn chân khung nhập. Sau lượt đầu tiên nó hiện `Claude 94% · Codex 6%`.
3. Bấm chip để xem bảng, hoặc gõ `/codex-router` để in bảng vào khung chat.

Tỷ lệ tính trên **token mới**: input chưa cache, ghi cache và output. Token đọc cache hiện riêng, và thẻ có thêm một dòng tỷ lệ khi tính cả token đọc cache (các phiên Claude đọc cache nhiều hơn Codex rất nhiều nên hai tỷ lệ có thể lệch xa). Subagent của Claude chưa được tính.

## Xử lý lỗi

| Dấu hiệu | Nguyên nhân và cách sửa |
| --- | --- |
| Lần gọi Codex lỗi `model_not_found` ("not supported when using Codex with a ChatGPT account") | Tài khoản của bạn không dùng được model đó. Chạy lại `codex login`, hoặc đổi model của tầng trong cài đặt plugin. Model có thể khác nhau giữa các tài khoản và gói. |
| `(chưa đăng nhập)` cạnh chip | `codex login status` báo bạn chưa đăng nhập. Chạy `codex login`. |
| `(chưa cài Codex)` cạnh chip | Lệnh `codex` không có trong `PATH`. Cài nó rồi khởi động lại Claude. |
| Chân khung nhập không hiện gì | Plugin chưa được nạp. Mở phiên mới hoặc chạy `/reload-plugins`. Kiểm tra engine Claude Code từ 2.1.330 trở lên. |
| `codex_delegate` lỗi ngay | Tiến trình chạy Claude phải có Node 18+ trong `PATH`. |
| `codex_delegate` trả lời Codex đang tắt hoặc tạm dừng | Tắt: công tắc **Codex bật / tắt** trong thẻ đang ở vị trí tắt, bật lại. Tạm dừng: hạn mức 5 giờ còn từ 20% trở xuống (phần bạn giữ lại cho mình), sẽ chạy lại khi hạn mức đặt lại. Đổi mức giữ lại bằng tuỳ chọn `reserve_percent`, 0 = không bao giờ tạm dừng. |
| Chip hiện `Codex 0%` sau khi giao việc, hoặc lâu lâu tụt về 0% | Lần gọi có thể lỗi trước khi dùng token (không được đếm). Lần gọi Codex được gắn với phiên bằng id; plugin còn lần theo các id tìm thấy trong transcript (footer mỗi câu trả lời của Codex có `session=<id>`), nên tiếp tục phiên, compact (tạo phiên mới với transcript mới) hoặc chuyển sang thư mục khác vẫn giữ được số. Phía Claude cũng đọc transcript của các phiên trước đó (mỗi tin nhắn chỉ tính một lần theo id), nên hai bên cùng tính cả chuỗi và compact không làm tỷ lệ đặt lại. `/clear` bắt đầu cuộc trò chuyện mới nên số đếm lại từ đầu. |

## Hạn chế đã biết

- Chỉ mới thử trên Windows. Script chỉ dùng `shell` trên Windows và chắc sẽ chạy được nơi khác, nhưng chưa thử.
- Chữ trên chip, thẻ và ghi chú đăng nhập là tiếng Việt, chưa có bản địa hoá.
- App Desktop vẽ nút của plugin thành viên thuốc, nên chip có nền mờ mà plugin không bỏ được. Cũng không làm được popup nổi cạnh chip ở chân khung của Desktop, vì vậy thẻ mở phía trên ô nhập.
- Subagent của Claude chưa được tính.
- `codex login status` chỉ cho biết bạn đã đăng nhập hay chưa, không cho biết token hết hạn hay model có được phép. Những lỗi đó chỉ lộ ra khi một lần gọi thất bại.

## Phát triển

```
.claude-plugin/plugin.json        manifest và các tuỳ chọn tầng (userConfig)
.claude-plugin/marketplace.json   biến repo này thành một marketplace cài được
hooks/hooks.json                  khai báo mô-đun hooks
hooks/register.tsx                chip, thẻ, /codex-router, đếm token, hook của tool
hooks/delegate.ts                 mô tả, schema và dòng lệnh của tool
bin/codex-delegate.mjs            chạy một lần gọi Codex chỉ đọc và ghi sổ
bin/codex-limits.mjs              đọc hạn mức Codex 5 giờ và tuần từ file phiên của nó
bin/codex-status.mjs              báo ok | login | missing | unknown của Codex
types/index.d.ts                  khai báo kiểu cho các giá trị plugin lưu
```

Kiểm tra bằng đúng bản Claude Code bạn nhắm tới (app Desktop đóng kèm bản riêng):

```
claude plugin validate .
```

Để nạp lại khi sửa, thêm thư mục này vào `CLAUDE_CODE_PLUGIN_DIRS` (với app Desktop thì đặt trong khối `env` của `~/.claude/settings.json`), đặt `CLAUDE_CODE_PLUGIN_DIR_WATCH=1`, rồi chạy `/reload-plugins` sau mỗi thay đổi.

## Giấy phép

[MIT](LICENSE).
