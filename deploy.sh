#!/usr/bin/env bash
# =====================================================================
# 部署 CloudFetch 到 Cloady PaaS
#
# 用法：
#   export CLOADY_TOKEN=cldy_xxx
#   export GIT_REPO_URL=https://github.com/<user>/cloudfetch
#   ./deploy.sh
#
# 可选环境变量：
#   APP_NAME       应用名，默认 cloudfetch
#   REGION         地区，默认自动挑可用 free 区
#   PANEL_PASSWORD 面板密码
#   OPENLIST_URL   OpenList 地址
#   OPENLIST_TOKEN OpenList 令牌
#   LIVE_SEGMENT_SECONDS 直播分段时长（秒），默认 600（10 分钟）
#   OPENLIST_UPLOAD_DIR  上传目录，默认 /cloudfetch
#                        （也接受旧名 UPLOAD_DIR，两者等价）
# =====================================================================
set -euo pipefail

API="https://cloady.com"
: "${CLOADY_TOKEN:?需要 CLOADY_TOKEN}"
: "${GIT_REPO_URL:?需要 GIT_REPO_URL（仓库地址）}"

APP_NAME="${APP_NAME:-cloudfetch}"
# 兼容两种写法：优先 OPENLIST_UPLOAD_DIR，其次 UPLOAD_DIR
UPLOAD_DIR="${OPENLIST_UPLOAD_DIR:-${UPLOAD_DIR:-/cloudfetch}}"
AUTH=(-H "Authorization: Bearer ${CLOADY_TOKEN}")

jqget() { python -c "import sys,json;d=json.load(sys.stdin);print(eval(sys.argv[1]))" "$1" 2>/dev/null || true; }

echo "==> 校验令牌"
ME="$(curl -fsS "${AUTH[@]}" "${API}/api/me")"
WS="$(echo "${ME}" >/dev/null; curl -fsS "${AUTH[@]}" "${API}/api/workspaces" | jqget "d['workspaces'][0]['slug']")"
if [ -z "${WS}" ]; then
  echo "!! 无法获取工作区，令牌可能无效"
  exit 1
fi
USER_NAME="$(echo "${ME}" | jqget "d['user']['name']")"
echo "    用户=${USER_NAME}  工作区=${WS}"

# ---------- 选地区 ----------
if [ -z "${REGION:-}" ]; then
  echo "==> 选择可用地区"
  REGION="$(curl -fsS "${AUTH[@]}" "${API}/api/regions" | python -c "
import sys,json
d=json.load(sys.stdin)
ok=[r for r in d['regions'] if r['status']=='ready' and r['plan']=='free']
# 优先日本/新加坡，其次美西/美东/欧洲
pref=['jpn1','sin1','usw1','use1','eu1','usc1','uk1','aus1','ind1']
ok.sort(key=lambda r: pref.index(r['id']) if r['id'] in pref else 99)
print(ok[0]['id'] if ok else '')
")"
  if [ -z "${REGION}" ]; then echo "!! 没有可用地区"; exit 1; fi
fi
echo "    地区=${REGION}"

# ---------- 检查同名应用 ----------
echo "==> 检查是否已存在应用 ${APP_NAME}"
EXISTING="$(curl -fsS "${AUTH[@]}" "${API}/api/workspaces/${WS}" | python -c "
import sys,json
d=json.load(sys.stdin)
svcs=d.get('workspace',{}).get('services') or []
hit=[s for s in svcs if s.get('slug')=='${APP_NAME}' or s.get('name')=='${APP_NAME}']
print(hit[0].get('slug','') if hit else '')
" 2>/dev/null || true)"

