# JSONL là nguồn chuẩn của Session; SQLite là projection có thể dựng lại

Status: accepted

Implementation: chưa triển khai; hợp đồng và acceptance criteria ở issue #232.

Wincode cần lịch sử đọc được bằng editor, di chuyển được cùng attachments, nhưng vẫn truy vấn nhanh, pagination nhất quán và thống kê turn. Chọn log JSONL append-only cho trạng thái bền vững của mỗi Session và một SQLite database riêng làm projection. Không chọn SQLite làm nguồn chuẩn duy nhất vì tính di chuyển/inspect; không chọn JSONL + chỉ mục RAM kiểu Pi vì nhu cầu truy vấn. Chấp nhận chi phí đồng bộ, kiểm tra integrity và rebuild của hướng hybrid tương tự Codex.

## Quyết định

- JSONL chứa đủ metadata và Session Selection, Session Records, thay đổi Steering Status, compactions và Session Usage Entries để dựng lại trạng thái Session. Một checkpoint được ghi trọn trong một entry có version, identity và sequence; thay đổi được append, không sửa dòng cũ. Token deltas, Queued Submissions và runtime đang chạy không được persist thành log event.
- ACK commit chỉ được phát sau khi log và các attachment mới được tham chiếu đã sync; tạo/publish file còn phải bảo đảm độ bền directory entry. Mức bảo đảm chịu process/OS crash và mất điện giới hạn bởi filesystem/storage hỗ trợ đúng sync. Không tự hạ cấp khi sync hoặc OS locking không được hỗ trợ.
- Log đã sync là đã commit dù SQLite lỗi. Projection cập nhật rows và cursor byte-offset/sequence/hash cùng một transaction. Khi projection lỗi, Session thể hiện commit đã thành công nhưng ngừng scheduling mới cho tới khi catch-up; không trả lỗi như thể input chưa được lưu. Ghi/sync không xác định kết quả phải dừng writer, đối soát log và retry cùng operation identity/payload, không append trùng. Điều này thay hợp đồng cũ của `SessionStore` rằng mọi rejected commit đều không có durable state.
- DB projection tách khỏi DB vận hành. Rebuild không xóa prompt history, File Observations, File Transactions, path leases hoặc Unresolved Recovery. Attachment bytes được giữ riêng; liveness được quyết định từ nguồn chuẩn và các owner hợp lệ, không từ projection có thể tụt sau.
- Giữ single Session Writer và OS lock của ADR-0034, nhưng identity khóa theo canonical log-store root + Session ID thay vì inode/path của DB projection. Thay hoặc rebuild projection không được tạo writer thứ hai. Chỉ hỗ trợ local filesystem trên cùng máy; persistent lock files không bị unlink.
- Chỉ tự sửa phần đuôi chưa có newline dưới writer lock, sau khi lưu bản sao bền vững. Dòng hoàn chỉnh không hợp lệ, đứt sequence, sai integrity hoặc version không hỗ trợ chặn resume; không bỏ qua để tiếp tục. JSONL để inspect, không phải giao diện sửa tay được hỗ trợ; checksum không phải chữ ký chống tác giả cố tình làm giả log.
- Stored Session History và danh sách Session dùng cursor/keyset pagination với mốc cố định, bao gồm trạng thái và metadata tại mốc đó. Projection giữ các phiên bản cần thiết. Truy vấn mới phải catch-up hoặc báo lỗi; rebuild và deletion làm cursor liên quan hết hiệu lực rõ ràng. Session Host vẫn nạp đủ Session Context cần cho execution, không dùng một trang UI làm model context.
- Export chỉ khi idle, bao gồm log tại mốc đã sync và đủ attachments có integrity metadata. Import validate toàn bộ trước publish; cùng Session identity và nội dung là no-op, khác nội dung thì từ chối, không merge. Session import mở idle, chỉ chạy sau continue/send rõ ràng bằng workspace, credentials và quyền của máy đích. Không chuyển Plugin task database, quyền cũ, file recovery hay tự replay công việc dở.
- Session Fork là Session mới độc lập từ checkpoint có context hợp lệ, remap identity nội bộ và giữ provenance nguồn. Chỉ thực hiện khi nguồn idle; không mang queue, nghĩa vụ pending hay SDK delivery bookkeeping. Session Rewind là fork rồi chuyển sang Session mới; nguồn giữ nguyên. Không rollback workspace hoặc replay tools. Usage kế thừa tách khỏi usage phát sinh để không tính lại chi phí của nguồn.
- Delete phải kiểm tra writer và unresolved recovery, ghi quyết định xóa bền vững trước cleanup để crash/rebuild không làm Session hồi sinh. Xóa transcript và thu dọn blobs không còn tham chiếu; không hứa secure erase. Fork đã tạo vẫn tự đọc, export và resume được khi nguồn bị xóa.

## Phạm vi và hệ quả

UI và public SDK có pagination, history, statistics, fork/rewind và import/export; CLI có import/export, verify/rebuild và các thao tác Session tương ứng. RPC dùng chung application service, không có writer riêng. Không có full-text search, cây nhánh trong cùng Session, network/shared-filesystem coordination, tự resume interrupted turns, hoặc workspace rollback trong quyết định này.

Clean cutover theo quy tắc solo-dev: không thêm migration hoặc legacy fallback. Không được dùng reset projection làm lý do tự xóa dữ liệu operational recovery. Giữ nguyên ownership của Stateful Agent/Session Host và Plugin theo ADR-0035/0040; không tạo event-sourced runtime hay đổi ý nghĩa Agent Turn. Giữ các tier/precedence của Session Selection theo ADR-0054, chỉ đổi nơi lưu nguồn chuẩn.

## Tài liệu liên quan

- Implementation spec: [issue #232](https://github.com/sonwjnn/wincode/issues/232)
- [Nghiên cứu Pi/Codex/Claude](../research/session-storage-pi-codex-claude.md)
- [ADR-0024: versioned reads và recoverable edits](0024-versioned-read-and-recoverable-edit-transactions.md)
- [ADR-0034: process-owned writer locks](0034-session-hosts-use-process-owned-writer-locks.md)
- [ADR-0035: Stateful Agent và durable conversations](0035-stateful-agent-and-durable-delegated-conversations.md)
- [ADR-0040: public Session SDK và Plugin ownership](0040-public-session-sdk-and-subagents-ownership.md)
- [ADR-0054: Session Selection precedence](0054-session-selection-owns-stored-precedence.md)
