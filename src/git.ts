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

/** Fetch the latest refs from origin. */
export function fetchArgs(): string[] {
	return ['fetch', 'origin']
}

/** Reset the work branch to the tip of the base branch (a clean per-run base). */
export function resetWorkBranchArgs(
	workBranch: string,
	baseBranch: string,
): string[] {
	return ['checkout', '-B', workBranch, `origin/${baseBranch}`]
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
 * Add a worktree at `path` checked out to a fresh `branch` based at origin/<base>.
 * `-B` resets the branch if it already exists, so a re-dispatch starts clean.
 */
export function worktreeAddArgs(
	path: string,
	branch: string,
	baseBranch: string,
): string[] {
	return ['worktree', 'add', '-B', branch, path, `origin/${baseBranch}`]
}

/** Remove a worktree, discarding its working tree (the branch it built persists). */
export function worktreeRemoveArgs(path: string): string[] {
	return ['worktree', 'remove', '--force', path]
}

/** Drop worktree bookkeeping for directories that no longer exist (post-crash hygiene). */
export function worktreePruneArgs(): string[] {
	return ['worktree', 'prune']
}
