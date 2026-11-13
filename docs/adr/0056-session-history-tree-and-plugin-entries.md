# Session chứa cây lịch sử và Plugin được mở rộng lịch sử bằng custom entries

Status: accepted

Implementation: chưa triển khai. Plugin Session State hiện tại vẫn theo log tuyến tính và Session Fork hiện có cho tới khi thực hiện quyết định này.

Người dùng cần tiếp tục nhiều hướng hội thoại trong cùng một Session; Plugin cần ghi lịch sử nghiệp vụ riêng, không chỉ thay snapshot theo key. Chọn cây lịch sử với đường đang được chọn, đặt trên JSONL append-only và Session Writer hiện có để giữ các bảo đảm durability và recovery. Plugin custom entries và Plugin Session State dùng chung lịch sử, không tạo thêm một nguồn chuẩn.

ADR này thay phần không hỗ trợ cây nhánh trong cùng Session của ADR-0055 và mở rộng ngoại lệ conversation-state của ADR-0040. Các bảo đảm về durable commit, recovery, ownership và không replay side effects của hai ADR đó vẫn giữ nguyên.

## Cây lịch sử và các thao tác

Một Session có nhiều đường lịch sử dùng chung tổ tiên. Session Entry là nút lịch sử có identity và parent; Active Leaf là vị trí đang được chọn; Selected Path là đường tổ tiên từ gốc đến Active Leaf. Một entry chỉ có một parent; không hỗ trợ merge nhánh hoặc nhiều parent.

```text
A → B → C → D
        └→ E → F  ← Active Leaf
```

Ở F, Session Context và Plugin state được dựng từ A–B–C–E–F, không từ D dù D được ghi trước F trong file.

- Navigation chọn một entry hoặc vị trí gốc trong cùng Session; không sửa hoặc xóa nhánh cũ. Append lịch sử tiếp theo tạo con của vị trí được chọn. Chọn một ancestor rồi append chính là tạo nhánh mới; chưa cần Branch ID hay branch registry độc lập.
- Session Fork vẫn tạo Session mới độc lập từ Selected Path tới checkpoint được chọn. Remap identity nội bộ có kiểu, giữ provenance và không phụ thuộc nguồn sau khi nguồn bị xóa.
- Session Rewind giữ nghĩa hiện có: Fork rồi chuyển sang Session mới. Navigation trong cùng cây là thao tác khác, không âm thầm đổi nghĩa Rewind.
- Navigation, tạo nhánh và Fork không rollback workspace, replay Tool Calls hoặc khôi phục quyền vận hành của task lịch sử.

## Nguồn chuẩn và phạm vi dữ liệu

JSONL vẫn là log vật lý tuyến tính với sequence, version, operation identity và hash chain. Các entry thuộc cây có Entry ID và Parent Entry ID riêng; parent phải tồn tại trước đó trong cùng Session hoặc là gốc. Sequence quyết định thứ tự commit và integrity, parent quyết định quan hệ hội thoại. Không dùng sequence prefix làm thay thế cho Selected Path.

Active Leaf phải được ghi bền vững. Append entry lịch sử phải commit cả entry và việc chọn nó làm leaf trong cùng một durable operation; Navigation không append nội dung vẫn phải commit lựa chọn leaf. Reopen, projection rebuild và import không suy leaf từ entry cuối file. Single writer, OS lock, idempotent retry và committed-but-projection-blocked/indeterminate outcomes của ADR-0055 áp dụng cho cả hai thao tác.

Không biến mọi log event thành nút hội thoại:

- Theo Selected Path: messages, Plugin custom entries, Plugin Session State, compaction, context edits và các lựa chọn Agent/Model/ThinkingLevel ảnh hưởng execution. Giữ precedence của ADR-0054 nhưng không lấy lựa chọn từ nhánh anh em.
- Theo Session: title, metadata quản lý chung, quyết định deletion và lựa chọn Active Leaf. Các control events này không được lẫn vào model context hoặc Plugin event replay.
- Theo vận hành: writer locks, runtime, queue, task ownership, report acknowledgement, credentials và recovery của workspace. Chúng không được phục hồi, nhân đôi hay chuyển owner bằng Navigation/Fork.

