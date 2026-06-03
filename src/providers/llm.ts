// src/providers/llm.ts
// Unified LLM provider that wraps Ollama, LM Studio, and any OpenAI-compatible backend.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMConfig {
  provider: 'ollama' | 'lmstudio' | 'openai-compatible';
  baseUrl: string;
  model: string;
  apiKey?: string;
  stream: boolean;
}

export interface StreamChunk {
  text: string;
  done: boolean;
}

// ─── Ollama ───────────────────────────────────────────────────────────────────

async function* ollamaStream(cfg: LLMConfig, messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/chat`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, stream: true }),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        yield { text: j.message?.content ?? '', done: j.done ?? false };
        if (j.done) return;
      } catch { /* skip malformed */ }
    }
  }
}

async function ollamaComplete(cfg: LLMConfig, messages: ChatMessage[]): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/api/chat`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: cfg.model, messages, stream: false }),
  });
  if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${await resp.text()}`);
  const j = await resp.json() as { message?: { content?: string } };
  return j.message?.content ?? '';
}

export async function ollamaListModels(baseUrl: string): Promise<string[]> {
  try {
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/api/tags`);
    if (!resp.ok) return [];
    const j = await resp.json() as { models?: Array<{ name: string }> };
    return (j.models ?? []).map(m => m.name);
  } catch { return []; }
}

// ─── OpenAI-compatible (LM Studio + others) ──────────────────────────────────

async function* openaiStream(cfg: LLMConfig, messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, messages, stream: true }),
  });
  if (!resp.ok || !resp.body) {
    throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  }
  const reader = resp.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const stripped = line.replace(/^data:\s*/, '').trim();
      if (!stripped || stripped === '[DONE]') {
        if (stripped === '[DONE]') { yield { text: '', done: true }; return; }
        continue;
      }
      try {
        const j = JSON.parse(stripped);
        const delta = j.choices?.[0]?.delta?.content ?? '';
        const isDone = j.choices?.[0]?.finish_reason === 'stop';
        yield { text: delta, done: isDone };
        if (isDone) return;
      } catch { /* skip */ }
    }
  }
}

async function openaiComplete(cfg: LLMConfig, messages: ChatMessage[]): Promise<string> {
  const url = `${cfg.baseUrl.replace(/\/$/, '')}/v1/chat/completions`;
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (cfg.apiKey) headers['Authorization'] = `Bearer ${cfg.apiKey}`;

  const resp = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, messages, stream: false }),
  });
  if (!resp.ok) throw new Error(`API error ${resp.status}: ${await resp.text()}`);
  const j = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  return j.choices?.[0]?.message?.content ?? '';
}

export async function openaiListModels(baseUrl: string, apiKey?: string): Promise<string[]> {
  try {
    const headers: Record<string, string> = {};
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
    const resp = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/models`, { headers });
    if (!resp.ok) return [];
    const j = await resp.json() as { data?: Array<{ id: string }> };
    return (j.data ?? []).map(m => m.id);
  } catch { return []; }
}

// ─── Unified API ─────────────────────────────────────────────────────────────

export class LLMProvider {
  constructor(private cfg: LLMConfig) {}

  async *stream(messages: ChatMessage[]): AsyncGenerator<StreamChunk> {
    if (this.cfg.provider === 'ollama') {
      yield* ollamaStream(this.cfg, messages);
    } else {
      yield* openaiStream(this.cfg, messages);
    }
  }

  async complete(messages: ChatMessage[]): Promise<string> {
    if (this.cfg.provider === 'ollama') {
      return ollamaComplete(this.cfg, messages);
    } else {
      return openaiComplete(this.cfg, messages);
    }
  }

  async listModels(): Promise<string[]> {
    if (this.cfg.provider === 'ollama') {
      return ollamaListModels(this.cfg.baseUrl);
    } else {
      return openaiListModels(this.cfg.baseUrl, this.cfg.apiKey);
    }
  }

  async testConnection(): Promise<{ ok: boolean; models: string[] }> {
    try {
      const models = await this.listModels();
      return { ok: true, models };
    } catch (e) {
      return { ok: false, models: [] };
    }
  }
}
