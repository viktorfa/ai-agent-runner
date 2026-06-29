import type { AgentConfig } from './config'
import {
	baseBranchPushArgs,
	fetchArgs,
	promoteWorkBranchArgs,
	remoteAheadBehindArgs,
	remoteBranchExistsArgs,
	remoteDiffStatArgs,
	resetWorkBranchArgs,
	workBranchPushArgs,
} from './git'

export interface StagingDeps {
	git(args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
	log(line: string): void
}

export interface StagingStatus {
	exists: boolean
	baseOnly: number
	stagingOnly: number
	diffStat: string
}

export async function statusStaging(
	config: AgentConfig,
	deps: StagingDeps,
): Promise<StagingStatus> {
	await deps.git(fetchArgs())
	const exists = await deps.git(remoteBranchExistsArgs(config.workBranch))
	if (exists.code !== 0) {
		const status = { exists: false, baseOnly: 0, stagingOnly: 0, diffStat: '' }
		deps.log(`staging ${config.workBranch}: absent`)
		return status
	}
	const aheadBehind = await deps.git(
		remoteAheadBehindArgs(config.baseBranch, config.workBranch),
	)
	if (aheadBehind.code !== 0) {
		throw new Error(
			`failed to compare origin/${config.baseBranch} and ` +
				`origin/${config.workBranch}: ${aheadBehind.stderr.trim() || '(none)'}`,
		)
	}
	const [baseOnlyText = '0', stagingOnlyText = '0'] = aheadBehind.stdout
		.trim()
		.split(/\s+/)
	const diff = await deps.git(
		remoteDiffStatArgs(config.baseBranch, config.workBranch),
	)
	if (diff.code !== 0) {
		throw new Error(
			`failed to diff origin/${config.baseBranch} and ` +
				`origin/${config.workBranch}: ${diff.stderr.trim() || '(none)'}`,
		)
	}
	const status = {
		exists: true,
		baseOnly: Number.parseInt(baseOnlyText, 10),
		stagingOnly: Number.parseInt(stagingOnlyText, 10),
		diffStat: diff.stdout.trim(),
	}
	deps.log(
		`staging ${config.workBranch}: ${status.stagingOnly} commit(s) ahead, ` +
			`${status.baseOnly} commit(s) behind ${config.baseBranch}`,
	)
	if (status.diffStat) deps.log(status.diffStat)
	return status
}

export async function promoteStaging(
	config: AgentConfig,
	deps: StagingDeps,
): Promise<void> {
	await deps.git(fetchArgs())
	const exists = await deps.git(remoteBranchExistsArgs(config.workBranch))
	if (exists.code !== 0) {
		throw new Error(`origin/${config.workBranch} does not exist`)
	}
	deps.log(
		`checking out ${config.baseBranch} from origin/${config.baseBranch}...`,
	)
	await mustGit(
		deps,
		resetWorkBranchArgs(config.baseBranch, config.baseBranch),
		`failed to check out ${config.baseBranch}`,
	)
	deps.log(
		`fast-forwarding ${config.baseBranch} to origin/${config.workBranch}...`,
	)
	await mustGit(
		deps,
		promoteWorkBranchArgs(config.workBranch),
		`origin/${config.workBranch} is not a fast-forward of ` +
			`origin/${config.baseBranch}`,
	)
	deps.log(`pushing ${config.baseBranch}...`)
	await mustGit(
		deps,
		baseBranchPushArgs(config.baseBranch),
		`failed to push ${config.baseBranch}`,
	)
}

export async function discardStaging(
	config: AgentConfig,
	deps: StagingDeps,
): Promise<void> {
	await deps.git(fetchArgs())
	deps.log(`resetting ${config.workBranch} to origin/${config.baseBranch}...`)
	await mustGit(
		deps,
		resetWorkBranchArgs(config.workBranch, config.baseBranch),
		`failed to reset ${config.workBranch}`,
	)
	deps.log(`pushing reset ${config.workBranch}...`)
	await mustGit(
		deps,
		workBranchPushArgs(config.workBranch),
		`failed to push reset ${config.workBranch}`,
	)
}

async function mustGit(
	deps: StagingDeps,
	args: string[],
	message: string,
): Promise<void> {
	const { code, stderr } = await deps.git(args)
	if (code !== 0) {
		throw new Error(`${message}: ${stderr.trim() || '(none)'}`)
	}
}