if [ -n "${EXISTING}" ]; then
  echo "    应用已存在，同步环境变量后重新部署"
  APP_SLUG="${EXISTING}"

  # 关键：已存在的应用不会自动继承新的 env，必须逐个写入。
  # 先 GET 现有变量拿到 id，已存在则 PATCH 更新，不存在则 POST 创建。
  VARS_JSON="$(curl -fsS "${AUTH[@]}" "${API}/api/workspaces/${WS}/apps/${APP_SLUG}/vars" || echo '{"vars":[]}')"

  set_var() {
    local key="$1" val="$2"
    [ -z "${val}" ] && return 0

    # 查这个 key 是否已存在
    local vid
    vid="$(echo "${VARS_JSON}" | python -c "
import sys,json
try:
    d=json.load(sys.stdin)
    for v in (d.get('vars') or []):
        if v.get('key')=='$key': print(v.get('id','')); break
except Exception: pass
" 2>/dev/null || true)"

    local body code
    # 同样用环境变量传值，避免密钥出现在进程命令行里
    body="$(CF_K="$key" CF_V="$val" python -c 'import json,os;print(json.dumps({"key":os.environ["CF_K"],"value":os.environ["CF_V"]}))')"

    if [ -n "${vid}" ]; then
      # 注意：不要带 ?env= 查询参数，服务端会把它当成 varId 解析而报 400
      code="$(curl -s -o /tmp/_v.out -w '%{http_code}' -X PATCH "${AUTH[@]}" \
        -H "Content-Type: application/json" -d "${body}" \
        "${API}/api/workspaces/${WS}/apps/${APP_SLUG}/vars/${vid}")"
    else
      code="$(curl -s -o /tmp/_v.out -w '%{http_code}' -X POST "${AUTH[@]}" \
        -H "Content-Type: application/json" -d "${body}" \
        "${API}/api/workspaces/${WS}/apps/${APP_SLUG}/vars")"
    fi

    if [ "${code}" = "200" ] || [ "${code}" = "201" ]; then
      echo "      ${key} = ${val} ✓"
    else
      echo "      ${key} 写入返回 HTTP ${code}：$(head -c 200 /tmp/_v.out)"
    fi
  }

  set_var "PORT" "3000"
  set_var "DATA_DIR" "/tmp/cloudfetch"
  set_var "OPENLIST_UPLOAD_DIR" "${UPLOAD_DIR}"
  set_var "DELETE_AFTER_UPLOAD" "true"
  set_var "MAX_CONCURRENT" "2"
  set_var "RETRY_MAX_ATTEMPTS" "8"
  set_var "LIVE_SEGMENT_SECONDS" "${LIVE_SEGMENT_SECONDS:-600}"
  [ -n "${PANEL_PASSWORD:-}" ] && set_var "PANEL_PASSWORD" "${PANEL_PASSWORD}"
  [ -n "${OPENLIST_URL:-}" ]   && set_var "OPENLIST_URL" "${OPENLIST_URL}"
  [ -n "${OPENLIST_TOKEN:-}" ] && set_var "OPENLIST_TOKEN" "${OPENLIST_TOKEN}"
  rm -f /tmp/_v.out

  echo "    触发重新部署"
  curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" \
    -d '{}' "${API}/api/workspaces/${WS}/apps/${APP_SLUG}/deploy" >/dev/null
else
  # ---------- 创建应用 ----------
  echo "==> 创建应用"
  BODY="$(mktemp)"
  # 用环境变量传参，不要走 argv：命令行参数在 ps/proc 里对同机所有用户可见，
  # 等于把 PANEL_PASSWORD / OPENLIST_TOKEN 明文挂出去。
  export CF_APP_NAME="$APP_NAME" \
         CF_REGION="$REGION" \
         CF_REPO="$GIT_REPO_URL" \
         CF_PANEL_PASSWORD="${PANEL_PASSWORD:-}" \
         CF_OPENLIST_URL="${OPENLIST_URL:-}" \
         CF_OPENLIST_TOKEN="${OPENLIST_TOKEN:-}" \
         CF_UPLOAD_DIR="$UPLOAD_DIR"
  python - "$BODY" <<'PY'
