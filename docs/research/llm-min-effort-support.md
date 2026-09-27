# Có API LLM nào hỗ trợ wire value `min` cho reasoning effort?


|                    |                                                                                                                |
| ------------------ | -------------------------------------------------------------------------------------------------------------- |
| Ngày nghiên cứu    | 2026-09-27                                                                                                     |
| Phạm vi            | Giá trị wire chính xác `min` (chữ thường), không đồng nhất với `minimal`, `MINIMAL`, `low` hay token budget   |
| Nguồn              | Tài liệu API/model catalog chính thức của OpenAI, Anthropic, Google Gemini, xAI, Mistral và DeepSeek        |
| Currentness        | Các trang live được kiểm tra ngày nghiên cứu; trang không công bố ngày cập nhật/revision riêng                 |
| Quy ước            | Chỉ ghi nhận hợp đồng được tài liệu hóa; không suy luận từ SDK, UI, bên trung gian hoặc hành vi chưa kiểm chứng |


## Kết luận

**Chưa tìm thấy nguồn chính thức nào trong phạm vi khảo sát xác nhận `min` là giá trị effort hợp lệ.** Tài liệu hiện hành dùng token khác: OpenAI, Mistral và một số API Google có `minimal`; DeepSeek còn ghi rõ `minimal` là alias được map thành `low`; Google GenerateContent API dùng enum wire `MINIMAL`. Không chuỗi nào trong số đó là `min`.

Đây là kết luận về **bằng chứng tài liệu**, không phải chứng minh rằng mọi API/model/provider trên thị trường đều từ chối `min`: khảo sát không thể bao phủ mọi model host, proxy hoặc alias không được công bố. Không có request thử nghiệm bằng credential để kiểm chứng cách server xử lý giá trị chưa tài liệu hóa.

## Đối chiếu nguồn chính thức


