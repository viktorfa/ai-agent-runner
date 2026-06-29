/**
 * git args to publish the runner-owned work branch (e.g. auto/work).
 *
 * Uses --force-with-lease so a between-runs reset of the branch lands cleanly
 * instead of being rejected as non-fast-forward, while still refusing to clobber
 * changes the runner hasn't seen (the lease).
 */
export function workBranchPushArgs(branch: string): string[] {
	return ['push', '--force-with-lease', 'origin', `HEAD:${branch}`]
}

/** Publish a local fast-forwarded base branch without force. */
export function baseBranchPushArgs(branch: string): string[] {
	return ['push', 'origin', `HEAD:${branch}`]
}

/** Fast-forward the local base branch to the published staging branch. */
export function promoteWorkBranchArgs(workBranch: string): string[] {
	return ['merge', '--ff-only', `origin/${workBranch}`]
}

/** Fetch the latest refs from origin. */
export function fetchArgs(): string[] {
	return ['fetch', 'origin']
}

/** Read a file's contents from a git ref without touching the working tree or index. */
export function showFileAtRefArgs(ref: string, path: string): string[] {
	return ['show', `${ref}:${path}`]
}

/**
 * Reset the work branch to the tip of the base branch (a clean per-run base).
 * `-f` discards any uncommitted changes in the staging checkout — it's runner-owned
 * scratch, so a half-finished integrate, stray board edit, or external tool touching
 * tracked files must not poison-pill the next drain. Real work lives on task branches
 * in separate worktrees, never here. Untracked files (e.g. transcripts) are left alone.
 */
export function resetWorkBranchArgs(
	workBranch: string,
	baseBranch: string,
): string[] {
	return ['checkout', '-f', '-B', workBranch, `origin/${baseBranch}`]
}

/** Count commits on the work branch not yet in the base branch (unmerged work). */
export function unmergedCountArgs(
	baseBranch: string,
	workBranch: string,
): string[] {
	return ['rev-list', '--count', `origin/${baseBranch}..origin/${workBranch}`]
}

/** Exit 0 (prints sha) if origin/<branch> exists, else non-zero — for accumulate. */
export function remoteBranchExistsArgs(branch: string): string[] {
	return ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${branch}`]
}

/** Merge origin/<base> into the current branch (accumulate: absorb new tickets). */
export function mergeBaseArgs(baseBranch: string): string[] {
	return ['merge', '--no-edit', `origin/${baseBranch}`]
}

/** Abort an in-progress merge (used when accumulate hits a conflict). */
export function mergeAbortArgs(): string[] {
	return ['merge', '--abort']
}

/** Branch for an isolated single-task run (one task → one branch → one diff). */
export function taskBranch(taskId: string): string {
	return `auto/${taskId.toLowerCase()}`
}

/**
 * Add a worktree at `path` on a fresh `branch` cut from `baseRef`. `-B` resets the
 * branch if it already exists, so a re-dispatch starts clean. `baseRef` is a full ref:
 * the local staging branch `auto/work` (so the agent gets the accumulated board + code),
 * not necessarily `origin/<base>`.
 */
export function worktreeAddArgs(
	path: string,
	branch: string,
	baseRef: string,
): string[] {
	return ['worktree', 'add', '-B', branch, path, baseRef]
}

/** Remove a worktree, discarding its working tree (the branch it built persists). */
export function worktreeRemoveArgs(path: string): string[] {
	return ['worktree', 'remove', '--force', path]
}

/** Drop worktree bookkeeping for directories that no longer exist (post-crash hygiene). */
export function worktreePruneArgs(): string[] {
	return ['worktree', 'prune']
}

/** The current HEAD commit sha — snapshot it before a merge so it can be rolled back to. */
export function headShaArgs(): string[] {
	return ['rev-parse', 'HEAD']
}

/**
 * Merge a task branch into the current (staging) branch. `--no-ff` forces a merge
 * commit even for a fast-forward, so each task lands as one distinct, individually
 * rollback-able step; `--no-edit` keeps it non-interactive.
 */
export function mergeTaskBranchArgs(branch: string): string[] {
	return ['merge', '--no-edit', '--no-ff', branch]
}

/** Hard-reset the current branch to a sha (undo a merge whose combined gates went red). */
export function resetHardArgs(sha: string): string[] {
	return ['reset', '--hard', sha]
}

/** Count commits on each side of two remote branches. */
export function remoteAheadBehindArgs(
	leftBranch: string,
	rightBranch: string,
): string[] {
	return [
		'rev-list',
		'--left-right',
		'--count',
		`origin/${leftBranch}...origin/${rightBranch}`,
	]
}

/** Summarize files changed between two remote branches. */
export function remoteDiffStatArgs(
	baseBranch: string,
	workBranch: string,
): string[] {
	return ['diff', '--stat', `origin/${baseBranch}..origin/${workBranch}`]
}
