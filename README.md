# Skill Launcher for Claude Code

Find, understand and run your [Claude Code](https://docs.claude.com/en/docs/claude-code) skills without memorizing their names.

Once you have dozens of skills across project, personal and plugin folders, the `/` menu becomes a long list to scroll. This extension adds a sidebar that shows **which skills fit what you are doing right now**, **which ones you actually use in this repo**, and **what each one expects**. It then types the command into your Claude terminal.

It works with any repository. It reads whatever skills that repo and your machine have, so nothing is configured per project.

> Unofficial community extension. It is not affiliated with or endorsed by Anthropic.

## Install

The extension is not on the VS Code Marketplace. You install the `.vsix` file directly.

**Option A: download a release**
1. Download `skill-launcher-vX.Y.Z.vsix` from this repo's **Releases** page.
2. Install it with **one** of these:
   - In VS Code, open the Extensions view, click `…`, choose **Install from VSIX…**, and pick the file.
   - Run `code --install-extension skill-launcher-vX.Y.Z.vsix`.

**Option B: build from source**
```bash
git clone https://github.com/nvminhtu/skill-launcher-vscode.git && cd skill-launcher-vscode
npm install
npm run install-local   # builds the .vsix and installs it into VS Code
```

To update, install a newer `.vsix` the same way. VS Code replaces the old version.

## Features

### Suggested Now
Skills ranked against your current context:

| Signal | Example | Suggests skills about… |
|---|---|---|
| Open file is a test | `login.page.spec.ts`, `test_api.py`, `LoginTests.swift` | tests, coverage |
| File type | `.swift`, `.kt`, `.scss`, `.md`, `Dockerfile`, `.github/workflows/*.yml` | iOS, Android, UI, docs, CI… |
| Folder names | `local_plugin/ble/ios/…` | plugin, ios |
| Branch | `fix/…`, `feat/ABC-123-…` | fixing/debugging, tickets/specs |
| Uncommitted changes | `git status` not clean | commit, lint, review, PR |

Each suggestion explains why it appears. Hover the item, or read the label next to it.

### Frequently Used
This view is built from your own Claude Code history (`~/.claude/projects/<this repo>/*.jsonl`). It counts slash commands you typed and skills Claude invoked, for **this workspace only**, over the last 30 days by default. It also remembers the arguments you passed, so you can run them again with one click.

### All Skills
Skills are grouped by where they come from:
- `.claude/skills/*/SKILL.md` and `.claude/commands/**/*.md` in the workspace
- `~/.claude/skills` and `~/.claude/commands`
- **Enabled** Claude Code plugins, namespaced as `plugin:skill`

Skills marked `user-invocable: false` are hidden.

### One-click run
Clicking a skill types `/skill-name` into the terminal where Claude Code is running:
- If the skill declares an `argument-hint`, or you have run it with arguments before, a quick input asks for arguments first and offers your recent ones.
- If no Claude terminal is open, you can start a new `claude` session, pick a terminal, or copy the command for the Claude Code chat panel.
- Enter is **not** pressed by default, so you can review the command first. Turn on `claudeSkills.autoSubmit` to change that.

`Cmd+Alt+K` / `Ctrl+Alt+K` opens a searchable picker: suggested skills first, then frequent ones, then everything else.

### Skill details
The detail panel shows:
- what the skill does
- its argument syntax
- the trigger phrases from its description ("use it when you say…")
- your recent arguments and usage count
- a preview of its instructions

### Ask Claude (optional, uses your Claude Code account)
- **Does this skill fit right now?** Sends the skill and your current context (branch, open file, `git status`) to `claude -p` and returns a verdict, the reason, and the exact command to run.
- **Find a skill for a task…** Describe what you want to do in plain words. Claude picks up to 3 skills from your catalog, with arguments filled in.

Both run a one-shot, tool-less `claude -p --no-session-persistence` call. Claude cannot read or change files, and the call does not appear in your history. The default model is `haiku` (see `claudeSkills.askModel`).

## Team rules: `.claude/skill-launcher.json`

Commit this file to share project-specific suggestions with everyone who opens the repo. Create it with **Claude Skills: Create Project Suggestion Rules File**.

```json
{
  "pinned": ["spec-implement"],
  "rules": [
    { "fileGlob": "**/*.spec.ts", "skills": ["run-unit-test"], "reason": "Editing a spec" },
    { "fileGlob": "src/**/*.{html,scss}", "skills": ["ui-reuse-check"], "reason": "UI work" },
    { "branch": "^(feat|fix)/[A-Z]+-\\d+", "dirty": true, "skills": ["create-commit"], "reason": "Ticket work to commit" }
  ]
}
```

All conditions in a rule must match. `pinned` skills always appear at the top of **Suggested Now**. You can add personal rules in the `claudeSkills.rules` setting.

## Settings

| Setting | Default | |
|---|---|---|
| `claudeSkills.clickAction` | `run` | `run` or `details` when clicking a skill |
| `claudeSkills.autoSubmit` | `false` | Press Enter after typing the command |
| `claudeSkills.promptForArgs` | `true` | Ask for arguments when a skill takes them |
| `claudeSkills.terminalNamePattern` | `claude` | Regex identifying Claude terminals |
| `claudeSkills.claudePath` | `claude` | Path to the CLI (common install paths are tried automatically) |
| `claudeSkills.askModel` | `haiku` | Model for the Ask Claude features |
| `claudeSkills.usageWindowDays` | `30` | History window for Frequently Used |
| `claudeSkills.maxSuggestions` | `7` | Size of Suggested Now |
| `claudeSkills.showStatusBar` | `true` | Show the top suggestion in the status bar |
| `claudeSkills.includePluginSkills` | `true` | Include skills from enabled plugins |
| `claudeSkills.rules` | `[]` | Personal suggestion rules |

## Privacy
- Everything except the Ask Claude features runs locally. The extension only reads files under `~/.claude` and the workspace's `.claude` folder.
- The Ask Claude features send the skill description and a short context summary through your own Claude Code CLI. Nothing else is sent anywhere.

## Limitations
- Claude Code's prompt is a full-screen terminal UI, so no extension can add inline completions inside it. This extension types the command for you instead.
- The Claude Code chat panel inside VS Code cannot receive text from other extensions. Use **Copy to clipboard** there.

## Development

```bash
npm install
npm test               # compile + unit tests (node:test)
npm run package        # builds skill-launcher-for-claude-code-<version>.vsix
npm run install-local  # builds and installs into your VS Code
```

Press `F5` in VS Code to launch an Extension Development Host.

### Releasing
1. Bump `version` in `package.json` and add an entry to `CHANGELOG.md`.
2. Tag the commit and push the tag: `git tag v0.1.1 && git push origin v0.1.1`.

The **Release VSIX** workflow then runs the tests, builds the `.vsix` and attaches it to a GitHub Release.
