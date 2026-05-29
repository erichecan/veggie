#!/usr/bin/env bash
# =============================================================================
# veggie-demo → GCP Cloud Run 一键部署脚本
# 运行方式：在项目根目录执行  bash deploy.sh
# =============================================================================
set -euo pipefail

# ─── 🔧 用户配置区（首次使用前填写）─────────────────────────────────────────
GCP_PROJECT_ID="${GCP_PROJECT_ID:-supply-491510}"
GCP_REGION="${GCP_REGION:-europe-west1}"      # 与 Neon eu-central-1 最近
SERVICE_NAME="veggie-demo"
IMAGE="gcr.io/${GCP_PROJECT_ID}/${SERVICE_NAME}"

# Secret Manager 中的密钥名称（与 cloudbuild.yaml 保持一致）
SECRET_DB_NAME="VEGGIE_DATABASE_URL"
SECRET_JWT_NAME="VEGGIE_JWT_SECRET"

# GCS bucket 名称（图片存储，public read）
GCS_BUCKET_NAME="${GCS_BUCKET_NAME:-veggie-supply-images}"
# Cloud Run Service Account（需要对 bucket 有 storage.objectCreator 权限）
# 首次运行 scripts/setup-gcs.sh 后，它会打印出正确的 SA email，填入此处
CR_SERVICE_ACCOUNT="${CR_SERVICE_ACCOUNT:-}"

# 从 .env.local 读取实际值（部署时用于写入 Secret Manager）
DB_URL="${DATABASE_URL:-}"
JWT_SECRET_VAL="${JWT_SECRET:-}"
# ─────────────────────────────────────────────────────────────────────────────

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
info()    { echo -e "${CYAN}[INFO]${NC}  $*"; }
success() { echo -e "${GREEN}[OK]${NC}    $*"; }
warn()    { echo -e "${YELLOW}[WARN]${NC}  $*"; }
error()   { echo -e "${RED}[ERROR]${NC} $*"; exit 1; }

# ─── 步骤 0：检查必填项 ────────────────────────────────────────────────────
echo ""
echo "🥦  veggie-demo → Cloud Run 部署脚本"
echo "======================================"

if [[ -z "$GCP_PROJECT_ID" ]]; then
  # 尝试从 gcloud 当前配置自动获取
  GCP_PROJECT_ID=$(gcloud config get-value project 2>/dev/null || true)
  if [[ -z "$GCP_PROJECT_ID" ]]; then
    error "未设置 GCP_PROJECT_ID。请在脚本顶部填写，或运行：\n  export GCP_PROJECT_ID=你的项目ID"
  fi
  info "自动获取 GCP 项目 ID：$GCP_PROJECT_ID"
fi

# 如果 DB_URL 未设置，尝试从 .env.local 加载
if [[ -z "$DB_URL" ]] && [[ -f ".env.local" ]]; then
  DB_URL=$(grep '^DATABASE_URL=' .env.local | cut -d'=' -f2- | tr -d '"')
fi
if [[ -z "$JWT_SECRET_VAL" ]] && [[ -f ".env.local" ]]; then
  JWT_SECRET_VAL=$(grep '^JWT_SECRET=' .env.local | cut -d'=' -f2- | tr -d '"')
fi

if [[ -z "$DB_URL" ]]; then
  error "未找到 DATABASE_URL。请在 .env.local 中配置，或设置环境变量 DATABASE_URL=..."
fi
if [[ -z "$JWT_SECRET_VAL" ]]; then
  error "未找到 JWT_SECRET。请在 .env.local 中配置，或设置环境变量 JWT_SECRET=..."
fi

# ─── 步骤 1：检查 gcloud 登录状态 ─────────────────────────────────────────
info "检查 gcloud 登录状态..."
ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1)
if [[ -z "$ACCOUNT" ]]; then
  warn "未登录 GCP，正在启动登录流程..."
  gcloud auth login
  ACCOUNT=$(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)
fi
success "已登录账号：$ACCOUNT"

