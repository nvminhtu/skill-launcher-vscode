import { spawn } from 'child_process';
import { existsSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import type { Skill } from './skills';
import type { SuggestContext } from './suggest';

/** GUI-launched editors often miss shell PATH additions, so also try the usual install locations. */
export function resolveClaudePath(configured: string): string {
  if (configured && configured !== 'claude') {
    return configured;
  }
  const home = os.homedir();
  const candidates = [
    path.join(home, '.claude', 'local', 'claude'),
    path.join(home, '.local', 'bin', 'claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  return candidates.find((c) => existsSync(c)) ?? 'claude';
}

export interface AskOptions {
  claudePath: string;
  model?: string;
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * One-shot, tool-less `claude -p` call. The prompt goes through stdin so no shell quoting is involved,
 * and session persistence is off so these calls never show up in the user's history or usage stats.
 */
export function askClaude(prompt: string, options: AskOptions): Promise<string> {
  // With `shell: true` (Windows) an empty argument would vanish, so pass it quoted.
  const noTools = process.platform === 'win32' ? '""' : '';
  const args = ['-p', '--output-format', 'text', '--tools', noTools, '--no-session-persistence'];
  if (options.model) {
    args.push('--model', options.model);
  }
  return new Promise((resolve, reject) => {
    const child = spawn(resolveClaudePath(options.claudePath), args, {
      cwd: options.cwd,
      shell: process.platform === 'win32',
      signal: options.signal,
      env: process.env,
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('Claude did not answer within the time limit.'));
    }, options.timeoutMs ?? 180_000);
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Could not start Claude Code CLI (${err.message}). Set "claudeSkills.claudePath".`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || stdout.trim() || `claude exited with code ${code}`));
      }
    });
    child.stdin.end(prompt);
  });
}

export interface ContextSummary extends SuggestContext {
  workspaceName: string;
  statusLines: string[];
}

function describeContext(ctx: ContextSummary): string {
  return [
    `Workspace: ${ctx.workspaceName}`,
    `Git branch: ${ctx.branch ?? '(unknown)'}`,
    `Active file: ${ctx.relativeFile ?? '(none)'}${ctx.languageId ? ` [${ctx.languageId}]` : ''}`,
    `Uncommitted changes (${ctx.dirtyCount}):`,
    ...(ctx.statusLines.length ? ctx.statusLines.slice(0, 30).map((l) => `  ${l}`) : ['  (none)']),
  ].join('\n');
}

export function fitPrompt(skill: Skill, ctx: ContextSummary): string {
  return `You help a developer decide whether a Claude Code skill fits what they are doing right now.
Answer from the information below only. Be concrete and brief (max 8 lines), using this format:

Verdict: Fits | Partly fits | Does not fit
Why: <one or two sentences tied to the context>
Run: </command and arguments to type, or "—" if it does not fit>
Instead: <a better-fitting idea, only if it does not fit>

## Skill
Command: /${skill.id}
Argument hint: ${skill.argumentHint ?? '(none)'}
Description: ${skill.description}

## Current context
${describeContext(ctx)}`;
}

export function findPrompt(task: string, skills: Skill[], ctx: ContextSummary): string {
  const catalog = skills
    .map((s) => `- /${s.id}${s.argumentHint ? ` ${s.argumentHint}` : ''}: ${s.description.replace(/\s+/g, ' ').slice(0, 280)}`)
    .join('\n');
  return `A developer wants to do a task with Claude Code and needs the right skill (slash command).
Pick up to 3 skills from the catalog that best fit the task, best first. Only use ids from the catalog.
Reply with ONLY a JSON array, no prose, e.g.:
[{"skill":"run-unit-test","args":"helper.service","why":"Runs the specs for the file being edited"}]
Use "" for args when none are needed. Reply [] if nothing fits.

## Task
${task}

## Current context
${describeContext(ctx)}

## Catalog
${catalog}`;
}

export interface FoundSkill {
  skill: string;
  args: string;
  why: string;
}

export function parseFoundSkills(answer: string, knownIds: Set<string>): FoundSkill[] {
  const start = answer.indexOf('[');
  const end = answer.lastIndexOf(']');
  if (start === -1 || end <= start) {
    return [];
  }
  try {
    const parsed = JSON.parse(answer.slice(start, end + 1));
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed
      .filter((item) => item && typeof item.skill === 'string')
      .map((item) => ({
        skill: String(item.skill).replace(/^\//, ''),
        args: typeof item.args === 'string' ? item.args : '',
        why: typeof item.why === 'string' ? item.why : '',
      }))
      .filter((item) => knownIds.has(item.skill))
      .slice(0, 3);
  } catch {
    return [];
  }
}
