#!/usr/bin/env python3
"""场景 C：只开放 Odoo 接口（拿不到 SSH/pg_dump，或 Odoo Online SaaS）时，
用 XML-RPC 把核心业务模型逐个分页导成 JSON。只依赖标准库，无需 pip 安装。

用法：
    cp config.env.example config.env   # 填 ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY
    set -a; source ./config.env; set +a
    python3 extract_via_api.py                 # 全量导出全部模型
    python3 extract_via_api.py --since 2025-01-01   # 仅导 write_date 之后变更的（增量）
    python3 extract_via_api.py --models res.partner,sale.order   # 只导指定模型

输出：./odoo-api-export/<model>.json（每个模型一个文件，UTF-8）
注意：ODOO_API_KEY 用 Odoo「开发者 API 密钥」，不要用账号明文密码。
"""
import os
import sys
import json
import time
import argparse
import xmlrpc.client

# 迁移最常用的核心模型（按依赖顺序：主数据在前，单据在后）
DEFAULT_MODELS = [
    "res.partner",          # 客户/供应商/联系人
    "res.users",            # 系统用户（业务员归属）
    "product.category",
    "uom.uom",
    "product.template",     # 商品（SPU）
    "product.product",      # 商品变体（SKU，真正下单的对象）
    "product.supplierinfo", # 供应商-商品-价格
    "sale.order",
    "sale.order.line",
    "purchase.order",
    "purchase.order.line",
    "stock.picking",
    "stock.move",
    "stock.quant",          # 当前库存（onhand 对账用）
    "account.move",         # 发票/账单（凭证头）
    "account.move.line",    # 凭证行（含科目、借贷）
    "account.payment",      # 收付款
    "account.account",      # 会计科目表
]

PAGE = 500  # 每页条数；网络差就调小


def env(key, required=True):
    v = os.environ.get(key, "").strip()
    if required and not v:
        sys.exit(f"!! 缺少环境变量 {key}（在 config.env 里填好并 source）")
    return v


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", help="只导 write_date >= 该日期的记录，如 2025-01-01")
    ap.add_argument("--models", help="逗号分隔的模型列表，覆盖默认集")
    ap.add_argument("--out", default="./odoo-api-export", help="输出目录")
    args = ap.parse_args()

    url = env("ODOO_URL")
    db = env("ODOO_DB")
    user = env("ODOO_USER")
    key = env("ODOO_API_KEY")
    models = [m.strip() for m in (args.models.split(",") if args.models else DEFAULT_MODELS) if m.strip()]
    os.makedirs(args.out, exist_ok=True)

    common = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/common")
    uid = common.authenticate(db, user, key, {})
    if not uid:
        sys.exit("!! 认证失败：检查 ODOO_URL / ODOO_DB / ODOO_USER / ODOO_API_KEY")
    print(f"已认证 uid={uid} @ {url} / {db}")
    api = xmlrpc.client.ServerProxy(f"{url}/xmlrpc/2/object")

    base_domain = []
    if args.since:
        base_domain = [["write_date", ">=", args.since]]

    summary = {}
    for model in models:
        try:
            total = api.execute_kw(db, uid, key, model, "search_count", [base_domain])
        except xmlrpc.client.Fault as e:
            print(f"  跳过 {model}：{e.faultString.splitlines()[0]}")
            summary[model] = "skipped"
            continue

        records = []
        offset = 0
        while offset < total:
            rows = api.execute_kw(
                db, uid, key, model, "search_read",
                [base_domain],
                {"offset": offset, "limit": PAGE, "context": {"active_test": False}},
            )
            if not rows:
                break
            records.extend(rows)
            offset += len(rows)
            print(f"  {model}: {offset}/{total}", end="\r")
            time.sleep(0.05)  # 轻微限速，别把生产 ERP 打挂

        path = os.path.join(args.out, f"{model}.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(records, f, ensure_ascii=False, indent=2, default=str)
        print(f"  {model}: {len(records)} 条 → {path}" + " " * 20)
        summary[model] = len(records)

    with open(os.path.join(args.out, "_summary.json"), "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)
    print("\n导出完成。汇总：")
    for m, n in summary.items():
        print(f"  {m}: {n}")
    print(f"\n文件在 {args.out}/。这些 JSON 含客户 PII，按 GDPR 加密保存、用完即删。")


if __name__ == "__main__":
    main()