# 设置当前项目
gcloud config set project "$GCP_PROJECT_ID" --quiet
success "已设置 GCP 项目：$GCP_PROJECT_ID"

# ─── 步骤 2：启用所需 GCP API ──────────────────────────────────────────────
info "启用所需的 GCP API（首次约需 1-2 分钟）..."
gcloud services enable \
  cloudbuild.googleapis.com \
  run.googleapis.com \
  containerregistry.googleapis.com \
  secretmanager.googleapis.com \
  --project="$GCP_PROJECT_ID" \
  --quiet
success "所有 API 已启用"

# ─── 步骤 3：授权 Cloud Build 访问 Cloud Run 和 Secret Manager ────────────
info "配置 Cloud Build 服务账号权限..."

PROJECT_NUMBER=$(gcloud projects describe "$GCP_PROJECT_ID" --format='value(projectNumber)')
CB_SA="${PROJECT_NUMBER}@cloudbuild.gserviceaccount.com"

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/run.admin" \
  --quiet > /dev/null

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/iam.serviceAccountUser" \
  --quiet > /dev/null

gcloud projects add-iam-policy-binding "$GCP_PROJECT_ID" \
  --member="serviceAccount:${CB_SA}" \
  --role="roles/secretmanager.secretAccessor" \
  --quiet > /dev/null

success "Cloud Build 权限配置完成"

# ─── 步骤 4：创建 / 更新 Secret Manager 密钥 ──────────────────────────────
info "配置 Secret Manager 密钥..."

create_or_update_secret() {
  local SECRET_NAME="$1"
  local SECRET_VALUE="$2"

  if gcloud secrets describe "$SECRET_NAME" --project="$GCP_PROJECT_ID" &>/dev/null; then
    warn "密钥 ${SECRET_NAME} 已存在，添加新版本..."
    echo -n "$SECRET_VALUE" | gcloud secrets versions add "$SECRET_NAME" \
      --data-file=- \
      --project="$GCP_PROJECT_ID" \
      --quiet
  else
    info "创建密钥：${SECRET_NAME}"
    echo -n "$SECRET_VALUE" | gcloud secrets create "$SECRET_NAME" \
      --data-file=- \
      --replication-policy=automatic \
      --project="$GCP_PROJECT_ID" \
      --quiet
  fi
  success "密钥 ${SECRET_NAME} 已就绪"
}

create_or_update_secret "$SECRET_DB_NAME"  "$DB_URL"
create_or_update_secret "$SECRET_JWT_NAME" "$JWT_SECRET_VAL"

# ─── 步骤 5：提交 Cloud Build 构建 ────────────────────────────────────────
info "提交 Cloud Build 构建（构建 + 推送镜像 + 部署到 Cloud Run）..."
info "这通常需要 5-10 分钟，请耐心等待..."
echo ""

gcloud builds submit \
  --config=cloudbuild.yaml \
  --project="$GCP_PROJECT_ID" \
  .

echo ""

# ─── 步骤 6：获取服务 URL ─────────────────────────────────────────────────
info "获取 Cloud Run 服务 URL..."
SERVICE_URL=$(gcloud run services describe "$SERVICE_NAME" \
  --region="$GCP_REGION" \
  --project="$GCP_PROJECT_ID" \
  --format='value(status.url)' 2>/dev/null || true)

echo ""
echo "======================================"
if [[ -n "$SERVICE_URL" ]]; then
  success "🎉 部署成功！"
  echo ""
  echo -e "  服务地址：${GREEN}${SERVICE_URL}${NC}"
  echo ""
  echo "  快速验证："
  echo "    curl ${SERVICE_URL}/api/health"
  echo "    open ${SERVICE_URL}"
else
  warn "部署已提交，稍后可运行以下命令查看服务地址："
  echo "    gcloud run services describe ${SERVICE_NAME} --region=${GCP_REGION} --format='value(status.url)'"
fi
echo "======================================"
echo ""
