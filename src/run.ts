import { claudeAdapter } from './adapters/claude'
import { codexAdapter } from './adapters/codex'
import { assemblePrompt } from './prompt'
import type { AgentAdapter, AgentResult, Assistant, RunOptions } from './types'

const adapters: Record<Assistant, AgentAdapter> = {
	claude: claudeAdapter,
	codex: codexAdapter,
}

/**
 * Upper bound on drain iterations — insurance against a run that keeps reporting
 * success while never clearing a task (which would otherwise loop forever).
 */
export const DRAIN_SAFETY_CAP = 25

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
	/** Whether the board still has a ready task to pick up (drain mode). */
	hasReadyWork(): Promise<boolean>
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
 * mode, until the board has no ready task left (bounded by DRAIN_SAFETY_CAP).
 * Each iteration spawns the agent, interprets its output, and pushes on success.
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
		let reason: 'empty' | 'auth' | 'cap' = 'cap'
		while (ran < DRAIN_SAFETY_CAP) {
			if (!(await deps.hasReadyWork())) {
				reason = 'empty'
				break
			}
			ran += 1
			const result = await runOne(`${ran} (drain)`)
			if (result.authFailed) {
				reason = 'auth'
				break
			}
		}
		if (reason === 'empty')
			deps.log('board has no ready tasks — drain complete')
		else if (reason === 'auth') deps.log('authentication failed — stopping')
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
