#!/usr/bin/env bash
# =============================================================================
# GCS 图片存储一次性初始化脚本
# 用法：在项目根目录执行  bash scripts/setup-gcs.sh
#
# 前置条件：
#   1. 已安装 gcloud CLI 并完成登录（gcloud auth login）
#   2. 已设置 GCP_PROJECT_ID 环境变量，或脚本会从 gcloud 配置中读取
# =============================================================================
set -euo pipefail

# ─── 配置 ─────────────────────────────────────────────────────────────────────
GCP_PROJECT_ID="${GCP_PROJECT_ID:-$(gcloud config get-value project 2>/dev/null || true)}"
GCP_REGION="${GCP_REGION:-europe-west1}"
BUCKET_NAME="${GCS_BUCKET_NAME:-veggie-supply-images}"
SERVICE_ACCOUNT_NAME="veggie-demo-sa"
SERVICE_NAME="veggie-demo"
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

echo ""
echo "🗂️  GCS 图片存储初始化"
echo "=========================="

if [[ -z "$GCP_PROJECT_ID" ]]; then
  error "未找到 GCP_PROJECT_ID。请运行：\n  export GCP_PROJECT_ID=你的项目ID"
fi
info "GCP 项目：$GCP_PROJECT_ID"
info "Bucket：  gs://${BUCKET_NAME}"
info "区域：    ${GCP_REGION}"
echo ""

# ─── 步骤 1：启用必要的 API ────────────────────────────────────────────────
info "启用 Cloud Storage API..."
gcloud services enable storage.googleapis.com --project="$GCP_PROJECT_ID" --quiet
success "Cloud Storage API 已启用"

# ─── 步骤 2：创建 Bucket ──────────────────────────────────────────────────
if gsutil ls -p "$GCP_PROJECT_ID" "gs://${BUCKET_NAME}" &>/dev/null; then
  warn "Bucket gs://${BUCKET_NAME} 已存在，跳过创建"
else
  info "创建 Bucket gs://${BUCKET_NAME}（区域：${GCP_REGION}）..."
  gsutil mb -p "$GCP_PROJECT_ID" -l "$GCP_REGION" -b on "gs://${BUCKET_NAME}"
  success "Bucket 创建成功"
fi

# ─── 步骤 3：设置 Bucket 公开读取（所有用户可访问图片 URL）────────────────
info "配置 Bucket 公开读取权限..."
gsutil iam ch allUsers:objectViewer "gs://${BUCKET_NAME}"
success "Bucket 已设为公开可读（图片 URL 可直接访问）"

# ─── 步骤 4：创建专用 Service Account ────────────────────────────────────
SA_EMAIL="${SERVICE_ACCOUNT_NAME}@${GCP_PROJECT_ID}.iam.gserviceaccount.com"
if gcloud iam service-accounts describe "$SA_EMAIL" --project="$GCP_PROJECT_ID" &>/dev/null; then
  warn "Service Account ${SA_EMAIL} 已存在，跳过创建"
else
  info "创建 Service Account：${SA_EMAIL}..."
  gcloud iam service-accounts create "$SERVICE_ACCOUNT_NAME" \
    --display-name="Veggie Demo Cloud Run SA" \
    --project="$GCP_PROJECT_ID"
  success "Service Account 创建成功"
fi

# ─── 步骤 5：授予 SA 对 Bucket 的写入权限 ────────────────────────────────
info "授予 ${SA_EMAIL} 对 Bucket 的写入权限..."
gsutil iam ch "serviceAccount:${SA_EMAIL}:objectCreator" "gs://${BUCKET_NAME}"
success "写入权限已配置"

# ─── 步骤 6：绑定 Cloud Run 服务 ─────────────────────────────────────────
info "更新 Cloud Run 服务 ${SERVICE_NAME} 使用此 Service Account..."
if gcloud run services describe "$SERVICE_NAME" \
  --region="$GCP_REGION" \
  --project="$GCP_PROJECT_ID" &>/dev/null; then
  gcloud run services update "$SERVICE_NAME" \
    --service-account="$SA_EMAIL" \
    --set-env-vars="GCS_BUCKET_NAME=${BUCKET_NAME}" \
    --region="$GCP_REGION" \
    --project="$GCP_PROJECT_ID" \
    --quiet
  success "Cloud Run 服务已更新"
else
  warn "Cloud Run 服务 ${SERVICE_NAME} 尚未部署，跳过绑定"
  warn "首次部署后，可重新运行此脚本完成绑定，或在 cloudbuild.yaml 中手动指定："
  warn "  --service-account=${SA_EMAIL}"
fi

# ─── 完成 ──────────────────────────────────────────────────────────────────
echo ""
echo "=========================================="
success "🎉 GCS 初始化完成！"
echo ""
echo "  Bucket URL：https://storage.googleapis.com/${BUCKET_NAME}/"
echo "  Service Account：${SA_EMAIL}"
echo ""
echo "  ✅ 上传图片后，URL 格式为："
echo "     https://storage.googleapis.com/${BUCKET_NAME}/products/{filename}"
echo ""
echo "  📌 将以下内容加入 deploy.sh（顶部配置区）："
echo "     CR_SERVICE_ACCOUNT=\"${SA_EMAIL}\""
echo "  并在 cloudbuild.yaml 中取消注释 --service-account 行"
echo "=========================================="
echo ""
