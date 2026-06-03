// src/tools/diffApplier.ts
// Parses LLM response for fenced code blocks and applies them to the active editor.

import * as vscode from 'vscode';

export interface ParsedBlock {
  language: string;
  code: string;
  filename?: string;
}

const FENCE_RE = /```(?:(\w+)(?::([^\n]+))?)?\n([\s\S]*?)```/g;

export function parseCodeBlocks(text: string): ParsedBlock[] {
  const blocks: ParsedBlock[] = [];
  let m: RegExpExecArray | null;
  FENCE_RE.lastIndex = 0;
  while ((m = FENCE_RE.exec(text)) !== null) {
    blocks.push({
      language: m[1] ?? '',
      filename: m[2]?.trim(),
      code: m[3],
    });
  }
  return blocks;
}

export async function applyCodeBlock(block: ParsedBlock): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    // No active editor — open a new untitled file
    const doc = await vscode.workspace.openTextDocument({
      content: block.code,
      language: block.language || 'plaintext',
    });
    await vscode.window.showTextDocument(doc);
    return;
  }

  const sel = editor.selection;
  await editor.edit(eb => {
    if (sel.isEmpty) {
      // Replace entire file content
      const full = new vscode.Range(0, 0, editor.document.lineCount, 0);
      eb.replace(full, block.code);
    } else {
      eb.replace(sel, block.code);
    }
  });

  // Format the document after applying
  await vscode.commands.executeCommand('editor.action.formatDocument');
}

export async function showDiffAndApply(
  originalContent: string,
  newContent: string,
  uri: vscode.Uri,
  title: string
): Promise<boolean> {
  // Create an untitled doc with new content for diffing
  const newDoc = await vscode.workspace.openTextDocument({ content: newContent });
  await vscode.commands.executeCommand(
    'vscode.diff',
    uri,
    newDoc.uri,
    title,
    { preview: true }
  );

  const answer = await vscode.window.showInformationMessage(
    'Apply these changes?',
    { modal: false },
    'Apply', 'Discard'
  );

  if (answer === 'Apply') {
    const edit = new vscode.WorkspaceEdit();
    const fullRange = new vscode.Range(0, 0, Number.MAX_SAFE_INTEGER, 0);
    edit.replace(uri, fullRange, newContent);
    await vscode.workspace.applyEdit(edit);
    return true;
  }
  return false;
}

export function extractFirstCodeBlock(text: string): string | null {
  const blocks = parseCodeBlocks(text);
  return blocks.length > 0 ? blocks[0].code : null;
}
