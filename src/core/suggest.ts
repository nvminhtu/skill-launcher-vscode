import type { Skill } from './skills';
import type { SkillUsage } from './usage';

/** Everything the suggester knows about "right now". Paths use forward slashes, relative to the workspace. */
export interface SuggestContext {
  relativeFile?: string;
  languageId?: string;
  branch?: string;
  dirtyCount: number;
}

export interface SuggestionRule {
  skills: string[];
  fileGlob?: string;
  branch?: string;
  dirty?: boolean;
  reason?: string;
}

export interface Suggestion {
  skill: Skill;
  score: number;
  reasons: string[];
}

interface Signal {
  keywords: string[];
  reason: string;
  /** Multiplier for how strongly this signal speaks for a skill. */
  weight: number;
}

const TEST_FILE = /([._-](spec|test|tests)\.[a-z0-9]+$)|(^|\/)(__tests__|tests?)\/|Tests?\.(swift|kt|java|cs)$/i;

const EXTENSION_KEYWORDS: Array<[RegExp, string[], string]> = [
  [/\.swift$/i, ['swift', 'swiftui', 'ios', 'xcode'], 'Swift file'],
  [/\.(m|mm)$/i, ['objective-c', 'ios', 'xcode'], 'Objective-C file'],
  [/\.kts?$/i, ['kotlin', 'android', 'gradle', 'compose'], 'Kotlin file'],
  [/\.java$/i, ['java', 'android', 'gradle'], 'Java file'],
  [/\.dart$/i, ['flutter', 'dart'], 'Dart file'],
  [/\.py$/i, ['python', 'pytest'], 'Python file'],
  [/\.go$/i, ['golang'], 'Go file'],
  [/\.rs$/i, ['rust', 'cargo'], 'Rust file'],
  [/\.(html|scss|sass|less|css|vue|svelte)$/i, ['ui', 'layout', 'css', 'style', 'design', 'component'], 'UI / style file'],
  [/\.(tsx|jsx)$/i, ['react', 'component', 'ui'], 'React component'],
  [/\.(md|mdx)$/i, ['doc', 'docs', 'documentation', 'markdown', 'readme', 'blog', 'post'], 'Markdown file'],
  [/\.sql$/i, ['sql', 'database', 'migration', 'schema'], 'SQL file'],
  [/(^|\/)(dockerfile|docker-compose[^/]*)$/i, ['docker', 'deploy', 'container'], 'Docker file'],
  [/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/i, ['ci', 'workflow', 'github', 'pipeline', 'build', 'release'], 'CI workflow'],
  [/(^|\/)(package\.json|pubspec\.yaml|build\.gradle(\.kts)?|podfile|cargo\.toml)$/i, ['dependency', 'dependencies', 'upgrade', 'build', 'version'], 'Build manifest'],
  [/(^|\/)\.claude\/(skills|commands)\//i, ['skill', 'skills', 'command'], 'Skill file'],
];

const BRANCH_PREFIX_KEYWORDS: Array<[RegExp, string[], string]> = [
  [/^(fix|bugfix|hotfix|bug)[/-]/i, ['fix', 'bug', 'debug', 'crash', 'error'], 'fix branch'],
  [/^(feat|feature)[/-]/i, ['feature', 'implement', 'plan', 'spec'], 'feature branch'],
  [/^(refactor)[/-]/i, ['refactor', 'cleanup', 'simplify'], 'refactor branch'],
  [/^(test|tests)[/-]/i, ['test', 'unit', 'coverage'], 'test branch'],
  [/^(docs?)[/-]/i, ['doc', 'docs', 'documentation'], 'docs branch'],
  [/^(chore|ci|build)[/-]/i, ['ci', 'build', 'chore', 'release'], 'chore/CI branch'],
  [/^(release)[/-]/i, ['release', 'version', 'changelog', 'build'], 'release branch'],
];

const TICKET = /\b([A-Z][A-Z0-9]+-\d+)\b/;
const DEFAULT_BRANCHES = /^(main|master|dev|develop|development|trunk|staging)$/i;

const PATH_STOPWORDS = new Set([
  'src', 'app', 'apps', 'lib', 'libs', 'main', 'java', 'kotlin', 'swift', 'source', 'sources', 'index', 'packages',
  'components', 'component', 'pages', 'page', 'views', 'view', 'shared', 'common', 'core', 'utils', 'util', 'test',
  'tests', 'spec', 'assets', 'public', 'resources', 'res', 'the', 'and', 'for', 'with', 'new', 'old',
]);

export function contextSignals(ctx: SuggestContext): Signal[] {
  const signals: Signal[] = [];
  const file = ctx.relativeFile;
  if (file) {
    if (TEST_FILE.test(file)) {
      signals.push({ keywords: ['test', 'unit', 'coverage', 'jest', 'jasmine', 'karma', 'vitest', 'pytest', 'xctest'], reason: 'editing a test file', weight: 1.5 });
    }
    for (const [pattern, keywords, reason] of EXTENSION_KEYWORDS) {
      if (pattern.test(file)) {
        // The open file is the most direct signal of what you are doing.
        signals.push({ keywords, reason, weight: 1.25 });
      }
    }
    const folders = file.split('/').slice(0, -1).slice(-3);
    const words = unique(folders.flatMap(splitWords)).filter((w) => w.length >= 3 && !PATH_STOPWORDS.has(w));
    if (words.length > 0) {
      signals.push({ keywords: words, reason: `path: ${folders.join('/')}`, weight: 0.75 });
    }
  }

  const branch = ctx.branch;
  if (branch && !DEFAULT_BRANCHES.test(branch)) {
    for (const [pattern, keywords, reason] of BRANCH_PREFIX_KEYWORDS) {
      if (pattern.test(branch)) {
        signals.push({ keywords, reason, weight: 1 });
      }
    }
    const ticket = TICKET.exec(branch);
    if (ticket) {
      signals.push({ keywords: ['ticket', 'jira', 'issue', 'spec', 'task', 'plan', 'implement'], reason: `ticket ${ticket[1]} in branch`, weight: 1 });
    }
    const words = splitWords(branch.replace(TICKET, ' ')).filter((w) => w.length >= 4 && !/^\d+$/.test(w));
    if (words.length > 0) {
      signals.push({ keywords: unique(words), reason: `branch "${branch}"`, weight: 0.5 });
    }
  }

  if (ctx.dirtyCount > 0) {
    signals.push({
      keywords: ['commit', 'lint', 'eslint', 'review', 'pr', 'pull request', 'diff', 'changes'],
      reason: `${ctx.dirtyCount} uncommitted change${ctx.dirtyCount === 1 ? '' : 's'}`,
      weight: 1,
    });
  }
  return signals;
}

export function suggest(
  skills: Skill[],
  ctx: SuggestContext,
  usage: Map<string, SkillUsage>,
  rules: SuggestionRule[],
  pinned: string[],
  limit: number,
): Suggestion[] {
  const signals = contextSignals(ctx);
  const byId = new Map(skills.map((s) => [s.id, s]));
  const results = new Map<string, Suggestion>();

  const bump = (skill: Skill, score: number, reason: string) => {
    const existing = results.get(skill.id) ?? { skill, score: 0, reasons: [] };
    existing.score += score;
    if (!existing.reasons.includes(reason)) {
      existing.reasons.push(reason);
    }
    results.set(skill.id, existing);
  };

  for (const id of pinned) {
    const skill = byId.get(id);
    if (skill) {
      bump(skill, 100, 'pinned for this project');
    }
  }

  for (const rule of rules) {
    if (!ruleMatches(rule, ctx)) {
      continue;
    }
    for (const id of rule.skills) {
      const skill = byId.get(id);
      if (skill) {
        bump(skill, 20, rule.reason || 'project rule');
      }
    }
  }

  for (const skill of skills) {
    const nameWords = new Set(splitWords(skill.id));
    const haystack = ` ${skill.description.toLowerCase()} ${skill.triggers.join(' ').toLowerCase()} `;
    for (const signal of signals) {
      let nameHits = 0;
      let textHits = 0;
      for (const keyword of signal.keywords) {
        if (nameWords.has(keyword)) {
          nameHits++;
        } else if (containsWord(haystack, keyword)) {
          textHits++;
        }
      }
      // Name matches are strong evidence; description matches are capped so long descriptions don't win by volume.
      const score = (nameHits * 3 + Math.min(textHits, 3)) * signal.weight;
      if (score >= 1.5) {
        bump(skill, score, signal.reason);
      }
    }
  }

  for (const suggestion of results.values()) {
    const used = usage.get(suggestion.skill.id);
    if (used) {
      // Tie-breaker among context matches, capped so habits never drown out the current context.
      suggestion.score += Math.min(Math.log2(1 + used.count), 4) * 0.75;
    }
  }

  return [...results.values()]
    .filter((s) => s.score >= 3)
    .sort((a, b) => b.score - a.score || a.skill.id.localeCompare(b.skill.id))
    .slice(0, limit);
}

export function ruleMatches(rule: SuggestionRule, ctx: SuggestContext): boolean {
  if (!Array.isArray(rule.skills) || rule.skills.length === 0) {
    return false;
  }
  if (rule.fileGlob && !(ctx.relativeFile && globToRegExp(rule.fileGlob).test(ctx.relativeFile))) {
    return false;
  }
  if (rule.branch) {
    let pattern: RegExp;
    try {
      pattern = new RegExp(rule.branch, 'i');
    } catch {
      return false;
    }
    if (!ctx.branch || !pattern.test(ctx.branch)) {
      return false;
    }
  }
  if (rule.dirty !== undefined && rule.dirty !== ctx.dirtyCount > 0) {
    return false;
  }
  return true;
}

/** Glob subset: `**`, `*`, `?`, `{a,b}`. A pattern without `/` matches the file name anywhere. */
export function globToRegExp(glob: string): RegExp {
  const pattern = glob.includes('/') ? glob : `**/${glob}`;
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        const slash = pattern[i + 2] === '/';
        out += slash ? '(?:.*/)?' : '.*';
        i += slash ? 2 : 1;
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if (c === '{') {
      const close = pattern.indexOf('}', i);
      if (close === -1) {
        out += '\\{';
      } else {
        out += `(?:${pattern.slice(i + 1, close).split(',').map(escapeRegExp).join('|')})`;
        i = close;
      }
    } else {
      out += escapeRegExp(c);
    }
  }
  return new RegExp(`^${out}$`, 'i');
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
}

export function splitWords(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function containsWord(haystack: string, keyword: string): boolean {
  const pattern = new RegExp(`(^|[^a-z0-9])${escapeRegExp(keyword)}s?([^a-z0-9]|$)`);
  return pattern.test(haystack);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}
