#!/usr/bin/env node
// OpenClaw ↔ Claude Code CLI Proxy
// Exposes OpenAI-compatible /v1/chat/completions endpoint
// Routes through: claude -p --permission-mode auto with session persistence
// and dynamic tool approval via 3-phase flow

const express = require('express');
const { spawn } = require('child_process');
const { randomUUID, createHash } = require('crypto');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const PORT = parseInt(process.env.PORT || '3456', 10);
const API_KEY = process.env.API_KEY || '';
const CLAUDE_CLI = process.env.CLAUDE_CLI_PATH || 'claude';
const MAX_CONCURRENT = parseInt(process.env.MAX_CONCURRENT || '3', 10);
const REQUEST_TIMEOUT = parseInt(process.env.REQUEST_TIMEOUT || '300000', 10);
const MAX_TOOL_TURNS = parseInt(process.env.MAX_TOOL_TURNS || '10', 10);
const SESSION_TTL = parseInt(process.env.SESSION_TTL || '86400000', 10); // 24h default

let activeRequests = 0;

const app = express();
app.use(express.json({ limit: '10mb' }));

// ---------------------------------------------------------------------------
// JSON response format instruction appended to system prompt
// ---------------------------------------------------------------------------
const JSON_FORMAT_INSTRUCTION = `

IMPORTANT RESPONSE FORMAT: You MUST always respond in the following JSON format, with no other text outside the JSON:
{"response": "<your natural language response here>", "tools_need_approval": []}

Rules:
- "response" contains your full natural language answer (use \\n for newlines)
- "tools_need_approval" is an array of Claude Code tool names you need permission to use
- If you can answer without any tools, set "tools_need_approval" to []
- If you need tools that are not currently allowed (e.g. Read, Write, Edit, Bash, Grep, Glob, WebFetch, WebSearch), list them in "tools_need_approval" and explain in "response" what you want to do and why
- When you have been granted tools and are asked to proceed, execute the tools and put the result in "response"
- ALWAYS respond with valid JSON. Never add text before or after the JSON object.
`;

// ---------------------------------------------------------------------------
// Session tracking
// States: NORMAL → PENDING_APPROVAL → NORMAL
// ---------------------------------------------------------------------------
const sessionMap = new Map();

// Session shape:
// {
//   claudeSessionId: string,
//   lastUsed: number,
//   state: 'NORMAL' | 'PENDING_APPROVAL',
//   pendingTools: string[],       // tools awaiting approval
//   approvedTools: Set<string>,   // tools approved so far (cumulative)
// }

function getSessionFingerprint(systemPrompt, messages) {
  const firstUserMsg = messages.find(m => m.role === 'user');
  const content = firstUserMsg
    ? (typeof firstUserMsg.content === 'string'
        ? firstUserMsg.content
        : Array.isArray(firstUserMsg.content)
          ? firstUserMsg.content.map(c => c.text || '').join('\n')
          : String(firstUserMsg.content || ''))
    : '';
  const raw = (systemPrompt || '') + '::' + content;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

function getOrCreateSession(fingerprint) {
  const existing = sessionMap.get(fingerprint);
  if (existing) {
    existing.lastUsed = Date.now();
    return { session: existing, isNew: false };
  }
  const session = {
    claudeSessionId: randomUUID(),
    lastUsed: Date.now(),
    state: 'NORMAL',
    pendingTools: [],
    approvedTools: new Set(),
  };
  sessionMap.set(fingerprint, session);
  return { session, isNew: true };
}

// Periodically clean up stale sessions
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of sessionMap) {
    if (now - val.lastUsed > SESSION_TTL) {
      sessionMap.delete(key);
    }
  }
}, 3600000);

// ---------------------------------------------------------------------------
// Auth middleware
// ---------------------------------------------------------------------------
function auth(req, res, next) {
  if (!API_KEY) return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  if (token !== API_KEY) {
    return res.status(401).json({ error: { message: 'Invalid API key', type: 'auth_error' } });
  }
  next();
}

// ---------------------------------------------------------------------------
// Extract content string from a message
// ---------------------------------------------------------------------------
function extractContent(msg) {
  if (typeof msg.content === 'string') return msg.content;
  if (Array.isArray(msg.content)) return msg.content.map(c => c.text || '').join('\n');
  return String(msg.content || '');
}

