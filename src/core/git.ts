import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

/** Resolves the real git dir, following the `gitdir:` pointer used by worktrees and submodules. */
export async function findGitDir(root: string): Promise<string | undefined> {
  const dotGit = path.join(root, '.git');
  try {
    const stat = await fs.stat(dotGit);
    if (stat.isDirectory()) {
      return dotGit;
    }
    const pointer = /^gitdir:\s*(.+)$/m.exec(await fs.readFile(dotGit, 'utf8'));
    return pointer ? path.resolve(root, pointer[1].trim()) : undefined;
  } catch {
    return undefined;
  }
}

export async function readBranch(root: string): Promise<string | undefined> {
  const gitDir = await findGitDir(root);
  if (!gitDir) {
    return undefined;
  }
  try {
    const head = (await fs.readFile(path.join(gitDir, 'HEAD'), 'utf8')).trim();
    const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return ref ? ref[1] : undefined;
  } catch {
    return undefined;
  }
}

export function gitStatus(root: string): Promise<string[]> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain'], { cwd: root, timeout: 5000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      resolve(error ? [] : stdout.split('\n').filter(Boolean));
    });
  });
}
