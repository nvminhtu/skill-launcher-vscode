import * as crypto from 'crypto';
import * as vscode from 'vscode';
import type { Skill } from '../core/skills';
import type { SkillStore } from './store';
import { relativeTime, sourceLabel } from './trees';

type Inbound =
  | { type: 'run'; args?: string }
  | { type: 'runWithArgs' }
  | { type: 'open' }
  | { type: 'copy' }
  | { type: 'ask' };

export interface DetailActions {
  run(skill: Skill, args?: string): void;
  runWithArgs(skill: Skill): void;
  open(skill: Skill): void;
  copy(skill: Skill): void;
  ask(skill: Skill): void;
}

/** One reusable panel that explains a skill: what it is for, how to call it, how you used it before. */
export class DetailPanel {
  static #panel: vscode.WebviewPanel | undefined;
  static #skill: Skill | undefined;
  static #answer: { text: string; loading: boolean; error?: boolean } | undefined;

  static show(skill: Skill, store: SkillStore, actions: DetailActions): void {
    if (DetailPanel.#skill?.id !== skill.id) {
      DetailPanel.#answer = undefined;
    }
    DetailPanel.#skill = skill;
    if (!DetailPanel.#panel) {
      const panel = vscode.window.createWebviewPanel('claudeSkills.detail', 'Skill', vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: false,
        localResourceRoots: [],
      });
      panel.onDidDispose(() => {
        DetailPanel.#panel = undefined;
        DetailPanel.#skill = undefined;
      });
      panel.webview.onDidReceiveMessage((message: Inbound) => {
        const current = DetailPanel.#skill;
        if (!current) {
          return;
        }
        switch (message.type) {
          case 'run':
            actions.run(current, typeof message.args === 'string' ? message.args : undefined);
            break;
          case 'runWithArgs':
            actions.runWithArgs(current);
            break;
          case 'open':
            actions.open(current);
            break;
          case 'copy':
            actions.copy(current);
            break;
          case 'ask':
            actions.ask(current);
            break;
        }
      });
      DetailPanel.#panel = panel;
    }
    DetailPanel.#render(store);
    DetailPanel.#panel.reveal(vscode.ViewColumn.Beside, true);
  }

  static setAnswer(skillId: string, answer: { text: string; loading: boolean; error?: boolean }, store: SkillStore): void {
    if (DetailPanel.#skill?.id !== skillId || !DetailPanel.#panel) {
      return;
    }
    DetailPanel.#answer = answer;
    DetailPanel.#render(store);
  }

  static isShowing(skillId: string): boolean {
    return !!DetailPanel.#panel && DetailPanel.#skill?.id === skillId;
  }

  static #render(store: SkillStore): void {
    const panel = DetailPanel.#panel;
    const skill = DetailPanel.#skill;
    if (!panel || !skill) {
      return;
    }
    panel.title = `/${skill.id}`;
    const usage = store.usage.get(skill.id);
    const suggestion = store.suggestions.find((s) => s.skill.id === skill.id);
    const nonce = crypto.randomBytes(16).toString('base64');
    const answer = DetailPanel.#answer;

    const chips = (items: string[], cls: string) =>
      items.map((t) => `<button class="chip ${cls}" data-args="${esc(t)}">${esc(t)}</button>`).join('');

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  body { font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); padding: 0 20px 24px; line-height: 1.5; }
  h1 { font-size: 1.5em; margin: 18px 0 2px; font-family: var(--vscode-editor-font-family); }
  h2 { font-size: 1.05em; margin: 22px 0 8px; text-transform: uppercase; letter-spacing: .04em; color: var(--vscode-descriptionForeground); }
  .meta { color: var(--vscode-descriptionForeground); }
  .hint { font-family: var(--vscode-editor-font-family); background: var(--vscode-textCodeBlock-background); padding: 2px 6px; border-radius: 4px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; margin: 16px 0 4px; }
  button { font: inherit; cursor: pointer; border: none; border-radius: 4px; padding: 5px 12px; color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button:hover { background: var(--vscode-button-secondaryHoverBackground); }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  .chip { border-radius: 12px; padding: 2px 10px; margin: 0 6px 6px 0; font-family: var(--vscode-editor-font-family); }
  .trigger { cursor: default; font-family: inherit; }
  .callout { border-left: 3px solid var(--vscode-textLink-foreground); padding: 6px 12px; background: var(--vscode-textBlockQuote-background); }
  .answer { white-space: pre-wrap; border-left: 3px solid var(--vscode-charts-green); padding: 8px 12px; background: var(--vscode-textBlockQuote-background); }
  .answer.error { border-color: var(--vscode-errorForeground); }
  pre { white-space: pre-wrap; word-break: break-word; background: var(--vscode-textCodeBlock-background); padding: 10px 12px; border-radius: 4px; max-height: 420px; overflow: auto; font-size: .92em; }
  a { color: var(--vscode-textLink-foreground); cursor: pointer; }
</style>
</head>
<body>
  <h1>/${esc(skill.id)}</h1>
  <div class="meta">${esc(sourceLabel(skill))} · <a data-action="open">${esc(skill.filePath)}</a></div>

  <div class="actions">
    <button class="primary" data-action="run">▶ Run</button>
    <button data-action="runWithArgs">Run with arguments…</button>
    <button data-action="ask">Ask Claude: does it fit right now?</button>
    <button data-action="copy">Copy command</button>
  </div>

  ${suggestion ? `<h2>Why it's suggested now</h2><div class="callout">${esc(suggestion.reasons.join(' · '))}</div>` : ''}

  ${answer ? `<h2>Claude's take</h2><div class="answer${answer.error ? ' error' : ''}">${answer.loading ? 'Asking Claude…' : esc(answer.text)}</div>` : ''}

  <h2>What it does</h2>
  <div>${esc(skill.description) || '<span class="meta">No description in front matter.</span>'}</div>

  ${skill.argumentHint ? `<h2>Arguments</h2><span class="hint">/${esc(skill.id)} ${esc(skill.argumentHint)}</span>` : ''}

  ${usage?.recentArgs.length ? `<h2>Your recent arguments — click to run</h2><div>${chips(usage.recentArgs, 'recent')}</div>` : ''}

  ${skill.triggers.length ? `<h2>Use it when you say…</h2><div>${skill.triggers.map((t) => `<span class="chip trigger">${esc(t)}</span>`).join('')}</div>` : ''}

  <h2>Usage in this workspace</h2>
  <div>${usage ? `Used ${usage.count}× · last ${esc(relativeTime(usage.lastUsed))}` : '<span class="meta">Not used in the selected time window.</span>'}</div>

  ${skill.overview ? `<h2>Instructions preview</h2><pre>${esc(skill.overview)}</pre>` : ''}

<script nonce="${nonce}">
  const vscode = acquireVsCodeApi();
  document.addEventListener('click', (event) => {
    const el = event.target.closest('[data-action], .recent');
    if (!el) return;
    if (el.classList.contains('recent')) {
      vscode.postMessage({ type: 'run', args: el.dataset.args });
    } else {
      vscode.postMessage({ type: el.dataset.action });
    }
  });
</script>
</body>
</html>`;
  }
}

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
