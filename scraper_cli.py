"""
CLI scraper — chạy độc lập, không liên quan đến Gradio app.

Cách dùng:
  # Tải danh sách tất cả mã vào DB
  python scraper_cli.py --load-symbols

  # Tải 1 mã cụ thể
  python scraper_cli.py --symbol FPT --start-date 01/01/2024

  # Tải tất cả mã (incremental từ lần chạy trước)
  python scraper_cli.py

  # Tải tất cả mã từ đầu
  python scraper_cli.py --start-date 01/01/2020 --end-date 31/12/2024

  # Chỉ định đường dẫn DB khác
  python scraper_cli.py --symbol VNM --db /data/stocks.db
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

# Đảm bảo import được vietstock_scraper trong cùng folder
sys.path.insert(0, str(Path(__file__).parent))

from vietstock_scraper import (
    download_all_stocks,
    fetch_all_symbols,
    get_historical_stock_data,
    get_meta,
    init_db,
    load_symbols_from_db,
    save_to_db,
    set_meta,
)

DEFAULT_DB = str(Path(__file__).parent / "stocks.db")


def parse_args():
    parser = argparse.ArgumentParser(
        description="Vietnam Stock Scraper — tải dữ liệu lịch sử từ CafeF vào SQLite.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument(
        "--symbol", type=str, default=None,
        help="Mã cổ phiếu (vd: FPT). Bỏ trống để tải tất cả mã trong DB.",
    )
    parser.add_argument(
        "--start-date", type=str, default=None,
        metavar="DD/MM/YYYY",
        help="Ngày bắt đầu. Mặc định: dùng last_price_load (incremental) hoặc từ đầu.",
    )
    parser.add_argument(
        "--end-date", type=str, default=None,
        metavar="DD/MM/YYYY",
        help="Ngày kết thúc. Mặc định: hôm nay.",
    )
    parser.add_argument(
        "--db", type=str, default=DEFAULT_DB,
        help=f"Đường dẫn file SQLite (mặc định: {DEFAULT_DB})",
    )
    parser.add_argument(
        "--delay", type=float, default=0.5,
        help="Delay (giây) giữa các request khi tải nhiều mã (mặc định: 0.5).",
    )
    parser.add_argument(
        "--load-symbols", action="store_true", default=False,
        help="Tải và lưu danh sách tất cả mã vào DB trước khi scrape.",
    )
    return parser.parse_args()


def main():
    args = parse_args()

    if args.end_date is None:
        args.end_date = datetime.now().strftime("%d/%m/%Y")

    print("🚀 Vietnam Stock Scraper")
    print(f"📅 start_date : {args.start_date or '(tự động)'}")
    print(f"📅 end_date   : {args.end_date}")
    print(f"💾 Database   : {args.db}\n")

    Path(args.db).parent.mkdir(parents=True, exist_ok=True)
    conn = init_db(args.db)

    # Hiển thị trạng thái DB
    last_sym   = get_meta(conn, "last_symbol_load")
    last_price = get_meta(conn, "last_price_load")
    if last_sym:
        print(f"📋 last_symbol_load : {last_sym}")
    if last_price:
        print(f"📋 last_price_load  : {last_price}")
    if last_sym or last_price:
        print()

    try:
        # Bước 1: Load symbols nếu được yêu cầu
        if args.load_symbols:
            symbols = fetch_all_symbols(conn)
            print(f"📋 Đã lưu {len(symbols)} mã vào bảng symbols\n")

        # Bước 2: Scrape dữ liệu
        if args.symbol:
            # Tải 1 mã cụ thể
            df, code = get_historical_stock_data(args.symbol, args.start_date, args.end_date)
            save_to_db(conn, df, code)
            print(f"\n✅ Đã lưu {len(df)} phiên giao dịch của {code} vào {args.db}")
            print(f"\n📋 Preview (10 dòng đầu):")
            print(df.head(10).to_string(index=False))
        else:
            # Tải tất cả mã
            symbols = load_symbols_from_db(conn)
            if not symbols:
                print("⚠️  Bảng symbols rỗng.")
                print("   Chạy với --load-symbols để tải danh sách mã trước.")
                return

            # Quyết định start_date
            if args.start_date is not None:
                effective_start = args.start_date
                print(f"📅 start_date tường minh: {effective_start}")
            else:
                if last_price:
                    effective_start = datetime.strptime(
                        last_price, "%Y-%m-%d %H:%M:%S"
                    ).strftime("%d/%m/%Y")
                    print(f"📅 Incremental từ last_price_load: {effective_start}")
                else:
                    effective_start = None
                    print("📅 Chưa có last_price_load → load toàn bộ lịch sử")

            conn.close()
            conn = None
            results = download_all_stocks(effective_start, args.end_date, args.db, args.delay)
            print(f"\n✅ Hoàn thành! Đã lưu {len(results)} mã vào {args.db}")

    except Exception as exc:
        print(f"\n❌ Lỗi: {exc}")
        import traceback
        traceback.print_exc()
    finally:
        if conn:
            conn.close()


if __name__ == "__main__":
    main()
