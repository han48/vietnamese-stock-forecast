"""
Vietnam stock historical data scraper.
Gọi trực tiếp API công khai của CafeF bằng requests thuần.
Lưu dữ liệu vào SQLite database.

Yêu cầu: requests, pandas (đã có trong requirements.txt)
"""

import re
import sqlite3
import time
from datetime import datetime
from pathlib import Path
from urllib.parse import urlparse

import pandas as pd
import requests

# ── Constants ────────────────────────────────────────────────────────────────

_URL_CAFE = "https://cafef.vn/du-lieu/ajax/pagenew/datahistory/pricehistory.ashx"
_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Referer": "https://cafef.vn/",
}
_RE_CHANGE = re.compile(r"([-+]?\d*\.?\d+)\s*\(\s*([-+]?\d*\.?\d+)\s*%\s*\)")
_PAGE_SIZE = 1000  # records per page khi fetch danh sách mã


# ── Database ──────────────────────────────────────────────────────────────────

def init_db(db_path: str) -> sqlite3.Connection:
    """Tạo database và bảng nếu chưa có."""
    conn = sqlite3.connect(db_path)
    
    # Bảng giá cổ phiếu
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_prices (
            symbol          TEXT    NOT NULL,
            date            TEXT    NOT NULL,
            open            REAL,
            high            REAL,
            low             REAL,
            close           REAL,
            adj_close       REAL,
            volume          REAL,
            value           REAL,
            change          REAL,
            percent_change  REAL,
            PRIMARY KEY (symbol, date)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_symbol ON stock_prices(symbol)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_date   ON stock_prices(date)")
    
    # Bảng danh sách mã
    conn.execute("""
        CREATE TABLE IF NOT EXISTS symbols (
            symbol      TEXT PRIMARY KEY,
            updated_at  TEXT NOT NULL
        )
    """)

    # Bảng metadata (lưu mốc thời gian chạy)
    conn.execute("""
        CREATE TABLE IF NOT EXISTS meta (
            key     TEXT PRIMARY KEY,
            value   TEXT NOT NULL
        )
    """)

    conn.commit()
    return conn


def save_symbols_to_db(conn: sqlite3.Connection, symbols: list):
    """Lưu danh sách mã vào bảng symbols."""
    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rows = [(sym, now) for sym in symbols]
    conn.executemany("""
        INSERT OR REPLACE INTO symbols (symbol, updated_at)
        VALUES (?, ?)
    """, rows)
    conn.commit()


def load_symbols_from_db(conn: sqlite3.Connection) -> list:
    """Đọc danh sách mã từ bảng symbols."""
    cursor = conn.execute("SELECT symbol FROM symbols ORDER BY symbol")
    return [row[0] for row in cursor.fetchall()]


def get_meta(conn: sqlite3.Connection, key: str) -> str | None:
    """Đọc giá trị từ bảng meta."""
    row = conn.execute("SELECT value FROM meta WHERE key = ?", (key,)).fetchone()
    return row[0] if row else None


def set_meta(conn: sqlite3.Connection, key: str, value: str):
    """Ghi giá trị vào bảng meta."""
    conn.execute("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)", (key, value))
    conn.commit()


def save_to_db(conn: sqlite3.Connection, df: pd.DataFrame, symbol: str):
    """Lưu DataFrame vào SQLite, bỏ qua các dòng đã tồn tại (upsert)."""
    rows = []
    for _, row in df.iterrows():
        rows.append((
            symbol,
            row["Date"].strftime("%Y-%m-%d") if pd.notna(row["Date"]) else None,
            _nan_to_none(row.get("Open")),
            _nan_to_none(row.get("High")),
            _nan_to_none(row.get("Low")),
            _nan_to_none(row.get("Close")),
            _nan_to_none(row.get("Adj_Close")),
            _nan_to_none(row.get("Volume")),
            _nan_to_none(row.get("Value")),
            _nan_to_none(row.get("Change")),
            _nan_to_none(row.get("Percent_Change")),
        ))

    conn.executemany("""
        INSERT OR REPLACE INTO stock_prices
            (symbol, date, open, high, low, close, adj_close, volume, value, change, percent_change)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, rows)
    conn.commit()


# ── Public API ────────────────────────────────────────────────────────────────

def fetch_all_symbols(conn: sqlite3.Connection, ref_date: str = "2024-01-02") -> list:
    """
    Lấy toàn bộ danh sách mã từ CafeF, lưu vào bảng symbols, trả về list.

    Args:
        conn:     SQLite connection (để lưu kết quả)
        ref_date: Ngày tham chiếu 'yyyy-mm-dd'

    Returns:
        list: Danh sách mã đã sắp xếp
    """
    _INDEX_SYMBOLS = {"VNINDEX", "VN30", "HNX30", "HNXINDEX", "UPCOMINDEX",
                      "VN100", "VNALL", "VNXALL", "VNCOND", "VNCONS", "VNDIAMOND",
                      "VNENE", "VNFIN", "VNFINLEAD", "VNFINSELECT", "VNHEAL",
                      "VNIND", "VNIT", "VNMAT", "VNMID", "VNREAL", "VNSI",
                      "VNSML", "VNUTI", "VNX50", "ALL"}

    print("🔍 Đang lấy danh sách tất cả mã cổ phiếu từ CafeF...")
    symbols = set()
    page = 1

    while True:
        params = {
            "Symbol":    "ALL",
            "StartDate": ref_date,
            "EndDate":   ref_date,
            "PageIndex": page,
            "PageSize":  _PAGE_SIZE,
        }
        resp = requests.get(_URL_CAFE, params=params, headers=_HEADERS, timeout=30, verify=False)
        resp.raise_for_status()
        payload = resp.json()

        if not payload.get("Success") or not payload.get("Data"):
            break

        rows = payload["Data"].get("Data", [])
        if not rows:
            break

        batch = {r["Symbol"] for r in rows if r.get("Symbol") not in _INDEX_SYMBOLS}
        symbols.update(batch)

        total = payload["Data"].get("TotalCount", 0)
        fetched_so_far = (page - 1) * _PAGE_SIZE + len(rows)
        print(f"  Page {page}: +{len(batch)} mã | tổng unique: {len(symbols)} / ~{total}")

        if fetched_so_far >= total:
            break
        page += 1
        time.sleep(0.3)

    result = sorted(symbols)
    save_symbols_to_db(conn, result)
    set_meta(conn, "last_symbol_load", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    print(f"✅ Đã lưu {len(result)} mã vào database\n")
    return result


def get_historical_stock_data(url_or_symbol: str, start_date: str | None, end_date: str):
    """
    Lấy dữ liệu lịch sử giá cổ phiếu từ CafeF.

    Args:
        url_or_symbol: URL Vietstock hoặc mã cổ phiếu (vd: 'FPT').
        start_date:    Ngày bắt đầu 'dd/mm/yyyy', hoặc None để lấy toàn bộ lịch sử.
        end_date:      Ngày kết thúc 'dd/mm/yyyy'.

    Returns:
        tuple: (pd.DataFrame, symbol)
    """
    symbol = _parse_symbol(url_or_symbol)
    end_dt = datetime.strptime(end_date, "%d/%m/%Y")

    params = {
        "Symbol":   symbol,
        "EndDate":  end_dt.strftime("%Y-%m-%d"),
        "PageIndex": 1,
    }

    if start_date is not None:
        start_dt = datetime.strptime(start_date, "%d/%m/%Y")
        params["StartDate"] = start_dt.strftime("%Y-%m-%d")
        params["PageSize"]  = max((end_dt - start_dt).days + 1, 1)
    else:
        params["PageSize"] = 9999  # lấy toàn bộ lịch sử

    print(f"📡 Fetching {symbol} | {start_date or 'từ đầu'} → {end_date}...")

    resp = requests.get(_URL_CAFE, params=params, headers=_HEADERS, timeout=30, verify=False)
    resp.raise_for_status()

    payload = resp.json()
    if not payload.get("Success") or not payload.get("Data"):
        raise ValueError(f"CafeF lỗi cho '{symbol}': {payload.get('Message', 'unknown')}")

    raw_rows = payload["Data"].get("Data", [])
    if not raw_rows:
        raise ValueError(f"Không có dữ liệu cho '{symbol}' ({start_date} – {end_date}).")

    records = []
    for row in raw_rows:
        change_val, pct_change = _parse_change(row.get("ThayDoi", ""))
        records.append({
            "Date":           row.get("Ngay", ""),
            "Open":           _to_float(row.get("GiaMoCua")),
            "High":           _to_float(row.get("GiaCaoNhat")),
            "Low":            _to_float(row.get("GiaThapNhat")),
            "Close":          _to_float(row.get("GiaDongCua")),
            "Adj_Close":      _to_float(row.get("GiaDieuChinh")),
            "Volume":         _to_float(row.get("KhoiLuongKhopLenh")),
            "Value":          _to_float(row.get("GiaTriKhopLenh")),
            "Change":         change_val,
            "Percent_Change": pct_change,
        })

    df = pd.DataFrame(records)
    df["Date"] = pd.to_datetime(df["Date"], format="%d/%m/%Y", errors="coerce")
    df = df.sort_values("Date").reset_index(drop=True)

    print(f"  ✅ {len(df)} phiên giao dịch")
    return df, symbol


def download_all_stocks(start_date: str | None, end_date: str,
                        db_path: str = "stocks/stocks.db", delay: float = 0.5):
    """
    Tải dữ liệu lịch sử cho tất cả mã trong bảng symbols và lưu vào SQLite.

    Logic start_date:
      - None          → load từ đầu (bỏ qua last_price_load)
      - giá trị cụ thể → dùng đúng giá trị đó (bỏ qua last_price_load)
      Sau khi hoàn thành, lưu last_price_load = thời điểm hiện tại.

    Để chạy incremental (chỉ lấy dữ liệu mới), dùng demo_vietstock.py
    không truyền --start-date → script sẽ tự đọc last_price_load từ DB.
    """
    Path(db_path).parent.mkdir(parents=True, exist_ok=True)
    conn = init_db(db_path)

    symbols = load_symbols_from_db(conn)
    if not symbols:
        conn.close()
        raise RuntimeError(
            "Bảng symbols rỗng. Hãy chạy với --load-symbols trước để tải danh sách mã."
        )

    if start_date is None:
        # Không giới hạn ngày bắt đầu — lấy toàn bộ lịch sử CafeF có
        print("ℹ️  start_date=None → load toàn bộ lịch sử")
        effective_start = None
    else:
        effective_start = start_date

    results, failed = {}, []
    print(f"\n🚀 Bắt đầu tải {len(symbols)} mã | {effective_start or 'từ đầu'} → {end_date}")
    print(f"💾 Database: {Path(db_path).absolute()}\n")

    for i, symbol in enumerate(symbols, 1):
        try:
            df, code = get_historical_stock_data(symbol, effective_start, end_date)
            save_to_db(conn, df, code)
            results[code] = len(df)
            print(f"  [{i}/{len(symbols)}] ✅ {code}: {len(df)} rows")
            if i < len(symbols):
                time.sleep(delay)
        except Exception as e:
            failed.append((symbol, str(e)))
            print(f"  [{i}/{len(symbols)}] ❌ {symbol}: {e}")

    set_meta(conn, "last_price_load", datetime.now().strftime("%Y-%m-%d %H:%M:%S"))
    conn.close()

    print(f"\n📊 Tổng kết: ✅ {len(results)} thành công | ❌ {len(failed)} thất bại")
    if failed:
        print("⚠️  Thất bại:")
        for sym, err in failed[:10]:
            print(f"    - {sym}: {err[:80]}")
        if len(failed) > 10:
            print(f"    ... và {len(failed) - 10} mã khác")

    return results


# ── Helpers ───────────────────────────────────────────────────────────────────

def _parse_symbol(url_or_symbol: str) -> str:
    s = str(url_or_symbol).strip()
    if s.startswith("http"):
        path = urlparse(s).path.strip("/")
        return path.split("-")[0].upper()
    return s.upper()


def _to_float(value) -> float:
    try:
        return float(str(value).replace(",", "").strip())
    except (ValueError, TypeError):
        return float("nan")


def _nan_to_none(value):
    try:
        import math
        return None if math.isnan(float(value)) else float(value)
    except (TypeError, ValueError):
        return None


def _parse_change(text: str):
    m = _RE_CHANGE.search(str(text))
    if m:
        return float(m.group(1)), float(m.group(2))
    return float("nan"), float("nan")
