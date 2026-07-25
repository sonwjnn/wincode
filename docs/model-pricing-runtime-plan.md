# Follow-up: thay giá hardcode bằng bảng giá runtime từ models.dev

> **Đọc cùng** `docs/session-usage-status-plan.md`. File đó mô tả tính năng hiển thị
> `34.3K (3%) · $0.02` ở footer. File này chỉ thay **nguồn dữ liệu giá + context limit**,
> áp dụng **sau khi** bản implement theo plan cũ đã xong. Toàn bộ phần usage/metadata/UI
> của plan cũ giữ nguyên, không đụng tới.

## Context

Plan cũ hardcode `contextLimit` và `cost` vào từng entry trong `packages/ai/src/models.ts`.
Đối chiếu 51 entry đó với `https://models.dev/api.json` (nguồn opencode dùng) cho kết quả:

| Hạng mục | Sai lệch |
|---|---|
| `contextLimit` lệch | **31/51** |
| `cost` lệch | **32/51** |

Vài ví dụ:

```
openai/o3                  repo 10/40      → thực tế 2/8
openai/gpt-5               repo 5/25       → thực tế 1.25/10
anthropic/claude-opus-4-5  repo 15/75      → thực tế 5/25
anthropic/claude-sonnet-5  ctx 200_000     → thực tế 1_000_000
openai/gpt-5.4-mini        ctx 128_000     → thực tế 400_000
openai/gpt-5.4-mini        repo 0.25/2     → billingPricebook 0.75/4.5   ← model hosted, sai giá của chính mình
```

Đây không phải lỗi của người điền — đây là hệ quả tất yếu của việc chép tay ~55 dòng giá và
kỳ vọng chúng đúng mãi. Nhà cung cấp đổi giá là chuyện xảy ra vài tháng một lần; mỗi lần đổi
mà phải sửa code + release là mô hình sai.

**Quyết định:** giá và context limit lấy runtime từ models.dev, cache xuống đĩa, kèm snapshot
commit trong repo làm fallback cho lần chạy đầu / khi offline. Riêng model hosted (`wincode`)
lấy giá từ `packages/billing/src/pricing.ts` vì đó là giá **mình** tính cho user, không phải
giá gốc của provider.

## Nguồn dữ liệu

`https://models.dev/api.json` — 3.2 MB, JSON, không cần auth. Shape:

```json
"anthropic": { "models": { "claude-sonnet-4-5": {
  "limit": { "context": 1000000, "output": 64000 },
  "cost":  { "input": 3, "output": 15, "cache_read": 0.3, "cache_write": 3.75 }
}}}
```

`cost` là USD trên 1M token — trùng đơn vị với type `ModelCost` đã có. Tra cứu bằng
`data[entry.provider].models[entry.id]` với `provider` là runtime provider trong catalog
(`anthropic` | `openai` | `google`).

Độ phủ với catalog hiện tại: **49/54 id**. 5 id không có:
`gpt-5-codex`, `gpt-5.1-codex`, `gpt-5.1-codex-max`, `gpt-5.2-codex`, `gpt-5.1-chat-latest`.
Đây là các model chỉ chạy qua OpenAI OAuth/ChatGPT subscription (repo dùng
`resolveOpenAIChatModel` với accessToken), không có giá per-token trên API → **không hiện `$`
là đúng bản chất**, chỉ cần `contextLimit` để tính `%`.

Xác nhận độ tin cậy: models.dev cho `gpt-5.4-mini` = `0.75/4.5` và `gemini-2.5-flash` =
`0.3/2.5`, khớp chính xác `billingPricebook` (`750000n`/`4500000n` micros).

## Kiến trúc

```
apps/cli/src/modules/model-pricing/
  model-pricing.ts                     types + resolve thuần (không I/O)     + test
  model-pricing-snapshot.generated.ts  fallback commit trong repo (sinh tự động)
  models-dev-response.ts               zod schema + parse response models.dev + test
  fetch-model-pricing.ts               HTTP fetch + timeout                  + test
  model-pricing-cache.ts               đọc/ghi cache đĩa + TTL               + test
  context/model-pricing-provider.tsx   React context, snapshot → cache → network
  index.ts                             module entry (như modules/connections)

scripts/sync-model-pricing.ts          regenerate snapshot
apps/cli/src/shared/paths/user-data-dir.ts   (tách từ conversations/storage/path.ts)
```

Đặt trong `apps/cli` chứ không phải `packages/ai` vì: chỉ CLI cần (server tự có billing),
và module này cần `@wincode/billing` — không nên để `@wincode/ai` phụ thuộc vào billing.

## Thay đổi theo file

### 1. `packages/ai/src/models.ts` — gỡ dữ liệu giá

- **Xoá** field `contextLimit` và `cost` khỏi `ModelCatalogEntryBase`, và xoá 2 dòng
  `contextLimit:` / `cost:` đã thêm vào từng entry (~138 dòng của plan cũ).
