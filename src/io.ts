import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import type { CliArgs } from './args'
import { resolvePromptPath } from './config'
import { workBranchPushArgs } from './git'
import type { RunDeps } from './run'

/** Spawn a command (optionally piping stdin); capture stdout while echoing it. */
function exec(
	cmd: string,
	args: string[],
	cwd: string,
	stdin?: string,
): Promise<{ code: number; stdout: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { cwd })
		let stdout = ''
		child.stdout?.on('data', (chunk: Buffer) => {
			const text = chunk.toString()
			stdout += text
			process.stdout.write(text)
		})
		child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk))
		child.on('error', reject)
		child.on('close', (code) => resolve({ code: code ?? 1, stdout }))
		if (stdin !== undefined) child.stdin?.end(stdin)
	})
}

/** Real IO for `runLoop`: read the prompt, spawn the agent, push the branch. */
export function makeDeps(args: CliArgs): RunDeps {
	const cwd = args.workspace
	return {
		readPrompt: () => readFile(resolvePromptPath(cwd, args.role), 'utf8'),

		spawnAgent: async (bin, argv, prompt) => {
			const { stdout } = await exec(bin, argv, cwd, prompt)
			return stdout
		},

		push: async () => {
			const head = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], cwd)
			const branch = head.stdout.trim()
			if (!branch || branch === 'HEAD') return false
			const { code } = await exec('git', workBranchPushArgs(branch), cwd)
			return code === 0
		},

		log: (line) => process.stderr.write(`${line}\n`),
	}
}