// ---------------------------------------------------------------------------
// Convert messages to prompt
// ---------------------------------------------------------------------------
function messagesToPrompt(messages, isNewSession) {
  if (!Array.isArray(messages) || messages.length === 0) return '';

  // For resumed sessions, only send the last user message
  if (!isNewSession) {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === 'user') return extractContent(messages[i]);
    }
    return '';
  }

  // For new sessions, send the full conversation
  const parts = [];
  for (const msg of messages) {
    const role = msg.role || 'user';
    const content = extractContent(msg);

    if (role === 'system') {
      parts.push(`[System Instructions]\n${content}\n[End System Instructions]`);
    } else if (role === 'assistant') {
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        const tcDesc = msg.tool_calls.map(tc => {
          let args = tc.function?.arguments || '{}';
          try { args = JSON.stringify(JSON.parse(args), null, 2); } catch (_) {}
          return `<tool_call>\n{"name": "${tc.function?.name}", "arguments": ${args}}\n</tool_call>`;
        }).join('\n');
        parts.push(`[Previous Assistant Response]\n${content || ''}${tcDesc ? '\n' + tcDesc : ''}`);
      } else {
        parts.push(`[Previous Assistant Response]\n${content}`);
      }
    } else if (role === 'tool') {
      const name = msg.name || msg.tool_call_id || 'unknown';
      parts.push(`[Tool Result: ${name}]\n${content}`);
    } else {
      parts.push(content);
    }
  }
  return parts.join('\n\n');
}

// ---------------------------------------------------------------------------
// Parse Claude's JSON response
// Falls back to raw text if not valid JSON
// ---------------------------------------------------------------------------
function parseClaudeResponse(raw) {
  const trimmed = raw.trim();

  // Try to extract JSON from the response (Claude may wrap it in markdown code blocks)
  let jsonStr = trimmed;

  // Strip ```json ... ``` wrapper if present
  const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (codeBlockMatch) {
    jsonStr = codeBlockMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    if (typeof parsed.response === 'string') {
      return {
        response: parsed.response,
        toolsNeedApproval: Array.isArray(parsed.tools_need_approval) ? parsed.tools_need_approval : [],
      };
    }
  } catch (_) {
    // Not valid JSON
  }

  // Fallback: treat entire output as plain response, no tools needed
  return { response: trimmed, toolsNeedApproval: [] };
}

