// src/views/chatPanel.ts
// Main sidebar + panel webview for interactive chat with local LLM.

import * as vscode from 'vscode';
import { LLMProvider, ChatMessage, LLMConfig } from '../providers/llm';
import { buildContext, formatContextBlock } from '../utils/context';
import { buildUserPrompt, getSystemPrompt } from '../utils/prompts';
import { parseCodeBlocks, applyCodeBlock } from '../tools/diffApplier';

export class ChatPanelProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = 'localcode.chatView';
  private view?: vscode.WebviewView;
  private history: ChatMessage[] = [];
  private provider?: LLMProvider;

  constructor(private readonly ctx: vscode.ExtensionContext) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken
  ) {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.ctx.extensionUri],
    };
    webviewView.webview.html = getHtml(webviewView.webview, this.ctx.extensionUri);
    webviewView.webview.onDidReceiveMessage(msg => this.handleMessage(msg));
    this.sendConfig();
  }

  private getConfig(): LLMConfig {
    const cfg = vscode.workspace.getConfiguration('localcode');
    return {
      provider: cfg.get<LLMConfig['provider']>('provider', 'ollama'),
      baseUrl: cfg.get<string>('baseUrl', 'http://localhost:11434'),
      model: cfg.get<string>('model', 'codestral'),
      apiKey: cfg.get<string>('apiKey', ''),
      stream: cfg.get<boolean>('streamResponses', true),
    };
  }

  private getOrCreateProvider(): LLMProvider {
    const cfg = this.getConfig();
    this.provider = new LLMProvider(cfg);
    return this.provider;
  }

  private sendConfig() {
    const cfg = this.getConfig();
    this.view?.webview.postMessage({ type: 'config', data: { model: cfg.model, provider: cfg.provider } });
  }

  private post(msg: Record<string, unknown>) {
    this.view?.webview.postMessage(msg);
  }

  public async sendTask(task: string, userMessage?: string) {
    if (!this.view) {
      await vscode.commands.executeCommand('localcode.chatView.focus');
    }
    await this.runQuery(task, userMessage);
  }

  private async handleMessage(msg: { type: string; [k: string]: unknown }) {
    switch (msg.type) {
      case 'send':
        await this.runQuery('chat', msg.text as string);
        break;
      case 'clear':
        this.history = [];
        this.post({ type: 'cleared' });
        break;
      case 'apply': {
        const blocks = parseCodeBlocks(msg.code as string);
        if (blocks.length > 0) {
          await applyCodeBlock(blocks[0]);
          this.post({ type: 'applied' });
        }
        break;
      }
      case 'pickModel':
        await this.pickModel();
        break;
      case 'testConnection':
        await this.testConnection();
        break;
      case 'getContext': {
        const ctx = await buildContext();
        this.post({ type: 'context', data: formatContextBlock(ctx) });
        break;
      }
      case 'openSettings':
        vscode.commands.executeCommand('workbench.action.openSettings', 'localcode');
        break;
    }
  }

  private async runQuery(task: string, userMessage?: string) {
    const llm = this.getOrCreateProvider();
    const cfg = this.getConfig();
    const customSystem = vscode.workspace.getConfiguration('localcode').get<string>('systemPrompt', '');

    // Gather code context
    const ctx = await buildContext();
    const contextBlock = formatContextBlock(ctx);
    const userPrompt = buildUserPrompt(task, contextBlock, userMessage);
    const system = getSystemPrompt(task, customSystem);

    // Build message history
    if (this.history.length === 0 || this.history[0].role !== 'system') {
      this.history = [{ role: 'system', content: system }];
    }
    this.history.push({ role: 'user', content: userPrompt });

    // Show user message in UI (sanitised, without context block)
    this.post({ type: 'userMessage', text: userMessage ?? `[${task}]` });
    this.post({ type: 'assistantStart' });

    let fullResponse = '';
    try {
      if (cfg.stream) {
        for await (const chunk of llm.stream(this.history)) {
          fullResponse += chunk.text;
          if (chunk.text) this.post({ type: 'token', text: chunk.text });
        }
      } else {
        fullResponse = await llm.complete(this.history);
        this.post({ type: 'token', text: fullResponse });
      }
      this.history.push({ role: 'assistant', content: fullResponse });
      this.post({ type: 'assistantDone', hasCode: parseCodeBlocks(fullResponse).length > 0 });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      this.post({ type: 'error', text: msg });
      this.history.pop(); // remove the failed user message
    }
  }

  private async pickModel() {
    const llm = this.getOrCreateProvider();
    this.post({ type: 'status', text: 'Fetching models…' });
    const models = await llm.listModels();
    if (models.length === 0) {
      vscode.window.showWarningMessage('LocalCode: No models found. Is the server running?');
      this.post({ type: 'status', text: '' });
      return;
    }
    const picked = await vscode.window.showQuickPick(models, { placeHolder: 'Select a model' });
    if (picked) {
      await vscode.workspace.getConfiguration('localcode').update('model', picked, true);
      this.sendConfig();
      vscode.window.showInformationMessage(`LocalCode: Model switched to ${picked}`);
    }
    this.post({ type: 'status', text: '' });
  }

  private async testConnection() {
    const llm = this.getOrCreateProvider();
    this.post({ type: 'status', text: 'Testing connection…' });
    const result = await llm.testConnection();
    if (result.ok) {
      this.post({ type: 'connected', models: result.models });
    } else {
      this.post({ type: 'connectionFailed' });
    }
  }
}

