import * as vscode from 'vscode';
import type { Skill } from '../core/skills';
import type { SkillUsage } from '../core/usage';
import type { SkillStore } from './store';

type Node = SkillNode | GroupNode;

class SkillNode {
  constructor(
    readonly skill: Skill,
    readonly note?: string,
    readonly reasons: string[] = [],
  ) {}
}

class GroupNode {
  constructor(
    readonly label: string,
    readonly skills: Skill[],
  ) {}
}

export function skillTooltip(skill: Skill, usage?: SkillUsage, reasons: string[] = []): vscode.MarkdownString {
  const md = new vscode.MarkdownString(undefined, true);
  md.appendMarkdown(`**/${skill.id}**${skill.argumentHint ? ` \`${skill.argumentHint}\`` : ''}\n\n`);
  md.appendText(skill.description.length > 600 ? `${skill.description.slice(0, 600)}…` : skill.description);
  if (reasons.length) {
    md.appendMarkdown(`\n\n$(lightbulb) Suggested because: ${reasons.join(', ')}`);
  }
  if (usage) {
    md.appendMarkdown(`\n\n$(history) Used ${usage.count}× · last ${relativeTime(usage.lastUsed)}`);
  }
  md.appendMarkdown(`\n\n_${sourceLabel(skill)}_`);
  return md;
}

export function sourceLabel(skill: Skill): string {
  const kind = skill.kind === 'command' ? 'command' : 'skill';
  if (skill.source === 'plugin') {
    return `plugin ${kind} · ${skill.pluginName}`;
  }
  return `${skill.source} ${kind}`;
}

export function relativeTime(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}m ago`;
  }
  const hours = Math.round(minutes / 60);
  if (hours < 48) {
    return `${hours}h ago`;
  }
  return `${Math.round(hours / 24)}d ago`;
}

abstract class SkillTree implements vscode.TreeDataProvider<Node> {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;

  constructor(protected readonly store: SkillStore) {
    store.onDidChange(() => this.#changed.fire());
  }

  abstract getChildren(node?: Node): Node[];

  getTreeItem(node: Node): vscode.TreeItem {
    if (node instanceof GroupNode) {
      const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.Expanded);
      item.description = String(node.skills.length);
      return item;
    }
    const { skill } = node;
    const item = new vscode.TreeItem(skill.id, vscode.TreeItemCollapsibleState.None);
    item.description = node.note;
    item.tooltip = skillTooltip(skill, this.store.usage.get(skill.id), node.reasons);
    item.contextValue = 'skill';
    item.iconPath = new vscode.ThemeIcon(skill.kind === 'command' ? 'terminal' : skill.source === 'plugin' ? 'extensions' : 'sparkle');
    const clickAction = vscode.workspace.getConfiguration('claudeSkills').get<string>('clickAction', 'run');
    item.command = {
      command: clickAction === 'details' ? 'claudeSkills.showDetails' : 'claudeSkills.runSkill',
      title: clickAction === 'details' ? 'Show Details' : 'Run',
      arguments: [node],
    };
    return item;
  }
}

export class SuggestedTree extends SkillTree {
  getChildren(node?: Node): Node[] {
    if (node) {
      return [];
    }
    return this.store.suggestions.map((s) => new SkillNode(s.skill, s.reasons[0], s.reasons));
  }
}

export class FrequentTree extends SkillTree {
  getChildren(node?: Node): Node[] {
    if (node) {
      return [];
    }
    return this.store.frequent().map(({ skill, usage }) => new SkillNode(skill, `${usage.count}× · ${relativeTime(usage.lastUsed)}`));
  }
}

export class AllSkillsTree extends SkillTree {
  getChildren(node?: Node): Node[] {
    if (node instanceof GroupNode) {
      return node.skills.map((s) => new SkillNode(s, s.argumentHint));
    }
    if (node) {
      return [];
    }
    const groups = new Map<string, Skill[]>();
    for (const skill of this.store.skills) {
      const label = skill.source === 'project' ? 'This project' : skill.source === 'personal' ? 'Personal (~/.claude)' : `Plugin: ${skill.pluginName}`;
      groups.set(label, [...(groups.get(label) ?? []), skill]);
    }
    return [...groups.entries()].map(([label, skills]) => new GroupNode(label, skills.sort((a, b) => a.id.localeCompare(b.id))));
  }
}

/** Commands receive either a tree node, a Skill, or a skill id (from the webview / quick pick). */
export function skillFromArg(arg: unknown, store: SkillStore): Skill | undefined {
  if (arg instanceof SkillNode) {
    return arg.skill;
  }
  if (typeof arg === 'string') {
    return store.find(arg);
  }
  if (arg && typeof arg === 'object' && 'id' in arg && 'filePath' in arg) {
    return arg as Skill;
  }
  return undefined;
}
