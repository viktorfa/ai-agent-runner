import { claudeAdapter } from './adapters/claude'
import { codexAdapter } from './adapters/codex'
import { assemblePrompt } from './prompt'
import type { TaskMeta } from './task'
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
 * Stop the drain after this many consecutive iterations where the agent itself
 * failed (a crash or API/auth-adjacent error, not an unfinishable task). Unlike a
 * stall we do NOT park a task here — the fault is the agent or its environment, so
 * we stop and let the run exit non-zero rather than blame (and Block) good work.
 */
export const AGENT_FAILURE_LIMIT = 2

/**
 * IO the run loop needs, injected so the orchestration is unit-testable without
 * spawning real agents, touching the filesystem, or pushing to a remote.
 */
export interface RunDeps {
	/** Read the base prompt for this assistant + role. */
	readPrompt(): Promise<string>
	/** Read an assigned task's metadata (criteria/docs/…) for the brief; null if unavailable. */
	readTaskMeta(id: string): Promise<TaskMeta | null>
	/** Spawn the agent, pipe `prompt` to stdin, resolve with captured stdout. */
	spawnAgent(bin: string, argv: string[], prompt: string): Promise<string>
	/** Push the work branch; resolve true on success. */
	push(): Promise<boolean>
	/** Number of ready (To Do) tasks on the board — drives drain + stall detection. */
	readyCount(): Promise<number>
	/**
	 * Park the top ready task as Blocked (resolve its id, or null if none) so the
	 * drain can surface a task it cannot finish instead of re-attempting it forever.
	 */
	parkStuckTask(note: string): Promise<string | null>
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
	const base = await deps.readPrompt()
	const meta = opts.task ? await deps.readTaskMeta(opts.task) : null
	const prompt = assemblePrompt({ base, task: opts.task, meta })
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
		let unproductive = 0
		let agentFailures = 0
		let parked: string | null = null
		let reason: 'empty' | 'auth' | 'cap' | 'stalled' | 'agent-error' = 'cap'
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
			if (!result.ok) {
				// The agent itself failed (crash / API error), not the task. Don't
				// blame a task — retry a couple times, then stop so a broken agent or
				// outage surfaces (non-zero exit) instead of churning the board.
				agentFailures += 1
				if (agentFailures >= AGENT_FAILURE_LIMIT) {
					reason = 'agent-error'
					break
				}
				continue
			}
			agentFailures = 0
			const after = await deps.readyCount()
			if (after < before) {
				unproductive = 0
				continue
			}
			// Agent ran cleanly but cleared nothing: the top task resists completion.
			// After the stall limit, park it (Blocked) so it stops re-spinning across
			// drains, then stop this drain — the next poll resumes with it removed.
			unproductive += 1
			if (unproductive >= DRAIN_STALL_LIMIT) {
				parked = await deps.parkStuckTask(
					`Auto-parked by the drain: ${DRAIN_STALL_LIMIT} clean agent ` +
						'iterations made no progress on this task. Needs human review.',
				)
				reason = 'stalled'
				break
			}
		}
		if (reason === 'empty')
			deps.log('board has no ready tasks — drain complete')
		else if (reason === 'auth') deps.log('authentication failed — stopping')
		else if (reason === 'agent-error')
			deps.log(
				`agent failed ${AGENT_FAILURE_LIMIT} iteration(s) in a row — stopping ` +
					'(see transcript; the run exits non-zero)',
			)
		else if (reason === 'stalled')
			deps.log(
				parked
					? `drain stalled: ${DRAIN_STALL_LIMIT} iterations cleared no task — ` +
							`parked ${parked} (Blocked) for review, stopping`
					: `drain stalled: ${DRAIN_STALL_LIMIT} iterations cleared no task ` +
							'and none could be parked — stopping',
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
