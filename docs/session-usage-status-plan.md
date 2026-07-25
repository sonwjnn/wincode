# Session usage indicator (tokens · % context · $) cho CLI

## Context

CLI hiện không cho biết một session đang tiêu tốn bao nhiêu. Người dùng phải đoán khi nào
context sắp đầy và không biết session đang tốn bao nhiêu tiền. Mục tiêu: thêm một chỉ báo
gọn ở footer giống opencode — `34.3K (3%) · $0.02` — trong đó:

- **tokens + %**: mức chiếm dụng context **hiện tại** (usage của lượt assistant gần nhất),
  chia cho context limit của model đang dùng. Đây là con số khiến `%` có ý nghĩa.
- **$**: chi phí **cộng dồn toàn session**, tính theo giá của chính model đã chạy từng lượt
  (nên session có đổi model giữa chừng vẫn tính đúng).

Số liệu đi theo `message.metadata` nên tự động persist vào SQLite và tự khôi phục khi mở lại
session — không cần bảng mới, không cần state store mới.

## Hiển thị

Đặt ở dòng footer dưới cùng của `ChatShell`, trong nhóm căn phải, ngay bên trái `tab agents`:

```
  ⠋ Esc interrupt                    34.3K (3%) · $0.02   tab agents
```

- Ẩn hoàn toàn khi session chưa có lượt assistant nào kèm usage (màn hình mới sạch sẽ).
- `%` chuyển sang màu cảnh báo (`colors.error`) khi ≥ 80% context limit.
- Phần `$` bị bỏ qua nếu model không có bảng giá (chỉ hiện `34.3K (3%)`).

## Data flow

```
provider ─► AI SDK stream ─ messageMetadata(part.type === "finish") ─► metadata.usage
   │                                                                        │
   ├─ hosted:  packages/ai/src/server/stream.ts                             ▼
   └─ direct:  apps/cli/.../local-chat-transport.ts              useChat messages
                                                                            │
                                              summarizeSessionUsage(messages) ─► footer
                                                                            │
                                              persistMessages ─► metadata_json (SQLite)
```

`AbstractChat` chỉ validate metadata khi có `messageMetadataSchema` (không được truyền ở
`use-chat.ts`), nên `usage` đi qua nguyên vẹn về client. `finalizeAssistantMessageMetadata`
trong `use-chat.ts` spread metadata cũ nên `usage` không bị mất khi finalize.

## Thay đổi theo file

### 1. `packages/ai/src/models.ts` — context limit + giá

Thêm vào `ModelCatalogEntryBase`:

```ts
contextLimit: number;                 // bắt buộc → TypeScript ép mọi entry phải khai báo
cost?: ModelCost;                     // USD trên 1 triệu token
```

```ts
export type ModelCost = {
  input: number;        // uncached input
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
};
```

Điền `contextLimit` cho **toàn bộ** ~55 entry, và `cost` cho toàn bộ model
anthropic/openai/google (đường direct — BYO API key vẫn hiện `$`) + 2 model hosted.

- 2 entry hosted (`gpt-5.4-mini`, `gemini-2.5-flash` với `connectionProviderId: "wincode"`)
  lấy đúng số từ `packages/billing/src/pricing.ts` (`billingPricebook`, đơn vị micros/1M →
  chia 1e6) và kèm comment trỏ về file đó để hai nguồn không lệch nhau.
- Model có giá công bố công khai → dùng giá thật.
- Model không tra được giá chính xác → dùng giá của sibling cùng tier trong họ, kèm comment
  `// estimated: mirrors <model-id>`. Đây là đánh đổi có chủ ý để `$` luôn hiện với API key
  riêng; số ước lượng được đánh dấu rõ để sửa sau.

Helper mới cùng file: `getChatModelContextLimit(selection)`, `getChatModelCost(selection)`.

### 2. `packages/ai/src/metadata.ts` — mở rộng schema

`codingMessageMetadataSchema` đang `.strict()` và được dùng ở 4 chỗ
(`sessions.ts` route, `drizzle-conversation-store.ts`, `chat-request.ts`), nên **bắt buộc**
phải thêm field, nếu không message có usage sẽ bị coi là metadata không hợp lệ:

```ts
usage: codingMessageUsageSchema.optional()
```

```ts
export const codingMessageUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative().optional(),
  cacheWriteTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative(),
  reasoningTokens: z.number().int().nonnegative().optional(),
  totalTokens: z.number().int().nonnegative().optional(),
}).strict();
```

### 3. `packages/ai/src/usage.ts` (mới) — logic thuần, dễ test

- `toCodingMessageUsage(usage: LanguageModelUsage): CodingMessageUsage | null`
  map từ shape AI SDK v6 (`inputTokens`, `inputTokenDetails.cacheReadTokens/cacheWriteTokens`,
  `outputTokens`, `outputTokenDetails.reasoningTokens`, `totalTokens` — tất cả đều
  `number | undefined`), trả `null` nếu thiếu cả input lẫn output.
- `getContextTokens(usage)` → `inputTokens + outputTokens` (`inputTokens` đã bao gồm cache read).
- `calculateUsageCostUsd(cost, usage)` → tách uncached input = `inputTokens - cacheReadTokens`,
  nhân theo từng rate; trả `null` khi không có `cost`.
- `formatTokenCount(n)` → `"34.3K"` / `"1.2M"`; `formatUsdAmount(n)` → `"$0.02"`
  (dùng 2 chữ số thập phân, `"$0.00"` khi rất nhỏ nhưng > 0 thì hiện `"<$0.01"`).

