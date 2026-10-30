# So sánh lưu session: Pi, Codex và Claude Code

| | |
|---|---|
| Phạm vi | Lịch sử hội thoại/session, chỉ mục SQLite, dữ liệu phụ trợ và khả năng khôi phục |
| Pi revision | [`50af8c160153e3721a18b1a046a4adf201635861`](https://github.com/earendil-works/pi/tree/50af8c160153e3721a18b1a046a4adf201635861) |
| Codex revision | [`a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd`](https://github.com/openai/codex/tree/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd) |
| Claude Code revision | [`b3f291d131924810e2b7713ededc144843a229d5`](https://github.com/anthropics/claude-code/tree/b3f291d131924810e2b7713ededc144843a229d5) |
| Status | Nghiên cứu dựa trên source code và tài liệu chính thức; không phải ADR |

## Kết luận nhanh

| Hệ thống | Nguồn chuẩn của transcript | SQLite/index | JSON và mức độ mở |
|---|---|---|---|
| **Pi coding-agent** | Một file JSONL cho mỗi session; entry nối thành cây nhờ `id`/`parentId` | Không có SQLite index bền vững cho session trong `SessionManager`; quét thư mục và dựng map trong RAM | `JSON.parse`/`JSON.stringify` và filesystem API có sẵn |
| **OpenAI Codex** | Rollout JSONL theo thread; mỗi dòng có timestamp, ordinal và event | Có SQLite thread-history riêng; materialize item/turn từ rollout, lưu cursor byte/ordinal để cập nhật tăng dần | Rust `serde_json` cho JSONL; `sqlx`/SQLite cho projection |
| **Anthropic Claude Code** | Transcript JSONL theo project/session; các output lớn và file snapshot được để riêng | Tài liệu công khai mô tả file/sidecar và adapter lưu trữ ngoài; không đủ căn cứ để khẳng định nội bộ không dùng SQLite | Tài liệu nói transcript JSONL nhưng định dạng là nội bộ, có thể thay đổi; không công bố thư viện serializer của CLI |

**Nếu mục tiêu Wincode là JSONL làm nguồn chuẩn nhưng vẫn giữ SQLite cho truy vấn lịch sử**, Codex là ví dụ sát nhất: rollout JSONL bền vững, cộng SQLite projection có thể cập nhật theo cursor và commit dữ liệu/cursor trong cùng transaction. Pi là mô hình đơn giản hơn: JSONL cộng quét filesystem và chỉ mục RAM. Claude chứng minh cách tổ chức transcript và dữ liệu phụ trợ thành các file/sidecar, nhưng tài liệu không cung cấp hợp đồng nội bộ ổn định để sao chép trực tiếp. ([Pi session format](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/coding-agent/docs/session-format.md), [Codex rollout recorder](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/rollout/src/recorder.rs), [Codex materialization](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/thread-store/src/local/thread_history_materialization.rs), [Claude session docs](https://code.claude.com/docs/en/sessions))

## Pi: JSONL thuần cho coding-agent session

Pi ghi session thành các JSON object theo từng dòng. Header chứa session ID, format version, timestamp và working directory; các entry hội thoại liên kết bằng `id` và `parentId`. Vì vậy lịch sử logic là một cây: rẽ nhánh nối thêm entry mới từ node cũ, không sửa hoặc nhân bản toàn bộ transcript. Các loại entry gồm message, compaction, branch summary, usage, custom data, label và thay đổi model/thinking level. ([tài liệu định dạng session](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/coding-agent/docs/session-format.md))

`SessionManager` giữ entry trong RAM, tạo file ở lần persist đầu tiên rồi nối thêm JSONL về sau. Khi mở session, nó nạp các dòng và dựng các map `byId`, label, cùng leaf hiện tại. Việc tìm session gần nhất/finder dùng scan thư mục và file header; session manager chuẩn không duy trì SQLite index cho lịch sử. ([implementation `SessionManager`](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/coding-agent/src/core/session-manager.ts))

Đường ghi/đọc của session manager dùng filesystem API và JSON tích hợp, không phải thư viện JSONL riêng. Parser bỏ qua dòng sai định dạng, còn header version được dùng để migrate format cũ. Hành vi bỏ qua dòng lỗi là lựa chọn của Pi, không phải đảm bảo chung rằng dòng hỏng luôn an toàn để bỏ. ([session manager](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/coding-agent/src/core/session-manager.ts), [package manifest](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/coding-agent/package.json))

**Phạm vi cần phân biệt:** repository Pi có package riêng `@earendil-works/pi-durable` với backend JSONL và `SqliteStorage`; điều đó không có nghĩa coding-agent `SessionManager` dùng SQLite cho session. ([package durable](https://github.com/earendil-works/pi/tree/50af8c160153e3721a18b1a046a4adf201635861/packages/durable), [backend SQLite riêng](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/durable/src/storage/sqlite/index.ts), [backend JSONL riêng](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/durable/src/storage/jsonl/index.ts))

## Codex: rollout JSONL cộng SQLite projection

### Rollout JSONL là log bền vững

Codex ghi rollout file trong `$CODEX_HOME/sessions` (mặc định `~/.codex/sessions`); App Server docs mô tả thread log là JSONL và thao tác archive sẽ chuyển log sang thư mục archived sessions. Tên file thường có dạng `rollout-<timestamp>-<thread_id>.jsonl`; thao tác revert có thể tạo file rollout mới trong khi giữ thread ID. ([Codex troubleshooting: vị trí transcript](https://developers.openai.com/codex/app/troubleshooting), [App Server: archive thread](https://developers.openai.com/codex/app-server), [tạo rollout và tên file](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/rollout/src/recorder.rs))

Mỗi dòng rollout mang timestamp, ordinal và một `RolloutItem`. Recorder serialize bằng `serde_json`, thêm newline rồi ghi/flush. Writer nền đệm các item trong hàng đợi; nếu I/O lỗi, giữ phần chưa ghi và thử lại ở barrier tiếp theo. Đây là một thiết kế mạnh hơn kiểu “gọi append file ở từng nơi”: session có một writer sở hữu hàng đợi và ranh giới flush. ([recorder](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/rollout/src/recorder.rs))

### SQLite lưu projection có thể cập nhật lại

Codex có database riêng `thread_history_1.sqlite`. Migration tạo bảng `thread_turns` và `thread_items`; `thread_items.item_json` chứa payload JSON của từng item, còn `thread_turns` lưu trạng thái turn, ordinal, thời điểm và ID của user/final-agent item. Các migration tiếp theo bổ sung item type, realtime items và các trường vòng đời. Đây không chỉ là index vài cột: SQLite chứa một projection có cấu trúc của lịch sử thread. ([SQLite DB configuration](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/state/src/sqlite.rs), [migration tạo bảng](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/state/thread_history_migrations/0001_thread_history.sql), [migration realtime items](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/state/thread_history_migrations/0005_thread_realtime_items.sql))

Projection được đọc tăng dần từ rollout theo byte offset và ordinal đã lưu. Codex commit các row projection cùng với cursor mới trong một SQLite transaction; nếu ghi DB lỗi, cursor không vượt trước JSONL đã materialize. Projection state có thể xóa và dựng lại từ rollout. ([code materialize rollout](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/thread-store/src/local/thread_history_materialization.rs), [transaction áp dụng projection/cursor](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/thread-store/src/local/thread_history.rs))

Codex còn có các SQLite DB chuyên biệt khác như `state_5.sqlite`, `logs_2.sqlite`, `goals_1.sqlite`, `memories_1.sqlite` và `queue_1.sqlite`; không nên gộp chúng thành một “session DB” duy nhất khi so sánh. Tài liệu config cũng có thiết lập `CODEX_SQLITE_HOME` cho SQLite-backed state. ([SQLite filenames/config](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/state/src/sqlite.rs), [biến môi trường Codex](https://developers.openai.com/codex/environment-variables))

Tài liệu Codex còn mô tả `history.persistence` và `history.max_bytes` cho `history.jsonl` dưới `CODEX_HOME`. Đây là một mục history file được cấu hình riêng; không nên nhầm tên đó với rollout JSONL theo thread trong `sessions/`. ([Advanced Configuration: history persistence](https://developers.openai.com/codex/config-advanced))

### Điểm kiến trúc nổi bật

Codex tách hai mục đích:

1. **Rollout JSONL:** log bền vững, có thứ tự, để replay/inspect và làm nguồn cho việc dựng lịch sử.
2. **SQLite thread-history:** projection truy vấn nhanh, pagination/read model và trạng thái turn; cursor lưu vị trí đã materialize trong rollout.

Mẫu này cho phép SQLite có thể rebuild mà không biến nó thành nguồn dữ liệu thứ hai độc lập. Tính nhất quán nằm ở hợp đồng “projection row + offset commit cùng transaction”. ([recorder](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/rollout/src/recorder.rs), [thread history projection](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/thread-store/src/local/thread_history.rs))

## Claude Code: transcript JSONL và thư mục sidecar

Tài liệu Anthropic nói CLI lưu transcript liên tục thành JSONL dưới `~/.claude/projects/<project>/<session-id>.jsonl`. `<project>` được tạo từ đường dẫn working directory; transcript chứa message, tool call/result và metadata/request data. Có thể tiếp tục session bằng `--continue`/`--resume`, hoặc truyền đường dẫn transcript. ([Manage sessions](https://code.claude.com/docs/en/sessions), [Explore the `.claude` directory](https://code.claude.com/docs/en/claude-directory))

Claude tách các dữ liệu lớn hoặc phụ trợ khỏi transcript: subagent transcript, tool-result lớn, MCP task state và pre-edit file snapshots nằm ở các file/thư mục riêng. File-history phục vụ checkpoint restore; retention sweep quản lý transcript và sidecar. ([cấu trúc `.claude` và cleanup](https://code.claude.com/docs/en/claude-directory))

Anthropic cảnh báo định dạng transcript là nội bộ và có thể thay đổi giữa các version; `/export`, hooks hoặc Agent SDK là ranh giới được tài liệu hóa tốt hơn cho consumer. Agent SDK mặc định dùng JSONL trên filesystem, nhưng có `SessionStore` adapter với `append`/`load` bắt buộc và các API tùy chọn như `listSessions`, `delete`, `listSubkeys`; adapter có thể mirror transcript sang object store, key-value store hoặc database để resume trên host khác. ([sessions: access/export](https://code.claude.com/docs/en/sessions), [SDK session storage](https://code.claude.com/docs/en/agent-sdk/session-storage))

Tài liệu chính thức đã khảo sát không mô tả một SQLite index cho transcript của CLI. Tuy nhiên, điều đó **không đủ để khẳng định toàn bộ runtime đóng của Claude Code không dùng SQLite ở nơi khác**; tài liệu xác nhận được là JSONL transcript cùng file sidecar, còn chi tiết serializer/index nội bộ không công khai trong các nguồn này. ([tài liệu session](https://code.claude.com/docs/en/sessions), [SDK session storage](https://code.claude.com/docs/en/agent-sdk/session-storage))

## So sánh hàm ý cho Wincode

### Chọn theo mục tiêu

- **Muốn ít thành phần và lịch sử dễ mở bằng editor:** Pi là mẫu đơn giản. JSONL là nguồn chuẩn; session list quét file, chỉ mục chi tiết sống trong RAM. Đổi lại, nhiều session và truy vấn toàn cục có thể cần scan/rebuild.
- **Muốn JSONL nhưng vẫn cần truy vấn nhanh, pagination và thống kê turn:** Codex là mẫu phù hợp nhất. Giữ log file làm nguồn chuẩn, dùng SQLite làm projection có cursor; ghi dữ liệu projection và cursor trong cùng transaction, và có đường dựng lại.
- **Muốn các transcript và artifact dễ di chuyển giữa host:** Claude cho thấy cách tách transcript, tool outputs, subagent data và file snapshots; SDK thêm adapter lưu trữ ngoài. Nhưng không nên phụ thuộc trực tiếp vào format transcript nội bộ nếu không chấp nhận thay đổi giữa phiên bản.

### Hướng khuyến nghị cho Wincode

Nếu mục tiêu vẫn là JSONL làm nguồn chuẩn mà không bỏ SQLite cho phần truy vấn/vận hành, nên bắt đầu theo mẫu Codex:

1. Một rollout JSONL cho mỗi Session; mỗi event có type, format version, ID, sequence/ordinal và timestamp.
2. Giữ SQLite projection có thể tái tạo, gồm metadata cần cho list/search/pagination và cursor byte-offset/sequence cuối đã xử lý.
3. Cập nhật projection và cursor trong cùng transaction. Nếu SQLite lỗi, để projection tụt sau log; tuyệt đối không ghi cursor vượt dữ liệu đã lưu.
4. Duy trì một writer duy nhất mỗi Session và cơ chế retry/flush có hàng đợi. Xác định rõ cách phát hiện/khôi phục dòng cuối bị ghi dở.
5. Giữ attachment bytes, file snapshots và recovery artifacts trong blob/filesystem/SQLite theo hợp đồng riêng; transcript chỉ giữ tham chiếu.
6. Runtime-validate JSONL theo discriminated schema/version; không mặc định bỏ qua dòng sai như Pi nếu điều đó có thể làm mất checkpoint.

Khác biệt quan trọng: Pi không phải bằng chứng rằng “nên giữ SQLite cho index” — Pi core không có persistent SQLite index session. Codex mới là bằng chứng cụ thể cho hybrid JSONL + SQLite projection. Với schema Wincode hiện tại, chỉ chuyển transcript/checkpoint trước; các bảng giao dịch sửa file, lease, attachment metadata và recovery không tự nhiên trở thành transcript event. ([Codex materialization transaction](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/thread-store/src/local/thread_history.rs), [Wincode schema](../../packages/coding-agent/modules/sessions/storage/schema.ts), [Wincode `SessionStore`](../../packages/coding-agent/modules/sessions/storage/session-store.ts))

## Nguồn chính

### Pi

- [Session File Format](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/coding-agent/docs/session-format.md)
- [SessionManager](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/coding-agent/src/core/session-manager.ts)
- [Coding-agent package manifest](https://github.com/earendil-works/pi/blob/50af8c160153e3721a18b1a046a4adf201635861/packages/coding-agent/package.json)
- [Separate `pi-durable` package](https://github.com/earendil-works/pi/tree/50af8c160153e3721a18b1a046a4adf201635861/packages/durable)

### OpenAI Codex

- [Rollout recorder](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/rollout/src/recorder.rs)
- [Rollout JSONL listing](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/rollout/src/list.rs)
- [SQLite configuration](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/state/src/sqlite.rs)
- [Thread-history schema](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/state/thread_history_migrations/0001_thread_history.sql)
- [Thread-history materialization](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/thread-store/src/local/thread_history_materialization.rs)
- [Thread-history projection writes](https://github.com/openai/codex/blob/a9e474c8fc7874cdb13b03ef8ffec0bead7c4fbd/codex-rs/thread-store/src/local/thread_history.rs)
- [Codex App Server docs](https://developers.openai.com/codex/app-server)
- [Codex advanced configuration](https://developers.openai.com/codex/config-advanced)
- [Codex environment variables](https://developers.openai.com/codex/environment-variables)

### Anthropic Claude Code

- [Manage sessions](https://code.claude.com/docs/en/sessions)
- [Explore the `.claude` directory](https://code.claude.com/docs/en/claude-directory)
- [Agent SDK session storage](https://code.claude.com/docs/en/agent-sdk/session-storage)
- [Agent SDK sessions](https://code.claude.com/docs/en/agent-sdk/sessions)
