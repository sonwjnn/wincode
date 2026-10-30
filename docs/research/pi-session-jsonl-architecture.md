# Lưu session bằng JSONL trong Pi và hàm ý cho Wincode

| | |
|---|---|
| Nguồn Pi | Repository [`earendil-works/pi`](https://github.com/earendil-works/pi) được duy trì chính thức |
| Phiên bản Pi | [`908aa7b74baa7502321293797313f64c6fec22ee`](https://github.com/earendil-works/pi/tree/908aa7b74baa7502321293797313f64c6fec22ee) |
| Phạm vi | Cách coding-agent lưu session, các thư viện JSON/JSONL, so sánh với SQLite hiện tại của Wincode và hướng kiến trúc đề xuất |
| Trạng thái | Ghi chú nghiên cứu; chưa phải quyết định kiến trúc được chấp thuận |

## Tóm tắt

Lịch sử session của coding-agent trong Pi được lưu thành một file JSONL cho mỗi session. Mỗi dòng là một đối tượng JSON có kiểu; các liên kết `id`/`parentId` tạo thành cây, nên có thể rẽ nhánh mà không phải viết lại lịch sử cũ. Session manager tự triển khai bằng API filesystem của Node và `JSON.parse`/`JSON.stringify` có sẵn; nó không dùng thư viện JSONL chuyên dụng để đọc hoặc ghi session. Pi cũng có package riêng `@earendil-works/pi-durable` với backend lưu trữ JSONL, nhưng package coding-agent không phụ thuộc vào package đó và `SessionManager` không dùng nó cho session hội thoại. ([định dạng session](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/docs/session-format.md), [session manager](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts), [các dependency của coding-agent](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/package.json), [backend JSONL riêng](https://github.com/earendil-works/pi/tree/908aa7b74baa7502321293797313f64c6fec22ee/packages/durable/src/storage/jsonl))

Với Wincode, hướng phù hợp nhất là dùng JSONL làm nguồn dữ liệu chuẩn cho **lịch sử hội thoại/sự kiện**, chứ không thay toàn bộ các bảng SQLite. Hiện Wincode dùng chung SQLite cho bản ghi session và trạng thái vận hành như metadata attachment, file observation, lease, giao dịch sửa file và recovery artifact. Các dữ liệu ngoài transcript này có ràng buộc quan hệ và cập nhật giao dịch, không tự nhiên phù hợp với một log hội thoại chỉ nối thêm. ([schema Wincode](../../packages/coding-agent/modules/sessions/storage/schema.ts), [khởi tạo database](../../packages/coding-agent/modules/sessions/storage/client.ts))

## Kiến trúc session của Pi

### File và mô hình entry

Tài liệu Pi mô tả mỗi file session JSONL là một đối tượng JSON trên mỗi dòng. Header `session` định danh session, phiên bản định dạng, thời điểm tạo và thư mục làm việc. Các dòng tiếp theo là entry có kiểu, gồm message, mốc compaction, branch summary, usage, dữ liệu tùy chỉnh, label, thay đổi model và thay đổi thinking level. Thư mục session mặc định nằm dưới `~/.pi/agent/sessions/`, được chia theo thư mục làm việc đã mã hóa. ([định dạng và vị trí file session](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/docs/session-format.md), [tạo thư mục session mặc định và header](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts))

Luồng dữ liệu chỉ nối thêm, nhưng lịch sử logic là một cây: mỗi entry có ID và parent ID, còn manager theo dõi một leaf hiện tại. Rẽ nhánh từ entry cũ sẽ nối thêm một entry con tại đó; các entry thuộc nhánh trước vẫn nằm trong file. Bộ dựng context lần theo đường từ root đến leaf được chọn và diễn giải các entry compaction/branch summary, thay vì coi mọi dòng trong file là message gửi cho model. Định dạng cũng cho phép có nhiều root trong các trường hợp reset hoặc điều hướng. ([ngữ nghĩa cây](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/docs/session-format.md), [code nối nhánh và dựng context](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts))

### Ghi và nạp dữ liệu

`SessionManager` giữ các entry trong bộ nhớ. Lần flush bền vững đầu tiên sẽ tạo file session theo chế độ độc quyền rồi ghi từng entry đã serialize, mỗi entry kết thúc bằng newline; các entry sau được serialize và nối vào file. Pi dùng `openSync`/`writeFileSync`/`appendFileSync`/`closeSync`, không dùng thư viện JSONL bên ngoài. Khi nạp, manager tách file thành các dòng, gọi `JSON.parse` cho từng dòng không rỗng và bỏ qua dòng sai định dạng. Manager cũng migrate các phiên bản session cũ dựa trên header. ([code ghi file, parser và migration của session manager](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts))

Bỏ qua dòng sai định dạng là hành vi phục hồi Pi chủ động chọn, không có nghĩa mọi entry bị ghi dở hoặc sai ngữ nghĩa đều an toàn để bỏ qua. Wincode cần quyết định rõ: cách ly dòng lỗi, coi đó là phần đuôi có thể phục hồi, hay từ chối mở session. Sao chép nguyên hành vi parser của Pi có thể che giấu một checkpoint bị mất. Định dạng Pi có version, nên cơ chế version/migration là một phần của hợp đồng file, không chỉ là chi tiết parser. ([hành vi nạp và code migration](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts), [version trong header](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/docs/session-format.md))

### Pi core có giữ chỉ mục SQLite không?

Với session coding-agent tiêu chuẩn, `SessionManager` được khảo sát không duy trì chỉ mục phụ trong SQLite. Việc tìm session gần nhất liệt kê các file `.jsonl` trong thư mục session, sắp xếp theo thời gian sửa đổi của filesystem rồi kiểm tra header; việc tìm một session cụ thể cũng quét thư mục. Khi file được nạp, `_buildIndex()` dựng lại các map trong bộ nhớ cho entry và label, cùng leaf hiện tại. Tóm lại, Pi core dùng quét filesystem để tìm session và giữ chỉ mục trong RAM khi session đang mở — không có chỉ mục SQLite bền vững. Đây là mô tả riêng về Pi; giữ SQLite làm chỉ mục có thể dựng lại vẫn là một lựa chọn cho Wincode, không phải kiến trúc của Pi. ([code tìm session gần nhất và dựng chỉ mục](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts))

Repository có package `@earendil-works/pi-durable` riêng, tức một hệ thống lưu trữ khác; backend JSONL của package đó không phải chỉ mục được `SessionManager` của coding-agent sử dụng. ([package durable](https://github.com/earendil-works/pi/tree/908aa7b74baa7502321293797313f64c6fec22ee/packages/durable), [dependency của coding-agent](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/package.json))

### Pi dùng thư viện JSON nào?

Với lịch sử session của coding-agent, Pi dùng JSON gốc và I/O filesystem: `JSON.parse(line)` khi nạp, `JSON.stringify(entry) + "\n"` khi ghi. Manifest của coding-agent không khai báo parser/writer JSONL hay thư viện parser JSON. ([implementation](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts), [package manifest](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/package.json))

Pi có package riêng `@earendil-works/pi-durable`, trong đó có backend `storage/jsonl`. Đây là runtime lưu trữ hội thoại/task/tài liệu riêng, không được liệt kê trong dependency của `@earendil-works/pi-coding-agent`; không nên kết luận rằng `SessionManager` hiện có của coding-agent được xây trên backend đó. ([manifest của durable](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/durable/package.json), [implementation lưu trữ JSONL](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/durable/src/storage/jsonl/storage.ts), [manifest của coding-agent](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/package.json))

## Wincode hiện tại

Wincode đã có ranh giới `SessionStore`, nhưng implementation cụ thể đang dùng SQLite/Drizzle. `createDatabase()` mở database Bun `bun:sqlite` và cấu hình WAL, foreign key cùng busy timeout; `createDrizzleSessionStore()` hiện thực hợp đồng store. Đây là seam hữu ích để bổ sung store hội thoại khác, nhưng không có nghĩa persistence hiện tại đã dựa trên file. ([hợp đồng `SessionStore`](../../packages/coding-agent/modules/sessions/storage/session-store.ts), [SQLite client](../../packages/coding-agent/modules/sessions/storage/client.ts), [`createDrizzleSessionStore`](../../packages/coding-agent/modules/sessions/storage/drizzle-session-store.ts))

Dữ liệu transcript/checkpoint hiện tại có cấu trúc phong phú hơn một bảng chat-message đơn giản:

- `session_record` lưu các checkpoint `SessionRecord` theo thứ tự, gồm record ID, turn/agent/model, outcome, mảng message dạng JSON, version và position trong session. Bộ kiểm tra yêu cầu mỗi record chứa đúng một durable message. ([schema](../../packages/coding-agent/modules/sessions/storage/schema.ts), [kiểm tra record](../../packages/coding-agent/modules/sessions/storage/session-record.ts))
- Checkpoint compaction và entry chỉ chứa usage nằm ở các bảng riêng. Metadata session và workspace cũng được lưu riêng. JSON trong các trường như `messages_json`, `outcome_json` và `summary_json` là JSON serialize **bên trong SQLite**, không phải JSONL. ([schema](../../packages/coding-agent/modules/sessions/storage/schema.ts))
- `commitSessionRecord` kiểm tra record, insert nó và cập nhật metadata thời điểm message gần nhất/model của session trong cùng một SQLite transaction. Cập nhật trạng thái submission sửa user record đã lưu trong một transaction. Nếu thay bằng file log, cần biểu diễn transition bằng event rõ ràng và định nghĩa hợp đồng commit/recovery. ([commit record](../../packages/coding-agent/modules/sessions/storage/drizzle-session-store.ts))
- Cùng schema đó còn quản lý attachment, workspace, file snapshot/observation, file lease, giao dịch sửa nhiều file và recovery artifact. Đây không chỉ là các dòng hội thoại và mặc định không nên chuyển chúng vào transcript log. ([schema](../../packages/coding-agent/modules/sessions/storage/schema.ts), [ADR-0024](../adr/0024-versioned-read-and-recoverable-edit-transactions.md))

Package Wincode dùng `drizzle-orm` cho SQLite, `zod` để kiểm tra dữ liệu và `jsonc-parser` cho cấu hình JSONC; không thư viện nào trong số đó là writer session JSONL. ([dependencies của coding-agent](../../packages/coding-agent/package.json), [kiểm tra Session Record](../../packages/coding-agent/modules/sessions/storage/session-record.ts))

## Hướng đề xuất cho Wincode

### Xác định rõ ranh giới

Coi file JSONL là lịch sử event có thứ tự và là nguồn dữ liệu chuẩn cho một Session. Giữ SQLite cho dữ liệu chủ yếu phục vụ truy vấn quan hệ, chỉ mục toàn workspace/nhiều session hoặc điều phối transaction. Nếu mục tiêu sản phẩm thực sự là “không dùng SQLite cho lịch sử session”, SQLite chỉ nên là **projection/chỉ mục có thể dựng lại** (hoặc bỏ projection nếu chấp nhận quét file); tránh để cả file lẫn database cùng tuyên bố là nguồn transcript chuẩn.

Interface `SessionStore` hiện tại là điểm khởi đầu, nhưng nó gộp thao tác transcript với metadata, attachment, usage, compaction, trạng thái editing và maintenance. Nên tách port theo trách nhiệm trước khi thêm JSONL implementation — ví dụ `SessionLogStore` cho event bền vững có thứ tự, và store riêng cho metadata/vận hành. Đây là đề xuất thiết kế cho Wincode, không phải mô tả API công khai của Pi. ([hợp đồng store hiện tại](../../packages/coding-agent/modules/sessions/storage/session-store.ts), [schema hiện tại](../../packages/coding-agent/modules/sessions/storage/schema.ts))

### Hình dạng event gợi ý

Dùng một file cho mỗi Session, mỗi dòng là một record có version và parse độc lập. Mô hình dòng của Wincode có thể bắt đầu như sau:

```jsonl
{"type":"session","formatVersion":1,"sessionId":"...","workspaceId":"...","createdAt":"...","cwd":"..."}
{"type":"record","sequence":1,"recordId":"...","record":{}}
{"type":"submission_status","sequence":2,"recordId":"...","submissionId":"...","status":"processing"}
{"type":"compaction","sequence":3,"compactionId":"...","compaction":{}}
{"type":"usage","sequence":4,"usageEntryId":"...","usage":{}}
```

Tên các trường chỉ mang tính minh họa. Các đặc tính quan trọng là discriminator (`type`), version định dạng/schema tường minh, ID ổn định cho event và Session, sequence xác định thứ tự, và payload đủ để dựng lại trạng thái bền vững. Thay đổi trạng thái hiện đang sửa record đã lưu nên trở thành event chuyển trạng thái mới; sửa một dòng JSONL cũ sẽ phá vỡ mô hình chỉ nối thêm. Không nhúng byte attachment lớn vào log; hãy lưu tham chiếu đến blob store hiện có. ([cấu trúc record và attachment của Wincode](../../packages/coding-agent/modules/sessions/storage/schema.ts), [cách cập nhật submission](../../packages/coding-agent/modules/sessions/storage/drizzle-session-store.ts), [các entry có kiểu của Pi](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/docs/session-format.md))

### Giữ các hợp đồng đúng đắn hiện tại

1. **Một writer cho mỗi Session.** Giữ invariant Session Writer lock hiện tại của Wincode; bản thân file JSONL không ngăn các process ghi đồng thời. ([ADR-0034](../adr/0034-session-hosts-use-process-owned-writer-locks.md))
2. **Commit record và projection nhất quán.** Hiện insert record và cập nhật metadata session được atomic trong một DB transaction. Với file, hoặc đặt mọi thông tin cần thiết cho checkpoint vào một dòng rồi suy ra metadata từ log, hoặc ghi event đi kèm theo thứ tự rõ ràng và có quy tắc recovery. Không giả định hai lần ghi riêng biệt là atomic. ([transaction hiện tại](../../packages/coding-agent/modules/sessions/storage/drizzle-session-store.ts))
3. **Kiểm tra dữ liệu khi đọc.** Wincode hiện kiểm tra record có version trước khi commit. Hãy tiếp tục runtime validation cho JSON đã parse, định nghĩa cách xử lý version chưa biết, và kiểm thử dòng cuối bị cắt, dòng giữa bị sai định dạng, ID/sequence trùng và replay sau restart. Việc Pi “bỏ qua dòng lỗi” là một lựa chọn có chủ đích, không phải thư viện kiểm tra schema. ([validator record](../../packages/coding-agent/modules/sessions/storage/session-record.ts), [parser của Pi](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts))
4. **Giữ các đường đọc dẫn xuất ở chi phí hợp lý.** Sắp xếp danh sách session, chọn model gần đây và phân trang transcript hiện là các truy vấn tự nhiên của database/chỉ mục. Nếu chuyển thành quét file, hãy đo chi phí startup và lịch sử; nếu không, giữ một index có thể dựng lại với ID, timestamp, title, workspace và offset, còn JSONL vẫn là nguồn dữ liệu chuẩn. ([API đọc của store](../../packages/coding-agent/modules/sessions/storage/session-store.ts), [index session và record](../../packages/coding-agent/modules/sessions/storage/schema.ts))
5. **Tách dữ liệu bền vững ngoài hội thoại.** Attachment, lease/giao dịch sửa file, snapshot và unresolved recovery không phải lịch sử hội thoại. Giữ chúng trong relational/blob storage hiện tại trừ khi có yêu cầu riêng để thiết kế lại. ([schema](../../packages/coding-agent/modules/sessions/storage/schema.ts), [ADR-0024](../adr/0024-versioned-read-and-recoverable-edit-transactions.md))

### Đánh đổi

JSONL giúp lịch sử bền vững dễ xem, dễ export và tự nhiên phù hợp với ghi nối thêm; Pi cho thấy có thể biểu diễn nhánh và compaction thành event có kiểu. SQLite hiện cung cấp cho Wincode truy vấn có index, uniqueness/foreign key và cập nhật transaction giữa Session Record với metadata. Chuyển transcript sang JSONL đồng nghĩa phải đặt các đảm bảo đó vào quyền sở hữu writer, định danh/thứ tự event, validation, replay, phục hồi phần đuôi bị ghi dở và khả năng dựng lại index. Giá trị chính có thể là quyền sở hữu đơn giản hơn và lịch sử dễ đọc/di chuyển — không phải tự động giảm mọi độ phức tạp persistence.

## Nguồn

### Nguồn chính từ Pi

- [Định dạng file session](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/docs/session-format.md)
- [Implementation `SessionManager`](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/src/core/session-manager.ts)
- [Package manifest của coding-agent](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/coding-agent/package.json)
- [Package manifest của durable riêng](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/durable/package.json)
- [Backend JSONL của durable riêng](https://github.com/earendil-works/pi/blob/908aa7b74baa7502321293797313f64c6fec22ee/packages/durable/src/storage/jsonl/storage.ts)

### Nguồn trong Wincode

- [`SessionStore`](../../packages/coding-agent/modules/sessions/storage/session-store.ts)
- [SQLite schema](../../packages/coding-agent/modules/sessions/storage/schema.ts)
- [SQLite client](../../packages/coding-agent/modules/sessions/storage/client.ts)
- [Implementation Drizzle SessionStore](../../packages/coding-agent/modules/sessions/storage/drizzle-session-store.ts)
- [Kiểm tra Session Record](../../packages/coding-agent/modules/sessions/storage/session-record.ts)
- [ADR-0024: transaction sửa file có thể phục hồi](../adr/0024-versioned-read-and-recoverable-edit-transactions.md)
- [ADR-0034: Session Writer lock do process sở hữu](../adr/0034-session-hosts-use-process-owned-writer-locks.md)
