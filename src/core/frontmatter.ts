/**
 * Minimal YAML front-matter reader for SKILL.md / command files.
 * Supports `key: value`, quoted values and block scalars (`>`, `>-`, `|`, `|-`).
 * Nested maps and lists are ignored — skills only need flat string fields.
 */
export interface ParsedDoc {
  data: Record<string, string>;
  body: string;
}

const BLOCK_INDICATOR = /^[>|][+-]?$/;

export function parseFrontmatter(text: string): ParsedDoc {
  const normalized = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { data: {}, body: normalized };
  }
  const end = normalized.indexOf('\n---', 4);
  if (end === -1) {
    return { data: {}, body: normalized };
  }
  const header = normalized.slice(4, end);
  const afterFence = normalized.indexOf('\n', end + 4);
  const body = afterFence === -1 ? '' : normalized.slice(afterFence + 1);

  const data: Record<string, string> = {};
  const lines = header.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i]);
    if (!match) {
      continue;
    }
    const key = match[1];
    let value = match[2].trim();

    if (BLOCK_INDICATOR.test(value) || value === '') {
      const folded = value.startsWith('>') || value === '';
      const collected: string[] = [];
      while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]) || lines[i + 1].trim() === '')) {
        i++;
        collected.push(lines[i].trim());
      }
      // A bare `key:` followed by a list/map is not a string field.
      if (value === '' && collected.some((l) => l.startsWith('- ') || /^[A-Za-z0-9_-]+:/.test(l))) {
        continue;
      }
      value = folded ? collected.filter(Boolean).join(' ') : collected.join('\n').trim();
    } else {
      value = unquote(value);
    }
    data[key] = value;
  }
  return { data, body };
}

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if (first === '"' && last === '"') {
      return value.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    if (first === "'" && last === "'") {
      return value.slice(1, -1).replace(/''/g, "'");
    }
  }
  return value;
}

export function isFalse(value: string | undefined): boolean {
  return value !== undefined && /^(false|no|off)$/i.test(value.trim());
}
