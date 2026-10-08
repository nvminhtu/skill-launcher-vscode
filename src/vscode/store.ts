import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import type { ContextSummary } from '../core/claudeCli';
import { gitStatus, readBranch } from '../core/git';
import { isRule, readProjectConfig } from '../core/projectConfig';
import { scanSkills, Skill } from '../core/skills';
import { suggest, Suggestion, SuggestionRule } from '../core/suggest';
import { SkillUsage, summarizeUsage, UsageReader } from '../core/usage';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Holds skills, usage and suggestions; views listen to `onDidChange`. */
export class SkillStore implements vscode.Disposable {
  skills: Skill[] = [];
  usage = new Map<string, SkillUsage>();
  suggestions: Suggestion[] = [];
  context: ContextSummary = { workspaceName: '', dirtyCount: 0, statusLines: [] };

  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.#changed.event;
  readonly #usageReader = new UsageReader(path.join(os.homedir(), '.claude', 'projects'));
  #pinned: string[] = [];
  #projectRules: SuggestionRule[] = [];
  #contextTimer: NodeJS.Timeout | undefined;

  get #roots(): string[] {
    return (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
  }

  get #config() {
    return vscode.workspace.getConfiguration('claudeSkills');
  }

  find(id: string): Skill | undefined {
    return this.skills.find((s) => s.id === id);
  }

  /** Full refresh: rescan skill files, project config and usage history. */
  async refresh(): Promise<void> {
    const roots = this.#roots;
    this.skills = await scanSkills({
      workspaceRoots: roots,
      homeDir: os.homedir(),
      includePlugins: this.#config.get<boolean>('includePluginSkills', true),
    });

    this.#pinned = [];
    this.#projectRules = [];
    for (const root of roots) {
      const projectConfig = await readProjectConfig(root);
      this.#pinned.push(...projectConfig.pinned);
      this.#projectRules.push(...projectConfig.rules);
    }

    await this.#loadUsage();
    await this.#refreshContext();
  }

  /** Cheap refresh after editor / branch / file-save changes, debounced. */
  scheduleContextRefresh(): void {
    clearTimeout(this.#contextTimer);
    this.#contextTimer = setTimeout(() => void this.#refreshContext(), 400);
  }

  /** Picks up skills run since the last refresh (Claude appends to its transcripts as you work). */
  async refreshUsage(): Promise<void> {
    await this.#loadUsage();
    this.#recompute();
  }

  async #loadUsage(): Promise<void> {
    const days = Math.max(1, this.#config.get<number>('usageWindowDays', 30));
    const events = await this.#usageReader.collect(this.#roots, Date.now() - days * DAY_MS);
    this.usage = summarizeUsage(events, new Set(this.skills.map((s) => s.id)));
  }

  async #refreshContext(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const folder = editor
      ? vscode.workspace.getWorkspaceFolder(editor.document.uri)
      : vscode.workspace.workspaceFolders?.[0];
    const root = folder?.uri.fsPath;

    let relativeFile: string | undefined;
    if (editor && folder && editor.document.uri.scheme === 'file') {
      relativeFile = path.relative(root!, editor.document.uri.fsPath).split(path.sep).join('/');
    }
    const statusLines = root ? await gitStatus(root) : [];
    this.context = {
      workspaceName: folder?.name ?? vscode.workspace.name ?? '',
      relativeFile,
      languageId: editor?.document.languageId,
      branch: root ? await readBranch(root) : undefined,
      dirtyCount: statusLines.length,
      statusLines,
    };
    this.#recompute();
  }

  #recompute(): void {
    const settingsRules = this.#config.get<unknown[]>('rules', []).filter(isRule);
    this.suggestions = suggest(
      this.skills,
      this.context,
      this.usage,
      [...this.#projectRules, ...settingsRules],
      this.#pinned,
      Math.max(1, this.#config.get<number>('maxSuggestions', 7)),
    );
    this.#changed.fire();
  }

  frequent(limit = 15): Array<{ skill: Skill; usage: SkillUsage }> {
    return [...this.usage.entries()]
      .map(([id, usage]) => ({ skill: this.find(id)!, usage }))
      .filter((e) => e.skill)
      .sort((a, b) => b.usage.count - a.usage.count || b.usage.lastUsed - a.usage.lastUsed)
      .slice(0, limit);
  }

  dispose(): void {
    clearTimeout(this.#contextTimer);
    this.#changed.dispose();
  }
}
