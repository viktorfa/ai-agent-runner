import type { AgentConfig } from './config'
import {
	fetchArgs,
	mergeAbortArgs,
	mergeBaseArgs,
	remoteBranchExistsArgs,
	resetWorkBranchArgs,
	unmergedCountArgs,
} from './git'
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
 * Prepare a fresh run, then execute it. The work branch is prepared per the
 * config's `workBranchMode`:
 *
 * - `reset` — reset the work branch to base (one clean diff per run), refusing to
 *   discard unmerged work unless `force`.
 * - `accumulate` — resume the long-lived work branch (creating it from base the
 *   first time) and merge base in to absorb newly-filed tickets. Work piles up
 *   across runs; you merge the branch to base periodically. `force` is unused.
 *
 * In drain mode, if the board has no ready task after preparing the branch, we
 * return immediately — so an idle watcher poll costs a fetch + count, not a setup
 * and an agent spawn.
 */
export async function orchestrate(
	opts: RunOptions,
	config: AgentConfig,
	deps: OrchestrateDeps,
	force = false,
): Promise<IterationOutcome[]> {
	deps.log(`fetching origin (${config.baseBranch})...`)
	await deps.git(fetchArgs())

	if (config.workBranchMode === 'accumulate') {
		const exists = await deps.git(remoteBranchExistsArgs(config.workBranch))
		const from = exists.code === 0 ? config.workBranch : config.baseBranch
		deps.log(`checking out ${config.workBranch} from origin/${from}...`)
		await deps.git(resetWorkBranchArgs(config.workBranch, from))
		deps.log(`merging origin/${config.baseBranch} into ${config.workBranch}...`)
		const merged = await deps.git(mergeBaseArgs(config.baseBranch))
		if (merged.code !== 0) {
			await deps.git(mergeAbortArgs())
			throw new Error(
				`${config.workBranch} conflicts with origin/${config.baseBranch}; ` +
					'resolve manually.',
			)
		}
	} else {
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
	}

	// Cheap idle poll: skip setup + the agent entirely when there's nothing to do.
	if (opts.drain && (await deps.readyCount()) === 0) {
		deps.log('no ready tasks — nothing to drain')
		return []
	}

	await deps.runSetup()
	return runLoop(opts, deps)
}
