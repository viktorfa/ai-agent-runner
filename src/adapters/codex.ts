import type { AgentAdapter, AgentResult, RunOptions } from '../types'

/** Last `agent_message` text in Codex's --json event stream, if any. */
function lastMessage(stdout: string): string | undefined {
	let summary: string | undefined
	for (const line of stdout.split('\n')) {
		if (!line.startsWith('{')) continue
		try {
			const obj = JSON.parse(line) as {
				type?: string
				item?: { type?: string; text?: string }
			}
			if (
				obj.type === 'item.completed' &&
				obj.item?.type === 'agent_message' &&
				typeof obj.item.text === 'string'
			) {
				summary = obj.item.text
			}
		} catch {
			// Codex interleaves plain ERROR lines — skip non-JSON.
		}
	}
	return summary
}

export const codexAdapter: AgentAdapter = {
	bin: 'codex',

	buildArgv(opts: RunOptions): string[] {
		const argv = [
			'-s',
			'danger-full-access',
			'-a',
			'never',
			'-c',
			'shell_environment_policy.inherit=all',
			'exec',
			'--json',
			'--dangerously-bypass-approvals-and-sandbox',
			// Use the real workspace, NOT a hardcoded /workspace — that path only
			// exists in the Docker backend and breaks the host backend.
			'-C',
			opts.workspace,
		]
		if (opts.model) argv.push('--model', opts.model)
		if (opts.effort) {
			argv.push('-c', `model_reasoning_effort="${opts.effort}"`)
		}
		return argv
	},

	parseResult(stdout: string): AgentResult {
		// Codex emits a final `turn.completed` on success.
		const ok = stdout.includes('"type":"turn.completed"')
		const summary = lastMessage(stdout)
		return summary ? { ok, summary } : { ok }
	},
}
