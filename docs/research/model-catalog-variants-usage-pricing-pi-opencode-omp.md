# Model catalog, variants, usage và pricing — Pi, OpenCode, OMP (đối chiếu Wincode)


|                 |                                                                                                                               |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Ngày nghiên cứu | 2026-09-11                                                                                                                    |
| Phạm vi         | Cách catalog model, variant, usage/token accounting và pricing được mô hình hóa, nạp, hợp nhất và tính toán                   |
| Pi              | `earendil-works/pi`, revision `853a80d26c90a14c1886f0ebb8ffaae133ca2185`                                                      |
| OpenCode        | `anomalyco/opencode`, revision `10765ff2a9da8c3b88e4de873aa383a49c318912`                                                     |
| OMP             | `can1357/oh-my-pi`, revision `51f03804476c3fd3c15748ae07e4849d1efc883b`                                                       |
| Quy ước         | Chỉ dùng tài liệu/source chính thức; các nhận định về Wincode là quan sát trên worktree hiện tại, không phải cam kết upstream |


## Kết luận điều hành

Ba hệ thống đều tách ít nhất bốn vấn đề thường bị trộn vào một bảng model: **identity** (provider/model/wire ID), **capability và request options**, **usage quan sát được**, và **pricing metadata/cách tính**. Điểm khác nằm ở nơi đặt quyền sở hữu và mức độ động:

- **OpenCode** dùng `ModelV2.Info` làm metadata khá giàu (capabilities, limits, status, cost tiers, request fields và các `variants`), rồi xây `Catalog` runtime từ provider integrations và nguồn Models.dev/OpenCode. Variant là override có tên cho cùng model; `VariantID` không phải enum đóng. Lớp AI SDK chuẩn hóa usage, nhưng các file được khảo sát không cho thấy một công thức cost tổng quát chạy ở lớp session.
- **Pi** để từng `Provider<TApi>` sở hữu catalog model và hook refresh. Catalog built-in được sinh từ source/provider files; provider động có thể khôi phục cache rồi refresh. Pi không có bảng variant riêng: reasoning được biểu diễn như capability của `Model` và `ModelThinkingLevel` ở request. `Usage` và `calculateCost` là phần mạnh nhất về accounting, gồm tier theo tổng input và cache-write 5 phút/1 giờ.
- **OMP** dùng model descriptor giàu provider/API, model cache SQLite, discovery runtime và `model-manager` để hợp nhất nhiều nguồn. Thinking là metadata build-time (`ThinkingConfig`), còn `variant-collapse` quy nhiều ID upstream có hậu tố thinking về một logical model, route wire ID theo effort. `Usage` tách token orchestration, premium requests, credits và CTTL cache; pricing hỗ trợ long-context và cache-write theo TTL, trong khi usage/quota provider-specific là một surface riêng.

Vì vậy, nếu Wincode chỉ duy trì một `modelCatalog` tĩnh, một enum variant toàn cục và một phép tính giá phẳng, nó sẽ khó biểu diễn model được phát hiện động, variant theo provider/model, SKU có tier/long-context, hoặc billing authoritative khác token usage. Đây là **rủi ro thiết kế suy ra từ đối chiếu**, không phải khẳng định rằng mọi đường chạy hiện tại đều sai.

## 1. OpenCode

### 1.1. Data model và identity

`packages/schema/src/model.ts` định nghĩa các schema v2:

- `ModelV2.ID` là branded string; `ModelV2.Ref` gồm `id`, `providerID` và `variant?: VariantID`.
- `ModelV2.Info` gồm `id`, `providerID`, `family?`, `name`, `api`, `capabilities`, `request`, `variants`, `time`, `cost`, `status`, `enabled` và `limit`.
- `capabilities` tách `tools`, `input[]`, `output[]`; `limit` tách `context`, `input?`, `output`.
- `ModelV2.Cost` có `tier?: { type: "context"; size: int }`, `input`, `output`, và `cache: { read, write }`. `cost` là **mảng**, nên một model có thể có nhiều bậc giá thay vì chỉ một rate.
- `ModelV2.Api` có hai hình thức: AI SDK (`Provider.AISDK`) hoặc native (`Provider.Native`).

`packages/schema/src/provider.ts` tách `Provider.ID`, thông tin provider/integration và API. `Provider.Request` chứa `headers` và `body`; `Provider.Info` có `integrationID?`, `disabled?`, `api` và `request`. Như vậy provider config và model config là hai lớp khác nhau, dù chúng cùng tham gia tạo request.

Tham chiếu: [`ModelV2` schemas](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/schema/src/model.ts), [`Provider` schemas](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/schema/src/provider.ts).

