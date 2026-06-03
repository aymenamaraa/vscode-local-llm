# LocalCode — AI Coding Agent for VS Code

A **Claude Code–style AI assistant** that runs entirely against **local models** — no cloud, no API keys, zero telemetry.

## Features

| Feature | Details |
|---|---|
| **Interactive Chat** | Full conversation panel in the sidebar |
| **Explain Code** | Select code → right-click → Explain |
| **Fix & Improve** | Select code → right-click → Fix |
| **Generate Tests** | Vitest/Jest/etc. unit tests from selection |
| **Generate Docs** | JSDoc/TSDoc for selected code |
| **Streaming** | Token-by-token streaming from local models |
| **Apply to Editor** | One-click apply of code blocks to active editor |
| **Model Switcher** | List and switch models without leaving VS Code |

## Supported Backends

| Provider | Default Port | Notes |
|---|---|---|
| **Ollama** | `11434` | Default. Works with `codestral`, `qwen2.5-coder`, `deepseek-coder-v2`, etc. |
| **LM Studio** | `1234` | Set provider to `lmstudio` |
| **OpenAI-compatible** | any | Set provider to `openai-compatible`, add API key if needed |

## Quick Start

### 1. Install a local model (Ollama example)
```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a code model
ollama pull codestral          # 22B — best quality
ollama pull qwen2.5-coder:7b   # 7B — fast
ollama pull deepseek-coder-v2  # 16B — great for TS/React
```

### 2. Configure the extension
Open Settings (`Ctrl+,`) → search `localcode`:

```jsonc
{
  "localcode.provider": "ollama",
  "localcode.baseUrl": "http://localhost:11434",
  "localcode.model": "codestral",
  "localcode.streamResponses": true
}
```

### 3. Use it
- Click the **LocalCode icon** in the Activity Bar
- Or press **`Ctrl+Shift+L`** to open the chat panel
- Select code, right-click → LocalCode actions

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Shift+L` | Open Chat |
| `Ctrl+Shift+E` | Explain selection |
| `Ctrl+Shift+F` | Fix selection |

## Building from Source

```bash
npm install
npm run build
# To package as .vsix:
npm run package
```

## Architecture

```
src/
├── extension.ts          # Entry point, command registration
├── providers/
│   └── llm.ts            # Ollama + OpenAI-compatible streaming
├── views/
│   └── chatPanel.ts      # Sidebar webview + HTML/CSS/JS
├── tools/
│   └── diffApplier.ts    # Code block parser + editor apply
└── utils/
    ├── context.ts         # VS Code context builder
    └── prompts.ts         # System + user prompt templates
```

## Recommended Models

| Model | Size | Best For |
|---|---|---|
| `codestral` | 22B | Best overall code quality |
| `qwen2.5-coder:7b` | 7B | Fast, good TypeScript/React |
| `deepseek-coder-v2:16b` | 16B | Strong reasoning + code |
| `llama3.1:8b` | 8B | General chat + code |
| `phi4:14b` | 14B | Balanced quality/speed |

## License

MIT
