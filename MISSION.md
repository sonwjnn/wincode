# Mission: So sánh và cải thiện kiến trúc system prompt

## Why
Bạn muốn hiểu sâu cách Pi, Oh My Pi và OpenCode xây dựng system prompt từ source thật, để có thể đánh giá và cải thiện Wincode có chủ đích thay vì sao chép template. Kết quả thực tế là đọc được composition pipeline, nhìn ra trade-off, rồi đề xuất thay đổi prompt có thể kiểm chứng.

## Success looks like
- Vẽ lại đúng pipeline ghép prompt của Pi, OMP và OpenCode từ source đã pin.
- Phân biệt được static base, dynamic context, tool schema, rules/skills và compaction prompt.
- Giải thích được trade-off của từng composition seam và chọn thiết kế phù hợp cho Wincode.
- Viết được một bản thiết kế system-prompt assembly cho Wincode với thứ tự block và provenance rõ ràng.

## Constraints
- Học bằng tiếng Việt, theo các bài ngắn có bài tập retrieval và feedback ngay.
- Ưu tiên source code, official documentation và revision cố định.
- Tập trung vào so sánh kiến trúc; chưa vội triển khai rewrite production.

## Out of scope
- Tối ưu prompt cho một provider/model cụ thể.
- Viết lại toàn bộ runtime hoặc compaction implementation của Wincode.
- Các kỹ thuật prompt engineering không liên quan đến composition architecture.
