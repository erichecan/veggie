#!/usr/bin/env python3
"""验证脚本：日销售中心手动登记退货（OrderReturn）全状态机 + 鉴权探针。

对应 DEV-PLAN.md「退货/报废流程整合」附录 A。跟 verify-return-flow.py（司机端上报，
Trip/ReturnItem）是姊妹脚本——两条入口共用 lib/returns-engine.ts，这里只测
/api/order-returns 这条独立入口自己的状态机（WAREHOUSE_PENDING → PENDING_REVIEW →
APPROVED/REJECTED）与鉴权矩阵，不重复司机端已经测过的 disposition 记账逻辑本身。

用法：
  BASE_URL=http://localhost:3000 DATABASE_URL=... \
  DRIVER_EMAIL=driver(at)demo.local DRIVER_PASSWORD=test12345 \
  WAREHOUSE_EMAIL=warehouse(at)demo.local WAREHOUSE_PASSWORD=test12345 \
  SALES_EMAIL=operator3(at)demo.local SALES_PASSWORD=test12345 \
  python3 scripts/verify-order-returns.py
"""
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3011")
DATABASE_URL = os.environ["DATABASE_URL"]
SUFFIX = str(int(time.time()))
PRODUCT_ID = f"verify-ordret-prod-{SUFFIX}"
ORDER_ID = f"verify-ordret-order-{SUFFIX}"

failures = []


def ok(label):
    print(f"  ✅ {label}")


def bad(label):
    print(f"  ❌ {label}")
    failures.append(label)