| Provider / model scope | Field và giá trị được công bố | Ý nghĩa với `min` |
| ---------------------- | ---------------------------- | ----------------- |
| **OpenAI — GPT-5** (Responses / Chat Completions) | [`reasoning.effort` / `reasoning_effort`](https://developers.openai.com/api/docs/models/gpt-5): `minimal`, `low`, `medium`, `high`. [Guide chung](https://developers.openai.com/api/docs/guides/reasoning) nói tập giá trị phụ thuộc model và có thể gồm `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. | Có `minimal`, không có `min` trong danh sách model. |
| **OpenAI — GPT-6 Astra** | [Model reference](https://developers.openai.com/api/docs/models/gpt-6-astra): `reasoning.effort` hỗ trợ `low`, `medium`, `high`, `xhigh`, `max`. | Model hiện được tài liệu giới thiệu là mạnh nhất; không liệt kê `min` hoặc `minimal`. |
| **Google Gemini — GenerateContent API** | [`generationConfig.thinkingConfig.thinkingLevel`](https://ai.google.dev/api/generate-content#ThinkingLevel) là enum `THINKING_LEVEL_UNSPECIFIED`, `MINIMAL`, `LOW`, `MEDIUM`, `HIGH`. [Thinking guide](https://ai.google.dev/gemini-api/docs/thinking) cũng mô tả `thinking_level` và mức hỗ trợ theo model cho Interactions API; ví dụ `gemini-3.8-flash` hỗ trợ `low`, `medium`, `high`. | Wire enum là `MINIMAL`, không phải `min`; giá trị hỗ trợ phụ thuộc API/model. |
| **Anthropic — Messages API** | [`output_config.effort`](https://platform.claude.com/docs/en/api/messages): các giá trị hợp lệ `low`, `medium`, `high`, `xhigh`, `max`. | Không liệt kê `min` hoặc `minimal`. |
| **xAI — Grok 4.5/4.6/4.7** | [Reasoning docs](https://docs.x.ai/developers/model-capabilities/text/reasoning): `reasoning_effort` nhận `low`, `medium`, `high`; `xhigh` có trên Grok 4.6 trở lên. | Không liệt kê `min` hoặc `minimal`. |
| **Mistral — Chat Completions API** | [API schema](https://docs.mistral.ai/api/endpoint/chat) liệt kê `reasoning_effort`: `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. | Có `minimal`, không liệt kê `min`. |
| **DeepSeek — Chat Completions** (`deepseek-flash`, `deepseek-v4-pro`) | [API reference](https://api-docs.deepseek.com/api/create-chat-completion) liệt kê `none`, `low`, `high`, `max`; nói rõ `minimal` là alias tương thích được map thành `low` (còn `medium`/`xhigh` map thành `high`). | Tài liệu phân biệt alias `minimal`; không công bố alias hoặc wire value `min`. |

## Ghi chú về ngày nguồn

Tài liệu trên là các trang chính thức được mở trực tiếp ngày **2026-09-27**. Trang tài liệu không hiển thị timestamp cập nhật/revision riêng; model reference của OpenAI ghi snapshot `gpt-5-2025-08-07`, còn model reference GPT-6 Astra không ghi snapshot có ngày. Ngày snapshot (nếu có) không phải ngày sửa tài liệu.

## Phân biệt selector Wincode `none` / `thinking` với wire value Qwen

### Phạm vi kiểm tra

Snapshot được commit tại `packages/ai/src/generated/model-metadata.generated.ts` có ngày `2026-09-13` và ghi nhận 49 model catalog đang active. `getSupportedModelVariants` trong `packages/ai/src/model-metadata-runtime.ts:41-65` tạo lựa chọn từ policy của từng model: có `levels` thì dùng ladder (thêm `none` nếu policy có `toggle`); không có ladder và không phải `unlevelled` thì policy có `toggle` đưa ra `none` + `thinking`. `thinking` là tên selector nội bộ Wincode cho trạng thái bật, không phải mức do Qwen công bố.

### Các selector hiện được Wincode expose

Giao của catalog đang active, metadata snapshot và `supportsReasoningVariants` (`packages/ai/src/catalog.ts:550-553`) cho kết quả:

- Có selector `none`: `openai/gpt-5.6`, `openai/gpt-5.6-sol`, `openai/gpt-5.6-terra`, `openai/gpt-5.6-luna`, `anthropic/claude-sonnet-5`, `opencode-go/gpt-5.6-luna`, `opencode-go/minimax-m3`, `opencode-go/qwen3.8-max`, `opencode-go/qwen3.8-flash`, `opencode-go/qwen3.7-max`, `opencode-go/qwen3.7-plus`, `opencode-go/qwen3.6-plus`.
- Có selector `thinking`: `opencode-go/minimax-m3`, `opencode-go/qwen3.7-max`, `opencode-go/qwen3.7-plus`, `opencode-go/qwen3.6-plus`.

Riêng các Qwen trong snapshot (`packages/ai/src/generated/model-metadata.generated.ts:807-910`):

| Model | Policy snapshot | Selector Wincode |
| ------ | --------------- | ---------------- |
| Qwen3.8 Max / Flash | `toggle: true`, ladder `low`, `medium`, `xhigh` | `none` và ba mức trên; **không** có `thinking` |
| Qwen3.7 Max / Plus; Qwen3.6 Plus | `toggle: true`, có `budgetMax`, không có ladder hoặc `unlevelled` | `none` và `thinking` |

Đây là khả năng lựa chọn của Wincode, không phải tập giá trị wire của Qwen. Metadata có thể chứa toggle/`none` mà Wincode không expose: `supportsReasoningVariants` loại các entry OpenCode Go dùng `openai-compatible`; ví dụ LongCat-2.0, DeepSeek V4 Flash Vision Exp, Hy4 preview và Hy3.

### Qwen: tài liệu API và provider mapping

Tài liệu chính thức của [Qwen Quickstart](https://qwen.readthedocs.io/en/latest/getting_started/quickstart.html) minh họa `enable_thinking=True` / `False` như boolean truyền vào `tokenizer.apply_chat_template`; `/think` và `/no_think` được mô tả riêng là chỉ thị trong prompt. Tài liệu API chính thức của [Alibaba Cloud Model Studio — DashScope API Reference](https://help.aliyun.com/en/model-studio/qwen-api-via-dashscope) mô tả `enable_thinking` là boolean `true` / `false`, đặt trong `parameters` khi gọi HTTP, cho các model hybrid được liệt kê như Qwen3.7 và Qwen3.6 (mục này không liệt kê Qwen3.8). Cùng tài liệu đó liệt kê `thinking_budget` là số nguyên và, riêng Qwen3.8, `reasoning_effort` nhận `xhigh`, `medium`, `low`; tài liệu không xác nhận selector `none` của Wincode tương ứng với tắt reasoning ở API Qwen3.8.

Các trang trên **không liệt kê chuỗi `none` hoặc `thinking` là giá trị wire hợp lệ của Qwen**. `thinking mode` trong văn xuôi hoặc `/think` trong prompt không phải một giá trị JSON/API. Kết luận này giới hạn ở hợp đồng được công bố trong các tài liệu nêu trên; không khẳng định mọi host/proxy của Qwen đều có cùng API.

Wincode cũng không gọi trực tiếp API DashScope cho các Qwen này: `packages/ai/src/catalog.ts:379-422` khai báo chúng là OpenCode Go với `protocol: "anthropic"`, và `reasoningWiring` trong `packages/ai/src/model-provider-options.ts:311-316` chọn wiring theo protocol đó. Ở ranh giới provider-options, `resolveReasoning` / `anthropicThinking` (`packages/ai/src/model-provider-options.ts:255-279,407-513`) chuyển `none` thành `anthropic.thinking: { type: "disabled" }`; với Qwen3.7/3.6, selector `thinking` chuyển thành `anthropic.thinking: { type: "enabled", budgetTokens: ... }` với budget suy ra từ policy.

Request serializer trong `packages/ai/src/model-client/request.ts:539-563,685-743` gửi OpenCode Go tới `https://opencode.ai/zen/go/v1/messages`: khi type là `disabled`, body bỏ hẳn field `thinking`; khi enabled, body gửi `thinking: { type: "enabled", budget_tokens: ... }`. Contract hiện có xác nhận Qwen3.7 Max ở giới hạn output mặc định dùng `budget_tokens: 8000` (`packages/ai/test/model-contracts.test.ts:265-290`). Vậy outbound body của Wincode không gửi chuỗi `"none"` / `"thinking"` hoặc `enable_thinking`; cách OpenCode Go chuyển tiếp các trường này tới backend Qwen không được xác lập bởi repo hay các tài liệu trên.

`none` có thể được serialize khác tùy adapter: chẳng hạn OpenAI mapping trả `reasoningEffort: "none"`, còn Anthropic mapping dùng `type: "disabled"` (`model-provider-options.ts:318-328,443-501`). Không nên đổi tên hoặc diễn giải selector Wincode như wire enum chung cho mọi provider.
