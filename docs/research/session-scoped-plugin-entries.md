# Session-scoped Plugin entries: Wincode và Pi

Trạng thái: nghiên cứu lịch sử, kèm cập nhật implementation. **Tài liệu này không phải ADR**; các quyết định đã chấp thuận nằm ở ADR-0040 và ADR-0055. Các phần 2–7 mô tả baseline trước V1 và đề xuất tại thời điểm khảo sát, không phải toàn bộ API hiện tại.

Wincode được khảo sát tại `aa13156bde5a6d2e1220cb3e2e9b7ccb89bcb26b`. Pi được đối chiếu với upstream `main` tại [`e5d9ff915c3b21719803e2f610a304ebac0a9642`](https://github.com/earendil-works/pi/commit/e5d9ff915c3b21719803e2f610a304ebac0a9642). Các đề xuất lịch sử bên dưới phải được đọc cùng cập nhật V1/V2 ở phần 8.

## 1. Câu hỏi thực sự

“State Plugin theo được export/import/fork” không nên có nghĩa là copy mọi dữ liệu của Plugin. Cần phân biệt:

- **Trạng thái diễn giải hội thoại**: kế hoạch đang chọn, checklist, nhãn và quyết định đã ghi nhận.
- **Trạng thái vận hành**: task đang chạy, child runtime, inbox delivery, retry, khóa, kết nối, credentials và quyền đã cấp.

Chuyển lịch sử hội thoại không đồng nghĩa chuyển quyền tiếp tục công việc bên ngoài. Một checklist được khôi phục không được tự biến thành lệnh chạy lại task.

Ví dụ: session cha có checklist “đã phân tích A”, đồng thời có child task đang sửa file. Fork có thể cần checklist tại checkpoint; nó không được trở thành owner thứ hai của child task đó.

## 2. Wincode tại baseline trước V1

### Nguồn chuẩn và ranh giới Plugin

JSONL là nguồn chuẩn cho session; SQLite là projection có thể dựng lại. Envelope có identity, operation ID, sequence, version và hash chain. Danh sách event được đóng: header/created/metadata, record/context/submission, compaction/usage, activation/fork/deletion; chưa có `plugin.*` hay custom entry. Payload được validate theo loại event. Không thể chỉ chèn một dòng tùy ý vào file rồi kỳ vọng resume/import hiểu nó.

Nguồn: [ADR-0055](../adr/0055-session-jsonl-authority-and-rebuildable-sqlite-projection.md), [codec: event types và envelope](../../packages/coding-agent/modules/sessions/storage/session-jsonl-codec.ts#L23-L55), [schema envelope](../../packages/coding-agent/modules/sessions/storage/session-jsonl-codec.ts#L173-L186).

Plugin nhận Session ID, workspace và public Session SDK operations; hiện không có API append/read durable Plugin entries. `onSessionStart` là lifecycle hook của **runtime được nạp**, không phải cam kết “chỉ gọi một lần khi session được tạo”. Khi runtime unload/reopen, hook chạy lại.

Nguồn: [Plugin context và hooks](../../packages/coding-agent/modules/plugins/public.ts#L158-L182), [Session SDK operations](../../packages/coding-agent/modules/sessions/sdk-contract.ts#L269-L282), [Plugin lifecycle](../../packages/coding-agent/modules/plugins/README.md#L133-L137).

Plugin hiện tự sở hữu durable data; `userDataDir` là root dùng chung, Plugin tự namespace và bảo vệ dữ liệu. Subagents là ví dụ cụ thể: task store dùng SQLite riêng theo workspace, lưu parent/child Session ID, turn/tool-call identity, trạng thái và report bookkeeping.

Nguồn: [Plugin persistence](../../packages/coding-agent/modules/plugins/README.md#L23-L25), [Subagents store](../../packages/subagents/src/plugin/store.ts#L20-L72).

### Export/import

Bundle chứa manifest, session JSONL và attachment closure, không phải bản sao toàn bộ user-data directory hay Plugin database. Export được admission khi idle và lấy snapshot dưới writer authority. Import giữ Session identity, validate trước publish, cùng identity/nội dung là no-op, nội dung khác là conflict; session nhập cần explicit activation để tiếp tục.

Nguồn: [bundle manifest](../../packages/coding-agent/modules/sessions/storage/session-bundle.ts#L155-L180), [export admission](../../packages/coding-agent/modules/sessions/session-bundle-export.ts#L223-L245), [ADR-0055: export/import](../adr/0055-session-jsonl-authority-and-rebuildable-sqlite-projection.md), [import contract tests](../../packages/coding-agent/test/sessions/session-bundle-import.test.ts).

Hệ quả: transcript có thể chứa kết quả một Plugin tool đã trả về, nhưng đó không phải bản sao authoritative state trong Plugin database. Mang được câu “task X đã tạo” không có nghĩa máy nhận quản lý được task X.

### Fork/rewind

Fork lấy `sourcePrefixEntries` với `sequence <= checkpointEntry.sequence`, tạo Session/log mới, remap record/message/turn/compaction identities và ghi provenance. Nó dựng lại các loại event được hỗ trợ, không copy mọi dòng từ source. Usage kế thừa được phân biệt với usage mới. Rewind là fork rồi đổi session, không rollback workspace.

Nguồn: [prefix tại checkpoint](../../packages/coding-agent/modules/sessions/storage/session-jsonl-store.ts#L7210-L7230), [identity/provenance](../../packages/coding-agent/modules/sessions/storage/session-jsonl-store.ts#L7264-L7380), [dựng log target](../../packages/coding-agent/modules/sessions/storage/session-jsonl-store.ts#L7381-L7513), [ADR-0055](../adr/0055-session-jsonl-authority-and-rebuildable-sqlite-projection.md).

**Chỉ thêm event vào codec là chưa đủ:** nếu không bổ sung fork copier, state có thể survive export/import nhưng biến mất khi fork.

## 2a. Pi hiện tại: đã có cơ chế, không có policy chung cho mọi state

### Hai loại entry khác nhau

- `pi.appendEntry(customType, data)` ghi `type: "custom"`: dữ liệu extension, **không đưa vào LLM context**. Entry có ID/parent ID/timestamp; API extension trả `void`, không trả entry ID.
- `pi.sendMessage({ customType, content, display, details })` tạo `custom_message`: content tham gia model context. `display: false` chỉ ẩn khỏi TUI, không loại content khỏi context. Không nên dùng message để cất state chỉ vì nó đã được persist.

Nguồn: [ExtensionAPI.appendEntry](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/extensions/types.ts#L1790-L1797), [entry types](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-manager.ts#L117-L169), [context projection](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-manager.ts#L437-L461).

Pi chưa flush file nếu chưa có user/assistant message. Một custom entry ghi trước hội thoại có thể chỉ nằm trong RAM cho đến khi có message. Vì vậy không nên suy từ tên `appendEntry` rằng nó có cùng durable ACK contract với Wincode.

Nguồn: [Pi _hasConversation / _persist](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-manager.ts#L1162-L1194).

### State thuộc đường nhánh, không phải toàn file

Pi lưu cây bằng `id`/`parentId`:

- `getBranch()` trả đường root → leaf được chọn, gồm custom entries trên đường đó.
- `getEntries()` trả mọi entry, gồm các nhánh không active.
- `createBranchedSession(leafId)` tạo session mới từ đường được chọn; custom entries ngoài đường không được copy.

Đọc “custom entry cuối cùng trong `getEntries()`” có thể làm state từ nhánh khác rò sang nhánh hiện tại. Pattern đúng cho branch-scoped state là reduce `getBranch()`, reset RAM về mặc định trước khi reduce, rồi khôi phục trên `session_start` và sau tree navigation (`session_tree`). Example `tools.ts` minh họa restore theo branch trên cả hai hook.

Nguồn: [getBranch](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-manager.ts#L1478-L1492), [getEntries](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-manager.ts#L1524-L1533), [createBranchedSession](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-manager.ts#L1640-L1763), [tools example restore](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/examples/extensions/tools.ts#L24-L58), [restore hooks](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/examples/extensions/tools.ts#L136-L147).

**Tên thao tác cần phân biệt:** runtime `/fork` mặc định `before` user message được chọn, tức leaf là parent của message đó; `at` mới gồm entry được chọn. CLI `--fork` dùng `SessionManager.forkFrom()` để tạo header mới và copy toàn bộ non-header entries/tree, không phải chỉ một đường. Không có một quy tắc “Pi fork luôn copy X” dùng chung cho cả hai.

Nguồn: [runtime fork](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/agent-session-runtime.ts#L262-L343), [forkFrom](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-manager.ts#L1821-L1880).

### Export/import không đồng nghĩa copy nguyên source tree

`/export file.jsonl` serialize **current branch**, gồm custom entries trên đường đó và re-chain parent IDs. `/import` nhận JSONL; HTML không trực tiếp import được. HTML export nhúng full tree + leaf để xem, không cùng representation với JSONL branch export.

Một boundary khác: nút “Download session JSON” trong HTML serialize tất cả embedded entries nhưng không encode leaf đang chọn. Khi nạp lại, manager chọn entry cuối; vì vậy có thể mở nhánh khác với nhánh đang xem trong HTML. Muốn round-trip branch xác định thì dùng JSONL branch export.

Nguồn: [serializeSessionBranch](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-export.ts#L9-L28), [JSONL import](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/agent-session-runtime.ts#L359-L397), [HTML export](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/export-html/index.ts#L238-L274), [HTML download](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/export-html/template.js#L1180-L1202), [load leaf](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/src/core/session-manager.ts#L1104-L1115).

### So sánh trực tiếp

| Khía cạnh | Wincode trước V1 | Pi tại SHA khảo sát |
|---|---|---|
| Plugin/extension-only state entry | Chưa có | `custom` qua `appendEntry` |
| Model context | Session context projection riêng; chưa có Plugin-state lane | `custom` không vào context; `custom_message` có |
| Cấu trúc lịch sử | Log tuyến tính mỗi Session; fork tạo log mới, remap identities | Cây trong file; branch chọn đường; `/fork` tạo session từ đường |
| Export portable | Bundle log + attachments có integrity metadata | JSONL export của current branch; HTML là representation khác |
| Khôi phục state | Plugin tự quản store và lifecycle | Extension tự reduce entries và restore theo lifecycle/tree |
| State tại fork | Chưa có policy Plugin; core copy event có chọn lọc đến cut | Custom entries trên selected path; không tự copy latest global state |
| Schema của state | Chưa có contract | Payload tùy extension; core không định nghĩa migration cho schema extension |

Pi cung cấp **cơ chế lưu/di chuyển entry**, không định nghĩa “mọi state của extension đều nên được kế thừa”. Payload semantics, phiên bản và side effects vẫn thuộc extension. Wincode có thể học cách tách state khỏi model messages, nhưng phải bổ sung policy phù hợp checkpoint/durability và ownership hiện có; không cần sao chép cây nhánh của Pi.

## 3. Quy tắc kế thừa đề xuất

Đây là lựa chọn thiết kế cho Wincode, không phải hành vi đã có.

| Loại dữ liệu | Export/import | Fork tại checkpoint |
|---|---|---|
| Checklist, plan, nhãn, quyết định hội thoại | Giữ trong log | Khôi phục đúng trạng thái tại cut |
| Kết quả task đã hoàn tất, muốn giữ như ghi chú | Giữ như dữ liệu lịch sử | Giữ nếu thuộc prefix; không còn quyền điều khiển task |
| Tham chiếu tới issue/service bên ngoài | Giữ như reference | Có thể giữ; không tự fetch hay execute |
| Task đang chạy, timer, retry, queue, report acknowledgement | Không đưa vào portable Plugin state | Không kế thừa ownership/nghĩa vụ pending |
| Credentials, trust, tool approvals | Không đưa vào portable Plugin state | Không kế thừa |
| Connection, AbortSignal, process resource, cache | Không serialize | Tạo lại khi cần |
| Record/message/turn IDs bên trong payload | Giữ identity của imported session | Chỉ hỗ trợ khi có reference schema và remap rõ ràng |
| Path máy cũ hoặc file Plugin tự quản | Không coi là portable asset | Không hứa tồn tại trên máy/session mới |

“Không đưa vào portable state” không có nghĩa xóa một chuỗi tình cờ xuất hiện trong transcript. Plugin không được ghi secrets vào entry ngay từ đầu; export toàn log không tự biết trường nào là bí mật.

### Chính sách tối thiểu

Đề xuất v1 chỉ nhận một loại dữ liệu: **portable, declarative, checkpoint-scoped state**. Tất cả entry loại này có cùng policy: export/import giữ nguyên; fork lấy prefix. Dữ liệu vận hành tiếp tục ở Plugin-owned store. Chưa cần framework cho mỗi field chọn `copy/reset/rebind/transform`.

Một payload minh họa, chưa phải API:

```json
{
  "pluginId": "planner",
  "key": "plan",
  "schemaVersion": 1,
  "value": {
    "items": [{ "id": "A", "status": "done" }]
  }
}
```

Host sở hữu namespace, thứ tự, durability, idempotency và giới hạn kích thước. Plugin sở hữu ý nghĩa `value` và schema của nó. Plugin ID để route dữ liệu, **không phải chứng thực tác giả hay quyền thực thi**. Không expose raw filesystem append hoặc tùy chọn tự khai `pluginId` để ghi dưới tên Plugin khác.

Snapshot theo key là điểm khởi đầu đơn giản: đọc latest value của từng key trong prefix; append snapshot mới để thay đổi. Cần tombstone rõ ràng khi xóa key để replay không làm state cũ sống lại. Không dùng shallow merge mặc định vì xóa field và lồng object sẽ mơ hồ.

## 4. Hai boundary dễ sai

### 4.1 State được ghi sau checkpoint

```text
seq 40: assistant record R — checkpoint được chọn
seq 41: Plugin ghi plan = "done"
seq 42: user mới
```

Theo cut hiện tại, fork tại R chỉ có `seq <= 40`: state ở 41 không được kế thừa, dù người dùng có thể coi nó là kết quả của cùng turn.

Cần chọn một trong hai hợp đồng và ghi rõ:

1. **Cut theo thứ tự log**: chỉ state đã commit trước/đúng cut được kế thừa. Đơn giản nhất; Plugin phải chấp nhận boundary này.
2. **State đi cùng checkpoint**: host commit record và Plugin state như một checkpoint atomic, hoặc có checkpoint-group protocol hoàn chỉnh. Cần thiết nếu UI hứa fork sau turn sẽ luôn có state cuối turn.

Chỉ thêm `anchorRecordId: R` vào event 41 không làm nó atomic với R và không tự giải quyết crash giữa hai lần ghi. Không được âm thầm copy “latest state hiện tại” vào fork quá khứ: như vậy lịch sử cũ bị trộn với tương lai.

### 4.2 Identity bên trong opaque JSON

Fork remap Session Records, nhưng host không biết một chuỗi trong `value` là message ID hay chỉ là text. Copy nguyên payload có thể để state trỏ tới record của source, khiến fork không độc lập sau source deletion.

V1 nên cấm reference nội bộ có ngữ nghĩa cần resolve trong opaque state; dùng Plugin-local IDs. Nếu có nhu cầu thật, thêm reference field có kiểu và host remap theo cùng identity map. Reference ra source có thể tồn tại như provenance chỉ đọc, không được giả làm target identity. Custom arbitrary fork-transform hooks là độ phức tạp tùy chọn, chưa cần mặc định.

## 5. Khôi phục không phải replay side effects

- Khi reopen/reload, Plugin đọc trạng thái đã commit rồi dựng lại RAM/UI; không gọi lại tool hay khởi động lại task từ entry lịch sử.
- Khi Plugin vắng mặt hoặc bị disable, host vẫn giữ và round-trip entry mà không load code chỉ vì log nhắc đến Plugin đó.
- Khi `schemaVersion` của Plugin chưa được hỗ trợ, không âm thầm reset/overwrite. Giữ opaque entry và báo phần tính năng không đọc được; core envelope/version không hỗ trợ vẫn phải theo quy tắc fail-closed của log.
- Destination phải enable Plugin bằng trust/config hiện tại. Không dùng absolute source path trên máy cũ làm bằng chứng tin cậy cho máy mới.
- Compaction không được xóa state cần để resume. State không mặc nhiên là model context; muốn model thấy thì cần projection/context policy riêng.
- Không dùng `onSessionShutdown` làm nơi lưu duy nhất: crash không đảm bảo cleanup hook chạy. ACK của thao tác thay đổi state phải dựa trên durable commit.

## 6. Tác động kiến trúc và implementation seams

Đây không phải chỉ thêm một discriminator:

1. **Public Plugin boundary**: scoped state reader/writer; host xác định owner; API không cho ghi bất kỳ session nào chỉ bằng ID.
2. **Host/store writer**: serialize cùng Session Writer, operation identity, sync và xử lý committed-but-projection-blocked/indeterminate như event core.
3. **Codec/reference validation**: typed envelope, payload/version/size limit, tombstone; không nới core decoder để bỏ qua loại event lạ.
4. **Read projection/rebuild**: nguồn chuẩn là JSONL; latest-per-key có thể dựng lại. Chưa cần table nếu đọc prefix đủ rẻ; chỉ thêm index khi có nhu cầu/đo đạc.
5. **Fork copier**: copy đúng prefix, xử lý reference có kiểu nếu hỗ trợ; không cần load Plugin để fork.
6. **Bundle/attachments**: event trong log đi theo bundle sau khi codec hỗ trợ, nhưng file Plugin bên ngoài không tự đi theo. V1 chỉ dùng JSON nhỏ; nếu thêm blob references phải nối vào closure validation, liveness, GC và source-deletion contract.
7. **Lifecycle**: restore hoàn tất trước khi turn/tool dùng state; không biến import/fork thành execution trigger.

ADR-0040 hiện nói host không cung cấp generic Plugin storage service; README cũng để Plugin tự quản durable data. Nếu triển khai, cần ghi nhận đây là **ngoại lệ hẹp cho dữ liệu hội thoại portable**, không phải thay thế ownership của Plugin database hay task runtime.

Nguồn: [ADR-0040](../adr/0040-public-session-sdk-and-subagents-ownership.md), [Plugin README](../../packages/coding-agent/modules/plugins/README.md), [projection](../../packages/coding-agent/modules/sessions/storage/session-jsonl-projection.ts), [fork implementation](../../packages/coding-agent/modules/sessions/storage/session-jsonl-store.ts#L6990-L7513).

## 7. Acceptance contracts nên có trước implementation

- Reopen/reload dựng cùng state từ log, không chạy lại hành động.
- Export/import round-trip state khi Plugin chưa được cài; cùng bundle import lại không nhân đôi state.
- Fork tại checkpoint cũ không nhìn thấy state ghi sau cut.
- State update sau terminal assistant record tuân đúng hợp đồng cut đã chọn, kể cả crash giữa hai commit.
- Fork độc lập: update child không đổi source; xóa source không làm child mất state/assets.
- Projection mất/hỏng rồi rebuild không làm mất hay hồi sinh key đã xóa.
- Commit đã sync nhưng projection lỗi không bị retry thành event thứ hai; indeterminate retry dùng cùng operation identity.
- Version Plugin không hỗ trợ không bị reset/overwrite ngầm; Plugin disabled không được load bởi dữ liệu nhập.
- Không kế thừa credentials, running-task ownership hay delivery acknowledgement; khôi phục ghi chú kết quả không đánh thức task.

## 8. Cập nhật V1 và V2

### V1 đã triển khai

Issue #253 được triển khai ở commit `cbea6478`; không suy từ trạng thái issue còn mở rằng API chưa tồn tại. Plugin opt-in bằng `sessionStateVersion` và nhận capability `read`, replace-key qua `set`, delete-key qua `delete`, gắn với Session và Plugin Identifier đang được nạp. State dùng JSONL v2, strict JSON nhỏ; không có bảng state SQLite riêng, migration hoặc fallback v1.

Bundle mang state trong log, kể cả khi destination không cài Plugin. Fork dựng state từ prefix tới Session Record được chọn; event sau Record không đi theo, kể cả cùng Agent Turn. State không tự vào Session Context, không replay Tool hay chuyển ownership của Delegated Task. ADR-0040 đã ghi nhận ngoại lệ hẹp này; ADR-0055 ghi rõ format, durability và prefix inheritance.

### V2: scheduling và recovery

Issue #254 bổ sung `executionMode: "sequential"` cho Tool. Nếu một Tool trong batch yêu cầu sequential, toàn bộ batch chạy theo thứ tự model phát ra, await trọn handler trước khi chạy call kế tiếp. Default vẫn parallel. `exclusiveInBatch` giữ nghĩa khác: batch nhiều call có Tool exclusive bị từ chối toàn bộ trước side effects; không đổi nó thành sequential.

Điều này bảo vệ chuỗi đọc → await → ghi của sibling Tool Calls nếu đọc state trong handler. Nó không phải optimistic lock, transaction, hoặc khóa chung cho mọi writer: Plugin Commands, background work, Session khác và snapshot đã tính trước vẫn cần Plugin tự phối hợp. Không thêm revision/CAS hoặc atomic record-plus-state checkpoint.

Pi cũng xử lý shared-state race ở scheduler chứ không ở `appendEntry`: [chọn batch mode](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/agent/src/agent-loop.ts#L518-L532) và [example stateful Tool](https://github.com/earendil-works/pi/blob/e5d9ff915c3b21719803e2f610a304ebac0a9642/packages/coding-agent/examples/extensions/tic-tac-toe.ts#L1-L18) xác nhận contract này. Trong một lần dispatch event, runner await từng handler; đó không phải khóa toàn cục giữa mọi callback. Append đồng bộ bảo vệ thứ tự entry trong một runtime, không phát hiện stale snapshot.

Coverage V2 kiểm chứng qua Agent Runtime và Session SDK: batch sequential có awaited work, parallel default, exclusive precedence, cancellation, state sau reopen, indeterminate retry chỉ có một mutation trong log, rebuild giữ tombstone, Fork độc lập sau source deletion, và absent-Plugin import/re-export. Các test recovery dùng lại fault injection JSONL hiện có. Ví dụ checklist thực thi được nằm trong package Coding-Agent; hướng dẫn Plugin nêu cách persist lúc thay đổi và restore không replay hành động.

Typed references, blob portability, atomic multi-key writes và schema migration vẫn là lựa chọn tương lai khi có consumer cụ thể, không phải mặc định phải làm ở V2.

## Kết luận tại thời điểm nghiên cứu

Pi chứng minh custom state có thể đi theo selected branch mà không đi vào model context; nó cũng cho thấy entry sau fork point và state từ nhánh khác là boundary phải xử lý rõ. Một portable Plugin-state lane có ích cho Wincode nếu có nhu cầu thật như plan/checklist phải theo session. Không nên đưa toàn bộ Plugin store vào JSONL. Trước implementation cần quyết định rõ **state nào thuộc hội thoại**, **cut ở đâu**, và **payload có reference cần remap hay không**. Với v1, snapshot JSON nhỏ, prefix inheritance và không replay side effects là phạm vi gọn nhất.