import json,sys,os
out = sys.argv[1]
name   = os.environ.get("CF_APP_NAME","cloudfetch")
region = os.environ.get("CF_REGION","")
repo   = os.environ.get("CF_REPO","")
pw     = os.environ.get("CF_PANEL_PASSWORD","")
olurl  = os.environ.get("CF_OPENLIST_URL","")
oltok  = os.environ.get("CF_OPENLIST_TOKEN","")
updir  = os.environ.get("CF_UPLOAD_DIR","/cloudfetch") or "/cloudfetch"
env = {
    "PORT": "3000",
    "DATA_DIR": "/tmp/cloudfetch",
    "OPENLIST_UPLOAD_DIR": updir,
    "DELETE_AFTER_UPLOAD": "true",
    "MAX_CONCURRENT": "2",
    "RETRY_MAX_ATTEMPTS": "8",
    "LIVE_SEGMENT_SECONDS": os.environ.get("LIVE_SEGMENT_SECONDS","600"),
}
secret = []
if pw:    env["PANEL_PASSWORD"]=pw; secret.append("PANEL_PASSWORD")
if olurl: env["OPENLIST_URL"]=olurl
if oltok: env["OPENLIST_TOKEN"]=oltok; secret.append("OPENLIST_TOKEN")
body = {
    "name": name,
    "region": region,
    "source": {"type":"git","repoUrl":repo},
    "port": 3000,
    "values": env,
    "secretKeys": secret,
    "scale": {"cpu":0.5,"memory":1},
}
open(out,'w').write(json.dumps(body))
print("    body ok, env keys:", list(env.keys()))
PY
  RESP="$(curl -fsS -X POST "${AUTH[@]}" -H "Content-Type: application/json" -d @"${BODY}" "${API}/api/workspaces/${WS}/deploy")"
  rm -f "${BODY}"
  APP_SLUG="$(echo "${RESP}" | python -c "
import sys,json
d=json.load(sys.stdin)
a=d.get('app') or {}
print(a.get('slug') or a.get('name') or '')
" 2>/dev/null || true)"
  if [ -z "${APP_SLUG}" ]; then
    echo "!! 创建失败，响应："
    echo "${RESP}"
    exit 1
  fi
  echo "    创建成功 slug=${APP_SLUG}"
fi

# ---------- 轮询状态 ----------
echo "==> 等待部署完成（最长 10 分钟）"
STATE=""
for i in $(seq 1 60); do
  sleep 10
  INFO="$(curl -fsS "${AUTH[@]}" "${API}/api/workspaces/${WS}/apps/${APP_SLUG}/status" 2>/dev/null || echo '{}')"
  STATE="$(echo "${INFO}" | python -c "
import sys,json
try:
    d=json.load(sys.stdin)
    print(d.get('status') or d.get('state') or '')
except: print('')
" 2>/dev/null || true)"
  echo "    [${i}/60] status=${STATE}"
  case "${STATE}" in
    running|ready|healthy|active) break ;;
    failed|error|crashed) echo "!! 部署失败"; break ;;
  esac
done

# ---------- 取访问地址 ----------
echo ""
echo "==> 应用信息"
curl -fsS "${AUTH[@]}" "${API}/api/workspaces/${WS}/apps/${APP_SLUG}/domains" 2>/dev/null \
  | python -c "
import sys,json
try:
    d=json.load(sys.stdin)
    ds = d.get('domains') or d if isinstance(d,list) else d.get('domains',[])
    for x in (ds or []):
        print('    域名:', x.get('host'))
except Exception as e:
    print('    (取域名失败)', e)
" 2>/dev/null || true

echo ""
echo "======================================================"
echo "  应用名 : ${APP_SLUG}"
echo "  工作区 : ${WS}"
echo "  地区   : ${REGION}"
echo "  状态   : ${STATE}"
echo "======================================================"
echo ""
echo "如状态不是 running，查看构建日志："
echo "  curl -H 'Authorization: Bearer \$CLOADY_TOKEN' \\"
echo "    '${API}/api/workspaces/${WS}/apps/${APP_SLUG}/deploys'"