// ---------------------------------------------------------------------------
// Spawn Claude Code CLI
// ---------------------------------------------------------------------------
function callClaude(prompt, { systemPrompt, claudeSessionId, isNewSession, hasTools, allowedTools }) {
  return new Promise((resolve, reject) => {
    const args = ['--print'];

    // Block Telegram MCP tools — OpenClaw delivers messages via its own Telegram plugin
    args.push('--disallowedTools', 'mcp__plugin_telegram_telegram__reply,mcp__plugin_telegram_telegram__react,mcp__plugin_telegram_telegram__edit_message,mcp__plugin_telegram_telegram__download_attachment');

    // Permission mode: use allowedTools if we have approved tools, otherwise auto
    if (allowedTools && allowedTools.length > 0) {
      args.push('--allowedTools', allowedTools.join(','));
    } else {
      args.push('--permission-mode', 'auto');
    }

    // Session management
    if (isNewSession) {
      args.push('--session-id', claudeSessionId);
    } else {
      args.push('--resume', claudeSessionId);
    }

    // Tool support
    if (hasTools) {
      args.push('--max-turns', String(MAX_TOOL_TURNS));
    }
    args.push('--verbose', '--output-format', 'stream-json');

    // System prompt (only on new sessions)
    const SYS_PROMPT_ARG_LIMIT = 100_000;
    let stdinInput = '';

    const fullSystemPrompt = isNewSession && systemPrompt
      ? systemPrompt + JSON_FORMAT_INSTRUCTION
      : isNewSession
        ? JSON_FORMAT_INSTRUCTION.trim()
        : null;

    if (fullSystemPrompt && fullSystemPrompt.length <= SYS_PROMPT_ARG_LIMIT) {
      args.push('--system-prompt', fullSystemPrompt);
    } else if (fullSystemPrompt) {
      stdinInput += `[System Instructions]\n${fullSystemPrompt}\n[End System Instructions]\n\n`;
    }

    stdinInput += prompt;

    console.log(`[${new Date().toISOString()}] Spawning: ${CLAUDE_CLI} ${args.map(a => a.length > 50 ? a.slice(0, 50) + '...' : a).join(' ')}`);

    const proc = spawn(CLAUDE_CLI, args, {
      cwd: process.env.HOME || '/home/ubuntu',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: REQUEST_TIMEOUT,
    });

    proc.stdin.write(stdinInput);
    proc.stdin.end();

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`Claude CLI exited with code ${code}: ${stderr.slice(0, 500)}`));
      } else {
        // Parse stream-json: extract last assistant text from NDJSON lines
        let lastAssistantText = '';
        const lines = stdout.trim().split('\n');
        for (const line of lines) {
          try {
            const obj = JSON.parse(line);
            if (obj.type === 'assistant' && obj.message && obj.message.content) {
              const texts = obj.message.content
                .filter(b => b.type === 'text')
                .map(b => b.text)
                .join('\n');
              if (texts.trim()) lastAssistantText = texts.trim();
            }
          } catch (_) {}
        }
        resolve(lastAssistantText || '(No text response produced)');
      }
    });

    proc.on('error', (err) => {
      reject(new Error(`Failed to spawn Claude CLI: ${err.message}`));
    });

    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      reject(new Error('Claude CLI timed out'));
    }, REQUEST_TIMEOUT + 5000);
  });
}

// ---------------------------------------------------------------------------
// One-shot advisor call: ask Claude what --allowedTools to use
// ---------------------------------------------------------------------------
async function askAdvisorForTools(userMessage, pendingTools) {
  const advisorPrompt = `A user said: "${userMessage}"

This was in response to a request for approval to use these Claude Code tools: ${JSON.stringify(pendingTools)}

Based on the user's response, which tools should be allowed? Respond with ONLY a JSON array of tool name strings, nothing else. Example: ["Read", "Bash"]

If the user seems to be declining or asking something unrelated, respond with an empty array: []`;

  return new Promise((resolve, reject) => {
    const args = ['--print'];
    const proc = spawn(CLAUDE_CLI, args, {
      cwd: process.env.HOME || '/home/ubuntu',
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      timeout: 30000,
    });

    proc.stdin.write(advisorPrompt);
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) {
        resolve([]); // fallback: no tools
        return;
      }
      const trimmed = stdout.trim();
      try {
        // Try to extract JSON array from response
        const match = trimmed.match(/\[[\s\S]*?\]/);
        if (match) {
          const tools = JSON.parse(match[0]);
          if (Array.isArray(tools)) {
            resolve(tools.filter(t => typeof t === 'string'));
            return;
          }
        }
      } catch (_) {}
      resolve([]);
    });
    proc.on('error', () => resolve([]));

    setTimeout(() => {
      try { proc.kill('SIGTERM'); } catch (_) {}
      resolve([]);
    }, 35000);
  });
}

