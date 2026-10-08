import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';
import { parseFoundSkills } from '../core/claudeCli';
import { parseFrontmatter } from '../core/frontmatter';
import { buildSkill, extractTriggers, scanSkills, Skill } from '../core/skills';
import { contextSignals, globToRegExp, ruleMatches, suggest } from '../core/suggest';
import { encodeProjectDir, parseTranscriptLine, summarizeUsage, UsageReader } from '../core/usage';

function skill(id: string, description: string, extra: Partial<Skill> = {}): Skill {
  return { id, name: id, description, source: 'project', kind: 'skill', filePath: `/x/${id}/SKILL.md`, triggers: extractTriggers(description), overview: '', ...extra };
}

describe('parseFrontmatter', () => {
  it('reads plain, quoted and folded values', () => {
    const { data, body } = parseFrontmatter(
      '---\nname: run-unit-test\nargument-hint: "<file> | branch"\ndescription: >\n  Runs tests\n  for a file.\nmodel: haiku\n---\n# Body\n',
    );
    assert.equal(data.name, 'run-unit-test');
    assert.equal(data['argument-hint'], '<file> | branch');
    assert.equal(data.description, 'Runs tests for a file.');
    assert.equal(data.model, 'haiku');
    assert.equal(body, '# Body\n');
  });

  it('keeps literal block newlines and handles CRLF', () => {
    const { data } = parseFrontmatter('---\r\ndescription: |\r\n  line one\r\n  line two\r\n---\r\n');
    assert.equal(data.description, 'line one\nline two');
  });

  it('returns the whole text as body when there is no front matter', () => {
    assert.deepEqual(parseFrontmatter('# Title'), { data: {}, body: '# Title' });
  });

  it('ignores nested lists', () => {
    const { data } = parseFrontmatter('---\nallowed-tools:\n  - Bash\n  - Read\nname: x\n---\n');
    assert.equal(data['allowed-tools'], undefined);
    assert.equal(data.name, 'x');
  });
});

describe('buildSkill', () => {
  it('hides skills marked user-invocable: false', () => {
    assert.equal(buildSkill('---\nname: x\nuser-invocable: false\n---\n', '/f', 'x', 'skill', { source: 'project' }), undefined);
  });

  it('namespaces plugin skills and extracts trigger phrases', () => {
    const s = buildSkill('---\nname: brainstorming\ndescription: Use when you say "let\'s build X" or “design this”.\n---\n', '/f', 'dir', 'skill', {
      source: 'plugin',
      pluginName: 'superpowers',
    })!;
    assert.equal(s.id, 'superpowers:brainstorming');
    assert.deepEqual(s.triggers, ["let's build X", 'design this']);
  });

  it('falls back to the first paragraph for commands without a description', () => {
    const s = buildSkill('# Deploy\n\nDeploys the app to staging.\n', '/f', 'deploy', 'command', { source: 'personal' })!;
    assert.equal(s.id, 'deploy');
    assert.equal(s.description, 'Deploys the app to staging.');
  });
});