SQLite vẫn là projection có thể dựng lại. Transcript mặc định hiển thị messages trên Selected Path; tree reader cung cấp cấu trúc toàn cây riêng. Session Context, Plugin state, Steering Message status, compaction và context edits phải được chiếu theo đúng đường. Context edit chỉ được target message trên đường tổ tiên hợp lệ; compaction của nhánh này không làm mất context của nhánh anh em. Read cursors phải gắn với snapshot và phạm vi path/tree rõ ràng; không trộn dữ liệu sau Navigation hoặc rebuild.

## Plugin custom entries và snapshot state

Plugin nhận capability append custom entry và đọc lịch sử theo Selected Path; đọc toàn cây là phạm vi riêng, được yêu cầu rõ ràng. Readers có pagination và mốc nhất quán. Host bind writer theo Plugin Identifier, Session và vị trí lịch sử hợp lệ; Plugin không tự chọn namespace của Plugin khác hoặc ghi vào Session bất kỳ bằng ID.

Custom entry chứa loại nghiệp vụ và strict-JSON payload có giới hạn, ví dụ `item-added` hoặc `item-completed`. Host sở hữu envelope, ordering, validation tài nguyên, durability và operation identity; Plugin sở hữu ý nghĩa payload, phiên bản nghiệp vụ và cách reduce lịch sử. Custom entries không tự trở thành Session Context hoặc model messages. Gửi nội dung cho model phải đi qua message/context contract riêng.

`sessionState.read/set/delete` tiếp tục là interface tiện dụng cho snapshot theo key, dùng chung writer và cây lịch sử với custom entries. Giá trị hiện tại là replace/delete cuối cùng trên Selected Path; delete không được làm key sống lại sau rebuild. Giữ schema-version mismatch protection hiện có. Custom entries không bị ép thành snapshot và Plugin không bắt buộc dùng snapshot nếu cần tự reduce events.

Giữ entries khi Plugin vắng mặt, disabled hoặc không đọc được schema; không load code chỉ vì dữ liệu lịch sử nhắc tới Plugin. Không tự migrate, xóa hoặc ghi đè opaque payload. Payload dùng Plugin-local IDs; chưa hứa remap core identities nằm trong JSON tùy ý hoặc vận chuyển file/blob riêng của Plugin.

Sequential Tools giữ nguyên nghĩa batch scheduling; không biến thành CAS, multi-key transaction hay khóa mọi Plugin writer. Các cập nhật state riêng vẫn là commit riêng: không ngầm gộp state ghi sau một assistant record vào checkpoint của record đó. Cây có thể chọn chính state entry để bao gồm nó; checkpoint theo Record vẫn dừng đúng tại Record đã chọn.

## Navigation và khôi phục runtime

Navigation là Session Command qua Session Host và public SDK, không phải thao tác riêng của UI hoặc raw storage writer. Chỉ nhận khi Host idle, không compacting, không có queued Submission hoặc input đã commit còn chờ xử lý. Admission và commit được serialize với các command và delivery khác; không để input đã nhận bị chuyển ngầm sang nhánh khác.

1. Validate target và chuẩn bị thay đổi; lifecycle hook trước Navigation có thể từ chối trước commit.
2. Commit Active Leaf mới, dựng lại context và các projection theo đường mới.
3. Thông báo lifecycle sau Navigation để Plugin reset/restore RAM và UI từ lịch sử đã commit.
4. Chỉ nhận execution mới khi restore hoàn tất. Restore không thực thi lại action lịch sử.

Nếu lỗi trước commit thì giữ leaf cũ. Nếu leaf đã commit nhưng projection hoặc Plugin restore thất bại, leaf mới vẫn là nguồn chuẩn; báo trạng thái blocked và không chạy với RAM/context cũ. Recovery phải khôi phục lại từ leaf đã commit. Hook sau Navigation không được giả vờ hủy durable commit.

Capability ghi giữ từ trước Navigation phải bị vô hiệu hóa, kể cả chuyển đi rồi quay lại cùng Entry ID; một callback cũ không được ghi vào nhánh đang chọn mới. SDK, RPC, Plugin và Interactive Mode dùng cùng admission, lifecycle và recovery contract.

## Portability, usage và deletion