Export qua `packages/ai/src/shared.ts`.

### 4. Wiring `messageMetadata` (2 chỗ, cùng một callback)

- **Hosted** — `packages/ai/src/server/stream.ts`: truyền `messageMetadata` vào
  `createAgentUIStreamResponse`.
- **Direct/local** — `apps/cli/src/modules/conversations/hooks/local-chat-transport.ts`:
  truyền `messageMetadata` vào `createStream(...)`.

Callback dùng chung (đặt trong `packages/ai/src/usage.ts`):

```ts
export const buildUsageMessageMetadata = ({ part }) =>
  part.type === "finish"
    ? (() => { const usage = toCodingMessageUsage(part.totalUsage);
               return usage ? { usage } : undefined; })()
    : undefined;
```

### 5. `apps/cli/src/modules/conversations/usage/session-usage.ts` (mới)

```ts
export type SessionUsageSummary = {
  contextTokens: number;
  contextLimit: number;
  contextPercent: number;   // 0-100, làm tròn
  costUsd: number | null;   // null khi không có lượt nào tính được giá
};

export const summarizeSessionUsage = (
  messages: CodingAgentUIMessage[],
  fallbackModel: ChatModelSelection
): SessionUsageSummary | null
```

- `contextTokens/contextLimit`: từ assistant message **cuối cùng có `metadata.usage`**;
  model lấy từ `metadata.model` của chính message đó, fallback về selection hiện tại.
- `costUsd`: cộng `calculateUsageCostUsd` trên **mọi** assistant message có usage, mỗi
  message dùng giá của model riêng nó.
- Trả `null` khi chưa có message nào có usage → footer không render gì.

### 6. `apps/cli/src/modules/conversations/ui/components/session-usage-bar.tsx` (mới)

Component thuần trình bày, nhận `SessionUsageSummary`, dùng `useTheme()` +
`TextAttributes.DIM` theo đúng style của `StatusBar` hiện tại.

### 7. `apps/cli/src/modules/conversations/ui/components/chat-shell.tsx`

`ChatShell` đã có sẵn `messages`, và `usePromptConfig()` đã được gọi ở đó → chỉ cần:

```tsx
const usage = summarizeSessionUsage(messages, model);
...
<box flexDirection="row" flexShrink={0} gap={2} marginLeft="auto">
  {usage ? <SessionUsageBar summary={usage} /> : null}
  <box flexDirection="row" gap={1}>
    <text>tab</text>
    <text attributes={TextAttributes.DIM}>agents</text>
  </box>
</box>
```

(`usePromptConfig()` hiện chỉ destructure `mode` — thêm `model`.)

## Edge cases

- **Model không có `cost`** → chỉ hiện `tokens (%)`, không hiện `$`.
- **Provider không trả cache/reasoning details** (Google thường thiếu) → các field optional,
  cost tính uncached input = toàn bộ input.
- **Session cũ** (message đã lưu trước thay đổi này) → không có `usage`, footer ẩn cho tới
  lượt chat tiếp theo. Không cần migration DB: `metadata_json` là cột JSON tự do.
- **Đổi model giữa session** → `%` theo limit của model mới, `$` vẫn cộng đúng theo từng lượt.
- **Lượt bị interrupt** → usage của phần đã stream vẫn được ghi nếu stream phát `finish`;
  nếu abort trước `finish` thì lượt đó không tính, chấp nhận được.

## Tests (bun test, colocate theo chuẩn repo)

- `packages/ai/src/usage.test.ts` — map usage từ shape AI SDK (đủ field / thiếu field),
  tính cost có/không cache read, format token & USD (`999` → `999`, `34_300` → `34.3K`,
  `1_200_000` → `1.2M`).
- `packages/ai/src/models.test.ts` (bổ sung) — mọi entry đều có `contextLimit > 0`; giá 2
  entry hosted khớp với `billingPricebook`.
- `packages/ai/src/ai-package.test.ts` (bổ sung) — `codingMessageMetadataSchema` chấp nhận
  metadata có `usage` và vẫn từ chối field lạ.
- `apps/cli/src/modules/conversations/usage/session-usage.test.ts` — chọn đúng message cuối,
  cộng dồn cost qua nhiều model, trả `null` khi chưa có usage, `%` được clamp ở 100.
- `apps/server/src/routes/sessions.test.ts` — request kèm metadata có `usage` không bị 400.

## Verification

1. `bun test` (root) + `bun run check-types`.
2. `bun x ultracite fix`.
3. `bun run dev:cli`, chọn một model **direct** với API key Anthropic/OpenAI, chat 1 câu →
   footer hiện `x.xK (n%) · $0.0x`; chat thêm 1 câu → tokens/% thay đổi theo context hiện
   tại, `$` chỉ tăng.
4. Thoát CLI, mở lại session cũ (`/sessions`) → chỉ số hiện lại y nguyên (đọc từ SQLite).
5. Đổi sang model **hosted** (`wincode`) → vẫn hiện chỉ số, và giá khớp bảng giá billing.
6. Kiểm tra model không có `cost` → chỉ còn `tokens (%)`, không vỡ layout.

## Ngoài phạm vi

- Không đổi cách billing/quota phía server hoạt động (`/billing` vẫn là nguồn sự thật cho
  hạn mức Go).
- Không thêm cảnh báo/auto-compact khi context gần đầy — có thể làm sau dựa trên số `%` này.