Tài liệu models dùng identity đầy đủ dạng `provider_id/model_id`, thay vì chỉ dùng model ID toàn cục. Đây là điều kiện cần khi cùng model ID xuất hiện qua nhiều provider hoặc endpoint. [OpenCode Models — “Model Providers”](https://opencode.ai/docs/models) mô tả format này.

### 1.2. Catalog, discovery và cache

`packages/core/src/catalog.ts` giữ `ProviderRecord` gồm `provider` và `models: Map<ModelV2.ID, ModelV2.MutableInfo>`. Service có các thao tác `provider.get/all/available` và `model.get/all/available/default/small`; model được sort theo ngày release, còn `available` lọc provider khả dụng và model `enabled`.

`Catalog.projectModel()` hợp nhất API, request headers/body của provider và model; `model.request.variant` được giữ như variant của model thay vì làm phẳng thành một model ID khác. Provider chỉ được coi là available khi không bị disable và có API key/env, integration connection, hoặc không cần integration. Catalog hỗ trợ `update/remove`, nên metadata có thể được nạp/cập nhật runtime thay vì chỉ là constant biên dịch. Tham chiếu: [`packages/core/src/catalog.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/catalog.ts).

`packages/core/src/models-dev.ts` mô tả nguồn model từ API OpenCode: model có `id`, `name`, `family?`, `release_date`, capability flags, `reasoning_options?`, `cost?`, `limit`, modalities, status và provider API metadata. Cost upstream có `input`, `output`, `cache_read?`, `cache_write?`, `tiers?`, cùng ngoại lệ `context_over_200k?`. `ReasoningOption` có các dạng `effort`, `toggle` và `budget_tokens`, vì vậy capability/variant policy có thể đến từ metadata thay vì một enum ứng dụng.

Nguồn mặc định trong revision khảo sát là `https://models.opencode.ai/api.json` (có override `OPENCODE_MODELS_URL` và `OPENCODE_MODELS_PATH`). Loader có embedded snapshot fallback, cache cục bộ với TTL ngắn, cờ tắt fetch, refresh tường minh và refresh định kỳ. Tham chiếu: [`packages/core/src/models-dev.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/models-dev.ts).

Đây là khác biệt đáng chú ý với một client lấy trực tiếp `https://models.dev/api.json`: OpenCode chọn endpoint/catalog của chính OpenCode làm default ở lớp này, dù metadata có thể được tạo từ upstream Models.dev. Không nên coi hai URL là cùng một hợp đồng mà không pin schema và revision.

`packages/opencode/src/provider/provider.ts` còn gắn catalog với runtime provider. Các provider/API được hỗ trợ có thể dùng AI SDK hoặc native transport; model được tìm trong catalog đã load và lỗi thiếu model đi kèm gợi ý model tương tự. Hàm chọn `small` model có ngoại lệ theo provider/model, không phải chỉ sort theo giá. Tham chiếu: [`provider runtime`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/provider/provider.ts).

### 1.3. Variant semantics

Ở schema, `VariantID` là branded string và `Info.variants` là danh sách các object có `id` cùng `Provider.Request.fields`. Không có closed global enum tương đương `none | low | medium ...`; variant thuộc về từng model/provider.

Tài liệu cấu hình cho phép đặt `provider.models.<model>.options` cho options chung và `provider.models.<model>.variants` cho các cấu hình có tên. Tài liệu mô tả variant là “different settings for the same model without duplicate entries”; có thể override hoặc thêm variant, tắt một variant bằng `disabled`, và xoay vòng bằng `variant_cycle`. Built-in list hiện được tài liệu hóa là Anthropic `high`/`max`, OpenAI `none`/`minimal`/`low`/`medium`/`high`/`xhigh`, Google `low`/`high`; đây không phải danh sách exhaustive cho mọi provider. Tham chiếu: [OpenCode Models — “Variants”](https://opencode.ai/docs/models).

Trong `packages/opencode/src/session/llm/request.ts`, request thường merge theo thứ tự:

1. base options của provider/model;
2. `input.model.options`;
3. `input.agent.options`;
4. object variant được chọn.

Variant vì vậy là lớp override cuối, có precedence rõ ràng. Nhánh `small` dùng options của small model và không áp variant người dùng. Tham chiếu: [`session/llm/request.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/llm/request.ts).

### 1.4. Usage và token accounting

`packages/opencode/src/session/llm/ai-sdk.ts` chuẩn hóa event usage từ AI SDK thành các trường:

- `inputTokens`, `outputTokens`, `totalTokens`;
- `reasoningTokens` (ưu tiên output detail, có fallback);
- `cacheReadInputTokens` (nested input detail hoặc `cachedInputTokens`);
- `cacheWriteInputTokens` (nested input detail).

Finish-step phát usage và finish cuối phát tổng usage. Với GitHub Copilot, adapter còn đọc raw chunk `copilot_usage.total_nano_aiu`; comment trong source nói raw chunks mới là billing authoritative cho Copilot. Tham chiếu: [`session/llm/ai-sdk.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/llm/ai-sdk.ts).

Trong các file session/adapter được khảo sát, usage được chuyển tiếp và lưu cùng event/session; không thấy một công thức generic lấy `ModelV2.Cost` rồi tự nhân rate cho mọi provider. Do đó cần phân biệt “catalog chứa cost metadata” với “client đã tính được hóa đơn”. [Giới hạn bằng chứng] Kết luận này chỉ áp dụng các file/revision đã khảo sát, không loại trừ code tính phí ở package khác.

### 1.5. Pricing representation và provider exceptions

Cost model của OpenCode có ba đặc điểm mà bảng giá phẳng khó mô tả:

1. **Tier**: `cost[]` và `tier.size` cho phép đổi rate theo ngưỡng context.
2. **Cache read/write riêng**: không bắt buộc dùng input rate cho cache; upstream models metadata có `cache_read` và `cache_write`.
3. **Giới hạn và capability song hành với giá**: `limit`/modalities/reasoning options là phần của cùng model record, nên resolver không cần suy luận chỉ từ tên.

Runtime có ngoại lệ transport/endpoint, gồm OpenAI Responses/Chat, Anthropic beta headers, Azure URL/options, GitHub Copilot chọn Responses hay Chat theo endpoint/model, Bedrock region/profile/env và các prefix `global.`, `us.`, `eu.`, `jp.`, `apac.`, `au.`, Google Vertex project/location, và OpenRouter attribution. Các nhánh này nằm trong [`provider runtime`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/provider/provider.ts) và các transform trong [`session/llm/request.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/llm/request.ts); chúng cho thấy provider/model identity không chỉ là nhãn hiển thị.

### 1.6. Model selection mặc định

Tài liệu [OpenCode Models — “Selecting Models”](https://opencode.ai/docs/models) ghi loading order: CLI `--model/-m`, model trong config, model dùng lần trước, rồi model đầu tiên theo internal priority. Catalog còn có `model.small`; các ngoại lệ Azure/Azure Cognitive Services không trả small model, OpenCode ưu tiên `gpt-5-nano` khi có, và các provider như Bedrock/Copilot có policy riêng. Đây là policy selection, không nên nhập chung vào pricing.

## 2. Pi (`@earendil-works/pi-ai`)

### 2.1. Data model và catalog ownership

`packages/ai/src/types.ts` định nghĩa `Model` là record runtime gồm `id`, `name`, `api`, `provider`, `baseUrl`, `reasoning`, `input`, `cost`, `contextWindow`, `maxTokens`, headers và các `compat`/API-specific fields. `ModelCostRates` có `input`, `output`, `cacheRead`, `cacheWrite`, tất cả được chú thích là `$ / million tokens`; `ModelCost` có thể có `tiers`, mỗi `ModelCostTier` có `inputTokensAbove`.

Pi đặt catalog dưới `Provider<TApi>`: provider sở hữu model list, auth resolution và stream/completion. `Models` là collection của các provider/routes; API có `getModels()`, `getModel()`, `refresh()` và `getAvailable()`. README mô tả querying là synchronous; dynamic provider có thể trả last-known list, rỗng trước refresh đầu tiên. Static provider refresh là no-op. Tham chiếu: [`Pi types.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/types.ts), [`Pi models.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/models.ts), và README mục [“Querying Models”](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/README.md#querying-models).

`packages/ai/src/models.generated.ts` là map generated từ các provider model files; header nói không chỉnh tay và được tạo bởi `scripts/generate-models.ts`. Generator chịu trách nhiệm fetch/parse source rồi map về `Model` chuẩn, bao gồm pricing, capabilities và ID quirks theo provider. Tham chiếu: [`models.generated.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/models.generated.ts) và README mục [“Adding a New Provider”](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/README.md#adding-a-new-provider).

### 2.2. Discovery, dynamic refresh và cache

Provider có `getModels()` đồng bộ, hook tùy chọn `refreshModels(context)`, và `filterModels()` để lọc theo credential. `Models.refresh()` chạy các dynamic providers, có generation guard/cancellation để refresh cũ không ghi đè kết quả mới; `getAvailable()` kết hợp credential availability với catalog.

`packages/ai/src/models-store.ts` lưu last-known dynamic rows theo provider: `models`, `lastModified` (remote `Last-Modified`), `checkedAt` và `etag`. Khi `createProvider()` khởi tạo, `baselineModels` và `dynamicModels` được merge theo model ID; refresh khôi phục cached rows đã lọc theo provider, rồi fetch mạng nếu context cho phép, publish `{models, checkedAt}` persistent và cập nhật memory. Tham chiếu: [`models-store.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185) và [`models.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/models.ts).

README cũng mô tả cách gọi `await models.refresh({providers: ["llamacpp"]})`; dynamic provider được refresh rõ ràng thay vì giả vờ rằng static catalog là đầy đủ. Đây là mô hình “built-in baseline + provider-specific dynamic last-known state”, đơn giản hơn OMP nhưng rõ ranh giới.

### 2.3. Variants/reasoning semantics

Pi không dùng một object `variants` trên mỗi model như OpenCode. Thay vào đó:

- `Model.reasoning` nói model có reasoning hay không.
- `ModelThinkingLevel` là `"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max"`.
- `thinkingLevelMap` tùy chọn map level chuẩn sang wire/provider values.
- `getSupportedThinkingLevels()` dựa trên capability và map; `xhigh`/`max` là opt-in theo model.
- `clampThinkingLevel()` xử lý level không được model hỗ trợ.

Request API dùng `completeSimple(..., { reasoning: "medium" })` để đưa reasoning level thống nhất vào provider. Provider-specific options vẫn đi qua `hasApi`; event stream có thinking events. Vì vậy level là **request-time capability**, không phải một catalog entry có ID riêng. Tham chiếu: Pi README mục [“Thinking / Reasoning”](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/README.md#thinking--reasoning), [`types.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/types.ts).

[Hàm ý] Cùng tên `high` hoặc `max` không đảm bảo cùng wire behavior: `thinkingLevelMap`, API compatibility và capability của chính model quyết định mapping.

### 2.4. Usage/token accounting

`Usage` của Pi có các bucket:

- `input`, `output`, `cacheRead`, `cacheWrite`;
- `cacheWrite1h?` cho cache-write dài hạn;
- `reasoning?`, là subset của output và có thể undefined nếu provider không expose;
- `totalTokens`;
- `cost: {input, output, cacheRead, cacheWrite, total}`.

API README cho ví dụ in `usage.totalTokens` và `usage.cost.total`, nên usage và cost đã được gắn trên kết quả completion, không chỉ là metadata catalog. Tham chiếu: [`@earendil-works/pi-ai README`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/README.md) và [`types.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/types.ts).

### 2.5. Pricing representation và công thức

`calculateCost(model, usage)` trong `packages/ai/src/models.ts` thực hiện các bước sau:

1. `inputTokens = usage.input + usage.cacheRead + usage.cacheWrite`.
2. Nếu model có `cost.tiers`, chọn tier cao nhất mà `inputTokens` vượt ngưỡng `inputTokensAbove`; tier áp dụng cho toàn request theo tổng input, không chỉ uncached input.
3. `usage.cost.input = rates.input / 1_000_000 * usage.input`.
4. `usage.cost.output = rates.output / 1_000_000 * usage.output`.
5. `usage.cost.cacheRead = rates.cacheRead / 1_000_000 * usage.cacheRead`.
6. Cache write thường dùng `rates.cacheWrite`; `cacheWrite1h` (ngoại lệ Anthropic) tính theo công thức dài hạn dùng `rates.input * 2` cho phần 1 giờ và rate cache-write cho phần ngắn.
7. `usage.cost.total` là tổng các thành phần.

Các rate được biểu diễn bằng USD trên một triệu token và cache read/write là các rate riêng. Tham chiếu: [`calculateCost`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/models.ts) và các type cost trong [`types.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/types.ts).

### 2.6. Provider-specific exceptions

Pi yêu cầu provider mới khai báo API implementation, model generation và factory; generator phải xử lý pricing/capability/ID quirks theo provider. Đây là một extension point có chủ ý, thay vì buộc mọi provider vào một resolver map chung.

Ngoại lệ rõ nhất trong accounting là Anthropic `cacheWrite1h`. Ngoài ra, model-specific `thinkingLevelMap`, API `compat` và credential-specific `filterModels()` khiến cùng một provider catalog có thể hiển thị availability khác nhau theo auth context. Tham chiếu: README mục [“Adding a New Provider”](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/README.md#adding-a-new-provider) và các type/API trong [`types.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/types.ts).

## 3. OMP (`oh-my-pi`)

### 3.1. Catalog layers và Model data model

README của `packages/catalog` chia catalog thành các lớp:

- `models.json` + `models`: bundled model database với pricing, context windows, modalities và thinking support;
- `provider-models`: provider descriptors và resolution;
- `discovery`: runtime discovery cho OpenAI-compatible, Gemini, Codex, Cursor, Antigravity, Ollama;
- `identity`: parse/classify/reference/equivalence/selection;
- `model-thinking`: generated thinking policies/metadata;
- `model-manager`/`model-cache`: runtime registry, discovery refresh và on-disk cache;
- `variant-collapse`: collapse provider-specific variants.

`models.json` được generate, không chỉnh tay; script lấy dữ liệu từ stencil.so, provider catalog/discovery và OpenCode docs, rồi resolver áp policy theo provider. Tham chiếu: [`packages/catalog/README.md`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/README.md), [`scripts/generate-models.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/scripts/generate-models.ts).

`packages/catalog/src/types.ts` có `KnownApi` union, gồm các API như `openai-completions`, `openai-responses`, `openrouter`, `openai-codex-responses`, `azure-openai-responses`, `anthropic-messages`, `bedrock-converse-stream`, `google-generative-ai`, `google-gemini-cli`, `google-vertex`, `ollama-chat`, `cursor-agent`, `gitlab-duo-agent`, `devin-agent`.

OMP `Model` gồm `id`, `requestModelId?` (ID local có thể khác wire ID), `reasoningMode?`, `name`, `api`, `provider`, `baseUrl`, capability/tokenizer/decoder fields, `cost`, `premiumMultiplier?`, `contextWindow: number | null`, `maxTokens: number | null`, `thinking?`, resolved `compat` và nhiều transport flags. `ModelSpec` là descriptor sparse dùng cho cache/custom model trước khi `buildModel()` resolve các field dẫn xuất. Tham chiếu: [`catalog/src/types.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/types.ts), [`catalog/src/build.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/build.ts).

### 3.2. Discovery, precedence và persistent cache

`model-manager.ts` hỗ trợ chiến lược `"online"`, `"offline"` và `"online-if-uncached"`, cùng `ModelsDevFallback` có `fetch`, `map`, `additiveOnly`. Kết quả ghi `source: "bundled" | "cache" | "models.dev" | "provider"`, `stale`, `updatedAt?`.

Resolution precedence là static → cached fallback → stencil.so → dynamic; source sau override theo model ID. Cache được khôi phục và fingerprint static catalog được so sánh. Dynamic source có thể authoritative và prune static rows khi descriptor cho phép; nếu remote fail, OMP dùng stale snapshot và ghi trạng thái non-authoritative; source thành công sẽ ghi cache. Merged result gọi `collapseBuiltModelVariants`. Tham chiếu: [`model-manager.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/model-manager.ts).

`model-cache.ts` dùng SQLite `models.db`, atomic cross-process access, schema version 12. Cache lưu sparse `ModelSpec` JSON; headers bị loại bỏ có chủ ý vì chứa credential. Row có provider ID/version, updated time, authoritative/static fingerprint, model JSON và header metadata/restorable IDs. Cache schema có thể invalidate khi policy thay đổi. Tham chiếu: [`model-cache.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/model-cache.ts).

OpenAI-compatible discovery GET `${baseUrl}/models`, chấp nhận nhiều envelope (`data`, `models`, `result`, `items`, array trực tiếp), dedupe/sort và áp custom mapper/filter. Unknown model được normalize với API/provider/base URL, `reasoning: false`, input text, cost zero, context/max null. Gemini discovery gọi endpoint Google có pagination, yêu cầu `generateContent`, dùng bundled reference nếu có và điền limits từ giá trị live. Tham chiếu: [`discovery/openai-compatible.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/discovery/openai-compatible.ts), [`discovery/gemini.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/discovery/gemini.ts).

### 3.3. Thinking và variant collapse

`ThinkingConfig` trong OMP làm thinking thành metadata explicit:

- `mode`: `"effort" | "budget" | "google-level" | "anthropic-adaptive" | "anthropic-budget-effort"`;
- ordered nonempty `efforts`, `defaultLevel?`, `effortMap?`;
- `supportsDisplay`, `effortRouting?`, `effortBudgets?`, `suppressWhenOff`, `requiresEffort`.

`model-thinking.ts` resolve metadata một lần ở build-time. Runtime helpers đọc metadata đã bake, không parse ID/host hay suy luận compat mỗi request. Metadata explicit của model có quyền quyết định capability; model reasoning nhưng không hỗ trợ wire effort có thể có `thinking: undefined`. Nhiều policy ladders/maps riêng cho Gemini, OpenAI, Anthropic, Kimi, DeepSeek và provider khác. Tham chiếu: [`model-thinking.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/model-thinking.ts).

`variant-collapse.ts` giải quyết trường hợp upstream công bố các ID như `X` và `X-thinking` nhưng đó thực chất là một logical model với một trục effort:

- collapse về logical ID để selection/cache/usage attribution ổn định;
- outbound wire ID được route theo effort qua `thinking.effortRouting`;
- chỉ collapse cặp có cùng pricing và cùng API; cặp chênh giá giữ là các SKU distinct;
- inherit non-tier fields từ member đầu tiên; thao tác deterministic/idempotent;
- áp dụng an toàn ở discovery, generator và manager merge.

Đây là semantics khác với việc đơn giản thêm `"thinking"` vào enum variant. Tham chiếu: [`variant-collapse.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/variant-collapse.ts).

### 3.4. Usage/token accounting

OMP tách usage completion và usage/quota provider. `packages/catalog/src/types.ts` định nghĩa Usage per request gồm:

- `input`: conversation input không cache;
- `output`: toàn bộ output conversation, gồm thinking/text/tool args;
- `cacheRead`, `cacheWrite`, `totalTokens`;
- `contextTokens?`, `orchestration? {input, cacheRead, output}`;
- `premiumRequests?`, `reasoningTokens?`, `cttl? {ephemeral5m?, ephemeral1h?}`;
- server-tool counters;
- `credits {cost, committedCost, acuCost}`;
- `cost {input, output, cacheRead, cacheWrite, total}`.

`packages/ai/src/usage.ts` lại là surface cho quota/report: `UsageUnit` có percent/tokens/requests/credits/usd/minutes/bytes/unknown; report có windows, scopes, limits, raw provider payload, history và observed token usage. `ObservedUsageEntry` theo `(provider, model)` có requests/input/output/cacheRead/cacheWrite và `costUsd` estimated (0 khi unknown). Tham chiếu: [`catalog/src/types.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/types.ts), [`packages/ai/src/usage.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage.ts).

### 3.5. Pricing representation và công thức

`TokenCost` dùng rate input/output/cacheRead/cacheWrite trên mỗi triệu token. `ModelCost` có `longContext` với `inputThreshold` và tùy chọn inclusive. `calculateUsageCost()`:

1. Chọn tier long-context dựa trên `usage.input + cacheRead + cacheWrite + orchestration.input + orchestration.cacheRead`.
2. Cost input tính từ `usage.input + orchestration.input`.
3. Cost output bao gồm `usage.output + orchestration.output`.
4. Cost cache read bao gồm `usage.cacheRead + orchestration.cacheRead`.
5. Cost cache write gọi `cacheWriteCost`; nếu có CTTL, phần ephemeral 5 phút dùng cache-write rate còn phần ephemeral 1 giờ dùng `rates.input * 2`.
6. Tổng là input + output + cacheRead + cacheWrite.

`calculateUncachedInputCost()` là helper riêng chỉ cho uncached prompt input. Tách helper này khỏi `calculateUsageCost()` cho thấy “ước tính input không cache” không đồng nghĩa “hóa đơn đầy đủ”. Tham chiếu: [`catalog/src/models.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/models.ts).

### 3.6. Provider-specific pricing, quota và discovery exceptions

`packages/catalog/src/provider-models/descriptors.ts`/`descriptor-types.ts` định nghĩa `ProviderCatalogEntry` với `id`, default model, env vars, `createModelManagerOptions`, `allowUnauthenticated`, `dynamicModelsAuthoritative`, `catalogDiscovery` và `specialModelManager`. Vì vậy provider có thể thay đổi authority, refresh, auth và discovery policy mà không sửa schema Model chung. Tham chiếu: [`descriptors.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/provider-models/descriptors.ts), [`descriptor-types.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/provider-models/descriptor-types.ts).

Generator có các policy cụ thể như `COPILOT_PREMIUM_MULTIPLIERS`, provider chỉ discovery runtime (`ollama`, `vllm`, `lm-studio`, `litellm`), provider credential-scoped (`Devin`), Kimi caps, Fireworks thinking shape, Antigravity endpoint normalization và premium overrides. Credential-scoped provider không nên bị coi là catalog public. Tham chiếu: [`scripts/generate-models.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/scripts/generate-models.ts).

Quota modules là một accounting plane khác per-request cost:

- GitHub Copilot lấy internal quota/billing usage, premium requests và per-model items; đơn vị chính là requests.
- Gemini CLI đọc `retrieveUserQuota`, bucket theo model, remaining fraction, reset window và tier.
- Cursor tách rail “Cursor Models”/“Other Models”, on-demand và USD cents.
- OpenAI Codex đọc `/wham/usage`, primary/secondary rate-limit windows, metered features, saved reset credits và `x-codex-*` headers.

Các module này không thể thay thế `Usage` token/cost chung. Tham chiếu: [`usage/github-copilot.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage/github-copilot.ts), [`usage/gemini.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage/gemini.ts), [`usage/cursor.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage/cursor.ts), [`usage/openai-codex.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage/openai-codex.ts).

## 4. Bảng so sánh


| Khía cạnh              | OpenCode                                                                                | Pi                                                                                  | OMP                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| Logical identity       | `provider_id/model_id`; `ModelV2.Ref` thêm `variant?`                                   | `Model.id` + `provider`/API; wire/API quirks trong model                            | `Model.id` có thể khác `requestModelId`; identity/equivalence riêng                                   |
| Nơi sở hữu catalog     | Runtime `Catalog` theo provider, model; metadata từ OpenCode Models API                 | Từng `Provider<TApi>`; `Models` collection điều phối                                | Bundled `models.json` + manager/cache/discovery/provider descriptors                                  |
| Discovery/cache        | OpenCode Models endpoint, embedded snapshot/cache, refresh policy                       | Dynamic provider hook + `ModelsStore` (`etag`, `Last-Modified`, `checkedAt`)        | SQLite cache, fingerprint/authority/stale, static→cache→remote→dynamic                                |
| Variant/thinking       | Named per-model request overrides; `VariantID` mở; merge variant cuối                   | Reasoning level capability/request (`ModelThinkingLevel`), không có variant records | Explicit `ThinkingConfig`; collapse nhiều upstream IDs thành logical model, route wire ID theo effort |
| Cost shape             | `Cost[]`, context tiers, input/output/cache read/write metadata                         | Rates USD/million, tiers theo tổng input, cacheWrite1h                              | Rates USD/million, long-context threshold, orchestration và CTTL cache                                |
| Usage shape            | AI SDK input/output/total/reasoning/cache read/write; Copilot raw billing exception     | input/output/cacheRead/cacheWrite/cacheWrite1h/reasoning/total + cost               | Nhiều bucket hơn: orchestration, premium, credits, CTTL, server tools; quota report riêng             |
| Provider policy        | API native/AI SDK, availability, small model và endpoint transforms                     | Provider factory, `compat`, auth filter, generator quirks                           | `ProviderCatalogEntry`, authoritative discovery, provider-specific generator/quota modules            |
| Mức độ tin cậy billing | Cited adapter không cho thấy generic local multiplier; Copilot raw chunks authoritative | Tính cost cục bộ từ model rates + usage                                             | Có estimated token cost và provider quota/credit surfaces; không phải mọi billing đều token-based     |


## 5. Wincode hiện tại: cấu trúc cũ và rủi ro stale

Các quan sát sau dựa trên worktree hiện tại của Wincode:

1. `packages/ai/src/models.ts` chứa `modelCatalog` tĩnh, `connectionProviderIds`/`modelRuntimeProviderIds` đóng và `modelVariantIds = ["none", "thinking", "minimal", "low", "medium", "high", "xhigh", "max"]`. Mỗi entry có `connectionProviderId`, display name, ID runtime/provider và mảng variants thủ công. Cấu trúc này dễ dùng cho allowlist UI nhưng không đại diện discovery/availability động hay variant mở theo model.
2. `getCatalogVariants()` ưu tiên `model.variants`; chỉ khi mảng rỗng mới fallback sang generated `modelVariantsByProviderModel`. Đây là hai nguồn policy cùng tồn tại, nên variant mới có thể bị che bởi mảng thủ công cũ.
3. `packages/ai/src/model-provider-options.ts` có các map model-specific (`reasoningSummaryModels`, `anthropicAdaptiveModels`, `anthropicManualModels`, `anthropicBudgets`, `googleLevelModels`, `googleBudgets`) và resolver tách theo provider. File còn TODO yêu cầu reconcile manual reasoning-budget tables với pipeline `scripts/sync-model-pricing.ts` đã xóa. Đây là dấu hiệu source-of-truth chưa liền mạch.
4. `packages/ai/src/generated/model-variants.generated.ts` ghi được generate bởi `scripts/sync-model-pricing.ts` từ `https://models.dev/api.json`, snapshot 2026-08-08. `wincode-cli/modules/model-pricing/model-pricing-snapshot.generated.ts` cũng là snapshot cùng ngày/source. Nếu catalog, variant và pricing refresh khác nhịp, UI/runtime có thể dùng metadata không cùng revision.
5. `packages/ai/src/model-usage.ts` chuẩn hóa input/output/reasoning/cache read/cache write/total, nhưng `calculateModelUsageCost()` chỉ tính uncached input, cache read (fallback về input rate) và output. `cacheWriteTokens` và `reasoningTokens` không tạo thành dòng cost riêng. Đây không nhất thiết sai nếu upstream billing contract coi chúng như input/output, nhưng hiện không có metadata đủ để biết trường hợp nào.
6. `wincode-cli/modules/model-pricing/model-pricing.ts` giải quyết một `ModelPricingEntry` theo key `${provider}/${modelId}`, gồm `contextLimit` và cost optional; `models-dev-response.ts` parse `cache_read`, `cache_write`, `input`, `output`, `limit.context` từ models.dev. Không thấy cấu trúc tier/long-context trong Wincode entry hiện tại.
7. `fetch-model-pricing.ts` dùng `https://models.dev/api.json`, timeout 5 giây và coverage guard dưới 50%; context provider cache TTL 24 giờ, hiển thị snapshot/cache stale rồi refresh nền. Đây là cơ chế tốt cho pricing resilience, nhưng không tự giải quyết catalog identity, variant policy hay provider-specific billing authority.
8. `CONTEXT.md` đã phân biệt Model Catalog, Model Target và session metadata; `docs/adding-a-provider.md` yêu cầu static entry, identity provider/model, variants, provider policy và resolver. Phần khái niệm này phù hợp với kết quả đối chiếu, nhưng implementation vẫn dồn nhiều policy vào enum/map tĩnh.

### Rủi ro cần gọi đúng tên

- **Stale source-of-truth**: generated pricing/variants, static catalog và manual provider maps có thể lệch snapshot. Đây là rủi ro bảo trì; chưa phải bằng chứng một model cụ thể đang sai.
- **Closed variant surface**: enum toàn cục khiến provider mới hoặc effort mới phải sửa schema/map trung tâm, trái với variant mở theo model của OpenCode và thinking metadata của OMP.
- **Pricing under-modeling**: thiếu tier/long-context/CTTL có thể làm giá ước tính sai khi provider tính theo ngưỡng hoặc cache lifetime.
- **Usage-vs-billing conflation**: token usage chung không bao phủ premium requests, credits, quota windows hoặc raw authoritative billing của provider.
- **Identity collapse chưa đủ**: cặp provider/model đã có, nhưng chưa biểu diễn rõ local logical ID và wire `requestModelId`, cũng như route theo variant/effort.

## 6. Hàm ý thiết kế cho Wincode

Các đề xuất dưới đây là khuyến nghị thiết kế rút ra từ ba upstream, không phải yêu cầu phải sao chép toàn bộ hệ thống:

1. **Giữ Model Catalog, Model Target và usage tách biệt.** Duy trì allowlist sản phẩm riêng với metadata remote; `Model Target` nên là identity hiệu dụng `(connectionProviderId, modelId, variant)` cộng authorization/runtime context. Persist variant được chọn trong session metadata như `CONTEXT.md` đã định hướng.
2. **Đổi variant từ enum global thành policy theo model/provider.** Dùng named request overrides hoặc `ThinkingConfig`-like metadata: mode, ordered efforts, default, effort map/budget, suppression khi off và wire routing. Resolver provider-specific chỉ tiêu thụ policy; không hardcode mọi model vào một file map.
3. **Tách static support khỏi discovery.** Một entry nên nói rõ `source`, `stale`, `updatedAt`, `authoritative`, static fingerprint và wire ID. Cho phép baseline tĩnh, cache last-known và remote discovery merge theo model ID; provider credential-scoped có thể authoritative và không nên lộ như catalog public.
4. **Mở rộng cost model trước khi thêm provider.** Tối thiểu biểu diễn `input`, `output`, `cacheRead`, `cacheWrite`, các `tiers` theo ngưỡng context và long-context tier. Nếu cần Anthropic-style cache lifetime, thêm TTL bucket thay vì nhét vào input rate. Công thức phải ghi rõ tier dùng tổng input nào và orchestration có tính hay không.
5. **Giữ usage raw và phân loại độ tin cậy.** Chuẩn hóa cache read/write, reasoning, total nhưng giữ raw provider metadata. Đánh dấu `estimated` cho cost nhân từ catalog; dành trường/surface `authoritative` cho Copilot, credits, premium requests, quota và provider billing không dựa trên token.
6. **Khôi phục một pipeline sinh dữ liệu có version.** TODO trong `model-provider-options.ts` nên được giải quyết bằng một source/pipeline duy nhất hoặc manifest versioned dùng chung cho catalog, variants và pricing. Snapshot cần ghi source URL, revision/schema, ngày fetch, coverage và fallback reason; không để generated file và manual map âm thầm trôi khác nhịp.
7. **Giữ provider exceptions ở descriptor/resolver boundary.** Provider descriptor nên khai báo API, auth/env, discovery authority, endpoint/wire-ID transform, small-model policy và quota adapter; core model record không nên biết mọi ngoại lệ của Azure/Bedrock/Copilot/Gemini.
8. **Không dùng giá để suy ra availability hoặc capability.** Capability, modality, limits, status, enabled và credential availability cần trường riêng; cost zero của model được discover không có nghĩa model miễn phí hay billing chắc chắn bằng zero.

## Nguồn chính

Tất cả liên kết dưới đây là source chính thức/repository chính thức; truy cập ngày 2026-09-11. Các revision GitHub được pin để việc đối chiếu có thể lặp lại.

### OpenCode

- [OpenCode Models documentation](https://opencode.ai/docs/models) — identity provider/model, loading order, built-in/custom variants.
- [OpenCode Providers documentation](https://opencode.ai/docs/providers) — provider configuration và integrations.
- [`packages/schema/src/model.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/schema/src/model.ts) — `ModelV2.ID`, `Ref`, `Info`, `Cost`, capabilities/limits/variants.
- [`packages/schema/src/provider.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/schema/src/provider.ts) — provider/API/request schemas.
- [`packages/core/src/model.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/model.ts) — model wrapper/types.
- [`packages/core/src/catalog.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/catalog.ts) — provider/model registry, availability và projection.
- [`packages/core/src/models-dev.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/core/src/models-dev.ts) — remote catalog schema, source URL, cache/refresh/fallback.
- [`packages/opencode/src/provider/provider.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/provider/provider.ts) — runtime provider resolution và provider exceptions.
- [`packages/opencode/src/session/llm/request.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/llm/request.ts) — options/variant merge và request transforms.
- [`packages/opencode/src/session/llm/ai-sdk.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/llm/ai-sdk.ts) — usage normalization, finish events và Copilot raw usage.
- [`packages/opencode/src/session/llm.ts`](https://github.com/anomalyco/opencode/blob/10765ff2a9da8c3b88e4de873aa383a49c318912/packages/opencode/src/session/llm.ts) — session LLM lifecycle.

### Pi

- [`packages/ai/README.md`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/README.md) — querying models, dynamic providers, thinking/reasoning, cost usage examples, adding provider.
- [`packages/ai/src/types.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/types.ts) — `Model`, `Usage`, `ModelCost`, thinking levels và compat.
- [`packages/ai/src/models.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/models.ts) — provider/model collection, refresh và `calculateCost`.
- [`packages/ai/src/models-store.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/models-store.ts) — persistent dynamic model state (`etag`, `Last-Modified`, `checkedAt`).
- [`packages/ai/src/models.generated.ts`](https://github.com/earendil-works/pi/blob/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/models.generated.ts) — generated built-in model map.
- [`packages/ai/src/providers/`](https://github.com/earendil-works/pi/tree/853a80d26c90a14c1886f0ebb8ffaae133ca2185/packages/ai/src/providers) — provider implementations and API-specific model handling.

### OMP

- [`packages/catalog/README.md`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/README.md) — catalog architecture, generated model database và discovery.
- [`packages/catalog/src/types.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/types.ts) — `Model`, `ModelSpec`, `ThinkingConfig`, `Usage`, `TokenCost`.
- [`packages/catalog/src/models.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/models.ts) — bundled lookup, long-context selection và usage cost calculation.
- [`packages/catalog/src/model-manager.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/model-manager.ts) — source precedence, cache/stale/authority và dynamic merge.
- [`packages/catalog/src/model-cache.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/model-cache.ts) — SQLite persistent cache và schema/fingerprint.
- [`packages/catalog/src/build.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/build.ts) — build-time materialization of models.
- [`packages/catalog/src/model-thinking.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/model-thinking.ts) — thinking metadata/policies.
- [`packages/catalog/src/variant-collapse.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/variant-collapse.ts) — logical model collapse và effort routing.
- [`packages/catalog/src/discovery/openai-compatible.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/discovery/openai-compatible.ts) — OpenAI-compatible discovery.
- [`packages/catalog/src/discovery/gemini.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/discovery/gemini.ts) — Gemini discovery.
- [`packages/catalog/src/provider-models/descriptors.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/provider-models/descriptors.ts) — provider catalog descriptors.
- [`packages/catalog/src/provider-models/descriptor-types.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/src/provider-models/descriptor-types.ts) — descriptor contract.
- [`packages/catalog/scripts/generate-models.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/catalog/scripts/generate-models.ts) — source generation, discovery-only/credential-scoped providers, pricing overrides.
- [`packages/ai/src/usage.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage.ts) — quota/report/observed usage surface.
- [`packages/ai/src/usage/github-copilot.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage/github-copilot.ts) — Copilot quota/billing.
- [`packages/ai/src/usage/gemini.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage/gemini.ts) — Gemini quota.
- [`packages/ai/src/usage/cursor.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage/cursor.ts) — Cursor usage rails.
- [`packages/ai/src/usage/openai-codex.ts`](https://github.com/can1357/oh-my-pi/blob/51f03804476c3fd3c15748ae07e4849d1efc883b/packages/ai/src/usage/openai-codex.ts) — Codex usage/rate limits.

### Wincode worktree evidence

- `packages/ai/src/models.ts` — static catalog, provider IDs, closed `modelVariantIds`, `getCatalogVariants()` và identity pair.
- `packages/ai/src/model-provider-options.ts` — provider option resolver, model-specific reasoning maps và sync pipeline TODO.
- `packages/ai/src/generated/model-variants.generated.ts` — generated variants snapshot từ models.dev.
- `packages/ai/src/model-usage.ts` — usage normalization và cost formula hiện tại.
- `wincode-cli/modules/model-pricing/model-pricing.ts` — runtime pricing table keyed provider/model.
- `wincode-cli/modules/model-pricing/models-dev-response.ts` — models.dev parser.
- `wincode-cli/modules/model-pricing/fetch-model-pricing.ts` — remote fetch, timeout và coverage guard.
- `wincode-cli/modules/model-pricing/context/model-pricing-provider.tsx` — 24-hour cache/stale background refresh.
- `CONTEXT.md` — Model Catalog/Model Target/session metadata vocabulary.
- `docs/adding-a-provider.md` — provider/model/variant/resolver extension instructions.

