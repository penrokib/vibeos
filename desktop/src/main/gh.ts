// =============================================================================
// rokibrain.app — gh subprocess wrapper (M09)
// -----------------------------------------------------------------------------
// Spawns `gh` CLI for PR operations. NEVER exposed to renderer. All calls go
// through IPC from main process only. Resolves gh PATH via /opt/homebrew/bin
// or system which.
//
// Hard walls:
//   - NEVER auto-merge (requires explicit user action via merge button)
//   - NEVER expose child_process to renderer
//   - Stream stdout/stderr via IPC for debugging
// =============================================================================

import { spawn, type ChildProcess } from 'node:child_process';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';

/** Resolves gh binary PATH, trying Homebrew first, then system. */
async function resolveGhPath(): Promise<string> {
  const candidates = [
    '/opt/homebrew/bin/gh',
    '/usr/local/bin/gh',
    'gh', // fallback to PATH
  ];

  for (const path of candidates) {
    try {
      if (path === 'gh') return path; // Let spawn resolve from PATH
      await access(path, constants.X_OK);
      return path;
    } catch {
      continue;
    }
  }

  throw new Error('gh CLI not found. Install via: brew install gh');
}

export interface GhPr {
  number: number;
  title: string;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  url: string;
  author: string;
  headRefName: string;
  baseRefName: string;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  statusCheckRollup: 'SUCCESS' | 'PENDING' | 'FAILURE' | 'ERROR' | null;
  labels: Array<{ name: string }>;
  repository: string;
  isDraft: boolean;
}

export interface GhSpawnOptions {
  args: string[];
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}

/** Low-level gh spawn. Returns { code, stdout, stderr }. */
async function spawnGh(options: GhSpawnOptions): Promise<{
  code: number;
  stdout: string;
  stderr: string;
}> {
  const ghPath = await resolveGhPath();
  const proc: ChildProcess = spawn(ghPath, options.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GH_PAGER: '' }, // Disable pager for JSON output
  });

  let stdout = '';
  let stderr = '';

  if (proc.stdout) {
    proc.stdout.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf8');
      stdout += str;
      options.onStdout?.(str);
    });
  }

  if (proc.stderr) {
    proc.stderr.on('data', (chunk: Buffer) => {
      const str = chunk.toString('utf8');
      stderr += str;
      options.onStderr?.(str);
    });
  }

  return new Promise((resolve, reject) => {
    proc.on('error', reject);
    proc.on('close', (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}

/** Lists open PRs across both rokibrain repos. */
export async function listOpenPrs(options?: {
  onStdout?: (data: string) => void;
  onStderr?: (data: string) => void;
}): Promise<GhPr[]> {
  const repos = ['penrokib/rokibrain.com', 'penrokib/Roki'];
  const allPrs: GhPr[] = [];

  for (const repo of repos) {
    const { code, stdout, stderr } = await spawnGh({
      args: [
        'pr',
        'list',
        '--state',
        'open',
        '-R',
        repo,
        '--json',
        'number,title,state,url,author,headRefName,baseRefName,mergeable,statusCheckRollup,labels,isDraft',
      ],
      onStdout: options?.onStdout,
      onStderr: options?.onStderr,
    });

    if (code !== 0) {
      console.error(`[gh] pr list failed for ${repo}: ${stderr}`);
      continue;
    }

    try {
      const parsed = JSON.parse(stdout) as Array<Omit<GhPr, 'repository'>>;
      const withRepo = parsed.map((pr) => ({ ...pr, repository: repo }));
      allPrs.push(...withRepo);
    } catch (err) {
      console.error(`[gh] failed to parse JSON from ${repo}:`, err);
    }
  }

  return allPrs;
}

/** Fetches full PR details via `gh pr view <number> --json ...`. */
export async function viewPr(
  repo: string,
  prNumber: number,
  options?: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  }
): Promise<GhPr | null> {
  const { code, stdout, stderr } = await spawnGh({
    args: [
      'pr',
      'view',
      String(prNumber),
      '-R',
      repo,
      '--json',
      'number,title,state,url,author,headRefName,baseRefName,mergeable,statusCheckRollup,labels,isDraft',
    ],
    onStdout: options?.onStdout,
    onStderr: options?.onStderr,
  });

  if (code !== 0) {
    console.error(`[gh] pr view ${prNumber} failed: ${stderr}`);
    return null;
  }

  try {
    const parsed = JSON.parse(stdout) as Omit<GhPr, 'repository'>;
    return { ...parsed, repository: repo };
  } catch (err) {
    console.error(`[gh] failed to parse pr view JSON:`, err);
    return null;
  }
}

export interface MergeResult {
  success: boolean;
  message: string;
}

/** Merges a PR via `gh pr merge <number> --merge`. NEVER auto-merge. */
export async function mergePr(
  repo: string,
  prNumber: number,
  options?: {
    onStdout?: (data: string) => void;
    onStderr?: (data: string) => void;
  }
): Promise<MergeResult> {
  const { code, stdout, stderr } = await spawnGh({
    args: ['pr', 'merge', String(prNumber), '-R', repo, '--merge'],
    onStdout: options?.onStdout,
    onStderr: options?.onStderr,
  });

  if (code !== 0) {
    return {
      success: false,
      message: stderr || 'Merge failed with unknown error',
    };
  }

  return {
    success: true,
    message: stdout.trim() || 'PR merged successfully',
  };
}

/** Opens a Terminal at the worktree for manual rebase. macOS only for v1. */
export async function openShellAtWorktree(
  repo: string,
  prNumber: number
): Promise<void> {
  // Fetch worktree path from gh pr view
  const { stdout, code } = await spawnGh({
    args: ['pr', 'view', String(prNumber), '-R', repo, '--json', 'headRefName'],
  });

  if (code !== 0) {
    throw new Error('Failed to fetch PR branch name');
  }

  const parsed = JSON.parse(stdout) as { headRefName: string };
  const branch = parsed.headRefName;

  // Assume worktree pattern: ~/Projects/rokibrain.com-<branch>
  // This is a convention, not enforced by gh. User may need to adapt.
  const repoName = repo.split('/')[1] || 'unknown';
  const worktreePath = join(
    process.env.HOME || '~',
    'Projects',
    `${repoName}-${branch}`
  );

  // Open Terminal.app at worktree path (macOS only)
  if (process.platform === 'darwin') {
    const { spawn } = await import('node:child_process');
    spawn('open', ['-a', 'Terminal', worktreePath], { detached: true });
  } else {
    console.warn('[gh] openShellAtWorktree is macOS-only in v1');
  }
}
