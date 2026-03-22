# Changelog

## [Unreleased]

### Added

- **Session 持久化**：用 `hash(system_prompt + 第一條 user message)` 產生 fingerprint，對應 Claude session。新對話用 `--session-id`，後續用 `--resume` 延續完整歷史。
- **三階段動態工具核准**：Claude 在 JSON 回應中聲明需要的工具（`tools_need_approval`），用戶核准後 Proxy 以 `--allowedTools` 精確授權。已核准的工具在 session 內累積保留。
- **Advisor 模式**：用戶的核准回應由獨立的 Claude 一次性呼叫解析（不汙染主 session）。
- **`BIND_ADDR` 環境變數**：可配置綁定地址，預設 `127.0.0.1`。
- **`SESSION_TTL` 環境變數**：Session 過期時間，預設 24 小時。
- **`GET /sessions` 端點**：列出所有活躍 session 的狀態、待核准工具和已累積核准的工具（需認證）。
- **JSON 格式回應指令**：注入 system prompt，強制 Claude 以 `{"response": "...", "tools_need_approval": [...]}` 格式回應。
- **Session 狀態機**：`NORMAL` ↔ `PENDING_APPROVAL`，自動追蹤工具核准流程。
- **自動清除機制**：Session 閒置超過 TTL 自動清除；resume 失敗時自動清除 stale session。

### Changed

- Resume 時只傳最後一條 user message，避免與 Claude session 歷史重複。
- `health` 端點新增 `active_sessions` 欄位。

### Removed

- **移除 `--dangerously-skip-permissions`**：改用 `--permission-mode auto` + 動態 `--allowedTools`。

## [1.0.0] - 2026-03-20

Initial release by [51AutoPilot](https://github.com/51AutoPilot/openclaw-claude-proxy).

### Added

- OpenAI 相容的 `/v1/chat/completions` 端點
- 透過 `claude --print` 轉發請求給 Claude Code CLI
- Simulated streaming（SSE）
- Bearer token 認證
- 並發請求限制
- PM2 ecosystem 設定
- `/v1/models` 和 `/health` 端點

[Unreleased]: https://github.com/lydian/openclaw-claude-proxy/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/lydian/openclaw-claude-proxy/releases/tag/v1.0.0
