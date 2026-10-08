import { createReadStream } from 'fs';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as readline from 'readline';

/**
 * Skill usage is read from Claude Code's own session transcripts:
 * `~/.claude/projects/<encoded workspace path>/*.jsonl`.
 * - Slash commands typed by the user show up as `<command-name>/x</command-name>` in user messages.
 * - Skills Claude invokes on its own show up as `Skill` tool_use blocks.
 */
export interface UsageEvent {
  skill: string;
  args?: string;
  timestamp: number;
}

export interface SkillUsage {
  count: number;
  lastUsed: number;
  recentArgs: string[];
}

/** Claude Code names a project's history folder by replacing every non-alphanumeric char with `-`. */
export function encodeProjectDir(workspacePath: string): string {
  return workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
}

const COMMAND_NAME = /<command-name>\/?([^<\s]+)<\/command-name>/;
const COMMAND_ARGS = /<command-args>([\s\S]*?)<\/command-args>/;

export function parseTranscriptLine(line: string): UsageEvent[] {
  if (!line.includes('"Skill"') && !line.includes('<command-name>')) {
    return [];
  }
  let entry: TranscriptEntry;
  try {
    entry = JSON.parse(line);
  } catch {
    return [];
  }
  const timestamp = Date.parse(entry.timestamp ?? '') || 0;
  const content = entry.message?.content;
  const events: UsageEvent[] = [];

  if (entry.type === 'assistant' && Array.isArray(content)) {
    for (const block of content) {
      if (block?.type === 'tool_use' && block.name === 'Skill' && typeof block.input?.skill === 'string') {
        events.push({ skill: stripSlash(block.input.skill), args: cleanArgs(block.input.args), timestamp });
      }
    }
  } else if (entry.type === 'user') {
    const text = typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n')
        : '';
    const name = COMMAND_NAME.exec(text);
    if (name) {
      events.push({ skill: stripSlash(name[1]), args: cleanArgs(COMMAND_ARGS.exec(text)?.[1]), timestamp });
    }
  }
  return events;
}

interface TranscriptEntry {
  type?: string;
  timestamp?: string;
  message?: {
    content?: string | Array<{ type?: string; name?: string; text?: string; input?: { skill?: unknown; args?: unknown } }>;
  };
}

function stripSlash(name: string): string {
  return name.trim().replace(/^\//, '');
}

function cleanArgs(args: unknown): string | undefined {
  if (typeof args !== 'string') {
    return undefined;
  }
  const trimmed = args.trim();
  // Only short one-liners are worth offering again as "recent arguments".
  return trimmed && trimmed.length <= 120 && !trimmed.includes('\n') ? trimmed : undefined;
}

interface CacheEntry {
  mtimeMs: number;
  size: number;
  events: UsageEvent[];
}

/** Re-reads only transcripts that changed since the last call. */
export class UsageReader {
  #cache = new Map<string, CacheEntry>();

  constructor(private readonly projectsDir: string) {}

  async collect(workspacePaths: string[], sinceMs: number): Promise<UsageEvent[]> {
    const dirs = await this.#matchingDirs(workspacePaths);
    const events: UsageEvent[] = [];
    for (const dir of dirs) {
      let files: string[];
      try {
        files = (await fs.readdir(dir)).filter((f) => f.endsWith('.jsonl'));
      } catch {
        continue;
      }
      for (const file of files) {
        const full = path.join(dir, file);
        let stat;
        try {
          stat = await fs.stat(full);
        } catch {
          continue;
        }
        if (stat.mtimeMs < sinceMs) {
          continue;
        }
        const cached = this.#cache.get(full);
        let fileEvents: UsageEvent[];
        if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
          fileEvents = cached.events;
        } else {
          fileEvents = await readTranscript(full);
          this.#cache.set(full, { mtimeMs: stat.mtimeMs, size: stat.size, events: fileEvents });
        }
        for (const event of fileEvents) {
          if (event.timestamp >= sinceMs) {
            events.push(event);
          }
        }
      }
    }
    return events;
  }

  /** The workspace folder itself plus sessions started in its sub-folders. */
  async #matchingDirs(workspacePaths: string[]): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.projectsDir);
    } catch {
      return [];
    }
    const prefixes = workspacePaths.map(encodeProjectDir);
    return names
      .filter((name) => prefixes.some((p) => name === p || name.startsWith(`${p}-`)))
      .map((name) => path.join(this.projectsDir, name));
  }
}

async function readTranscript(file: string): Promise<UsageEvent[]> {
  const events: UsageEvent[] = [];
  const lines = readline.createInterface({ input: createReadStream(file, 'utf8'), crlfDelay: Infinity });
  for await (const line of lines) {
    events.push(...parseTranscriptLine(line));
  }
  return events;
}

/** Counts events per known skill id. Unknown names (built-ins like /model) are dropped. */
export function summarizeUsage(events: UsageEvent[], knownIds: Set<string>): Map<string, SkillUsage> {
  const sorted = [...events].sort((a, b) => b.timestamp - a.timestamp);
  const usage = new Map<string, SkillUsage>();
  for (const event of sorted) {
    if (!knownIds.has(event.skill)) {
      continue;
    }
    let entry = usage.get(event.skill);
    if (!entry) {
      entry = { count: 0, lastUsed: event.timestamp, recentArgs: [] };
      usage.set(event.skill, entry);
    }
    entry.count++;
    if (event.args && entry.recentArgs.length < 5 && !entry.recentArgs.includes(event.args)) {
      entry.recentArgs.push(event.args);
    }
  }
  return usage;
}
