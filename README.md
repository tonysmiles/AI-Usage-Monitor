<img width="1882" height="1055" alt="image" src="https://github.com/user-attachments/assets/9b5dd771-e7b2-4cf9-9fb3-d7fea8238ae0" /># AI Usage Monitor

App Windows (Electron) hiện mức dùng gói **Claude** (Pro/Max) và **ChatGPT** (Plus/Pro): thanh % của phiên 5 giờ và giới hạn tuần, kèm đếm ngược reset. Có icon ở khay hệ thống, tự làm mới, tuỳ chọn luôn nằm trên cùng và chạy cùng Windows.

## Dùng

Bấm đúp `AI-Usage-Monitor.exe`. Ở mỗi thẻ bấm **Đăng nhập**: trình duyệt mặc định của máy mở ra, mày bấm cho phép, app tự nhận kết quả qua `localhost`.

- Claude dùng cổng **54545**, ChatGPT dùng cổng **1455**. Nếu Claude Code / Codex CLI đang đăng nhập cùng lúc thì cổng bị chiếm, đóng chúng rồi thử lại.
- Token lưu trong `%APPDATA%\ai-usage-monitor\tokens.bin`, mã hoá bằng DPAPI của Windows (chỉ tài khoản Windows này giải mã được).
- Bấm **Đăng xuất** để xoá token khỏi máy. Muốn thu hồi hẳn thì vào phần ứng dụng/phiên đăng nhập trong cài đặt tài khoản Claude / ChatGPT.

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
