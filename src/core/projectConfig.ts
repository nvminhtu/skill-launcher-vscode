import * as fs from 'fs/promises';
import * as path from 'path';
import type { SuggestionRule } from './suggest';

/**
 * Optional team-shareable file: `<workspace>/.claude/skill-launcher.json`
 * { "pinned": ["spec-implement"], "rules": [{ "fileGlob": "**\/*.spec.ts", "skills": ["run-unit-test"] }] }
 */
export interface ProjectConfig {
  pinned: string[];
  rules: SuggestionRule[];
}

export const PROJECT_CONFIG_PATH = path.join('.claude', 'skill-launcher.json');

export async function readProjectConfig(root: string): Promise<ProjectConfig> {
  try {
    const json = JSON.parse(await fs.readFile(path.join(root, PROJECT_CONFIG_PATH), 'utf8'));
    return {
      pinned: Array.isArray(json.pinned) ? json.pinned.filter((p: unknown) => typeof p === 'string') : [],
      rules: Array.isArray(json.rules) ? json.rules.filter(isRule) : [],
    };
  } catch {
    return { pinned: [], rules: [] };
  }
}

export function isRule(value: unknown): value is SuggestionRule {
  return !!value && typeof value === 'object' && Array.isArray((value as SuggestionRule).skills);
}

export const PROJECT_CONFIG_TEMPLATE = `{
  "$comment": "Skill Launcher for Claude Code — suggestion rules shared with everyone who opens this repo.",
  "pinned": [],
  "rules": [
    {
      "fileGlob": "**/*.{spec,test}.{ts,js}",
      "skills": ["run-unit-test"],
      "reason": "Editing a test file"
    },
    {
      "branch": "^(feat|fix)/[A-Z]+-\\\\d+",
      "dirty": true,
      "skills": ["create-commit"],
      "reason": "Ticket branch with uncommitted work"
    }
  ]
}
`;