// ---------------------------------------------------------------------------
// Build and send response (shared between normal and streaming)
// ---------------------------------------------------------------------------
function sendResponse(res, { requestId, created, model, content, stream, claudeSessionId }) {
  if (stream) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Request-Id', requestId);
    res.setHeader('X-Claude-Session-Id', claudeSessionId);

    const chunk = {
      id: requestId,
      object: 'chat.completion.chunk',
      created,
      model: model || 'claude-opus-4-6',
      choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
    };
    res.write(`data: ${JSON.stringify(chunk)}\n\n`);
    res.write(`data: ${JSON.stringify({
      id: requestId, object: 'chat.completion.chunk', created,
      model: model || 'claude-opus-4-6',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
  } else {
    res.json({
      id: requestId,
      object: 'chat.completion',
      created,
      model: model || 'claude-opus-4-6',
      choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
      usage: {
        prompt_tokens: Math.ceil(content.length / 4),
        completion_tokens: Math.ceil(content.length / 4),
        total_tokens: Math.ceil(content.length / 2),
      },
      claude_session_id: claudeSessionId,
    });
  }
}

// ---------------------------------------------------------------------------
// POST /v1/chat/completions — Main endpoint with 3-phase tool approval
// ---------------------------------------------------------------------------
app.post('/v1/chat/completions', auth, async (req, res) => {
  const { messages, model, stream, max_tokens, tools } = req.body;

  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({
      error: { message: 'messages array is required', type: 'invalid_request_error' }
    });
  }

  if (activeRequests >= MAX_CONCURRENT) {
    return res.status(429).json({
      error: { message: 'Too many concurrent requests, please retry later', type: 'rate_limit_error' }
    });
  }

  activeRequests++;
  const requestId = `chatcmpl-${randomUUID().replace(/-/g, '').slice(0, 24)}`;
  const created = Math.floor(Date.now() / 1000);

  // Extract system prompt and non-system messages
  let systemPrompt = '';
  const nonSystemMessages = [];
  for (const msg of messages) {
    if (msg.role === 'system') {
      systemPrompt += (systemPrompt ? '\n' : '') + (typeof msg.content === 'string' ? msg.content : '');
    } else {
      nonSystemMessages.push(msg);
    }
  }

  // Session lookup
  const fingerprint = getSessionFingerprint(systemPrompt, nonSystemMessages);
  const { session, isNew } = getOrCreateSession(fingerprint);
  const hasTools = tools && Array.isArray(tools) && tools.length > 0;

  // Get last user message for logging and approval detection
  let lastUserMessage = '';
  for (let i = nonSystemMessages.length - 1; i >= 0; i--) {
    if (nonSystemMessages[i].role === 'user') {
      lastUserMessage = extractContent(nonSystemMessages[i]);
      break;
    }
  }

  console.log(`[${new Date().toISOString()}] Request ${requestId} | session=${session.claudeSessionId.slice(0, 8)}... (${isNew ? 'new' : 'resume'}) | state=${session.state} | approved=[${[...session.approvedTools]}] | fingerprint=${fingerprint}`);

  try {
    // -----------------------------------------------------------------------
    // PHASE: PENDING_APPROVAL — user responded, resolve tools then execute
    // -----------------------------------------------------------------------
    if (session.state === 'PENDING_APPROVAL') {
      console.log(`[${new Date().toISOString()}] Session in PENDING_APPROVAL. Pending tools: [${session.pendingTools}]. User said: "${lastUserMessage.slice(0, 100)}"`);

      // Step A: Ask advisor what tools to approve based on user's response
      const advisorApproved = await askAdvisorForTools(lastUserMessage, session.pendingTools);
      console.log(`[${new Date().toISOString()}] Advisor approved: [${advisorApproved}]`);

      if (advisorApproved.length === 0) {
        // User declined or said something unrelated — go back to NORMAL,
        // forward the message to Claude normally
        session.state = 'NORMAL';
        session.pendingTools = [];
        console.log(`[${new Date().toISOString()}] No tools approved, falling through to normal flow`);
      } else {
        // Add newly approved tools to cumulative set
        for (const tool of advisorApproved) {
          session.approvedTools.add(tool);
        }
        session.state = 'NORMAL';
        session.pendingTools = [];

        // Step B: Resume Claude session with approved tools
        const allApproved = [...session.approvedTools];
        console.log(`[${new Date().toISOString()}] Resuming with --allowedTools ${allApproved.join(',')}`);

        const result = await callClaude(
          `The user has approved the following tools: [${allApproved.join(', ')}]. Please proceed with the task.`,
          {
            systemPrompt: undefined, // already in session
            claudeSessionId: session.claudeSessionId,
            isNewSession: false,
            hasTools,
            allowedTools: allApproved,
          }
        );

        const parsed = parseClaudeResponse(result);

        // Check if Claude needs even more tools
        if (parsed.toolsNeedApproval.length > 0) {
          session.state = 'PENDING_APPROVAL';
          session.pendingTools = parsed.toolsNeedApproval;
          console.log(`[${new Date().toISOString()}] Claude needs more tools: [${parsed.toolsNeedApproval}]`);
        }

        activeRequests--;
        sendResponse(res, { requestId, created, model, content: parsed.response, stream, claudeSessionId: session.claudeSessionId });
        return;
      }
    }

    // -----------------------------------------------------------------------
    // PHASE: NORMAL — standard request
    // -----------------------------------------------------------------------
    const prompt = messagesToPrompt(nonSystemMessages, isNew);
    const allApproved = [...session.approvedTools];

    const result = await callClaude(prompt, {
      systemPrompt: systemPrompt || undefined,
      claudeSessionId: session.claudeSessionId,
      isNewSession: isNew,
      hasTools,
      allowedTools: allApproved.length > 0 ? allApproved : null,
    });

    const parsed = parseClaudeResponse(result);

    // If Claude needs tools, transition to PENDING_APPROVAL
    if (parsed.toolsNeedApproval.length > 0) {
      session.state = 'PENDING_APPROVAL';
      session.pendingTools = parsed.toolsNeedApproval;
      console.log(`[${new Date().toISOString()}] Tools need approval: [${parsed.toolsNeedApproval}]. Transitioning to PENDING_APPROVAL`);
    }

    activeRequests--;
    sendResponse(res, { requestId, created, model, content: parsed.response, stream, claudeSessionId: session.claudeSessionId });

  } catch (err) {
    activeRequests--;
    console.error(`[${new Date().toISOString()}] Error ${requestId}:`, err.message);

    if (!isNew && err.message.includes('exited with code')) {
      sessionMap.delete(fingerprint);
      console.log(`[${new Date().toISOString()}] Cleared stale session for fingerprint ${fingerprint}`);
    }

    res.status(500).json({
      error: { message: err.message, type: 'server_error' }
    });
  }
});

// ---------------------------------------------------------------------------
// GET /v1/models
// ---------------------------------------------------------------------------
app.get('/v1/models', auth, (req, res) => {
  res.json({
    object: 'list',
    data: [
      { id: 'claude-opus-4-6', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-sonnet-4-5-20250929', object: 'model', created: 1700000000, owned_by: 'anthropic' },
      { id: 'claude-haiku-4-5-20251001', object: 'model', created: 1700000000, owned_by: 'anthropic' },
    ],
  });
});

// ---------------------------------------------------------------------------
// GET /health
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    active_requests: activeRequests,
    max_concurrent: MAX_CONCURRENT,
    active_sessions: sessionMap.size,
  });
});

// ---------------------------------------------------------------------------
// GET /sessions — debug endpoint
// ---------------------------------------------------------------------------
app.get('/sessions', auth, (req, res) => {
  const sessions = [];
  for (const [fingerprint, val] of sessionMap) {
    sessions.push({
      fingerprint,
      claudeSessionId: val.claudeSessionId,
      state: val.state,
      pendingTools: val.pendingTools,
      approvedTools: [...val.approvedTools],
      lastUsed: new Date(val.lastUsed).toISOString(),
      ageMinutes: Math.round((Date.now() - val.lastUsed) / 60000),
    });
  }
  res.json({ sessions });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const BIND_ADDR = process.env.BIND_ADDR || '127.0.0.1';
app.listen(PORT, BIND_ADDR, () => {
  console.log(`
╔══════════════════════════════════════════════╗
║  OpenClaw ↔ Claude Code Proxy               ║
║  Port: ${String(PORT).padEnd(38)}║
║  Bind: ${BIND_ADDR.padEnd(38)}║
║  Auth: ${API_KEY ? 'Enabled'.padEnd(38) : 'Disabled (set API_KEY)'.padEnd(38)}║
║  Max concurrent: ${String(MAX_CONCURRENT).padEnd(27)}║
║  Permission: auto + dynamic tool approval    ║
║  Session TTL: ${String(SESSION_TTL / 3600000) + 'h'.padEnd(31)}║
║  CLI: ${CLAUDE_CLI.padEnd(39)}║
╠══════════════════════════════════════════════╣
║  POST /v1/chat/completions                   ║
║  GET  /v1/models                             ║
║  GET  /health                                ║
║  GET  /sessions                              ║
╚══════════════════════════════════════════════╝
  `);
});