describe('scanSkills', () => {
  it('finds project, personal and enabled plugin skills', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skills-'));
    const repo = path.join(tmp, 'repo');
    const home = path.join(tmp, 'home');
    const write = async (file: string, text: string) => {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, text);
    };
    await write(path.join(repo, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: Deploy it\n---\n');
    await write(path.join(repo, '.claude/skills/README.md'), 'not a skill');
    await write(path.join(repo, '.claude/commands/review.md'), '---\ndescription: Review\n---\n');
    await write(path.join(home, '.claude/skills/deploy/SKILL.md'), '---\nname: deploy\ndescription: personal dup\n---\n');
    await write(path.join(home, '.claude/skills/notes/SKILL.md'), '---\nname: notes\ndescription: Notes\n---\n');
    const pluginPath = path.join(home, '.claude/plugins/cache/m/tools/1.0.0');
    await write(path.join(pluginPath, 'skills/lint/SKILL.md'), '---\nname: lint\ndescription: Lint\n---\n');
    await write(path.join(home, '.claude/plugins/installed_plugins.json'), JSON.stringify({
      version: 2,
      plugins: {
        'tools@m': [{ scope: 'user', installPath: pluginPath }],
        'off@m': [{ scope: 'user', installPath: path.join(home, 'nope') }],
      },
    }));
    await write(path.join(home, '.claude/settings.json'), JSON.stringify({ enabledPlugins: { 'tools@m': true, 'off@m': false } }));

    const skills = await scanSkills({ workspaceRoots: [repo], homeDir: home, includePlugins: true });
    const ids = skills.map((s) => `${s.source}:${s.id}`).sort();
    assert.deepEqual(ids, ['personal:notes', 'plugin:tools:lint', 'project:deploy', 'project:review']);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('usage', () => {
  it('encodes project folders the way Claude Code does', () => {
    assert.equal(encodeProjectDir('/Users/me/my_app.v2/web'), '-Users-me-my-app-v2-web');
  });

  it('reads slash commands typed by the user', () => {
    const line = JSON.stringify({
      type: 'user',
      timestamp: '2026-10-01T10:00:00Z',
      message: { content: '<command-message>x</command-message>\n<command-name>/run-unit-test</command-name>\n<command-args>helper.service</command-args>' },
    });
    assert.deepEqual(parseTranscriptLine(line), [{ skill: 'run-unit-test', args: 'helper.service', timestamp: Date.parse('2026-10-01T10:00:00Z') }]);
  });

  it('reads Skill tool calls made by Claude', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-10-01T10:00:00Z',
      message: { content: [{ type: 'text', text: 'hi' }, { type: 'tool_use', name: 'Skill', input: { skill: 'superpowers:brainstorming', args: '' } }] },
    });
    assert.deepEqual(parseTranscriptLine(line), [{ skill: 'superpowers:brainstorming', args: undefined, timestamp: Date.parse('2026-10-01T10:00:00Z') }]);
  });

  it('ignores lines that merely mention skills (e.g. system prompt snapshots)', () => {
    assert.deepEqual(parseTranscriptLine(JSON.stringify({ type: 'system', content: '"name":"Skill" <command-name>/x</command-name>' })), []);
    assert.deepEqual(parseTranscriptLine('not json "Skill"'), []);
  });

  it('summarizes counts, last use and distinct recent args for known skills only', () => {
    const usage = summarizeUsage(
      [
        { skill: 'a', args: 'one', timestamp: 1 },
        { skill: 'a', args: 'two', timestamp: 3 },
        { skill: 'a', args: 'two', timestamp: 2 },
        { skill: 'model', timestamp: 5 },
      ],
      new Set(['a']),
    );
    assert.deepEqual([...usage.keys()], ['a']);
    assert.deepEqual(usage.get('a'), { count: 3, lastUsed: 3, recentArgs: ['two', 'one'] });
  });

  it('collects from the workspace folder and its sub-folders, skipping old files', async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'usage-'));
    const workspace = '/work/app';
    const now = Date.now();
    const line = (name: string, t: number) =>
      JSON.stringify({ type: 'user', timestamp: new Date(t).toISOString(), message: { content: `<command-name>/${name}</command-name>` } });
    await fs.mkdir(path.join(tmp, '-work-app'));
    await fs.mkdir(path.join(tmp, '-work-app-sub'));
    await fs.mkdir(path.join(tmp, '-work-other'));
    await fs.writeFile(path.join(tmp, '-work-app/s1.jsonl'), `${line('a', now)}\n${line('a', now - 90 * 86400000)}\n`);
    await fs.writeFile(path.join(tmp, '-work-app-sub/s2.jsonl'), `${line('b', now)}\n`);
    await fs.writeFile(path.join(tmp, '-work-other/s3.jsonl'), `${line('c', now)}\n`);

    const events = await new UsageReader(tmp).collect([workspace], now - 30 * 86400000);
    assert.deepEqual(events.map((e) => e.skill).sort(), ['a', 'b']);
    await fs.rm(tmp, { recursive: true, force: true });
  });
});