// ─── HTML ─────────────────────────────────────────────────────────────────────

function getHtml(_webview: vscode.Webview, _extensionUri: vscode.Uri): string {
  return /* html */`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>LocalCode</title>
<style>
  :root {
    --bg0: var(--vscode-sideBar-background, #0d1117);
    --bg1: var(--vscode-editor-background, #161b22);
    --bg2: var(--vscode-input-background, #21262d);
    --border: var(--vscode-panel-border, #30363d);
    --fg: var(--vscode-foreground, #c9d1d9);
    --fg-dim: var(--vscode-descriptionForeground, #8b949e);
    --accent: var(--vscode-button-background, #238636);
    --accent-fg: var(--vscode-button-foreground, #ffffff);
    --error: var(--vscode-errorForeground, #f85149);
    --warn: var(--vscode-editorWarning-foreground, #d29922);
    --code-bg: var(--vscode-textCodeBlock-background, #161b22);
    --link: var(--vscode-textLink-foreground, #58a6ff);
    --user-bubble: #1a3050;
    --radius: 6px;
    --font-mono: var(--vscode-editor-font-family, 'Cascadia Code', 'Fira Code', monospace);
    --font-ui: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { height: 100%; background: var(--bg0); color: var(--fg); font-family: var(--font-ui); font-size: 13px; }

  #app { display: flex; flex-direction: column; height: 100vh; }

  /* ── Header ── */
  #header {
    padding: 8px 10px 6px;
    border-bottom: 1px solid var(--border);
    background: var(--bg1);
    display: flex; align-items: center; gap: 8px;
  }
  #logo { font-size: 11px; font-weight: 700; letter-spacing: .08em; color: var(--fg-dim); flex: 1;
    font-family: var(--font-mono); text-transform: uppercase; }
  #logo span { color: var(--link); }
  #model-badge {
    font-size: 10px; background: var(--bg2); border: 1px solid var(--border);
    border-radius: 3px; padding: 2px 6px; color: var(--fg-dim); cursor: pointer;
    transition: border-color .15s;
  }
  #model-badge:hover { border-color: var(--link); color: var(--link); }
  .hbtn {
    background: none; border: none; color: var(--fg-dim); cursor: pointer;
    padding: 2px 4px; border-radius: 3px; font-size: 14px; line-height: 1;
    transition: color .15s, background .15s;
  }
  .hbtn:hover { color: var(--fg); background: var(--bg2); }

  /* ── Status bar ── */
  #status-bar {
    font-size: 10px; color: var(--fg-dim); padding: 3px 10px;
    background: var(--bg1); border-bottom: 1px solid var(--border);
    min-height: 20px; display: flex; align-items: center; gap: 6px;
  }
  #conn-dot { width: 7px; height: 7px; border-radius: 50%; background: #333; flex-shrink: 0; }
  #conn-dot.ok { background: #3fb950; }
  #conn-dot.fail { background: var(--error); }
  #conn-dot.checking { background: var(--warn); animation: pulse 1s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }

  /* ── Messages ── */
  #messages {
    flex: 1; overflow-y: auto; padding: 12px 10px; display: flex;
    flex-direction: column; gap: 10px;
    scroll-behavior: smooth;
  }
  #messages::-webkit-scrollbar { width: 4px; }
  #messages::-webkit-scrollbar-thumb { background: var(--border); border-radius: 2px; }

  .msg { display: flex; flex-direction: column; gap: 4px; animation: fadeIn .18s ease; }
  @keyframes fadeIn { from { opacity:0; transform: translateY(4px); } to { opacity:1; transform:none; } }

  .msg-user .bubble {
    align-self: flex-end; background: var(--user-bubble);
    border: 1px solid #1f4068; border-radius: var(--radius);
    padding: 7px 10px; max-width: 92%; word-break: break-word;
    font-size: 12.5px; line-height: 1.5;
  }
  .msg-role { font-size: 10px; color: var(--fg-dim); padding: 0 2px; }
  .msg-user .msg-role { text-align: right; }

  .msg-assistant .bubble {
    background: var(--bg1); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 10px 12px;
    max-width: 100%; line-height: 1.6; font-size: 12.5px;
    word-break: break-word;
  }

  .msg-assistant .bubble p { margin: 6px 0; }
  .msg-assistant .bubble p:first-child { margin-top: 0; }
  .msg-assistant .bubble p:last-child { margin-bottom: 0; }

  /* Code blocks inside assistant messages */
  .code-wrap {
    position: relative; margin: 8px 0;
    border-radius: var(--radius); overflow: hidden;
    border: 1px solid var(--border);
  }
  .code-header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 4px 10px; background: #0d1117; border-bottom: 1px solid var(--border);
    font-size: 10px; color: var(--fg-dim); font-family: var(--font-mono);
  }
  .code-header .lang { text-transform: uppercase; letter-spacing: .06em; }
  .code-actions { display: flex; gap: 4px; }
  .cbtn {
    font-size: 10px; padding: 2px 7px; border-radius: 3px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg2); color: var(--fg-dim);
    transition: all .12s; font-family: var(--font-ui);
  }
  .cbtn:hover { border-color: var(--accent); color: var(--accent-fg); background: var(--accent); }
  .cbtn.apply { border-color: var(--accent); color: #3fb950; }
  .cbtn.apply:hover { background: var(--accent); color: var(--accent-fg); }
  pre {
    background: var(--code-bg); overflow-x: auto; margin: 0;
    padding: 10px 12px; font-family: var(--font-mono);
    font-size: 12px; line-height: 1.55;
  }
  pre code { background: none; padding: 0; color: var(--fg); }
  code { background: var(--bg2); padding: 1px 4px; border-radius: 3px; font-family: var(--font-mono); font-size: .9em; }

  .msg-error .bubble {
    border-color: var(--error); background: #2d1215; color: var(--error);
    border-radius: var(--radius); padding: 8px 10px; font-size: 12px;
  }

  /* streaming cursor */
  .cursor::after {
    content: '▋'; animation: blink .7s step-end infinite;
    color: var(--link); margin-left: 1px;
  }
  @keyframes blink { 0%,100%{opacity:1} 50%{opacity:0} }

  /* ── Toolbar ── */
  #toolbar {
    display: flex; gap: 4px; padding: 4px 8px;
    border-top: 1px solid var(--border);
    background: var(--bg1); flex-wrap: wrap;
  }
  .tool-btn {
    font-size: 10px; padding: 3px 9px; border-radius: 3px; cursor: pointer;
    border: 1px solid var(--border); background: var(--bg2); color: var(--fg-dim);
    transition: all .12s; font-family: var(--font-ui);
    white-space: nowrap;
  }
  .tool-btn:hover { border-color: var(--link); color: var(--link); }

  /* ── Input area ── */
  #input-area {
    padding: 8px 10px 10px;
    background: var(--bg1);
    border-top: 1px solid var(--border);
  }
  #input-wrap {
    display: flex; gap: 6px; align-items: flex-end;
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 6px 8px;
    transition: border-color .15s;
  }
  #input-wrap:focus-within { border-color: var(--link); }
  #input {
    flex: 1; background: none; border: none; outline: none;
    color: var(--fg); font-family: var(--font-ui); font-size: 13px;
    resize: none; min-height: 20px; max-height: 140px;
    line-height: 1.5; overflow-y: auto;
  }
  #input::placeholder { color: var(--fg-dim); }
  #send-btn {
    background: var(--accent); color: var(--accent-fg); border: none;
    border-radius: 4px; cursor: pointer; padding: 5px 10px;
    font-size: 13px; line-height: 1; transition: opacity .12s; flex-shrink: 0;
  }
  #send-btn:hover:not(:disabled) { opacity: .85; }
  #send-btn:disabled { opacity: .4; cursor: not-allowed; }

  #char-hint { font-size: 10px; color: var(--fg-dim); text-align: right; margin-top: 3px; }

  /* ── Welcome ── */
  #welcome {
    text-align: center; color: var(--fg-dim); padding: 24px 16px;
    font-size: 12px; line-height: 1.7;
  }
  #welcome h2 { color: var(--fg); font-size: 15px; margin-bottom: 8px; font-weight: 600; }
  #welcome kbd {
    background: var(--bg2); border: 1px solid var(--border);
    border-radius: 3px; padding: 1px 5px; font-family: var(--font-mono); font-size: 11px;
  }
  #welcome .tips { text-align: left; margin-top: 16px; }
  #welcome .tip { display: flex; gap: 8px; align-items: baseline; margin: 5px 0; }
  #welcome .tip-icon { color: var(--link); flex-shrink: 0; }
</style>
</head>
<body>
<div id="app">
  <div id="header">
    <div id="logo">Local<span>Code</span></div>
    <div id="model-badge" title="Click to switch model" onclick="pickModel()">codestral</div>
    <button class="hbtn" title="Test connection" onclick="testConn()">⚡</button>
    <button class="hbtn" title="Settings" onclick="openSettings()">⚙</button>
    <button class="hbtn" title="Clear history" onclick="clearHistory()">✕</button>
  </div>

  <div id="status-bar">
    <div id="conn-dot" class="checking"></div>
    <span id="status-text">Connecting…</span>
  </div>

  <div id="messages">
    <div id="welcome">
      <h2>🤖 LocalCode</h2>
      <p>AI coding assistant powered by your local models.<br/>
      No cloud. No telemetry. Fully private.</p>
      <div class="tips">
        <div class="tip"><span class="tip-icon">→</span><span>Select code + right-click for quick actions</span></div>
        <div class="tip"><span class="tip-icon">→</span><span>Press <kbd>Ctrl+Shift+L</kbd> to open this panel</span></div>
        <div class="tip"><span class="tip-icon">→</span><span>Click ⚡ to test your connection</span></div>
        <div class="tip"><span class="tip-icon">→</span><span>Click the model badge to switch models</span></div>
      </div>
    </div>
  </div>

  <div id="toolbar">
    <button class="tool-btn" onclick="sendTask('explain')">Explain</button>
    <button class="tool-btn" onclick="sendTask('fix')">Fix</button>
    <button class="tool-btn" onclick="sendTask('tests')">Tests</button>
    <button class="tool-btn" onclick="sendTask('docs')">Docs</button>
  </div>

  <div id="input-area">
    <div id="input-wrap">
      <textarea id="input" rows="1" placeholder="Ask anything about your code… (Enter to send, Shift+Enter for newline)"></textarea>
      <button id="send-btn" onclick="sendMessage()" title="Send (Enter)">↑</button>
    </div>
    <div id="char-hint"></div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let isStreaming = false;
let currentAssistantBubble = null;
let currentRaw = '';
let currentCodeMap = {};

// ── Textarea auto-grow ──────────────────────────────────────────────────────
const input = document.getElementById('input');
input.addEventListener('input', () => {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 140) + 'px';
  const len = input.value.length;
  document.getElementById('char-hint').textContent = len > 200 ? len + ' chars' : '';
});
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

// ── Send ────────────────────────────────────────────────────────────────────
function sendMessage() {
  const text = input.value.trim();
  if (!text || isStreaming) return;
  input.value = ''; input.style.height = 'auto';
  document.getElementById('send-btn').disabled = true;
  vscode.postMessage({ type: 'send', text });
}
function sendTask(task) {
  if (isStreaming) return;
  vscode.postMessage({ type: 'send', text: \`__task__\${task}\` });
}

// ── Actions ─────────────────────────────────────────────────────────────────
function pickModel() { vscode.postMessage({ type: 'pickModel' }); }
function testConn()  { vscode.postMessage({ type: 'testConnection' }); }
function clearHistory() { vscode.postMessage({ type: 'clear' }); }
function openSettings() { vscode.postMessage({ type: 'openSettings' }); }

function copyCode(id) {
  const code = currentCodeMap[id] || '';
  navigator.clipboard?.writeText(code);
}
function applyCode(id) {
  const code = currentCodeMap[id] || '';
  vscode.postMessage({ type: 'apply', code });
}

// ── Messages from extension ─────────────────────────────────────────────────
window.addEventListener('message', e => {
  const msg = e.data;
  switch (msg.type) {
    case 'config':
      document.getElementById('model-badge').textContent = msg.data.model;
      break;
    case 'status':
      setStatus(msg.text, null);
      break;
    case 'connected':
      setStatus('Connected · ' + msg.models.length + ' model(s)', 'ok');
      break;
    case 'connectionFailed':
      setStatus('Connection failed — check settings', 'fail');
      break;
    case 'userMessage':
      if (!msg.text.startsWith('__task__')) addUserMsg(msg.text);
      break;
    case 'assistantStart':
      isStreaming = true;
      document.getElementById('send-btn').disabled = true;
      hideWelcome();
      currentRaw = '';
      currentAssistantBubble = createAssistantBubble();
      break;
    case 'token':
      currentRaw += msg.text;
      renderAssistant(currentAssistantBubble, currentRaw, true);
      scrollBottom();
      break;
    case 'assistantDone':
      isStreaming = false;
      document.getElementById('send-btn').disabled = false;
      renderAssistant(currentAssistantBubble, currentRaw, false);
      scrollBottom();
      break;
    case 'error':
      isStreaming = false;
      document.getElementById('send-btn').disabled = false;
      addError(msg.text);
      break;
    case 'cleared':
      document.getElementById('messages').innerHTML = '';
      showWelcome();
      break;
    case 'applied':
      flashStatus('✓ Applied to editor');
      break;
  }
});

// ── DOM helpers ──────────────────────────────────────────────────────────────
function hideWelcome() {
  const w = document.getElementById('welcome');
  if (w) w.remove();
}
function showWelcome() {
  const msgs = document.getElementById('messages');
  const w = document.createElement('div');
  w.id = 'welcome';
  w.innerHTML = '<h2>🤖 LocalCode</h2><p>History cleared.</p>';
  msgs.appendChild(w);
}

function scrollBottom() {
  const m = document.getElementById('messages');
  m.scrollTop = m.scrollHeight;
}

function addUserMsg(text) {
  hideWelcome();
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg msg-user';
  div.innerHTML = \`<div class="msg-role">You</div><div class="bubble">\${escHtml(text)}</div>\`;
  msgs.appendChild(div);
  scrollBottom();
}

function createAssistantBubble() {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg msg-assistant';
  div.innerHTML = '<div class="msg-role">LocalCode</div><div class="bubble"><span class="cursor"></span></div>';
  msgs.appendChild(div);
  return div.querySelector('.bubble');
}

function renderAssistant(bubble, raw, streaming) {
  if (!bubble) return;
  const rendered = markdownToHtml(raw);
  bubble.innerHTML = rendered;
  if (streaming) {
    const cur = document.createElement('span');
    cur.className = 'cursor';
    bubble.appendChild(cur);
  }
}

function addError(text) {
  const msgs = document.getElementById('messages');
  const div = document.createElement('div');
  div.className = 'msg msg-error';
  div.innerHTML = \`<div class="msg-role">Error</div><div class="bubble">⚠ \${escHtml(text)}</div>\`;
  msgs.appendChild(div);
  scrollBottom();
}

function setStatus(text, state) {
  document.getElementById('status-text').textContent = text;
  const dot = document.getElementById('conn-dot');
  dot.className = 'checking';
  if (state === 'ok')   dot.className = 'ok';
  if (state === 'fail') dot.className = 'fail';
}

function flashStatus(text) {
  const s = document.getElementById('status-text');
  const old = s.textContent;
  s.textContent = text;
  setTimeout(() => { s.textContent = old; }, 2000);
}

// ── Markdown renderer (minimal, no deps) ────────────────────────────────────
let codeBlockCounter = 0;
function markdownToHtml(text) {
  currentCodeMap = {};
  // Fenced code blocks
  const TICK3 = '\`\`\`';
  const fenceRe = new RegExp(TICK3 + '(\\w*(?::[^\\n]+)?)?\\n([\\s\\S]*?)' + TICK3, 'g');
  text = text.replace(fenceRe, (_, langLine, code) => {
    const id = 'cb' + (++codeBlockCounter);
    const lang = (langLine || '').split(':')[0].trim() || 'text';
    currentCodeMap[id] = code.trimEnd();
    return \`<div class="code-wrap">
<div class="code-header">
  <span class="lang">\${escHtml(lang)}</span>
  <div class="code-actions">
    <button class="cbtn" onclick="copyCode('\${id}')">Copy</button>
    <button class="cbtn apply" onclick="applyCode('\${id}')">Apply</button>
  </div>
</div>
<pre><code>\${escHtml(code.trimEnd())}</code></pre>
</div>\`;
  });
  // Inline code
  text = text.replace(/\`([^\`\n]+)\`/g, '<code>$1</code>');
  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  text = text.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Bullet lists
  text = text.replace(/^[*-] (.+)/gm, '<li>$1</li>');
  text = text.replace(/(<li>.*<\/li>\n?)+/gs, m => '<ul>' + m + '</ul>');
  // Numbered lists
  text = text.replace(/^\d+\. (.+)/gm, '<li>$1</li>');
  // Headers
  text = text.replace(/^### (.+)/gm, '<h4>$1</h4>');
  text = text.replace(/^## (.+)/gm, '<h3>$1</h3>');
  text = text.replace(/^# (.+)/gm, '<h2>$1</h2>');
  // Paragraphs
  const blocks = text.split(/\n{2,}/);
  return blocks.map(b => {
    b = b.trim();
    if (!b) return '';
    if (b.startsWith('<')) return b;
    return '<p>' + b.replace(/\n/g, '<br>') + '</p>';
  }).filter(Boolean).join('\n');
}

function escHtml(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Init: test connection on load ────────────────────────────────────────────
testConn();
</script>
</body>
</html>`;
}
