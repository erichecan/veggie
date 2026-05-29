#!/usr/bin/env python3
"""
Import sale.order CSV from Odoo into the veggie-demo Order table.
Run: python3 scripts/import-orders.py
"""
import csv
import uuid
import json
import psycopg2
from datetime import datetime

DB_URL = "postgresql://neondb_owner:npg_tUI9Eo4mjNHe@ep-icy-rice-al9r6fgz-pooler.c-3.eu-central-1.aws.neon.tech/veggie?sslmode=require"
PARTNER_CSV = "pic/res.partner.csv"
ORDER_CSV   = "pic/sale.order (1).csv"

STATUS_MAP = {
    "Fully Invoiced":      "COMPLETED",
    "To Invoice":          "COMPLETED",
    "Nothing to Invoice":  "COMPLETED",
}

def make_id():
    # cuid-compatible: use uuid4 with 'c' prefix
    return "c" + uuid.uuid4().hex[:24]

def parse_amount(s):
    try:
        return float(s.replace("'", "").replace(",", ""))
    except Exception:
        return 0.0

def parse_date(s):
    try:
        return datetime.strptime(s.strip(), "%Y-%m-%d %H:%M:%S")
    except Exception:
        return datetime.now()

def main():
    # 1. Build Odoo external_id → display_name map
    partner_map = {}
    with open(PARTNER_CSV, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            partner_map[row["External ID"]] = row["Display Name"]

    # 2. Connect DB
    conn = psycopg2.connect(DB_URL)
    cur = conn.cursor()

    # 3. Load existing customers (name → id)
    cur.execute('SELECT id, name FROM "Customer"')
    db_customers = {row[1]: row[0] for row in cur.fetchall()}

    # 4. Load existing externalRefs to avoid duplicates
    cur.execute('SELECT "externalRef" FROM "Order" WHERE "externalRef" IS NOT NULL')
    existing_refs = set(row[0] for row in cur.fetchall())
    print(f"DB 已有 {len(existing_refs)} 条 externalRef 记录，将跳过重复")

    # 5. Read orders CSV
    orders = []
    with open(ORDER_CSV, encoding="utf-8") as f:
        for row in csv.DictReader(f):
            orders.append(row)

    print(f"CSV 共 {len(orders)} 条订单")

    inserted = 0
    skipped_dup = 0
    skipped_no_customer = 0

    rows_to_insert = []

    for row in orders:
        ref = row["Order Reference"].strip()

        # Skip duplicates
        if ref in existing_refs:
            skipped_dup += 1
            continue

        # Resolve customer
        partner_ext_id = row["Customer"].strip()
        customer_name  = partner_map.get(partner_ext_id, "")

        if not customer_name:
            skipped_no_customer += 1
            continue

        restaurant_id = db_customers.get(customer_name)
        if not restaurant_id:
            # Customer name not in DB — use a synthetic id based on name
            restaurant_id = "ext_" + uuid.uuid5(uuid.NAMESPACE_DNS, customer_name).hex[:16]

        status       = STATUS_MAP.get(row["Invoice Status"].strip(), "COMPLETED")
        total_amount = parse_amount(row["Total"])
        created_at   = parse_date(row["Order Date"])
        order_id     = make_id()

        rows_to_insert.append((
            order_id,
            restaurant_id,
            customer_name,
            json.dumps([]),
            total_amount,
            status,
            "ONLINE",
            ref,
            created_at,
        ))

    print(f"准备插入 {len(rows_to_insert)} 条，跳过重复 {skipped_dup}，跳过无客户 {skipped_no_customer}")

    # Batch insert in chunks of 500
    CHUNK = 500
    for i in range(0, len(rows_to_insert), CHUNK):
        chunk = rows_to_insert[i:i+CHUNK]
        cur.executemany(
            """
            INSERT INTO "Order"
              (id, "restaurantId", "restaurantName", items, "totalAmount", status, "paymentMethod", "externalRef", "createdAt")
            VALUES (%s, %s, %s, %s::jsonb, %s, %s::"OrderStatus", %s::"PaymentMethod", %s, %s)
            ON CONFLICT DO NOTHING
            """,
            chunk
        )
        conn.commit()
        inserted += len(chunk)
        print(f"  已插入 {min(i+CHUNK, len(rows_to_insert))}/{len(rows_to_insert)}")

    print(f"\n✅ 完成：插入 {inserted} 条，跳过重复 {skipped_dup}，跳过无客户 {skipped_no_customer}")
    cur.close()
    conn.close()

if __name__ == "__main__":
    main()