describe('suggest', () => {
  const skills = [
    skill('run-unit-test', 'Run the unit tests for a file and show coverage.'),
    skill('create-commit', 'Stage changes and create a commit following project conventions.'),
    skill('swift-ios-build-run', 'Build and run the iOS app with Xcode.'),
    skill('write-blog-post', 'Write a markdown blog post.'),
    skill('spec-implement', 'Implement the tasks of a ticket spec, phase by phase.'),
  ];

  it('suggests test skills when a spec file is open', () => {
    const result = suggest(skills, { relativeFile: 'src/app/home.page.spec.ts', dirtyCount: 0 }, new Map(), [], [], 5);
    assert.equal(result[0].skill.id, 'run-unit-test');
    assert.ok(result[0].reasons.includes('editing a test file'));
  });

  it('suggests commit skills when there are uncommitted changes', () => {
    const result = suggest(skills, { dirtyCount: 3, branch: 'main' }, new Map(), [], [], 5);
    assert.deepEqual(result.map((r) => r.skill.id), ['create-commit']);
    assert.match(result[0].reasons[0], /3 uncommitted changes/);
  });

  it('uses file type and ticket branches', () => {
    const swift = suggest(skills, { relativeFile: 'ios/App/Login.swift', dirtyCount: 0 }, new Map(), [], [], 5);
    assert.equal(swift[0].skill.id, 'swift-ios-build-run');
    const ticket = suggest(skills, { branch: 'feat/ABC-123-login', dirtyCount: 0 }, new Map(), [], [], 5);
    assert.equal(ticket[0].skill.id, 'spec-implement');
  });

  it('returns nothing on a clean default branch with no file open', () => {
    assert.deepEqual(suggest(skills, { branch: 'main', dirtyCount: 0 }, new Map(), [], [], 5), []);
  });

  it('puts pinned skills and matching rules first', () => {
    const result = suggest(
      skills,
      { relativeFile: 'docs/a.md', dirtyCount: 0 },
      new Map(),
      [{ fileGlob: '**/*.md', skills: ['create-commit'], reason: 'docs edit' }],
      ['spec-implement'],
      5,
    );
    assert.deepEqual(result.slice(0, 3).map((r) => r.skill.id), ['spec-implement', 'create-commit', 'write-blog-post']);
    assert.ok(result[1].reasons.includes('docs edit'));
  });

  it('uses frequency to order equally relevant skills, without overriding the open file', () => {
    const pool = [...skills, skill('commit-and-push', 'Create a commit and push it.')];
    const usage = new Map([['commit-and-push', { count: 40, lastUsed: 1, recentArgs: [] }]]);
    const dirty = suggest(pool, { dirtyCount: 2 }, usage, [], [], 5);
    assert.deepEqual(dirty.map((r) => r.skill.id), ['commit-and-push', 'create-commit']);
    const testFile = suggest(pool, { relativeFile: 'src/a.spec.ts', dirtyCount: 2 }, usage, [], [], 5);
    assert.equal(testFile[0].skill.id, 'run-unit-test');
  });
});

describe('rules and globs', () => {
  it('matches globs', () => {
    assert.ok(globToRegExp('**/*.spec.ts').test('src/a/b.spec.ts'));
    assert.ok(globToRegExp('*.spec.ts').test('src/a/b.spec.ts'));
    assert.ok(globToRegExp('src/**/*.{ts,js}').test('src/x.js'));
    assert.ok(!globToRegExp('src/*.ts').test('src/a/x.ts'));
  });

  it('requires every given condition', () => {
    const rule = { skills: ['x'], fileGlob: '*.ts', branch: '^feat/', dirty: true };
    assert.ok(ruleMatches(rule, { relativeFile: 'a.ts', branch: 'feat/x', dirtyCount: 1 }));
    assert.ok(!ruleMatches(rule, { relativeFile: 'a.ts', branch: 'feat/x', dirtyCount: 0 }));
    assert.ok(!ruleMatches(rule, { relativeFile: 'a.ts', branch: 'fix/x', dirtyCount: 1 }));
    assert.ok(!ruleMatches({ skills: ['x'], branch: '([' }, { branch: 'x', dirtyCount: 0 }));
  });

  it('derives no path signal from generic folder names', () => {
    const signals = contextSignals({ relativeFile: 'src/app/index.ts', dirtyCount: 0 });
    assert.deepEqual(signals, []);
  });
});

describe('parseFoundSkills', () => {
  it('extracts known skills from a JSON answer wrapped in prose', () => {
    const answer = 'Sure:\n[{"skill":"/run-unit-test","args":"a","why":"tests"},{"skill":"made-up","args":"","why":""}]';
    assert.deepEqual(parseFoundSkills(answer, new Set(['run-unit-test'])), [{ skill: 'run-unit-test', args: 'a', why: 'tests' }]);
  });

  it('returns [] for unparseable answers', () => {
    assert.deepEqual(parseFoundSkills('no idea', new Set()), []);
  });
});
