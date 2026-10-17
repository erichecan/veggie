#!/usr/bin/env python3
"""验证脚本（HTTP 部分）：采购运费按数量分摊进成本，确认时联动 Product.standardPrice。

对应 docs/20261017-采购运费分摊成本联动-tasks.md「附录 A：技术验收标准」。
tsc/migrate status 由同目录 verify-po-freight-allocation.sh 负责，这里只跑：
确认分支写成本 + 取消分支回滚 + 分摊合计校验(409) + 鉴权(401/401/403) + SERVICE 行排除分摊。

用法：
  BASE_URL=http://localhost:3001 \
  BOSS_EMAIL=boss(at)demo.local BOSS_PASSWORD=... \
  LOWPERM_EMAIL=finance(at)demo.local LOWPERM_PASSWORD=... \
  VENDOR_ID=... PRODUCT_ID=... SERVICE_PRODUCT_ID=... \
  python3 scripts/verify-po-freight-allocation.py

VENDOR_ID/PRODUCT_ID/SERVICE_PRODUCT_ID 留空则用本次开发时实测过的开发库默认值
（20261017，vest + 测试服务行）；换一套开发库时请按需覆盖。
LOWPERM_EMAIL/LOWPERM_PASSWORD 不设时，403 鉴权探针跳过并标 ⚠️ 未验证，不冒充通过。
"""
import json
import os
import sys
import urllib.request
import urllib.error

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3001")
VENDOR_ID = os.environ.get("VENDOR_ID", "cd1e931579e8d47b0ac642ac5")
PRODUCT_ID = os.environ.get("PRODUCT_ID", "cmqn90vbz02nfdmyli3w876kp")  # vest，非 SERVICE
SERVICE_PRODUCT_ID = os.environ.get("SERVICE_PRODUCT_ID", "cmvbwv7900034dvsidr2v8847")  # type=SERVICE

failures = []
skipped = []


def ok(label):
    print(f"  ✅ {label}")


def bad(label):
    print(f"  ❌ {label}")
    failures.append(label)


def warn_skip(label):
    print(f"  ⚠️ 未验证（跳过）：{label}")
    skipped.append(label)


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


def create_draft_po(token, freight_amount, vest_qty=10, vest_cost=2, svc_cost=5):
    status, body = call("POST", "/api/purchase-orders", token=token, body={
        "supplierId": VENDOR_ID,
        "currency": "EUR",
        "freightAmount": freight_amount,
        "lines": [
            {"productId": PRODUCT_ID, "productName": "verify-vest", "orderedQty": vest_qty, "unitCost": vest_cost, "taxRate": 23},
            {"productId": SERVICE_PRODUCT_ID, "productName": "verify-service", "orderedQty": 1, "unitCost": svc_cost, "taxRate": 23},
        ],
    })
    if status != 201:
        raise SystemExit(f"建测试 PO 失败: {status} {body}")
    lines = {l["productId"]: l for l in body["lines"]}
    return body["id"], lines[PRODUCT_ID]["id"], lines[SERVICE_PRODUCT_ID]["id"]


def get_product_standard_price(token, product_id):
    status, body = call("GET", f"/api/products/{product_id}", token=token)
    if status != 200:
        raise SystemExit(f"查商品失败: {status} {body}")
    return body["standardPrice"]


