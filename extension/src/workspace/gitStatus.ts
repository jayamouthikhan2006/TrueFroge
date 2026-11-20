import { execFile } from 'node:child_process';

/** `git status --porcelain` for the workspace, or undefined when it is not a git repository. */
export function gitStatus(root: string): Promise<string[] | undefined> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, windowsHide: true, timeout: 10_000 }, (error, stdout) => {
      if (error) {
        resolve(undefined);
        return;
      }
      resolve(
        stdout
          .split(/\r?\n/)
          .map((l) => l.trimEnd())
          .filter((l) => l.length > 0),
      );
    });
  });
}

/** Lines present in `after` but not in `before`: what a run changed in the working tree. */
export function statusDelta(before: string[], after: string[]): string[] {
  const prior = new Set(before);
  return after.filter((line) => !prior.has(line));
}
