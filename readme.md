# 一小時搞定：用 Claude Max 訂閱 + AWS 打造你的 Telegram AI 助手

> 把 $200/月的 Opus 4.6 變成 24/7 隨身 AI 顧問，從零到能聊天只要一小時。

---

## 為什麼要做這件事

試過各家模型當 OpenClaw 的大腦——Kimi K2.5、Gemini 3 Pro、GPT 5.2、MiniMax M2.5，全部跑了一輪。

結論：Opus 4.6 的「活人感」碾壓全場。講話直接，像個靠譜的工程師，但關鍵時刻又會幫你多想一步。

問題是 API 直打真的貴。跑不到一小時燒 $10，一個月幾千美金跑不掉。

Session Token 白嫖？Reddit 上一堆慘案，帳號被 Ban，歷史對話全沒，調教好的思維慣性歸零。不值得。

所以我換了個思路：**Claude Max 訂閱 $200/月，透過 Claude Code CLI 的 `--print` 模式驅動，官方 Binary 出去的 Request，跟你坐在 Terminal 前打字沒區別。**

---

## 最終架構

```
手機 Telegram
    ↓
@你的Bot
    ↓
OpenClaw Gateway (systemd)
    ↓
自訂 Provider (claude-proxy)
    ↓
Node.js Proxy (PM2, localhost:3456)
    ↓  ┌─────────────────────────┐
    ↓  │ Session Map             │
    ↓  │ fingerprint → sessionId │
    ↓  └─────────────────────────┘
    ↓
claude --print --permission-mode auto --resume <session-id>
    ↓
Anthropic API (Max 訂閱)
```

全部跑在一台 AWS EC2 Free Tier 上。月費：**$200（就是 Claude Max 訂閱費）。**

---

## 功能特色

- **OpenAI 相容 API**：`POST /v1/chat/completions`，可直接作為 OpenClaw 的自訂 provider
- **Session 持久化**：同一對話自動 `--resume`，Claude 記得完整歷史
- **三階段動態工具核准**：Claude 需要工具時主動詢問，用戶核准後才授權，已核准的工具累積保留
- **`--permission-mode auto`**：取代 `--dangerously-skip-permissions`，Claude 自行判斷安全操作
- **Simulated streaming**：相容 OpenClaw 的 streaming 請求
- **Session TTL**：閒置超過 24 小時自動清除

---

## 完整步驟

### Step 1：開 VPS / EC2

- Instance: t3.small (2 vCPU, 2GB RAM) 或同等 VPS
- OS: Ubuntu 24.04 LTS
- Storage: 30GB gp3
- Security Group: **只開 SSH (22)，其他什麼都不開**
- 綁 Elastic IP（重啟不換 IP）

為什麼只開 SSH？因為 Bot 和 Proxy 跑在同一台機器，全走 localhost，不需要對外暴露任何端口。這是最安全的做法。

### Step 2：安裝基礎工具

```bash
ssh -i your-key.pem ubuntu@你的IP

# Node.js 22（OpenClaw 需要 22+）
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs

# PM2 進程管理 + Claude Code CLI
sudo npm install -g pm2 @anthropic-ai/claude-code

# 認證 Claude CLI（只做一次）
claude
# 瀏覽器打開 URL → 登入你的 Max 帳號 → 完成後 Ctrl+C
```

### Step 3：部署 Proxy

```bash
git clone https://github.com/lydian/openclaw-claude-proxy.git
cd openclaw-claude-proxy
npm install

# 設定環境變數
cat > .env <<EOF
API_KEY=$(openssl rand -hex 16)
PORT=3456
BIND_ADDR=127.0.0.1
MAX_CONCURRENT=3
REQUEST_TIMEOUT=300000
SESSION_TTL=86400000
EOF

# 用 PM2 啟動 + 開機自啟
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

**環境變數說明：**

| 變數 | 預設值 | 說明 |
|---|---|---|
| `API_KEY` | （空，不驗證） | Proxy 的 Bearer Token |
| `PORT` | `3456` | 監聽埠號 |
| `BIND_ADDR` | `127.0.0.1` | 綁定地址（安全起見不要用 `0.0.0.0`） |
| `MAX_CONCURRENT` | `3` | 最大同時請求數 |
| `REQUEST_TIMEOUT` | `300000` | 請求逾時（毫秒） |
| `SESSION_TTL` | `86400000` | Session 過期時間（預設 24 小時） |
| `MAX_TOOL_TURNS` | `10` | Claude 工具執行最大回合數 |

### Step 4：安裝 OpenClaw

```bash
sudo npm install -g openclaw@latest
```

### Step 5：設定 Telegram Bot

1. Telegram 找 @BotFather → `/newbot` → 拿到 Bot Token
2. 設定 OpenClaw：

```bash
# Telegram
openclaw config set channels.telegram.botToken "你的TOKEN"
openclaw config set channels.telegram.dmPolicy allowlist
openclaw config set channels.telegram.allowFrom --json '["telegram:你的USER_ID"]'

