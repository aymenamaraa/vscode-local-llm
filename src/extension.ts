// src/extension.ts
// LocalCode VS Code extension — Claude Code-like AI assistant for local models.

import * as vscode from 'vscode';
import { ChatPanelProvider } from './views/chatPanel';
import { LLMProvider } from './providers/llm';
import { buildContext, formatContextBlock } from './utils/context';
import { buildUserPrompt, getSystemPrompt } from './utils/prompts';
import { parseCodeBlocks, applyCodeBlock } from './tools/diffApplier';

let chatProvider: ChatPanelProvider;

export function activate(context: vscode.ExtensionContext) {
  console.log('LocalCode: activating');

  // ── Register sidebar webview ──────────────────────────────────────────────
  chatProvider = new ChatPanelProvider(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      ChatPanelProvider.viewType,
      chatProvider,
      { webviewOptions: { retainContextWhenHidden: true } }
    )
  );

  // ── Commands ──────────────────────────────────────────────────────────────

  // Open chat panel
  register(context, 'localcode.openChat', async () => {
    await vscode.commands.executeCommand('localcode.chatView.focus');
  });

  // Quick task commands — run via chat panel
  register(context, 'localcode.explainCode', async () => {
    await chatProvider.sendTask('explain');
    await vscode.commands.executeCommand('localcode.chatView.focus');
  });

  register(context, 'localcode.fixCode', async () => {
    const extra = await vscode.window.showInputBox({
      prompt: 'Optional: describe what to fix or improve (leave blank for auto)',
      placeHolder: 'e.g. "fix the null pointer" or leave empty',
    });
    if (extra === undefined) return; // cancelled
    await chatProvider.sendTask('fix', extra || undefined);
    await vscode.commands.executeCommand('localcode.chatView.focus');
  });

  register(context, 'localcode.generateTests', async () => {
    await chatProvider.sendTask('tests');
    await vscode.commands.executeCommand('localcode.chatView.focus');
  });

  register(context, 'localcode.generateDocs', async () => {
    await chatProvider.sendTask('docs');
    await vscode.commands.executeCommand('localcode.chatView.focus');
  });

  // Switch model
  register(context, 'localcode.pickModel', async () => {
    const cfg = getConfig();
    const llm = new LLMProvider(cfg);
    const models = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'LocalCode: fetching models…' },
      () => llm.listModels()
    );
    if (models.length === 0) {
      vscode.window.showWarningMessage('LocalCode: no models found. Is the server running?');
      return;
    }
    const picked = await vscode.window.showQuickPick(models, { placeHolder: 'Select model' });
    if (picked) {
      await vscode.workspace.getConfiguration('localcode').update('model', picked, true);
      vscode.window.showInformationMessage(`LocalCode: model → ${picked}`);
    }
  });

  // Clear history
  register(context, 'localcode.clearHistory', () => {
    chatProvider.sendTask('__clear__');
  });

  // Inline quick-fix via editor decoration (no panel needed)
  register(context, 'localcode.inlineExplain', async () => {
    const result = await runInline('explain');
    if (result) showInlineResult(result);
  });

  // Config change watcher
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('localcode')) {
        vscode.window.showInformationMessage('LocalCode: configuration updated.');
      }
    })
  );

  // Status bar item
  const sb = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  sb.command = 'localcode.openChat';
  sb.tooltip = 'Open LocalCode';
  context.subscriptions.push(sb);

  function updateStatusBar() {
    const cfg = getConfig();
    sb.text = `$(hubot) ${cfg.model}`;
    sb.show();
  }
  updateStatusBar();
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('localcode.model')) updateStatusBar();
    })
  );

  console.log('LocalCode: ready');
}

export function deactivate() {}

// ── Helpers ───────────────────────────────────────────────────────────────────

function register(ctx: vscode.ExtensionContext, id: string, fn: (...args: unknown[]) => unknown) {
  ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));
}

function getConfig() {
  const c = vscode.workspace.getConfiguration('localcode');
  return {
    provider: c.get<'ollama' | 'lmstudio' | 'openai-compatible'>('provider', 'ollama'),
    baseUrl: c.get<string>('baseUrl', 'http://localhost:11434'),
    model: c.get<string>('model', 'codestral'),
    apiKey: c.get<string>('apiKey', ''),
    stream: c.get<boolean>('streamResponses', true),
  };
}

async function runInline(task: string): Promise<string | null> {
  const cfg = getConfig();
  const llm = new LLMProvider(cfg);
  const ctx = await buildContext();
  const contextBlock = formatContextBlock(ctx);
  const system = getSystemPrompt(task);
  const userPrompt = buildUserPrompt(task, contextBlock);
  const messages = [
    { role: 'system' as const, content: system },
    { role: 'user' as const, content: userPrompt },
  ];
  return vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `LocalCode: ${task}ing…`, cancellable: false },
    async () => {
      try { return await llm.complete(messages); }
      catch (e: unknown) {
        vscode.window.showErrorMessage(`LocalCode: ${e instanceof Error ? e.message : String(e)}`);
        return null;
      }
    }
  );
}

async function showInlineResult(text: string) {
  const blocks = parseCodeBlocks(text);
  if (blocks.length > 0) {
    const answer = await vscode.window.showInformationMessage(
      'LocalCode produced code. Apply to editor?', 'Apply', 'Show only'
    );
    if (answer === 'Apply') {
      await applyCodeBlock(blocks[0]);
      return;
    }
  }
  // Show in output channel
  const out = vscode.window.createOutputChannel('LocalCode');
  out.clear(); out.append(text); out.show(true);
}
