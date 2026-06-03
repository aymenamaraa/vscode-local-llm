// src/utils/context.ts
// Builds rich context payloads from VS Code state.

import * as vscode from 'vscode';
import * as path from 'path';

export interface CodeContext {
  filePath: string;
  language: string;
  selection: string;
  selectionRange: { start: number; end: number } | null;
  surroundingCode: string;
  fullFile: string;
  workspaceRoot: string | null;
  openFiles: string[];
  diagnostics: string[];
  gitBranch: string | null;
}

export async function buildContext(editor?: vscode.TextEditor): Promise<CodeContext> {
  const activeEditor = editor ?? vscode.window.activeTextEditor;
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  if (!activeEditor) {
    return emptyContext(workspaceRoot);
  }

  const doc = activeEditor.document;
  const sel = activeEditor.selection;
  const config = vscode.workspace.getConfiguration('localcode');
  const contextLines = config.get<number>('contextLines', 100);

  const fullText = doc.getText();
  const lines = fullText.split('\n');

  let selectionText = '';
  let selectionRange: { start: number; end: number } | null = null;
  if (!sel.isEmpty) {
    selectionText = doc.getText(sel);
    selectionRange = { start: sel.start.line + 1, end: sel.end.line + 1 };
  }

  // Surrounding context window
  const startLine = Math.max(0, (sel.isEmpty ? 0 : sel.start.line) - contextLines);
  const endLine = Math.min(lines.length - 1, (sel.isEmpty ? lines.length - 1 : sel.end.line) + contextLines);
  const surroundingCode = lines.slice(startLine, endLine + 1).join('\n');

  // Diagnostics for current file
  const diags = vscode.languages.getDiagnostics(doc.uri)
    .filter(d => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
    .slice(0, 20)
    .map(d => `Line ${d.range.start.line + 1}: [${d.severity === 0 ? 'ERROR' : 'WARN'}] ${d.message}`);

  // Open editors
  const openFiles = vscode.window.tabGroups.all
    .flatMap(g => g.tabs)
    .map(t => {
      const input = t.input as { uri?: vscode.Uri };
      return input?.uri?.fsPath ?? '';
    })
    .filter(Boolean)
    .filter(f => f !== doc.uri.fsPath)
    .slice(0, 10);

  // Git branch
  let gitBranch: string | null = null;
  try {
    const gitExt = vscode.extensions.getExtension('vscode.git');
    if (gitExt?.isActive) {
      const git = gitExt.exports.getAPI(1);
      const repo = git.repositories[0];
      gitBranch = repo?.state?.HEAD?.name ?? null;
    }
  } catch { /* git not available */ }

  const relPath = workspaceRoot
    ? path.relative(workspaceRoot, doc.uri.fsPath)
    : doc.uri.fsPath;

  return {
    filePath: relPath,
    language: doc.languageId,
    selection: selectionText,
    selectionRange,
    surroundingCode,
    fullFile: fullText.slice(0, 50000), // cap at 50k chars
    workspaceRoot,
    openFiles: openFiles.map(f => workspaceRoot ? path.relative(workspaceRoot, f) : f),
    diagnostics: diags,
    gitBranch,
  };
}

function emptyContext(workspaceRoot: string | null): CodeContext {
  return {
    filePath: '',
    language: 'plaintext',
    selection: '',
    selectionRange: null,
    surroundingCode: '',
    fullFile: '',
    workspaceRoot,
    openFiles: [],
    diagnostics: [],
    gitBranch: null,
  };
}

export function formatContextBlock(ctx: CodeContext): string {
  const parts: string[] = [];

  if (ctx.workspaceRoot) {
    parts.push(`<workspace>${path.basename(ctx.workspaceRoot)}</workspace>`);
  }
  if (ctx.gitBranch) {
    parts.push(`<git_branch>${ctx.gitBranch}</git_branch>`);
  }
  if (ctx.filePath) {
    parts.push(`<file path="${ctx.filePath}" language="${ctx.language}">`);
    if (ctx.selectionRange) {
      parts.push(`<selected_lines start="${ctx.selectionRange.start}" end="${ctx.selectionRange.end}">`);
      parts.push(ctx.selection);
      parts.push(`</selected_lines>`);
    } else {
      parts.push(ctx.surroundingCode || ctx.fullFile);
    }
    parts.push(`</file>`);
  }
  if (ctx.diagnostics.length > 0) {
    parts.push(`<diagnostics>\n${ctx.diagnostics.join('\n')}\n</diagnostics>`);
  }
  if (ctx.openFiles.length > 0) {
    parts.push(`<open_files>\n${ctx.openFiles.join('\n')}\n</open_files>`);
  }

  return parts.join('\n');
}
