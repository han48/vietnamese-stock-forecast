# Vietnamese Stock Forecast

Ứng dụng dự báo giá cổ phiếu Việt Nam chạy hoàn toàn trên trình duyệt, không cần backend. Dữ liệu lịch sử được scrape từ CafeF và lưu vào SQLite. Mô hình ARIMA/ARIMAX chạy trong Web Worker. Tích hợp AI chat (Qwen3-0.6B, WebGPU) để hỏi đáp về kết quả phân tích.

Oneline demo: [huggingface](https://huggingface.co/spaces/mr4/vietnamese-stock-forecast)

---

## Tính năng

- **ARIMA** — Dự báo giá đóng cửa với Grid Search AIC tự động tìm tham số (p, d, q)
- **ARIMAX** — ARIMA mở rộng với features OHLCV: Log Return, H-L Range, Volume/MA5, RSI 14, MACD Histogram, VAR(1)
- **Candlestick chart** — Biểu đồ nến kết hợp dự báo và khoảng tin cậy 95%
- **AI Chat** — Hỏi đáp về kết quả phân tích bằng tiếng Việt, tự động truy vấn DB theo ngày/mã được đề cập
- **Offline-first** — DB được cache trên trình duyệt (Cache API), không cần reload mỗi lần

---

## Cấu trúc

```
├── index.html             # Frontend chính
├── app.js                 # Logic UI, ARIMA worker, AI chat
├── arima.worker.js        # ARIMA chạy trong Web Worker
├── arimax.worker.js       # ARIMAX chạy trong Web Worker
├── llm.worker.js          # LLM inference (transformers.js + WebGPU)
├── style.css
├── native.wasm            # WASM binary
├── native-async.js        # WASM loader
├── stocks.db              # SQLite database
├── vietstock_scraper.py   # Scraper lấy dữ liệu từ CafeF API
└── scraper_cli.py         # CLI để chạy scraper
```

---

## Cài đặt & Chạy

### 1. Cài dependencies Python

```bash
pip install requests pandas
```

### 2. Scrape dữ liệu

```bash
# Lần đầu: tải danh sách tất cả mã
python scraper_cli.py --load-symbols

# Tải dữ liệu lịch sử tất cả mã (incremental)
python scraper_cli.py

# Tải từ ngày cụ thể
python scraper_cli.py --start-date 01/01/2023

# Tải 1 mã cụ thể
python scraper_cli.py --symbol FPT --start-date 01/01/2024
```

### 3. Serve frontend

Cần serve qua HTTP (không mở file:// trực tiếp vì WASM và Worker yêu cầu HTTP):

```bash
python3 -m http.server 8080
```

Mở trình duyệt: `http://localhost:8080`

---

## AI Chat

- Model: **Qwen3-0.6B** ([onnx-community/Qwen3-0.6B-ONNX](https://huggingface.co/onnx-community/Qwen3-0.6B-ONNX)), chạy trên WebGPU
- Lần đầu tải ~750 MB, sau đó được cache trên trình duyệt
- Yêu cầu trình duyệt hỗ trợ WebGPU (Chrome 113+, Edge 113+)
- Tự động truy vấn DB khi hỏi về mã/ngày cụ thể (ví dụ: *"Giá FPT ngày 2026/02/06 thế nào?"*)
- Chỉ lấy context của mã được đề cập, không dump toàn bộ dữ liệu vào prompt

---

## Database Schema

```sql
stock_prices (symbol, date, open, high, low, close, adj_close, volume, value, change, percent_change)
symbols      (symbol, updated_at)
meta         (key, value)   -- lưu last_symbol_load, last_price_load
```

---

## Nguồn dữ liệu

Dữ liệu lịch sử lấy từ API công khai của [CafeF](https://cafef.vn). Chỉ dùng cho mục đích học tập và nghiên cứu.
