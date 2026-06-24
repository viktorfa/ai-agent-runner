import type { AgentConfig } from './config'
import { fetchArgs, resetWorkBranchArgs, unmergedCountArgs } from './git'
import { type IterationOutcome, type RunDeps, runLoop } from './run'
import type { RunOptions } from './types'

/** IO `orchestrate` needs on top of the run loop. */
export interface OrchestrateDeps extends RunDeps {
	/** Run a git subcommand in the workspace. */
	git(args: string[]): Promise<{ code: number; stdout: string }>
	/** Run the workspace setup hook (pnpm install, skillshare sync). */
	runSetup(): Promise<void>
}

/**
 * Prepare a fresh run, then execute it: fetch origin, reset the work branch to
 * the base (so each run is a clean diff vs base), run setup, then the loop.
 *
 * Refuses to discard unmerged work on the work branch unless `force` — cheap
 * insurance against blowing away a run you forgot to review.
 */
export async function orchestrate(
	opts: RunOptions,
	config: AgentConfig,
	deps: OrchestrateDeps,
	force = false,
): Promise<IterationOutcome[]> {
	deps.log(`fetching origin (${config.baseBranch})...`)
	await deps.git(fetchArgs())

	if (!force) {
		const seen = await deps.git(
			unmergedCountArgs(config.baseBranch, config.workBranch),
		)
		const unmerged = Number.parseInt(seen.stdout.trim() || '0', 10)
		if (seen.code === 0 && unmerged > 0) {
			throw new Error(
				`origin/${config.workBranch} has ${unmerged} commit(s) not in ` +
					`origin/${config.baseBranch}. Review + merge them, or pass --force ` +
					'to discard and reset.',
			)
		}
	}

	deps.log(`resetting ${config.workBranch} to origin/${config.baseBranch}...`)
	await deps.git(resetWorkBranchArgs(config.workBranch, config.baseBranch))

	await deps.runSetup()
	return runLoop(opts, deps)
}
