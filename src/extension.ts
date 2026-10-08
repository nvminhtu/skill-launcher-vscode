import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { askClaude, findPrompt, fitPrompt, parseFoundSkills } from './core/claudeCli';
import { PROJECT_CONFIG_PATH, PROJECT_CONFIG_TEMPLATE } from './core/projectConfig';
import type { Skill } from './core/skills';
import { encodeProjectDir } from './core/usage';
import { DetailPanel, DetailActions } from './vscode/detailPanel';
import { SkillStore } from './vscode/store';
import { ClaudeTerminals } from './vscode/terminal';
import { AllSkillsTree, FrequentTree, skillFromArg, SuggestedTree } from './vscode/trees';

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const store = new SkillStore();
  const terminals = new ClaudeTerminals();
  const output = vscode.window.createOutputChannel('Claude Skills');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = 'claudeSkills.pick';
  context.subscriptions.push(store, terminals, output, statusBar);

  const config = () => vscode.workspace.getConfiguration('claudeSkills');
  const workspaceRoot = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? os.homedir();
  const commandFor = (skill: Skill, args?: string) => `/${skill.id}${args ? ` ${args}` : ''}`;

  // ── Running skills ───────────────────────────────────────────────────────

  const askForArgs = async (skill: Skill): Promise<string | undefined> => {
    type Item = vscode.QuickPickItem & { args: string };
    const recent = store.usage.get(skill.id)?.recentArgs ?? [];
    const noArgs: Item = { label: '$(play) Run without arguments', args: '' };
    const recentItems: Item[] = recent.map((a) => ({ label: a, description: 'recent', args: a }));

    const pick = vscode.window.createQuickPick<Item>();
    pick.title = `/${skill.id}${skill.argumentHint ? ` ${skill.argumentHint}` : ''}`;
    pick.placeholder = skill.argumentHint ? `Arguments: ${skill.argumentHint}` : 'Arguments (optional)';
    pick.items = [noArgs, ...recentItems];
    pick.onDidChangeValue((value) => {
      pick.items = value.trim()
        ? [{ label: value, description: 'run with these arguments', args: value.trim(), alwaysShow: true }, ...recentItems]
        : [noArgs, ...recentItems];
    });

    return new Promise((resolve) => {
      let accepted = false;
      pick.onDidAccept(() => {
        accepted = true;
        resolve(pick.selectedItems[0]?.args ?? pick.value.trim());
        pick.hide();
      });
      pick.onDidHide(() => {
        if (!accepted) {
          resolve(undefined);
        }
        pick.dispose();
      });
      pick.show();
    });
  };

  const run = async (skill: Skill, args?: string) => {
    await terminals.send(commandFor(skill, args));
  };

  const runPrompting = async (skill: Skill, force: boolean) => {
    const wantsArgs = !!skill.argumentHint || (store.usage.get(skill.id)?.recentArgs.length ?? 0) > 0;
    if (force || (wantsArgs && config().get<boolean>('promptForArgs', true))) {
      const args = await askForArgs(skill);
      if (args === undefined) {
        return;
      }
      await run(skill, args);
    } else {
      await run(skill);
    }
  };

  // ── Ask Claude ───────────────────────────────────────────────────────────

  const askFit = async (skill: Skill) => {
    DetailPanel.show(skill, store, detailActions);
    DetailPanel.setAnswer(skill.id, { text: '', loading: true }, store);
    try {
      const answer = await askClaude(fitPrompt(skill, store.context), {
        claudePath: config().get<string>('claudePath', 'claude'),
        model: config().get<string>('askModel', 'haiku') || undefined,
        cwd: workspaceRoot(),
      });
      DetailPanel.setAnswer(skill.id, { text: answer, loading: false }, store);
    } catch (error) {
      DetailPanel.setAnswer(skill.id, { text: (error as Error).message, loading: false, error: true }, store);
    }
  };

  const detailActions: DetailActions = {
    run: (skill, args) => void (args === undefined ? runPrompting(skill, false) : run(skill, args)),
    runWithArgs: (skill) => void runPrompting(skill, true),
    open: (skill) => void vscode.window.showTextDocument(vscode.Uri.file(skill.filePath), { preview: true }),
    copy: (skill) => void copyCommand(skill),
    ask: (skill) => void askFit(skill),
  };

  const copyCommand = async (skill: Skill) => {
    await vscode.env.clipboard.writeText(commandFor(skill));
    void vscode.window.setStatusBarMessage(`Copied ${commandFor(skill)}`, 2500);
  };

  const findForTask = async () => {
    if (store.skills.length === 0) {
      void vscode.window.showWarningMessage('No skills found to choose from.');
      return;
    }
    const task = await vscode.window.showInputBox({
      title: 'Find a skill for a task',
      prompt: 'Describe what you want to do. Claude picks the best-fitting skills from this workspace.',
      placeHolder: 'e.g. run the tests for the file I changed and check coverage',
      ignoreFocusOut: true,
    });
    if (!task?.trim()) {
      return;
    }
    const knownIds = new Set(store.skills.map((s) => s.id));
    let answer: string;
    try {
      answer = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Asking Claude which skill fits…', cancellable: true },
        (_progress, token) => {
          const abort = new AbortController();
          token.onCancellationRequested(() => abort.abort());
          return askClaude(findPrompt(task, store.skills, store.context), {
            claudePath: config().get<string>('claudePath', 'claude'),
            model: config().get<string>('askModel', 'haiku') || undefined,
            cwd: workspaceRoot(),
            signal: abort.signal,
          });
        },
      );
    } catch (error) {
      if ((error as Error).name !== 'AbortError') {
        void vscode.window.showErrorMessage(`Claude Skills: ${(error as Error).message}`);
      }
      return;
    }

    const found = parseFoundSkills(answer, knownIds);
    if (found.length === 0) {
      output.appendLine(`Task: ${task}\n${answer}\n`);
      output.show(true);
      void vscode.window.showInformationMessage('Claude did not find a matching skill — its answer is in the "Claude Skills" output.');
      return;
    }
    type Item = vscode.QuickPickItem & { skill: Skill; args: string };
    const picked = await vscode.window.showQuickPick<Item>(
      found.map((f) => {
        const skill = store.find(f.skill)!;
        return { label: commandFor(skill, f.args), detail: f.why, skill, args: f.args };
      }),
      { title: 'Claude suggests', placeHolder: 'Pick one to send it to Claude Code' },
    );
    if (picked) {
      await run(picked.skill, picked.args || undefined);
    }
  };

  // ── Quick pick over everything ───────────────────────────────────────────

  const pickSkill = async () => {
    type Item = vscode.QuickPickItem & { skill?: Skill };
    const infoButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('info'), tooltip: 'Show details' };
    const toItem = (skill: Skill, description?: string): Item => ({
      label: `/${skill.id}`,
      description: description ?? skill.argumentHint,
      detail: skill.description.replace(/\s+/g, ' ').slice(0, 200),
      buttons: [infoButton],
      skill,
    });

    const items: Item[] = [];
    const listed = new Set<string>();
    if (store.suggestions.length) {
      items.push({ label: 'Suggested now', kind: vscode.QuickPickItemKind.Separator });
      for (const s of store.suggestions) {
        items.push(toItem(s.skill, `$(lightbulb) ${s.reasons.join(', ')}`));
        listed.add(s.skill.id);
      }
    }
    const frequent = store.frequent(8).filter((f) => !listed.has(f.skill.id));
    if (frequent.length) {
      items.push({ label: 'Frequently used', kind: vscode.QuickPickItemKind.Separator });
      for (const f of frequent) {
        items.push(toItem(f.skill, `$(history) ${f.usage.count}×`));
        listed.add(f.skill.id);
      }
    }
    items.push({ label: 'All skills', kind: vscode.QuickPickItemKind.Separator });
    for (const skill of [...store.skills].sort((a, b) => a.id.localeCompare(b.id))) {
      if (!listed.has(skill.id)) {
        items.push(toItem(skill));
      }
    }

    const pick = vscode.window.createQuickPick<Item>();
    pick.title = 'Claude Skills';
    pick.placeholder = 'Type to search skills by name or description';
    pick.matchOnDescription = true;
    pick.matchOnDetail = true;
    pick.items = items;
    pick.onDidTriggerItemButton((e) => {
      if (e.item.skill) {
        pick.hide();
        DetailPanel.show(e.item.skill, store, detailActions);
      }
    });
    pick.onDidAccept(() => {
      const skill = pick.selectedItems[0]?.skill;
      pick.hide();
      if (skill) {
        void runPrompting(skill, false);
      }
    });
    pick.onDidHide(() => pick.dispose());
    pick.show();
  };

  // ── Status bar ───────────────────────────────────────────────────────────

  const updateStatusBar = () => {
    if (!config().get<boolean>('showStatusBar', true) || store.skills.length === 0) {
      statusBar.hide();
      return;
    }
    const top = store.suggestions[0];
    statusBar.text = top ? `$(sparkle) /${top.skill.id}` : '$(sparkle) Skills';
    statusBar.tooltip = top
      ? `Suggested skill: /${top.skill.id}\n${top.reasons.join(', ')}\n\nClick to browse all skills (${process.platform === 'darwin' ? '⌘⌥K' : 'Ctrl+Alt+K'})`
      : 'Browse Claude Code skills';
    statusBar.show();
  };
  store.onDidChange(updateStatusBar);

  // ── Registration ─────────────────────────────────────────────────────────

  const withSkill = (fn: (skill: Skill) => unknown) => (arg: unknown) => {
    const skill = skillFromArg(arg, store);
    if (skill) {
      return fn(skill);
    }
  };

  context.subscriptions.push(
    vscode.window.registerTreeDataProvider('claudeSkills.suggested', new SuggestedTree(store)),
    vscode.window.registerTreeDataProvider('claudeSkills.frequent', new FrequentTree(store)),
    vscode.window.registerTreeDataProvider('claudeSkills.all', new AllSkillsTree(store)),
    vscode.commands.registerCommand('claudeSkills.pick', pickSkill),
    vscode.commands.registerCommand('claudeSkills.findForTask', findForTask),
    vscode.commands.registerCommand('claudeSkills.refresh', () => store.refresh()),
    vscode.commands.registerCommand('claudeSkills.runSkill', withSkill((s) => runPrompting(s, false))),
    vscode.commands.registerCommand('claudeSkills.runSkillWithArgs', withSkill((s) => runPrompting(s, true))),
    vscode.commands.registerCommand('claudeSkills.showDetails', withSkill((s) => DetailPanel.show(s, store, detailActions))),
    vscode.commands.registerCommand('claudeSkills.openSkillFile', withSkill((s) => detailActions.open(s))),
    vscode.commands.registerCommand('claudeSkills.copyCommand', withSkill(copyCommand)),
    vscode.commands.registerCommand('claudeSkills.askFit', withSkill(askFit)),
    vscode.commands.registerCommand('claudeSkills.createRulesFile', () => createRulesFile()),
  );

  // ── Keeping things fresh ─────────────────────────────────────────────────

  const debounce = (fn: () => unknown, ms: number) => {
    let timer: NodeJS.Timeout | undefined;
    context.subscriptions.push({ dispose: () => clearTimeout(timer) });
    return () => {
      clearTimeout(timer);
      timer = setTimeout(fn, ms);
    };
  };
  const refreshAll = debounce(() => store.refresh(), 800);
  const refreshUsage = debounce(() => store.refreshUsage(), 3000);

  const watch = (pattern: vscode.GlobPattern, onChange: () => void) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    watcher.onDidChange(onChange);
    watcher.onDidCreate(onChange);
    watcher.onDidDelete(onChange);
    context.subscriptions.push(watcher);
  };

  const claudeHome = vscode.Uri.file(path.join(os.homedir(), '.claude'));
  watch('**/.claude/{skills,commands}/**/*.md', refreshAll);
  watch('**/.claude/{skill-launcher.json,settings.json,settings.local.json}', refreshAll);
  watch(new vscode.RelativePattern(claudeHome, '{skills,commands}/**/*.md'), refreshAll);
  watch(new vscode.RelativePattern(claudeHome, '{settings.json,plugins/installed_plugins.json}'), refreshAll);
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    watch(new vscode.RelativePattern(folder, '.git/HEAD'), () => store.scheduleContextRefresh());
    watch(
      new vscode.RelativePattern(vscode.Uri.joinPath(claudeHome, 'projects'), `${encodeProjectDir(folder.uri.fsPath)}*/*.jsonl`),
      refreshUsage,
    );
  }

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(() => store.scheduleContextRefresh()),
    vscode.workspace.onDidSaveTextDocument(() => store.scheduleContextRefresh()),
    vscode.workspace.onDidChangeWorkspaceFolders(refreshAll),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('claudeSkills')) {
        refreshAll();
      }
    }),
  );

  await store.refresh();
}

async function createRulesFile(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0];
  if (!folder) {
    void vscode.window.showWarningMessage('Open a folder first.');
    return;
  }
  const file = vscode.Uri.joinPath(folder.uri, PROJECT_CONFIG_PATH);
  try {
    await fs.access(file.fsPath);
  } catch {
    await fs.mkdir(path.dirname(file.fsPath), { recursive: true });
    await fs.writeFile(file.fsPath, PROJECT_CONFIG_TEMPLATE, 'utf8');
  }
  await vscode.window.showTextDocument(file);
}

export function deactivate(): void {}
