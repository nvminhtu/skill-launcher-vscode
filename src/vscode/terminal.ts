import * as vscode from 'vscode';
import { resolveClaudePath } from '../core/claudeCli';

/**
 * Delivers a slash command to Claude Code running in an integrated terminal.
 * Claude's prompt is a full-screen TUI, so the extension cannot add inline completions there —
 * it types the command for you instead (and presses Enter only when `autoSubmit` is on).
 */
export class ClaudeTerminals implements vscode.Disposable {
  #lastUsed: vscode.Terminal | undefined;
  readonly #ours = new Set<vscode.Terminal>();
  readonly #subscriptions: vscode.Disposable[] = [];

  constructor() {
    this.#subscriptions.push(
      vscode.window.onDidCloseTerminal((t) => {
        this.#ours.delete(t);
        if (this.#lastUsed === t) {
          this.#lastUsed = undefined;
        }
      }),
    );
  }

  async send(command: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('claudeSkills');
    const target = await this.#pickTarget();
    if (!target) {
      return;
    }
    if (target === 'clipboard') {
      await vscode.env.clipboard.writeText(command);
      void vscode.window.showInformationMessage(`Copied "${command}" — paste it into Claude Code.`);
      return;
    }
    if (target === 'new') {
      this.#startSession(command, config.get<string>('claudePath', 'claude'));
      return;
    }

    this.#lastUsed = target;
    target.show(false);
    target.sendText(command, false);
    if (config.get<boolean>('autoSubmit', false)) {
      // A separate keystroke so Claude doesn't treat the Enter as part of a paste.
      setTimeout(() => target.sendText('\r', false), 150);
    }
  }

  #isClaude(terminal: vscode.Terminal): boolean {
    if (this.#ours.has(terminal)) {
      return true;
    }
    const source = vscode.workspace.getConfiguration('claudeSkills').get<string>('terminalNamePattern', 'claude');
    try {
      return new RegExp(source || 'claude', 'i').test(terminal.name);
    } catch {
      return /claude/i.test(terminal.name);
    }
  }

  async #pickTarget(): Promise<vscode.Terminal | 'new' | 'clipboard' | undefined> {
    const terminals = vscode.window.terminals;
    const active = vscode.window.activeTerminal;
    if (active && this.#isClaude(active)) {
      return active;
    }
    if (this.#lastUsed && terminals.includes(this.#lastUsed)) {
      return this.#lastUsed;
    }
    const claudeTerminals = terminals.filter((t) => this.#isClaude(t));
    if (claudeTerminals.length === 1) {
      return claudeTerminals[0];
    }

    type Item = vscode.QuickPickItem & { target: vscode.Terminal | 'new' | 'clipboard' };
    const items: Item[] = [
      { label: '$(add) Start a new Claude Code session', target: 'new' },
      ...terminals.map((t) => ({
        label: `$(terminal) ${t.name}`,
        description: this.#isClaude(t) ? 'Claude' : undefined,
        detail: 'Type the command into this terminal (pick it if Claude Code is running there)',
        target: t,
      })),
      { label: '$(copy) Copy to clipboard', detail: 'For the Claude Code chat panel or another window', target: 'clipboard' },
    ];
    const picked = await vscode.window.showQuickPick(items, { placeHolder: 'Where is Claude Code running?' });
    return picked?.target;
  }

  #startSession(command: string, claudePath: string): void {
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri;
    const terminal = vscode.window.createTerminal({ name: 'Claude', cwd });
    this.#ours.add(terminal);
    this.#lastUsed = terminal;
    terminal.show(false);
    terminal.sendText(`${quoteArg(resolveClaudePath(claudePath))} ${quoteArg(command)}`, true);
  }

  dispose(): void {
    this.#subscriptions.forEach((d) => d.dispose());
  }
}

/** POSIX shells take '…' with '\'' escapes; PowerShell (Windows default) doubles the quote. */
export function quoteArg(value: string): string {
  if (/^[A-Za-z0-9_./:@-]+$/.test(value)) {
    return value;
  }
  return process.platform === 'win32'
    ? `'${value.replace(/'/g, "''")}'`
    : `'${value.replace(/'/g, `'\\''`)}'`;
}
