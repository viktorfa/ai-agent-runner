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