- **Giữ** `export type ModelCost` — `packages/ai/src/usage.ts` đang dùng, và module pricing
  mới cũng dùng lại type này.
- Catalog quay về đúng vai trò: danh sách model + routing + variants. Không giữ dữ liệu
  thay đổi theo thời gian.

`packages/ai/src/{metadata,usage,shared}.ts` và toàn bộ phần wiring `messageMetadata`
**không đổi**.

### 2. `apps/cli/src/modules/model-pricing/model-pricing.ts` — logic thuần

```ts
export type ModelPricingEntry = { contextLimit: number; cost?: ModelCost };
export type ModelPricingTable = Readonly<Record<string, ModelPricingEntry>>; // key: `${provider}/${modelId}`

export const modelPricingKey = (provider: ModelRuntimeProviderId, modelId: string) =>
  `${provider}/${modelId}`;

/** Giá hosted lấy từ billingPricebook (micros/1M → USD/1M). */
export const getHostedModelCost = (modelId: string): ModelCost | undefined => ...

/** Nguồn giá cho một selection. Hosted → billing pricebook; direct → bảng runtime. */
export const resolveModelPricing = (
  table: ModelPricingTable,
  selection: ChatModelSelection
): ModelPricingEntry | null => ...
```

Quy tắc `resolveModelPricing`:

1. Tìm catalog entry qua `findSupportedChatModelSelection(selection)` → lấy `provider` + `id`.
2. `contextLimit` luôn lấy từ `table[modelPricingKey(provider, id)]`.
3. `cost`:
   - `connectionProviderId === "wincode"` → `getHostedModelCost(id)` (billing pricebook).
   - còn lại → `table[...].cost`, có thể `undefined` (5 model OAuth) → footer ẩn `$`.
4. Không có entry nào trong table → trả `null` → footer ẩn hoàn toàn.

`apps/cli/package.json` thêm `"@wincode/billing": "workspace:*"`.

### 3. `models-dev-response.ts` — parse có chọn lọc

Không validate cả 172 provider trong 3.2 MB. Chỉ duyệt đúng các id có trong
`supportedChatModels`:

```ts
const modelsDevEntrySchema = z.object({
  limit: z.object({ context: z.number().int().positive() }).partial().optional(),
  cost: z.object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cache_read: z.number().nonnegative().optional(),
    cache_write: z.number().nonnegative().optional(),
  }).optional(),
});

export const buildModelPricingTable = (raw: unknown): ModelPricingTable
```

- Model nào parse lỗi hoặc thiếu `limit.context` thì **bỏ qua entry đó**, không làm hỏng cả
  bảng (một model mới có shape lạ không được phép làm hỏng chỉ báo của mọi model khác).
- Bảng rỗng / thiếu quá nửa số id → coi như fetch thất bại, giữ nguồn cũ.

### 4. `model-pricing-cache.ts` — cache đĩa

- Đường dẫn: `join(resolveUserDataDir(), "model-pricing.json")`.
- `resolveUserDataDir()` hiện nằm trong `apps/cli/src/modules/conversations/storage/path.ts`.
  Tách sang `apps/cli/src/shared/paths/user-data-dir.ts` và cho `storage/path.ts` import lại
  — tránh module `model-pricing` phải với sang module `conversations`.
- File cache: `{ "version": 1, "fetchedAt": <epoch ms>, "table": { ... } }`.
- Đọc lỗi / JSON hỏng / sai `version` → coi như không có cache, xoá file, dùng snapshot.
  Không throw ra UI.

### 5. `fetch-model-pricing.ts`

- `AbortSignal.timeout(5000)`.
- Chỉ chấp nhận HTTP 200 + `content-type` JSON.
- Trả `ModelPricingTable | null`; mọi lỗi đều nuốt và trả `null`.

### 6. `context/model-pricing-provider.tsx`

Thứ tự, không chặn render lần nào:

```
state ban đầu = snapshot (đồng bộ, có sẵn trong bundle)
useEffect:
  cache = readCache()
  nếu cache còn hạn (fetchedAt trong TTL)      → setState(cache.table), dừng
  ngược lại                                    → setState(cache.table) nếu có,
                                                  rồi fetch nền
     fetch ok   → writeCache() + setState(table)
     fetch fail → giữ nguyên state, im lặng (không toast, đây là tiện ích chứ không phải lỗi)
```

- TTL mặc định **24h**.
- Chỉ fetch **một lần cho mỗi tiến trình CLI**, kể cả khi provider re-mount.
- Mount trong `apps/cli/src/app/layouts/root-layout.tsx`, đặt trong `PromptConfigProvider`
  và ngoài `ToastProvider` (cùng tầng với `BillingComposition`).

Hook `useModelPricing()` trả `{ table }`; component footer đổi từ đọc catalog sang
`resolveModelPricing(table, model)`.

### 7. Env — `packages/env/src/cli.ts`

