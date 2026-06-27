import { spawn } from 'node:child_process'
import { createWriteStream, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { parseReadyTaskIds } from './board'
import { type AgentConfig, promptPath } from './config'
import { workBranchPushArgs } from './git'
import type { OrchestrateDeps } from './orchestrate'
import type { RunDeps } from './run'
import type { RunOptions } from './types'

/** Mirrors everything the run prints to a transcript file. */
export type Sink = (text: string) => void

interface ExecOpts {
	/** Tee captured output to the transcript. */
	sink?: Sink
	/** Pipe this to the child's stdin. */
	stdin?: string
	/** Capture only — don't echo to this process's stdout/stderr or the sink. */
	quiet?: boolean
}

/** Spawn a command; capture stdout while (unless quiet) echoing + teeing it. */
function exec(
	cmd: string,
	args: string[],
	cwd: string,
	{ sink, stdin, quiet }: ExecOpts = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd })
		let stdout = ''
		let stderr = ''
		child.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString()
			stdout += text
			if (!quiet) {
				process.stdout.write(text)
				sink?.(text)
			}
		})
		child.stderr?.on('data', (chunk: Buffer) => {
			// Captured even when quiet, so a failed command can report why it failed.
			stderr += chunk.toString()
			if (!quiet) {
				process.stderr.write(chunk)
				sink?.(chunk.toString())
			}
		})
		child.on('error', reject)
		child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }))
		if (stdin !== undefined) child.stdin?.end(stdin)
	})
}

/**
 * Open an append-mode transcript file (creating its directory). The CLI owns the
 * lifecycle: pass `sink` into the dep factories, then `await close()` before exit
 * so buffered output is flushed.
 */
export function openSink(logFile: string): {
	sink: Sink
	close: () => Promise<void>
} {
	mkdirSync(dirname(logFile), { recursive: true })
	const stream = createWriteStream(logFile, { flags: 'a' })
	return {
		sink: (text) => {
			stream.write(text)
		},
		close: () => new Promise((resolve) => stream.end(resolve)),
	}
}

const BOARD_LIST = ['exec', 'backlog', 'task', 'list', '--plain']

/**
 * Ready (To Do) task ids on the Backlog board, top first. Throws if the board
 * command itself fails — a non-zero exit must not be coerced into "0 ready",
 * which would make a tooling failure (e.g. pnpm/corepack breakage) look like an
 * empty queue and silently idle the loop.
 */
async function readReadyTaskIds(cwd: string): Promise<string[]> {
	const { code, stdout, stderr } = await exec('pnpm', BOARD_LIST, cwd, {
		quiet: true,
	})
	if (code !== 0) {
		throw new Error(
			`board read failed: \`pnpm ${BOARD_LIST.join(' ')}\` exited ${code} — ` +
				'cannot distinguish ready work from an empty queue. ' +
				`stderr: ${stderr.trim() || '(none)'}`,
		)
	}
	return parseReadyTaskIds(stdout)
}

/** Count the To Do tasks on the board (the agent's ready work). */
async function readyCount(cwd: string): Promise<number> {
	return (await readReadyTaskIds(cwd)).length
}

/**
 * Park the top ready task as Blocked so a drain that keeps making no progress
 * surfaces the offending task for review instead of re-attempting it forever.
 * Returns the parked id, or null if the board has no ready task to park.
 */
async function parkStuckTask(
	cwd: string,
	note: string,
): Promise<string | null> {
	const [top] = await readReadyTaskIds(cwd)
	if (!top) return null
	const { code, stderr } = await exec(
		'pnpm',
		[
			'exec',
			'backlog',
			'task',
			'edit',
			top,
			'-s',
			'Blocked',
			'--comment',
			note,
		],
		cwd,
		{ quiet: true },
	)
	if (code !== 0) {
		throw new Error(
			`failed to park ${top}: backlog edit exited ${code} — ` +
				`${stderr.trim() || '(none)'}`,
		)
	}
	return top
}

/** Real IO for `runLoop`: read the prompt, spawn the agent, push the branch. */
export function makeDeps(
	opts: RunOptions,
	config: AgentConfig,
	sink?: Sink,
): RunDeps {
	const cwd = opts.workspace
	return {
		readPrompt: () => readFile(promptPath(cwd, config, opts.role), 'utf8'),

		spawnAgent: async (bin, argv, prompt) => {
			const { stdout } = await exec(bin, argv, cwd, { sink, stdin: prompt })
			return stdout
		},

		push: async () => {
			const head = await exec(
				'git',
				['rev-parse', '--abbrev-ref', 'HEAD'],
				cwd,
				{ sink },
			)
			const branch = head.stdout.trim()
			if (!branch || branch === 'HEAD') return false
			const { code } = await exec('git', workBranchPushArgs(branch), cwd, {
				sink,
			})
			return code === 0
		},

		readyCount: () => readyCount(cwd),

		parkStuckTask: (note) => parkStuckTask(cwd, note),

		log: (line) => {
			process.stderr.write(`${line}\n`)
			sink?.(`${line}\n`)
		},
	}
}

/** Real IO for `orchestrate`: the run deps plus git + the setup hook. */
export function makeOrchestrateDeps(
	opts: RunOptions,
	config: AgentConfig,
	sink?: Sink,
): OrchestrateDeps {
	const cwd = opts.workspace
	return {
		...makeDeps(opts, config, sink),
		git: (gitArgs) => exec('git', gitArgs, cwd, { sink }),
		runSetup: async () => {
			await exec('bash', [config.setup], cwd, { sink })
		},
	}
}
