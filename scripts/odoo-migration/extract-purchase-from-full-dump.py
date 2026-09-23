#!/usr/bin/env python3
"""
从归档的完整 Odoo12 pg_dump（/Volumes/datacenter/04-eric/AIcoding/_archive/odoo12-full-dump-20260716.sql，
plain text 格式，非 -Fc）里直接抠出 purchase_order / purchase_order_line 两个 COPY 块，
不需要 restore 成本地 Postgres（省磁盘、省时间）。

COPY 块是 tab 分隔文本，每行一条记录，字段内的制表符/换行/反斜杠已被 pg_dump 转义成
\t \n \\，所以按行 split('\n') 后每行再按 '\t' split 就是完整字段，不会跨行。

输出：scripts/odoo-migration/exports/purchase_order.csv / purchase_order_line.csv
      列名沿用 sale_order.csv / sale_order_line.csv 的风格（externalId 对齐现有 Customer/Product 导入）
"""
import csv
import sys

DUMP_PATH = "/Volumes/datacenter/04-eric/AIcoding/_archive/odoo12-full-dump-20260716.sql"
OUT_DIR = "exports"

TABLES = {
    "purchase_order": {
        "marker": "COPY public.purchase_order (",
        "out": f"{OUT_DIR}/purchase_order.csv",
    },
    "purchase_order_line": {
        "marker": "COPY public.purchase_order_line (",
        "out": f"{OUT_DIR}/purchase_order_line.csv",
    },
}


def unescape(v: str) -> str:
    if v == "\\N":
        return ""
    return (
        v.replace("\\t", "\t")
        .replace("\\n", "\n")
        .replace("\\r", "\r")
        .replace("\\\\", "\\")
    )


def main():
    targets = {name: cfg for name, cfg in TABLES.items()}
    writers = {}
    files = {}
    columns = {}
    active = None

    with open(DUMP_PATH, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            if active is None:
                for name, cfg in targets.items():
                    if line.startswith(cfg["marker"]):
                        # 解析列名：括号内逗号分隔
                        inside = line[len(cfg["marker"]):].split(") FROM stdin;")[0]
                        cols = [c.strip() for c in inside.split(",")]
                        columns[name] = cols
                        fh = open(cfg["out"], "w", newline="", encoding="utf-8")
                        w = csv.writer(fh)
                        w.writerow(cols)
                        writers[name] = w
                        files[name] = fh
                        active = name
                        print(f"-- 开始导出 {name}: {len(cols)} 列 -> {cfg['out']}")
                        break
                continue

            if line.rstrip("\n") == "\\.":
                print(f"-- {active} 导出完成")
                active = None
                continue

            raw_fields = line.rstrip("\n").split("\t")
            fields = [unescape(v) for v in raw_fields]
            if len(fields) != len(columns[active]):
                print(f"!! {active} 字段数不匹配：期望 {len(columns[active])} 实际 {len(fields)}，跳过一行", file=sys.stderr)
                continue
            writers[active].writerow(fields)

    for fh in files.values():
        fh.close()


if __name__ == "__main__":
    main()