- Export Session mang toàn cây, Active Leaf chính xác và attachment closure của toàn cây. Snapshot export phải nhất quán dưới writer authority.
- Export branch mang Selected Path, re-chain và validate log đích, giữ leaf xác định và chỉ mang attachment closure cần thiết. Phải định nghĩa rõ identity của artifact khi tách branch; không trình bày một phần cây như bản sao full Session cùng identity. Import vẫn không merge các log khác nhau dùng chung Session identity.
- Import validate graph, leaf, references, integrity và resource bounds trước publish; imported Session idle và không tự chạy Plugin hoặc Tool. Thiếu Plugin không cản round-trip opaque entries.
- Fork độc lập từ đường được chọn, không copy mọi entry có sequence nhỏ hơn checkpoint. References có kiểu được remap; reference ẩn trong opaque JSON không được coi là đã remap.
- Usage toàn Session tính mỗi execution thực tế một lần, kể cả ở nhánh không active; usage của Selected Path là projection riêng. Navigation không xóa hay nhân đôi chi phí. Fork tiếp tục phân biệt usage kế thừa với usage phát sinh.
- Attachment GC xét toàn bộ cây được giữ, không chỉ Selected Path. Xóa source không làm Fork mất dữ liệu. Không thêm branch pruning trong quyết định này.

## Lựa chọn loại bỏ và hệ quả

Chỉ thêm custom entries vào log tuyến tính không đủ: nó không cho người dùng giữ và quay lại các hướng hội thoại trong một Session. Dùng Session Fork để giả lập tree cũng không đủ vì mỗi nhánh thành identity và lifecycle riêng. Thay storage bằng cây chỉ lưu trong RAM và ghi file không có durable commit sẽ bỏ các bảo đảm writer, sync và rebuild mà Wincode đã chọn. Ngược lại, thêm generic Plugin database, tự replay tasks hoặc merge nhánh là phạm vi không cần thiết.

Đổi lại, mọi history projection phải hiểu Selected Path; chỉ đổi codec hoặc thêm tree UI là implementation chưa hoàn chỉnh. Thứ tự triển khai: history graph và durable leaf qua SDK; Plugin entries và restore lifecycle; Interactive tree navigation; toàn bộ portability contracts. Không công bố hỗ trợ đầy đủ trước khi context/state/recovery/export cùng tuân theo cây.

Đây là thay đổi format theo clean cutover, không thêm migration hoặc legacy fallback. Format/version và interface cụ thể được chốt khi triển khai; phiên bản không hỗ trợ phải fail closed. Không xóa operational recovery để vượt lỗi schema, và không mô tả quyết định accepted này như tính năng đã có.

## Acceptance contracts

- Hai nhánh không rò messages, selection, Plugin state, context edits hoặc compaction sang nhau.
- Reopen/rebuild giữ đúng Active Leaf, kể cả Navigation không có append sau đó; crash không tách entry mới khỏi việc chọn leaf của nó.
- Restore lỗi sau commit chặn execution; stale callback/capability không ghi được sau Navigation.
- Navigation bị từ chối khi input còn pending và không đổi đích của delivery đã nhận.
- Restore, Navigation và import không replay Tool Calls, chuyển task ownership hoặc kế thừa credentials.
- Retry cùng operation identity/payload không nhân đôi entry hay Navigation; lỗi projection không bị báo như commit chưa xảy ra.
- Whole-tree và branch export/import giữ đúng phạm vi, leaf và attachments, kể cả khi Plugin không được cài.
- Fork độc lập sau source deletion; state ghi sau checkpoint không bị kéo ngược vào đường được kế thừa.
- Usage không mất hoặc nhân đôi khi đổi nhánh; attachment của nhánh không active không bị GC.

## Tài liệu liên quan

- [ADR-0055: JSONL authority và SQLite projection](0055-session-jsonl-authority-and-rebuildable-sqlite-projection.md)
- [ADR-0040: Session SDK và Plugin ownership](0040-public-session-sdk-and-subagents-ownership.md)
- [ADR-0054: Session Selection precedence](0054-session-selection-owns-stored-precedence.md)
- [Nghiên cứu Session-scoped Plugin entries, gồm cập nhật V1/V2](../research/session-scoped-plugin-entries.md)