def call(method, path, token=None, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(f"{BASE_URL}{path}", data=data, method=method)
    req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            return e.code, json.loads(e.read() or b"{}")
        except json.JSONDecodeError:
            return e.code, {}


def login(email, password):
    status, body = call("POST", "/api/auth/login", body={"email": email, "password": password})
    if status != 200:
        raise SystemExit(f"登录失败 {email}: {status} {body}")
    return body["token"]


def psql(sql):
    subprocess.run(["psql", DATABASE_URL, "-c", sql], check=True, capture_output=True)


def psql_scalar(sql):
    r = subprocess.run(["psql", DATABASE_URL, "-tA", "-c", sql], check=True, capture_output=True, text=True)
    return r.stdout.strip()


def main():
    driver_token = login(os.environ["DRIVER_EMAIL"], os.environ["DRIVER_PASSWORD"])
    warehouse_token = login(os.environ["WAREHOUSE_EMAIL"], os.environ["WAREHOUSE_PASSWORD"])
    sales_token = login(os.environ["SALES_EMAIL"], os.environ["SALES_PASSWORD"])

    psql(f"""
        INSERT INTO "Product" (id, name, type, "qtyOnHand", "updatedAt")
        VALUES ('{PRODUCT_ID}', 'Verify OrderReturn Product', 'PRODUCT', 100, NOW())
    """)
    psql(f"""
        INSERT INTO "Order" (id, "restaurantId", "restaurantName", status)
        VALUES ('{ORDER_ID}', 'verify-ordret-cust', 'Verify OrderReturn Restaurant', 'IN_DELIVERY')
    """)
    psql(f"""
        INSERT INTO "OrderLine" (id, "orderId", "productId", "productName", "unitPrice", "orderedQty", "subtotal", "deliveredQty", "updatedAt")
        VALUES ('verify-ordret-line-{SUFFIX}', '{ORDER_ID}', '{PRODUCT_ID}', 'Verify OrderReturn Product', 9.9, 10, 99, 10, NOW())
    """)
    ok(f"测试订单/商品就绪：{ORDER_ID} / {PRODUCT_ID}")

    try:
        # ── 登记：鉴权矩阵 ──
        register_body = {"orderId": ORDER_ID, "productId": PRODUCT_ID, "quantity": 2, "reason": "verify"}
        status, _ = call("POST", "/api/order-returns", body=register_body)
        ok("无 token 登记退货 → 401") if status == 401 else bad(f"无 token 登记应为 401，实得 {status}")

        status, _ = call("POST", "/api/order-returns", token="garbage", body=register_body)
        ok("错 token 登记退货 → 401") if status == 401 else bad(f"错 token 登记应为 401，实得 {status}")

        status, _ = call("POST", "/api/order-returns", token=driver_token, body=register_body)
        ok("DRIVER 登记退货 → 403（无 goods_return.register）") if status == 403 else bad(f"DRIVER 登记应为 403，实得 {status}")

        # ── 登记：业务校验 ──
        status, _ = call("POST", "/api/order-returns", token=sales_token, body={"orderId": ORDER_ID, "productId": PRODUCT_ID})
        ok("缺 quantity → 400") if status == 400 else bad(f"缺字段应为 400，实得 {status}")

        status, _ = call("POST", "/api/order-returns", token=sales_token, body={**register_body, "orderId": "no-such-order"})
        ok("订单不存在 → 404") if status == 404 else bad(f"订单不存在应为 404，实得 {status}")

        psql(f"UPDATE \"Order\" SET status='PENDING' WHERE id='{ORDER_ID}'")
        status, _ = call("POST", "/api/order-returns", token=sales_token, body=register_body)
        ok("订单未送达(PENDING) → 400") if status == 400 else bad(f"订单未送达应为 400，实得 {status}")
        psql(f"UPDATE \"Order\" SET status='IN_DELIVERY' WHERE id='{ORDER_ID}'")

        status, resp = call("POST", "/api/order-returns", token=sales_token, body=register_body)
        if status == 200 and resp.get("status") == "WAREHOUSE_PENDING" and resp.get("productName") == "Verify OrderReturn Product":
            ok("SALES 登记成功，初始状态 WAREHOUSE_PENDING，productName 从 OrderLine 回填")
        else:
            bad(f"登记失败或初始状态错误：{status} {resp}")
        return_id = resp.get("id")

        # ── 列表：鉴权矩阵 ──
        status, _ = call("GET", "/api/order-returns", token=driver_token)
        ok("DRIVER 查看列表 → 403（无 warehouse_verify/review）") if status == 403 else bad(f"DRIVER 查看列表应为 403，实得 {status}")

        status, resp = call("GET", "/api/order-returns", token=warehouse_token, body=None)
        found = any(r.get("id") == return_id for r in resp.get("returns", []))
        ok("WAREHOUSE 查看列表 → 200，能看到刚登记的记录") if status == 200 and found else bad(f"WAREHOUSE 查看列表异常：{status}，找到={found}")

        # ── 仓库核实：鉴权矩阵 ──
        verify_body = {"id": return_id, "action": "verify"}
        status, _ = call("PUT", f"/api/order-returns/{return_id}/warehouse-verify", token=sales_token, body=verify_body)
        ok("SALES 仓库核实 → 403（无 warehouse_verify）") if status == 403 else bad(f"SALES 核实应为 403，实得 {status}")

        status, _ = call("PUT", f"/api/order-returns/{return_id}/warehouse-verify", token=driver_token, body=verify_body)
        ok("DRIVER 仓库核实 → 403") if status == 403 else bad(f"DRIVER 核实应为 403，实得 {status}")

        status, _ = call("PUT", f"/api/order-returns/{return_id}/warehouse-verify", token=warehouse_token, body={})
        ok("仓库核实缺 action → 400") if status == 400 else bad(f"缺 action 应为 400，实得 {status}")

        status, _ = call("PUT", f"/api/order-returns/{return_id}/warehouse-verify", token=warehouse_token, body={"action": "reject"})
        ok("仓库核实拒绝缺 note → 400") if status == 400 else bad(f"缺 note 应为 400，实得 {status}")

        status, _ = call("PUT", f"/api/order-returns/no-such-id/warehouse-verify", token=warehouse_token, body=verify_body)
        ok("核实不存在的记录 → 404") if status == 404 else bad(f"记录不存在应为 404，实得 {status}")

        status, resp = call("PUT", f"/api/order-returns/{return_id}/warehouse-verify", token=warehouse_token, body=verify_body)
        if status == 200 and resp.get("orderReturn", {}).get("status") == "PENDING_REVIEW":
            ok("WAREHOUSE 核实通过 → 状态转 PENDING_REVIEW")
        else:
            bad(f"核实通过后状态异常：{status} {resp}")

        status, _ = call("PUT", f"/api/order-returns/{return_id}/warehouse-verify", token=warehouse_token, body=verify_body)
        ok("重复核实（已不在 WAREHOUSE_PENDING） → 409") if status == 409 else bad(f"重复核实应为 409，实得 {status}")

        # ── 审核处置：鉴权矩阵 ──
        approve_body = {"action": "approve", "disposition": "SELLABLE"}
        status, _ = call("PUT", f"/api/order-returns/{return_id}/review", token=warehouse_token, body=approve_body)
        ok("WAREHOUSE 审核处置 → 403（无 review）") if status == 403 else bad(f"WAREHOUSE 审核应为 403，实得 {status}")

        status, _ = call("PUT", f"/api/order-returns/{return_id}/review", token=driver_token, body=approve_body)
        ok("DRIVER 审核处置 → 403") if status == 403 else bad(f"DRIVER 审核应为 403，实得 {status}")

        status, _ = call("PUT", f"/api/order-returns/{return_id}/review", token=sales_token, body={})
        ok("审核缺 action → 400") if status == 400 else bad(f"缺 action 应为 400，实得 {status}")

        status, _ = call("PUT", f"/api/order-returns/{return_id}/review", token=sales_token, body={"action": "approve"})
        ok("批准缺 disposition → 400") if status == 400 else bad(f"缺 disposition 应为 400，实得 {status}")

        qty_before = float(psql_scalar(f"SELECT \"qtyOnHand\" FROM \"Product\" WHERE id='{PRODUCT_ID}'"))
        status, resp = call("PUT", f"/api/order-returns/{return_id}/review", token=sales_token, body=approve_body)
        if status == 200 and resp.get("orderReturn", {}).get("status") == "APPROVED":
            ok("SALES 审核通过(SELLABLE) → 状态转 APPROVED")
        else:
            bad(f"审核通过后状态异常：{status} {resp}")

        qty_after = float(psql_scalar(f"SELECT \"qtyOnHand\" FROM \"Product\" WHERE id='{PRODUCT_ID}'"))
        if abs(qty_after - qty_before - 2) < 0.001:
            ok(f"SELLABLE 处置：qtyOnHand +2（{qty_before} → {qty_after}）")
        else:
            bad(f"SELLABLE 处置后 qtyOnHand 异常：{qty_before} → {qty_after}（应 +2）")

        delivered_qty = float(psql_scalar(f"SELECT \"deliveredQty\" FROM \"OrderLine\" WHERE id='verify-ordret-line-{SUFFIX}'"))
        if abs(delivered_qty - 8) < 0.001:
            ok(f"OrderLine.deliveredQty 已按退货量回扣（10 → {delivered_qty}）")
        else:
            bad(f"OrderLine.deliveredQty 未正确回扣：{delivered_qty}（应为 8）")

        status, _ = call("PUT", f"/api/order-returns/{return_id}/review", token=sales_token, body=approve_body)
        ok("重复审核（已不在 PENDING_REVIEW） → 409") if status == 409 else bad(f"重复审核应为 409，实得 {status}")

        # ── 第二条记录：仓库核实拒绝路径 ──
        status, resp = call("POST", "/api/order-returns", token=sales_token, body={**register_body, "quantity": 1, "reason": "拒绝路径"})
        reject_id = resp.get("id")
        status, resp = call("PUT", f"/api/order-returns/{reject_id}/warehouse-verify", token=warehouse_token, body={"action": "reject", "note": "实物没收到"})
        if status == 200 and resp.get("orderReturn", {}).get("status") == "REJECTED":
            ok("仓库核实拒绝 → 状态直接转 REJECTED（不进审核栏）")
        else:
            bad(f"仓库核实拒绝路径异常：{status} {resp}")

        # ── 第三条记录：SCRAP 处置，qtyOnHand 净不变 ──
        status, resp = call("POST", "/api/order-returns", token=sales_token, body={**register_body, "quantity": 3, "reason": "报废路径"})
        scrap_id = resp.get("id")
        call("PUT", f"/api/order-returns/{scrap_id}/warehouse-verify", token=warehouse_token, body={"action": "verify"})
        qty_before_scrap = float(psql_scalar(f"SELECT \"qtyOnHand\" FROM \"Product\" WHERE id='{PRODUCT_ID}'"))
        status, resp = call("PUT", f"/api/order-returns/{scrap_id}/review", token=sales_token, body={"action": "approve", "disposition": "SCRAP"})
        qty_after_scrap = float(psql_scalar(f"SELECT \"qtyOnHand\" FROM \"Product\" WHERE id='{PRODUCT_ID}'"))
        if status == 200 and abs(qty_after_scrap - qty_before_scrap) < 0.001:
            ok(f"SCRAP 处置：qtyOnHand 净不变（{qty_before_scrap} → {qty_after_scrap}，RETURN+SCRAP 两笔流水互相抵消）")
        else:
            bad(f"SCRAP 处置 qtyOnHand 异常：{qty_before_scrap} → {qty_after_scrap}（应不变），status={status}")

        move_count = psql_scalar(f"""
            SELECT COUNT(*) FROM "StockMove"
            WHERE "sourceId" = '{scrap_id}' AND "sourceType" IN ('ORDER_RETURN', 'ORDER_RETURN_SCRAP')
        """)
        if move_count.strip() == "2":
            ok("SCRAP 处置落了 2 笔 StockMove（RETURN + SCRAP）")
        else:
            bad(f"SCRAP 处置 StockMove 笔数异常：{move_count}（应为 2）")

        # ── 拒绝路径不应留下任何库存流水 ──
        reject_moves = psql_scalar(f"""SELECT COUNT(*) FROM "StockMove" WHERE "sourceId" = '{reject_id}'""")
        if reject_moves.strip() == "0":
            ok("REJECTED 路径未留下任何 StockMove（符合预期：拒绝不动库存）")
        else:
            bad(f"REJECTED 路径意外产生了 StockMove：{reject_moves} 笔")

    finally:
        psql(f"""DELETE FROM "StockMove" WHERE "sourceId" IN (
            SELECT id FROM "OrderReturn" WHERE "orderId" = '{ORDER_ID}'
        )""")
        psql(f"""DELETE FROM "OrderReturn" WHERE "orderId" = '{ORDER_ID}'""")
        psql(f"""DELETE FROM "OrderLine" WHERE "orderId" = '{ORDER_ID}'""")
        psql(f"""DELETE FROM "Order" WHERE id = '{ORDER_ID}'""")
        psql(f"""DELETE FROM "Lot" WHERE "productId" = '{PRODUCT_ID}'""")
        psql(f"""DELETE FROM "Product" WHERE id = '{PRODUCT_ID}'""")

    print()
    if failures:
        print(f"❌ {len(failures)} 项失败")
        for f in failures:
            print(f"   - {f}")
        sys.exit(1)
    print("✅ 全部通过")


if __name__ == "__main__":
    main()
