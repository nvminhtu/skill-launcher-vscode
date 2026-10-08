import * as fs from 'fs/promises';
import * as path from 'path';
import { isFalse, parseFrontmatter } from './frontmatter';

export type SkillSource = 'project' | 'personal' | 'plugin';
export type SkillKind = 'skill' | 'command';

export interface Skill {
  /** What you type after the slash, e.g. `run-unit-test` or `superpowers:brainstorming`. */
  id: string;
  name: string;
  description: string;
  argumentHint?: string;
  source: SkillSource;
  kind: SkillKind;
  pluginName?: string;
  /** Workspace folder the project skill belongs to. */
  root?: string;
  filePath: string;
  /** Quoted trigger phrases pulled out of the description ("Triggers on …"). */
  triggers: string[];
  /** First part of the body, for previews. */
  overview: string;
}

export interface ScanOptions {
  workspaceRoots: string[];
  homeDir: string;
  includePlugins: boolean;
}

export async function scanSkills(options: ScanOptions): Promise<Skill[]> {
  const claudeHome = path.join(options.homeDir, '.claude');
  const found: Skill[] = [];

  for (const root of options.workspaceRoots) {
    found.push(...(await readSkillDir(path.join(root, '.claude', 'skills'), { source: 'project', root })));
    found.push(...(await readCommandDir(path.join(root, '.claude', 'commands'), { source: 'project', root })));
  }
  found.push(...(await readSkillDir(path.join(claudeHome, 'skills'), { source: 'personal' })));
  found.push(...(await readCommandDir(path.join(claudeHome, 'commands'), { source: 'personal' })));

  if (options.includePlugins) {
    for (const plugin of await findEnabledPlugins(claudeHome, options.workspaceRoots)) {
      const base = { source: 'plugin' as const, pluginName: plugin.name };
      found.push(...(await readSkillDir(path.join(plugin.installPath, 'skills'), base)));
      found.push(...(await readCommandDir(path.join(plugin.installPath, 'commands'), base)));
    }
  }

  // Same id from several places: keep the first (project > personal > plugin).
  const seen = new Set<string>();
  return found.filter((skill) => {
    if (seen.has(skill.id)) {
      return false;
    }
    seen.add(skill.id);
    return true;
  });
}

interface Origin {
  source: SkillSource;
  root?: string;
  pluginName?: string;
}

async function readSkillDir(dir: string, origin: Origin): Promise<Skill[]> {
  const entries = await safeReaddir(dir);
  const skills: Skill[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const file = path.join(dir, entry.name, 'SKILL.md');
    const text = await safeRead(file);
    if (text === undefined) {
      continue;
    }
    const skill = buildSkill(text, file, entry.name, 'skill', origin);
    if (skill) {
      skills.push(skill);
    }
  }
  return skills;
}

async function readCommandDir(dir: string, origin: Origin, depth = 0): Promise<Skill[]> {
  if (depth > 3) {
    return [];
  }
  const entries = await safeReaddir(dir);
  const skills: Skill[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      skills.push(...(await readCommandDir(full, origin, depth + 1)));
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      const text = await safeRead(full);
      if (text === undefined) {
        continue;
      }
      const skill = buildSkill(text, full, entry.name.replace(/\.md$/i, ''), 'command', origin);
      if (skill) {
        skills.push(skill);
      }
    }
  }
  return skills;
}

export function buildSkill(
  text: string,
  filePath: string,
  fallbackName: string,
  kind: SkillKind,
  origin: Origin,
): Skill | undefined {
  const { data, body } = parseFrontmatter(text);
  if (isFalse(data['user-invocable'])) {
    return undefined;
  }
  const name = (kind === 'skill' && data.name) || fallbackName;
  const description = data.description || firstParagraph(body);
  return {
    id: origin.pluginName ? `${origin.pluginName}:${name}` : name,
    name,
    description,
    argumentHint: data['argument-hint'] || undefined,
    source: origin.source,
    kind,
    pluginName: origin.pluginName,
    root: origin.root,
    filePath,
    triggers: extractTriggers(description),
    overview: overviewOf(body),
  };
}

export function extractTriggers(description: string): string[] {
  const triggers: string[] = [];
  const pattern = /["“]([^"”\n]{2,80})["”]/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(description)) !== null) {
    const phrase = match[1].trim();
    if (phrase && !triggers.includes(phrase)) {
      triggers.push(phrase);
    }
  }
  return triggers;
}

function firstParagraph(body: string): string {
  for (const block of body.split(/\n\s*\n/)) {
    const cleaned = block
      .split('\n')
      .filter((line) => !/^\s*(#|```|<!--)/.test(line))
      .join(' ')
      .trim();
    if (cleaned) {
      return cleaned.slice(0, 400);
    }
  }
  return '';
}

function overviewOf(body: string): string {
  const trimmed = body.trim();
  return trimmed.length > 2400 ? `${trimmed.slice(0, 2400)}\n…` : trimmed;
}

interface PluginInstall {
  name: string;
  installPath: string;
}

/** Enabled plugins = `enabledPlugins` merged from user, project and local settings. */
export async function findEnabledPlugins(claudeHome: string, roots: string[]): Promise<PluginInstall[]> {
  const enabled: Record<string, boolean> = {};
  const settingsFiles = [path.join(claudeHome, 'settings.json')];
  for (const root of roots) {
    settingsFiles.push(path.join(root, '.claude', 'settings.json'), path.join(root, '.claude', 'settings.local.json'));
  }
  for (const file of settingsFiles) {
    const json = await safeJson(file);
    const map = json?.enabledPlugins;
    if (map && typeof map === 'object') {
      for (const [key, value] of Object.entries(map)) {
        enabled[key] = value === true;
      }
    }
  }

  const installed = await safeJson(path.join(claudeHome, 'plugins', 'installed_plugins.json'));
  const plugins = installed?.plugins;
  if (!plugins || typeof plugins !== 'object') {
    return [];
  }

  const result: PluginInstall[] = [];
  for (const [key, raw] of Object.entries(plugins)) {
    if (!enabled[key]) {
      continue;
    }
    const entries = (Array.isArray(raw) ? raw : [raw]) as Array<Record<string, unknown>>;
    const usable = entries
      .filter((e) => e && typeof e.installPath === 'string')
      .filter((e) => e.scope !== 'local' && e.scope !== 'project' ? true : roots.some((r) => samePath(r, e.projectPath)))
      .sort((a, b) => String(b.lastUpdated ?? '').localeCompare(String(a.lastUpdated ?? '')));
    if (usable.length > 0) {
      result.push({ name: key.split('@')[0], installPath: usable[0].installPath as string });
    }
  }
  return result;
}

function samePath(a: string, b: unknown): boolean {
  return typeof b === 'string' && path.resolve(a) === path.resolve(b);
}

async function safeReaddir(dir: string) {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

async function safeRead(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch {
    return undefined;
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function safeJson(file: string): Promise<any> {
  const text = await safeRead(file);
  if (text === undefined) {
    return undefined;
  }
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