def main():
    boss_email = os.environ.get("BOSS_EMAIL")
    boss_password = os.environ.get("BOSS_PASSWORD")
    if not boss_email or not boss_password:
        raise SystemExit("请设置 BOSS_EMAIL / BOSS_PASSWORD（需同时具备 purchase.order.update + .approve）")
    boss_token = login(boss_email, boss_password)

    # ── 鉴权探针：无 token / 错 token ──────────────────────────────
    po_id, vest_line_id, svc_line_id = create_draft_po(boss_token, freight_amount=30)

    status, _ = call("PATCH", f"/api/purchase-orders/{po_id}", body={"action": "confirm"})
    ok("无 token confirm → 401") if status == 401 else bad(f"无 token confirm 应为 401，实得 {status}")

    status, _ = call("PATCH", f"/api/purchase-orders/{po_id}", token="garbage", body={"action": "confirm"})
    ok("错 token confirm → 401") if status == 401 else bad(f"错 token confirm 应为 401，实得 {status}")

    lowperm_email = os.environ.get("LOWPERM_EMAIL")
    lowperm_password = os.environ.get("LOWPERM_PASSWORD")
    if lowperm_email and lowperm_password:
        lowperm_token = login(lowperm_email, lowperm_password)
        status, _ = call("PATCH", f"/api/purchase-orders/{po_id}", token=lowperm_token, body={"action": "confirm"})
        ok("低权限（无 purchase.order.approve）confirm → 403") if status == 403 else bad(f"低权限 confirm 应为 403，实得 {status}")
    else:
        warn_skip("低权限 confirm → 403（未设置 LOWPERM_EMAIL/LOWPERM_PASSWORD）")

    # ── 校验探针：手动覆盖造出分摊合计不一致 → 409 ──────────────────
    status, body = call("PUT", f"/api/purchase-orders/{po_id}", token=boss_token, body={
        "lines": [
            {"id": vest_line_id, "orderedQty": 10, "unitCost": 2, "taxRate": 23, "allocatedFreightEur": 10},
            {"id": svc_line_id, "orderedQty": 1, "unitCost": 5, "taxRate": 23, "allocatedFreightEur": None},
        ],
    })
    if status != 200:
        bad(f"PUT 手动覆盖分摊运费失败: {status} {body}")
    else:
        status, body = call("PATCH", f"/api/purchase-orders/{po_id}", token=boss_token, body={"action": "confirm"})
        err = body.get("error", "")
        if status == 409 and "10.00" in err and "30.00" in err:
            ok("分摊合计与运费总额不一致 → 409 且错误信息带具体差额")
        else:
            bad(f"分摊不一致应为 409 且带差额，实得 {status} {err}")

    # ── 恢复自动分摊，走真正的确认分支 ────────────────────────────
    status, body = call("PUT", f"/api/purchase-orders/{po_id}", token=boss_token, body={
        "lines": [
            {"id": vest_line_id, "orderedQty": 10, "unitCost": 2, "taxRate": 23, "allocatedFreightEur": None},
            {"id": svc_line_id, "orderedQty": 1, "unitCost": 5, "taxRate": 23, "allocatedFreightEur": None},
        ],
    })
    if status != 200:
        raise SystemExit(f"清空手动覆盖失败: {status} {body}")

    price_before_confirm = get_product_standard_price(boss_token, PRODUCT_ID)

    status, body = call("PATCH", f"/api/purchase-orders/{po_id}", token=boss_token, body={"action": "confirm"})
    if status != 200 or body.get("status") != "CONFIRMED":
        bad(f"confirm 应为 200 CONFIRMED，实得 {status} {body.get('status')}")
    else:
        ok("confirm → 200 CONFIRMED")
        lines_by_product = {l["productId"]: l for l in body["lines"]}
        vest_line = lines_by_product[PRODUCT_ID]
        svc_line = lines_by_product[SERVICE_PRODUCT_ID]

        # (subtotalExTax 20 + allocatedFreight 30) / qty 10 = 5
        expected_landed = round((vest_line["subtotalExTax"] + 30) / vest_line["orderedQty"], 2)
        if vest_line["allocatedFreightEur"] == 30 and vest_line["landedUnitCostEur"] == expected_landed:
            ok(f"非 SERVICE 行分摊运费=30、落地成本={expected_landed}，与手算一致")
        else:
            bad(f"非 SERVICE 行分摊/落地成本不符：{vest_line}")

        if svc_line["allocatedFreightEur"] == 0 and svc_line.get("landedUnitCostEur") in (None, 0):
            ok("SERVICE 行分摊运费恒为 0，不参与分摊")
        else:
            bad(f"SERVICE 行应分摊 0，实得：{svc_line}")

        new_price = get_product_standard_price(boss_token, PRODUCT_ID)
        if new_price == expected_landed:
            ok(f"confirm 后 Product.standardPrice 已推到落地成本 {expected_landed}")
        else:
            bad(f"confirm 后 standardPrice 应为 {expected_landed}，实得 {new_price}")

        # ── 取消：standardPrice 应回滚到确认前快照 ──────────────────
        status, body = call("PATCH", f"/api/purchase-orders/{po_id}", token=boss_token, body={"action": "cancel"})
        if status == 200 and body.get("status") == "CANCELLED":
            ok("cancel → 200 CANCELLED")
        else:
            bad(f"cancel 应为 200 CANCELLED，实得 {status} {body.get('status')}")

        rolled_back_price = get_product_standard_price(boss_token, PRODUCT_ID)
        if rolled_back_price == price_before_confirm:
            ok(f"cancel 后 Product.standardPrice 回滚到确认前快照 {price_before_confirm}")
        else:
            bad(f"cancel 后 standardPrice 应回滚到 {price_before_confirm}，实得 {rolled_back_price}")

    print()
    if failures:
        print(f"❌ {len(failures)} 项失败：")
        for f in failures:
            print(f"   - {f}")
    if skipped:
        print(f"⚠️ {len(skipped)} 项未验证（跳过）：")
        for s in skipped:
            print(f"   - {s}")
    if not failures and not skipped:
        print("✅ 全部通过")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
