import { join } from 'node:path'

/**
 * Path for a run's transcript: `<workspace>/loop/<assistant>-<stamp>.log`.
 *
 * The ISO timestamp is reduced to second resolution and made filesystem-safe so
 * transcripts sort chronologically and survive on any filesystem:
 * `2026-06-24T00:17:39.123Z` -> `2026-06-24T00-17-39`.
 */
export function runLogPath({
	workspace,
	assistant,
	timestamp,
}: {
	workspace: string
	assistant: string
	timestamp: string
}): string {
	const stamp = timestamp.replace(/\..*$/, '').replace(/:/g, '-')
	return join(workspace, 'loop', `${assistant}-${stamp}.log`)
}
