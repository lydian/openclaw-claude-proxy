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
    ↓
claude --print (官方 CLI Binary)
    ↓
Anthropic API (Max 訂閱)
```

全部跑在一台 AWS EC2 Free Tier 上。月費：**$200（就是 Claude Max 訂閱費）。**

---

## 完整步驟

### Step 1：開 AWS EC2

- Region: ap-northeast-1 (Tokyo)
- Instance: t3.small (2 vCPU, 2GB RAM)
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

Proxy 的本質很簡單：接收 OpenAI 格式的 API 請求，轉成 CLI 指令丟給 Claude，再把回覆包成 OpenAI 格式回傳。

**server.js 核心邏輯：**

```javascript
// 把 OpenAI messages 格式轉成純文字
function messagesToPrompt(messages) {
  const parts = [];
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content : '';
    if (msg.role === 'system') {
      parts.push(`[System Instructions]\n${content}\n[End System Instructions]`);
    } else if (msg.role === 'assistant') {
      parts.push(`[Previous Assistant Response]\n${content}`);
    } else {
      parts.push(content);
    }
  }
  return parts.join('\n\n');
}

// 呼叫 Claude CLI
function callClaude(prompt, systemPrompt) {
  return new Promise((resolve, reject) => {
    const args = ['--print'];
    if (systemPrompt) args.push('--system-prompt', systemPrompt);
    args.push(prompt);

    const proc = spawn('claude', args, {
      cwd: process.env.HOME || '/home/ubuntu',
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.on('close', (code) => {
      code !== 0 ? reject(new Error('CLI failed')) : resolve(stdout.trim());
    });
  });
}
```

**關鍵設計決策：**

OpenClaw 會發 streaming 請求，但 `claude --print` 是一次輸出完整回覆。所以我用 **simulated stream** ── CLI 跑完後，把完整回覆包成一個 SSE chunk 回傳。比真 streaming 慢一點點（等 CLI 跑完才回），但 100% 穩定。

```bash
mkdir ~/openclaw-claude-proxy
# 把 server.js, package.json, .env 放進去
cd ~/openclaw-claude-proxy
npm install

# 生成 API Key
echo "API_KEY=sk-proxy-$(openssl rand -hex 16)" >> .env

# 用 PM2 啟動 + 開機自啟
pm2 start ecosystem.config.js
pm2 save && pm2 startup
```

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

openclaw config set agents.defaults.model.primary "claude-proxy/claude-opus-4-6"
```

這樣 OpenClaw 就會把所有 AI 請求打到你的本地 Proxy，而不是直接打 OpenAI 或 Anthropic 的 API。

### Step 7：啟動

```bash
# 建立 systemd service（見部署筆記）
sudo systemctl enable openclaw
sudo systemctl start openclaw
```

打開 Telegram，跟你的 Bot 說句話。看到回覆的那一刻，值了。

---

## 踩過的坑

| 坑 | 症狀 | 解法 |
|---|---|---|
| Node 版本太低 | OpenClaw 啟動報錯 | Node 20 → 22 |
| Gateway 不啟動 | `gateway.mode` 未設定 | `openclaw config set gateway.mode local` |
| Telegram 拒絕回應 | `access not configured` | 設 `dmPolicy: allowlist` + 加你的 user ID |
| Model 不認識 | `Unknown model: openai/claude-opus-4-6` | 不能用內建 provider，要用 `models.providers` 自訂 |
| `OPENAI_BASE_URL` 沒用 | 請求打去真 OpenAI | OpenClaw 不讀這個環境變數，必須用 config |
| Streaming 卡住 | Bot 沒回應也沒報錯 | `--print` 不支援真 streaming，改 simulated stream |
| Sandbox 擋寫入 | Bot 說不能寫 workspace | 改 CLI 工作目錄到 `$HOME` + 開 `tools.fs.workspaceOnly: false` |

---

## 跟原文作者方案的差異

原文作者花了三個小時破三道牆：權限（跳過 Y 確認）、環境（TTY 模擬）、瀏覽器（封裝 Playwright 指令）。

我的方案更簡單：

| | 原文方案 | 我的方案 |
|---|---|---|
| CLI 模式 | 完整 Agent（需要 TTY 模擬） | `--print` 純文字模式 |
| 權限處理 | `--dangerously-skip-permissions` | 不需要（print 模式無互動） |
| 瀏覽器 | CLI 封裝 Playwright | OpenClaw 原生 Playwright |
| 寫 code | CLI 原生工具 | OpenClaw coding-agent skill |
| 架構 | CLI = 完整 Agent 替代品 | CLI = 純大腦，OpenClaw = 身體 |
| 耗時 | 3 小時 | 1 小時 |

核心差異：**我不讓 CLI 做 Agent 的事。CLI 只負責思考，OpenClaw 負責所有動作。** 兩邊各做各的強項，零坑。

---

## 安全性

跑在 AWS EC2 上而不是本地電腦，是刻意的選擇。

OpenClaw 的 Agent 有能力讀寫檔案、操作瀏覽器、跑 shell 指令。跑在你的 Mac/PC 上，你的照片、密碼、私鑰全暴露在它面前。

EC2 是一台空機器。OpenClaw 權力再大，面對一台沒有個人資料的 Ubuntu，也搞不出什麼名堂。壞了就砍掉重建。

Security Group 只開 SSH，Proxy port 不對外。所有流量走 localhost。

至於 Claude Max 的使用：`claude --print` 是官方 CLI 的官方功能，Request 從官方 Binary 出去。跟你坐在 Terminal 前面打字沒有區別。唯一注意：不要跑固定間隔的 heartbeat 任務，太規律的 request pattern 可能被標記。這類工作交給 Gemini Flash。

---

## 最終成果

一台 $15/月的 EC2 + $200/月的 Claude Max，換來：

- ✅ Telegram 24/7 AI 助手（Opus 4.6 大腦）
- ✅ 瀏覽器操作（Playwright + Chromium）
- ✅ 寫程式（coding-agent）
- ✅ 檔案讀寫
- ✅ 排程任務（cron）
- ✅ 持久記憶（MEMORY.md + session）
- ✅ 可擴展（Twitter、Discord 隨時加）

所有 Request 走官方 Binary，不偷 Token，不怕封號。

既然有最好的靈魂，就該親手為它打造最適合的軀殼。

---

## 資源

- Proxy 原始碼 + 部署筆記：在 `openclaw-claude-proxy/` 目錄
- OpenClaw 官方：[github.com/openclaw/openclaw](https://github.com/openclaw/openclaw)
- Claude Code CLI：[Anthropic 官方工具](https://docs.anthropic.com/en/docs/claude-code)