Thêm (đều optional, theo pattern `createEnv` sẵn có):

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `WINCODE_MODEL_PRICING_URL` | `https://models.dev/api.json` | đổi nguồn / trỏ fixture khi test |
| `WINCODE_MODEL_PRICING_OFFLINE` | `false` | `1` → không gọi mạng, chỉ dùng cache + snapshot |
| `WINCODE_MODEL_PRICING_TTL_HOURS` | `24` | hạn cache |

`WINCODE_MODEL_PRICING_OFFLINE` là bắt buộc phải có: CLI gọi mạng ngầm là thứ người dùng có
quyền tắt.

### 8. `scripts/sync-model-pricing.ts`

```
bun run scripts/sync-model-pricing.ts
  → fetch WINCODE_MODEL_PRICING_URL
  → lọc theo supportedChatModels
  → ghi apps/cli/src/modules/model-pricing/model-pricing-snapshot.generated.ts
  → in ra: số model có giá / thiếu giá / thiếu context limit
```

- File sinh ra mở đầu bằng `// Generated by scripts/sync-model-pricing.ts — do not edit.`
  kèm ngày fetch.
- Script có `contextLimitOverrides` khai báo tay cho 5 model OAuth (`gpt-5*-codex*`,
  `gpt-5.1-chat-latest`) — chỉ `contextLimit`, không có `cost`, kèm comment nguồn.
- Thêm `"sync:model-pricing"` vào `scripts` của `package.json` gốc.
- Snapshot **được commit**. Chạy lại script định kỳ / khi thêm model mới vào catalog.

## Edge cases

- **Lần chạy đầu, không mạng** → dùng snapshot. Số liệu có thể cũ vài tháng nhưng luôn hiện.
- **Model mới thêm vào catalog nhưng chưa sync snapshot** → không có trong snapshot; lần fetch
  runtime đầu tiên sẽ có. Trước đó footer ẩn với model đó.
- **models.dev đổi shape / chết** → parse thất bại → giữ snapshot, CLI không vỡ. Đây là lý do
  snapshot phải commit chứ không chỉ cache.
- **Cache thuộc về máy chứ không thuộc workspace** → nằm ở user data dir, dùng chung mọi repo.
- **Giá hosted lệch giữa billingPricebook và models.dev** → luôn ưu tiên billingPricebook, và
  thêm test cảnh báo khi hai bên lệch để biết mà rà lại.

## Tests

- `model-pricing.test.ts` — hosted lấy giá từ pricebook chứ không phải table; direct lấy từ
  table; model không có `cost` trả entry có `contextLimit` nhưng `cost` undefined; selection
  không có trong catalog trả `null`.
- `models-dev-response.test.ts` — parse fixture rút gọn; bỏ qua entry hỏng mà vẫn giữ entry
  tốt; thiếu `limit.context` thì loại; bảng rỗng.
- `model-pricing-cache.test.ts` — ghi/đọc round-trip, TTL hết hạn, JSON hỏng, sai `version`.
- `fetch-model-pricing.test.ts` — 200 hợp lệ, non-200, timeout, JSON hỏng → `null`.
- `model-pricing-snapshot.test.ts` — mọi id trong `supportedChatModels` đều có `contextLimit`
  trong snapshot (kể cả 5 model override) → thêm model mới mà quên sync sẽ fail test.
- Bổ sung vào test billing/ai: giá hosted trong snapshot khớp `billingPricebook`.

## Verification

1. `bun test` + `bun run check-types` + `bun x ultracite fix`.
2. `bun run sync:model-pricing` → diff snapshot sạch sẽ, log in ra 49 model có giá,
   5 model chỉ có context limit.
3. `bun run dev:cli` với API key Anthropic → chat 1 câu, footer hiện `$`; đối chiếu
   `input × giá + output × giá` bằng tay xem có khớp không.
4. Xoá `<userDataDir>/model-pricing.json`, chạy lại → cache được tạo lại; chạy tiếp lần nữa
   → không có request mạng thứ hai (kiểm bằng `WINCODE_MODEL_PRICING_URL` trỏ vào một
   server local đếm request).
5. `WINCODE_MODEL_PRICING_OFFLINE=1` + xoá cache → vẫn hiện chỉ số (từ snapshot), không gọi mạng.
6. `WINCODE_MODEL_PRICING_URL=http://127.0.0.1:1` (port chết) → CLI khởi động bình thường,
   không toast lỗi, footer vẫn có số.
7. Chọn `gpt-5.1-codex` (OAuth) → hiện `tokens (%)`, không có `$`.

## Checklist gỡ code của plan cũ

- [ ] `packages/ai/src/models.ts`: gỡ `contextLimit` + `cost` khỏi type và khỏi ~55 entry
- [ ] Gỡ test nào đang assert giá hardcode trong `packages/ai/src/models.test.ts`
- [ ] Footer/`session-usage.ts` đổi từ đọc catalog sang `useModelPricing()` +
      `resolveModelPricing()`
- [ ] `packages/ai/src/usage.ts`, `metadata.ts`, wiring `messageMetadata`: **giữ nguyên**
