<img width="1882" height="1055" alt="image" src="https://github.com/user-attachments/assets/9b5dd771-e7b2-4cf9-9fb3-d7fea8238ae0" /># AI Usage Monitor

App Windows (Electron) hiện mức dùng gói **Claude** (Pro/Max) và **ChatGPT** (Plus/Pro): thanh % của phiên 5 giờ và giới hạn tuần, kèm đếm ngược reset. Có icon ở khay hệ thống, tự làm mới, tuỳ chọn luôn nằm trên cùng và chạy cùng Windows.

## Dùng

Bấm đúp `AI-Usage-Monitor.exe`. Ở mỗi thẻ bấm **Đăng nhập**: trình duyệt mặc định của máy mở ra, mày bấm cho phép, app tự nhận kết quả qua `localhost`.

- Claude dùng cổng **54545**, ChatGPT dùng cổng **1455**. Nếu Claude Code / Codex CLI đang đăng nhập cùng lúc thì cổng bị chiếm, đóng chúng rồi thử lại.
- Token lưu trong `%APPDATA%\ai-usage-monitor\tokens.bin`, mã hoá bằng DPAPI của Windows (chỉ tài khoản Windows này giải mã được).
- Bấm **Đăng xuất** để xoá token khỏi máy. Muốn thu hồi hẳn thì vào phần ứng dụng/phiên đăng nhập trong cài đặt tài khoản Claude / ChatGPT.

## Tính năng

- Widget nhỏ ở góc dưới phải, tự làm mới (mặc định 1 phút) và làm mới đúng lúc reset.
- Giờ reset hiện theo múi giờ của máy.
- Khi một giới hạn reset: dòng đó loé xanh, có hiệu ứng pháo hoa nhỏ, chữ "Reset!" và thông báo Windows.
- Từ 70%: thanh cam phát sáng, có vệt sáng chạy, % nhấp nháy; từ 90% chuyển đỏ và nhanh hơn. Lúc vừa vượt 70% dòng đó rung nhẹ và có thông báo.
- Ngày gia hạn gói: ChatGPT tự đọc từ token, Claude tự dò nếu có, không thì bấm dòng "Đặt ngày gia hạn" để nhập. Còn ≤3 ngày thì chuyển cam và nhắc một lần.
- Tiếng Việt / English: chuột phải icon ở khay → Ngôn ngữ / Language.
- Nhiều tài khoản, không giới hạn số lượng: bấm **+** trên widget (hoặc menu khay → Thêm tài khoản). Mỗi tài khoản có menu **⋯** để đổi tên, sắp xếp, đăng nhập lại, xoá. Đăng nhập lại cùng email thì app cập nhật tài khoản cũ chứ không tạo bản trùng.
- Thêm tài khoản thứ hai cùng bên: đổi tài khoản trên trình duyệt trước, hoặc bấm **Sao chép link** rồi dán vào cửa sổ ẩn danh / profile Chrome khác.
- Nhiều tài khoản quá thì bấm **≡** để thu gọn: mỗi tài khoản một dòng (mức dùng cao nhất + giờ reset gần nhất), bấm vào dòng để mở chi tiết.

## Chạy từ mã nguồn / build lại .exe

Cần Node.js và có mạng:

```
npm install
npm start          # chạy thử
npm test           # test logic
npm run dist       # ra dist\AI-Usage-Monitor.exe
```

## Lưu ý quan trọng

- Không có OAuth client chính thức cho app bên thứ ba đọc usage của gói đăng ký, nên app **mượn client_id của Claude Code và Codex CLI** (xem `src/oauth.js`). Trang xin quyền sẽ hiện là "Claude Code" / "Codex". Đây là vùng xám về điều khoản dịch vụ, có thể bị chặn bất cứ lúc nào.
- Các endpoint usage đều không công khai (`/api/oauth/usage` của Claude, `/backend-api/wham/usage` của ChatGPT). Họ đổi là app báo lỗi, khi đó sửa `src/usage.js` và `src/normalize.js`.
- Mặc định làm mới mỗi 2 phút, đừng đặt quá dày.
