import { claudeAdapter } from './adapters/claude'
import { codexAdapter } from './adapters/codex'
import { assemblePrompt } from './prompt'
import type { AgentAdapter, AgentResult, Assistant, RunOptions } from './types'

const adapters: Record<Assistant, AgentAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
}

/**
 * Upper bound on drain iterations — a coarse backstop against a run that keeps
 * clearing tasks but never empties the board.
 */
export const DRAIN_SAFETY_CAP = 25

/**
 * Stop draining after this many consecutive iterations that clear no task. A
 * task the agent can't finish gets claimed (In Progress) or parked (Blocked) and
 * thus leaves the To Do set, so the count drops — if it does NOT drop, the agent
 * is stuck on the same task and we'd just burn tokens retrying it.
 */
export const DRAIN_STALL_LIMIT = 2

/**
 * IO the run loop needs, injected so the orchestration is unit-testable without
 * spawning real agents, touching the filesystem, or pushing to a remote.
 */
export interface RunDeps {
	/** Read the base prompt for this assistant + role. */
	readPrompt(): Promise<string>
	/** Spawn the agent, pipe `prompt` to stdin, resolve with captured stdout. */
	spawnAgent(bin: string, argv: string[], prompt: string): Promise<string>
	/** Push the work branch; resolve true on success. */
	push(): Promise<boolean>
	/** Number of ready (To Do) tasks on the board — drives drain + stall detection. */
	readyCount(): Promise<number>
	/** Progress logging. */
	log(line: string): void
}

export interface IterationOutcome {
	iteration: number
	result: AgentResult
	pushed: boolean
}

/**
 * Run an agent session: assemble the prompt (+ optional task directive), build the
 * adapter argv, then run iterations — a fixed `iterations` count, or, in drain
 * mode, until the board's To Do set is empty (stopping early on a stall or the
 * safety cap). Each iteration spawns the agent, interprets its output, and pushes
 * on success.
 */
export async function runLoop(
	opts: RunOptions,
	deps: RunDeps,
): Promise<IterationOutcome[]> {
	const adapter = adapters[opts.assistant]
	const prompt = assemblePrompt(await deps.readPrompt(), opts.task)
	const argv = adapter.buildArgv(opts)
	const outcomes: IterationOutcome[] = []

	const runOne = async (label: string): Promise<AgentResult> => {
		deps.log(`=== iteration ${label} ===`)
		const stdout = await deps.spawnAgent(adapter.bin, argv, prompt)
		const result = adapter.parseResult(stdout)
		let pushed = false
		if (result.ok && !opts.noPush) pushed = await deps.push()
		outcomes.push({ iteration: outcomes.length + 1, result, pushed })
		return result
	}

	if (opts.drain) {
		let ran = 0
		let stall = 0
		let reason: 'empty' | 'auth' | 'cap' | 'stalled' = 'cap'
		while (ran < DRAIN_SAFETY_CAP) {
			const before = await deps.readyCount()
			if (before === 0) {
				reason = 'empty'
				break
			}
			ran += 1
			const result = await runOne(`${ran} (drain)`)
			if (result.authFailed) {
				reason = 'auth'
				break
			}
			const after = await deps.readyCount()
			if (after >= before) {
				stall += 1
				if (stall >= DRAIN_STALL_LIMIT) {
					reason = 'stalled'
					break
				}
			} else {
				stall = 0
			}
		}
		if (reason === 'empty')
			deps.log('board has no ready tasks — drain complete')
		else if (reason === 'auth') deps.log('authentication failed — stopping')
		else if (reason === 'stalled')
			deps.log(
				`drain stalled: ${DRAIN_STALL_LIMIT} iterations cleared no task — ` +
					'stopping (a task the agent could not complete; left for review)',
			)
		else
			deps.log(
				`drain safety cap (${DRAIN_SAFETY_CAP}) reached — ` +
					'board may still have ready work',
			)
		return outcomes
	}

	for (let i = 1; i <= opts.iterations; i++) {
		const result = await runOne(`${i}/${opts.iterations}`)
		if (result.authFailed) {
			deps.log('authentication failed — stopping')
			break
		}
	}
	return outcomes
}
