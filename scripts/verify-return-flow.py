#!/usr/bin/env python3
"""验证脚本（HTTP/状态机部分）：退换货流程补缺口。

对应 DEV-PLAN.md「附录 A：技术验收标准」。tsc/build 由同目录 verify-return-flow.sh 负责，
这里只跑鉴权探针 + 状态机探针——用 Python 而不是纯 bash 字符串拼接 JSON，避免引号/中文/
花括号在 shell 里互相打架。

用法：
  BASE_URL=http://localhost:3011 DATABASE_URL=... \
  DRIVER_EMAIL=driver(at)demo.local DRIVER_PASSWORD=test12345 \
  WAREHOUSE_EMAIL=warehouse(at)demo.local WAREHOUSE_PASSWORD=test12345 \
  SALES_EMAIL=operator3(at)demo.local SALES_PASSWORD=test12345 \
  python3 scripts/verify-return-flow.py
"""
import base64
import json
import os
import subprocess
import sys
import time
import urllib.request
import urllib.error

BASE_URL = os.environ.get("BASE_URL", "http://localhost:3011")
DATABASE_URL = os.environ["DATABASE_URL"]
TRIP_ID = f"verify-return-flow-{int(time.time())}"

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


def jwt_user_id(token):
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)
    return json.loads(base64.urlsafe_b64decode(payload))["userId"]


def psql(sql):
    subprocess.run(["psql", DATABASE_URL, "-c", sql], check=True, capture_output=True)


