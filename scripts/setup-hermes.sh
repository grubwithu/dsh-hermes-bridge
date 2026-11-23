#!/usr/bin/env bash
set -euo pipefail

DRY_RUN=0
if [[ "${1:-}" == "--dry-run" ]]; then
  DRY_RUN=1
elif [[ -n "${1:-}" ]]; then
  echo "Usage: $0 [--dry-run]" >&2
  exit 2
fi

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
SKILL_SRC="${REPO_ROOT}/hermes/skills/dsh-bridge"
SKILL_DEST_DIR="${HERMES_HOME}/skills"
SKILL_DEST="${SKILL_DEST_DIR}/dsh-bridge"

WEBHOOK_HEALTH_URL="${DSH_HERMES_WEBHOOK_HEALTH_URL:-http://127.0.0.1:8644/health}"
MCP_HEALTH_URL="${DSH_HERMES_MCP_HEALTH_URL:-http://127.0.0.1:8790/health}"

gen_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  elif command -v python3 >/dev/null 2>&1; then
    python3 -c 'import secrets; print(secrets.token_hex(32))'
  elif command -v node >/dev/null 2>&1; then
    node -e 'const { randomBytes } = require("node:crypto"); console.log(randomBytes(32).toString("hex"));'
  else
    echo "Error: need openssl, python3, or node to generate random secrets." >&2
    exit 1
  fi
}

probe_url() {
  local label="$1"
  local url="$2"
  if command -v curl >/dev/null 2>&1; then
    if resp="$(curl -fsS --max-time 2 "$url" 2>/dev/null)"; then
      echo "  [OK]   ${label} (${url}) -> ${resp}"
      return 0
    fi
  elif command -v python3 >/dev/null 2>&1; then
    if resp="$(python3 -c "import urllib.request; print(urllib.request.urlopen('${url}', timeout=2).read().decode())" 2>/dev/null)"; then
      echo "  [OK]   ${label} (${url}) -> ${resp}"
      return 0
    fi
  fi
  echo "  [WAIT] ${label} (${url}) 未响应（若对应服务尚未启动，属正常现象）"
  return 0
}

echo "=== dsh-hermes-bridge Hermes 安装辅助脚本 ==="
echo "仓库路径: ${REPO_ROOT}"
echo "HERMES_HOME: ${HERMES_HOME}"
echo

# 1. Symlink Skill
if [[ ! -f "${SKILL_SRC}/SKILL.md" ]]; then
  echo "Error: 未找到 Skill 文件: ${SKILL_SRC}/SKILL.md" >&2
  exit 1
fi

if [[ "${DRY_RUN}" -eq 1 ]]; then
  echo "[dry-run] 将创建目录: ${SKILL_DEST_DIR}"
  echo "[dry-run] 将创建软链接: ${SKILL_DEST} -> ${SKILL_SRC}"
else
  mkdir -p "${SKILL_DEST_DIR}"
  ln -sfn "${SKILL_SRC}" "${SKILL_DEST}"
  echo "[OK] 已软链 Skill: ${SKILL_DEST} -> ${SKILL_SRC}"
fi
echo

# 2. Generate shared secrets
MCP_TOKEN="${DSH_HERMES_MCP_TOKEN:-$(gen_secret)}"
WEBHOOK_SECRET="${DSH_HERMES_WEBHOOK_SECRET:-$(gen_secret)}"

echo "=== 请将以下环境变量添加到 DSH 运行环境（或写入 cordis.patch.yml） ==="
cat <<EOF
export DSH_HERMES_MCP_TOKEN="${MCP_TOKEN}"
export DSH_HERMES_WEBHOOK_SECRET="${WEBHOOK_SECRET}"
EOF
echo

echo "=== 请将以下配置合并到 ${HERMES_HOME}/config.yaml ==="
cat <<EOF
platforms:
  webhook:
    enabled: true
    extra:
      host: "127.0.0.1"
      port: 8644
      rate_limit: 60
      routes:
        dsh-events:
          secret: "${WEBHOOK_SECRET}"
          events: ["paused_approval", "paused_question", "interrupted_error", "stopped"]
          deliver: "telegram"
          deliver_only: true
          mirror_to_session: true
          prompt: "DSH 那边「{taskTitle}」现在处于「{stateLabel}」状态：{summary}"

mcp_servers:
  dsh_bridge:
    url: "http://127.0.0.1:8790/mcp"
    headers:
      Authorization: "Bearer ${MCP_TOKEN}"
    timeout: 60
    connect_timeout: 30
EOF
echo

echo "=== 本地开发挂载示例（DSH --patch） ==="
cat <<EOF
dsh --profile web --patch ${REPO_ROOT}/cordis.patch.yml
EOF
echo

echo "=== 连通性探测 ==="
probe_url "Hermes Webhook" "${WEBHOOK_HEALTH_URL}"
probe_url "DSH Bridge MCP" "${MCP_HEALTH_URL}"