# Gateway
openclaw config set gateway.mode local
```

### Step 6：設定自訂 Provider（最關鍵的一步）

這是整個過程中踩坑最多的地方。試了 `OPENAI_BASE_URL` 環境變數、`agents.defaults.model` 各種格式，全部失敗。

**最終解法：用 `models.providers` 註冊自訂 provider。**

```bash
openclaw config set 'models.providers.claude-proxy' --json '{
  "baseUrl": "http://localhost:3456/v1",
  "apiKey": "你的PROXY_API_KEY",
  "api": "openai-completions",
  "models": [
    {"id": "claude-opus-4-6", "name": "Claude Opus 4.6"}
  ]
}'

# 作為主要模型
openclaw config set agents.defaults.model.primary "claude-proxy/claude-opus-4-6"

# 或作為 fallback
openclaw config set agents.defaults.model.fallbacks --json '["claude-proxy/claude-opus-4-6", "openrouter/auto"]'
```

這樣 OpenClaw 就會把所有 AI 請求打到你的本地 Proxy，而不是直接打 OpenAI 或 Anthropic 的 API。如果 OpenClaw 跑在 Docker 容器中，`baseUrl` 需改為 Docker bridge gateway IP（如 `http://172.21.0.1:3456/v1`），並確保防火牆允許容器存取該埠。

### Step 7：啟動

```bash
# 建立 systemd service（見部署筆記）
sudo systemctl enable openclaw
sudo systemctl start openclaw
```

打開 Telegram，跟你的 Bot 說句話。看到回覆的那一刻，值了。

---

## API 端點

| 方法 | 路徑 | 說明 |
|---|---|---|
| POST | `/v1/chat/completions` | OpenAI 相容的 chat completion（含三階段工具核准） |
| GET | `/v1/models` | 可用模型列表 |
| GET | `/health` | 健康檢查（含活躍 session 數） |
| GET | `/sessions` | 列出所有 session 狀態、已核准工具（需認證） |

回應中會包含 `claude_session_id` 欄位，方便追蹤。

---

## Session 機制

Proxy 用 `hash(system_prompt + 第一條 user message)` 產生 fingerprint，對應到一個 Claude session：

- **新對話**：`claude -p --permission-mode auto --session-id <UUID>`
- **延續對話**：`claude -p --permission-mode auto --resume <UUID>`

Resume 時只傳最後一條 user message，避免重複上下文。

### 三階段工具核准

```
NORMAL ──(Claude 需要工具)──→ PENDING_APPROVAL
                                    │
                              (用戶回應)
                                    │
                    ┌───────────────┴───────────────┐
                    ↓                               ↓
            (核准工具)                        (拒絕/無關)
                    │                               │
          Advisor 解析工具                    直接當一般訊息
          Resume + --allowedTools                   │
                    │                               │
                    └───────────→ NORMAL ←──────────┘
```

**流程範例：**

```
請求 1：「幫我看 /etc/hostname 的內容」
  → Claude：{"response": "我需要 Read 權限...", "tools_need_approval": ["Read"]}
  → 用戶收到：「我需要 Read 權限...」

請求 2：「好，去做」
  → Advisor 確認核准 ["Read"]
  → claude -p --resume <UUID> --allowedTools "Read"
  → Claude 讀取檔案，回傳結果（approvedTools 累積保留）

請求 3：「幫我改 /etc/hosts」
  → Claude 還需要 Write → 再走一次核准流程
  → 核准後：--allowedTools "Read,Write"（累積）
```

Session 閒置超過 TTL 後自動清除，工具權限歸零。Resume 失敗時自動清除 session，下次請求重新建立。

---

## 安全性

- **`--permission-mode auto`**：Claude 自行判斷操作安全性，高風險操作需用戶核准
- **動態工具核准**：工具權限逐步授權，非一次全開
- **`BIND_ADDR`**：預設 `127.0.0.1`，只接受本地連線。Docker 環境改為 bridge gateway IP，不要用 `0.0.0.0`
- **建議跑在獨立 VPS/EC2 上**，不要跑在有個人資料的電腦上
- **Claude Max 使用**：`claude --print` 是官方 CLI 功能，Request 從官方 Binary 出去。避免跑固定間隔的 heartbeat 任務，太規律的 pattern 可能被標記

---

## 踩過的坑

| 坑 | 症狀 | 解法 |
|---|---|---|
| Node 版本太低 | OpenClaw 啟動報錯 | Node 20 → 22 |
| Gateway 不啟動 | `gateway.mode` 未設定 | `openclaw config set gateway.mode local` |
| Model 不認識 | `Unknown model` | 用 `models.providers` 自訂，不能用內建 provider |
| `OPENAI_BASE_URL` 沒用 | 請求打去真 OpenAI | OpenClaw 不讀環境變數，必須用 config |
| Streaming 卡住 | Bot 沒回應 | `--print` 不支援真 streaming，用 simulated stream |
| Docker 容器連不到 Proxy | Connection timeout | 改 `BIND_ADDR` 為 Docker bridge gateway IP + 加 iptables 規則 |

---

## 資源

- 上游 repo：[51AutoPilot/openclaw-claude-proxy](https://github.com/51AutoPilot/openclaw-claude-proxy)
- OpenClaw：[github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- Claude Code CLI：[Anthropic 官方工具](https://docs.anthropic.com/en/docs/claude-code)
