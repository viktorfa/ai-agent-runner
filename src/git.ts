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