def main():
    driver_token = login(os.environ["DRIVER_EMAIL"], os.environ["DRIVER_PASSWORD"])
    warehouse_token = login(os.environ["WAREHOUSE_EMAIL"], os.environ["WAREHOUSE_PASSWORD"])
    sales_token = login(os.environ["SALES_EMAIL"], os.environ["SALES_PASSWORD"])
    driver_id = jwt_user_id(driver_token)

    restaurants = json.dumps([{
        "restaurantId": "verify-cust", "restaurantName": "Verify Restaurant",
        "orderIds": ["verify-order"],
        "items": [{"productId": "verify-prod", "productName": "Verify Product", "quantity": 10, "price": 9.9, "subtotal": 99, "spec": "unit"}],
        "delivered": False, "returns": [], "pods": [], "cargoVerified": True,
    }]).replace("'", "''")
    psql(f"""
        INSERT INTO "Trip" (id, "driverId", "driverName", status, restaurants, "totalPayment", "createdAt")
        VALUES ('{TRIP_ID}', '{driver_id}', 'Verify Script Driver', 'IN_PROGRESS', '{restaurants}'::jsonb, 0, NOW())
    """)
    ok(f"测试 Trip 就绪：{TRIP_ID}")

    try:
        status, _ = call("POST", f"/api/trips/{TRIP_ID}/returns")
        ok("无 token 提交退货 → 401") if status == 401 else bad(f"无 token 提交退货应为 401，实得 {status}")

        status, _ = call("POST", f"/api/trips/{TRIP_ID}/returns", token="garbage")
        ok("错 token 提交退货 → 401") if status == 401 else bad(f"错 token 提交退货应为 401，实得 {status}")

        return_body = {"restaurantId": "verify-cust", "driverSignature": "data:x",
                       "returns": [{"productId": "verify-prod", "productName": "Verify Product", "quantity": 1, "reason": "test"}]}
        status, _ = call("POST", f"/api/trips/{TRIP_ID}/returns", token=warehouse_token, body=return_body)
        ok("WAREHOUSE 提交退货 → 403") if status == 403 else bad(f"WAREHOUSE 提交退货应为 403，实得 {status}")

        # 回归检查：出发前核货阶段（VERIFYING）司机端本来就有"报告异常"按钮，
        # 这次改走专用接口时曾漏了这个状态，导致点了按钮却提交 400——已修复
        psql(f"UPDATE \"Trip\" SET status='VERIFYING' WHERE id='{TRIP_ID}'")
        verifying_body = {"restaurantId": "verify-cust", "driverSignature": "data:x",
                          "returns": [{"productId": "verify-prod", "productName": "Verify Product", "quantity": 1, "reason": "核货阶段发现异常"}]}
        status, _ = call("POST", f"/api/trips/{TRIP_ID}/returns", token=driver_token, body=verifying_body)
        ok("VERIFYING 状态下司机可提交退货（回归修复）") if status == 200 else bad(f"VERIFYING 状态提交应为 200，实得 {status}")
        psql(f"UPDATE \"Trip\" SET status='IN_PROGRESS', restaurants = jsonb_set(restaurants, '{{0,returns}}', '[]'::jsonb) WHERE id='{TRIP_ID}'")

        nosign_body = {"restaurantId": "verify-cust",
                       "returns": [{"productId": "verify-prod", "productName": "Verify Product", "quantity": 1, "reason": "test"}]}
        status, _ = call("POST", f"/api/trips/{TRIP_ID}/returns", token=driver_token, body=nosign_body)
        ok("司机缺签名提交 → 400") if status == 400 else bad(f"司机缺签名提交应为 400，实得 {status}")

        status, resp = call("POST", f"/api/trips/{TRIP_ID}/returns", token=driver_token, body=return_body)
        item = (resp.get("returns") or [{}])[0]
        if status == 200 and item.get("unitPrice") == 9.9:
            ok("司机提交 unitPrice 快照正确(9.9)")
        else:
            bad(f"司机提交 unitPrice 快照错误：{status} {item}")
        if item.get("status") == "WAREHOUSE_PENDING":
            ok("司机提交初始状态为 WAREHOUSE_PENDING")
        else:
            bad(f"司机提交初始状态错误：{item.get('status')}")

        review_body = {"reviews": [{"restaurantId": "verify-cust", "productId": "verify-prod", "action": "reject"}]}
        status, _ = call("PUT", f"/api/trips/{TRIP_ID}/returns", token=driver_token, body=review_body)
        ok("司机审核退货 → 403") if status == 403 else bad(f"司机审核退货应为 403，实得 {status}")

        verify_body = {"restaurantId": "verify-cust", "productId": "verify-prod", "action": "verify"}
        status, _ = call("PUT", f"/api/trips/{TRIP_ID}/returns/warehouse-verify", token=driver_token, body=verify_body)
        ok("司机仓库核实 → 403") if status == 403 else bad(f"司机仓库核实应为 403，实得 {status}")

        status, resp = call("PUT", f"/api/trips/{TRIP_ID}/returns", token=sales_token, body=review_body)
        if status == 200 and resp.get("approved") == 0 and resp.get("rejected") == 0:
            ok("SALES 可访问审核接口，但仓库未核实前状态机拦截（0 处理）")
        else:
            bad(f"SALES 审核前置状态机检查异常：{status} {resp}")

        reject_no_note = {"restaurantId": "verify-cust", "productId": "verify-prod", "action": "reject"}
        status, _ = call("PUT", f"/api/trips/{TRIP_ID}/returns/warehouse-verify", token=warehouse_token, body=reject_no_note)
        ok("仓库核实不通过缺 note → 400") if status == 400 else bad(f"仓库核实不通过缺 note 应为 400，实得 {status}")

        status, resp = call("PUT", f"/api/trips/{TRIP_ID}/returns/warehouse-verify", token=warehouse_token, body=verify_body)
        if status == 200 and resp.get("status") == "PENDING_REVIEW":
            ok("仓库核实通过 → 状态转 PENDING_REVIEW")
        else:
            bad(f"仓库核实通过后状态异常：{status} {resp}")

        status, _ = call("PUT", f"/api/trips/{TRIP_ID}/returns/warehouse-verify", token=warehouse_token, body=verify_body)
        ok("重复仓库核实 → 400") if status == 400 else bad(f"重复仓库核实应为 400，实得 {status}")

        status, resp = call("PUT", f"/api/trips/{TRIP_ID}/returns", token=sales_token, body=review_body)
        if status == 200 and resp.get("rejected") == 1:
            ok("SALES 审核（拒绝）生效")
        else:
            bad(f"SALES 审核应拒绝 1 条：{status} {resp}")

        psql(f"UPDATE \"Trip\" SET status='COMPLETED' WHERE id='{TRIP_ID}'")
        hist_body = {"restaurantId": "verify-cust", "driverSignature": "data:x",
                    "returns": [{"productId": "verify-prod", "productName": "Verify Product", "quantity": 1, "reason": "历史补报"}]}
        status, resp = call("POST", f"/api/trips/{TRIP_ID}/returns", token=driver_token, body=hist_body)
        ok("COMPLETED 历史行程仍可补报退货") if status == 200 else bad(f"COMPLETED 历史行程补报应为 200，实得 {status}")
        first_id = (resp.get("returns") or [{}])[0].get("id")

        # 回归检查：同一商品被分别上报两次时，仓库核实/审核必须靠 returnId 精确
        # 定位到具体那一条，不能只靠 productId+status 命中数组里第一条同状态记录
        status, resp = call("POST", f"/api/trips/{TRIP_ID}/returns", token=driver_token, body=hist_body)
        second_id = (resp.get("returns") or [{}])[0].get("id")
        if not first_id or not second_id or first_id == second_id:
            bad(f"两次提交应得到两个不同的 returnId：{first_id} / {second_id}")
        else:
            ok("同一商品分别上报两次，各自拿到不同的 returnId")
            dup_verify = {"restaurantId": "verify-cust", "productId": "verify-prod", "returnId": second_id, "action": "verify"}
            status, _ = call("PUT", f"/api/trips/{TRIP_ID}/returns/warehouse-verify", token=warehouse_token, body=dup_verify)
            _, trip_row = call("GET", f"/api/trips/{TRIP_ID}", token=warehouse_token)
            returns = (trip_row.get("restaurants") or [{}])[0].get("returns") or []
            first_status = next((r["status"] for r in returns if r.get("id") == first_id), None)
            second_status = next((r["status"] for r in returns if r.get("id") == second_id), None)
            if status == 200 and second_status == "PENDING_REVIEW" and first_status == "WAREHOUSE_PENDING":
                ok("按 returnId 核实只影响目标那一条，另一条同商品记录不受影响")
            else:
                bad(f"returnId 精确匹配失败：second={second_status}（期望 PENDING_REVIEW），first={first_status}（期望仍是 WAREHOUSE_PENDING）")
    finally:
        psql(f"DELETE FROM \"Trip\" WHERE id='{TRIP_ID}'")

    print()
    if failures:
        print(f"❌ {len(failures)} 项失败")
        sys.exit(1)
    print("✅ 全部通过")


if __name__ == "__main__":
    main()
