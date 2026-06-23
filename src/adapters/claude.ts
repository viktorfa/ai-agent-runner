import type { AgentAdapter, AgentResult, RunOptions } from '../types'

/** Pull the final result text out of Claude's stream-json output, if present. */
function resultSummary(stdout: string): string | undefined {
	const lines = stdout.split('\n')
	for (let i = lines.length - 1; i >= 0; i--) {
		const line = lines[i]
		if (!line.includes('"type":"result"')) continue
		try {
			const obj = JSON.parse(line) as { result?: unknown }
			if (typeof obj.result === 'string') return obj.result
		} catch {
			// not valid JSON / not the line we want
		}
	}
	return undefined
}

export const claudeAdapter: AgentAdapter = {
	bin: 'claude',

	buildArgv(opts: RunOptions): string[] {
		const argv = [
			'-p',
			'--verbose',
			'--dangerously-skip-permissions',
			'--output-format=stream-json',
		]
		if (opts.model) argv.push('--model', opts.model)
		if (opts.effort) argv.push('--effort', opts.effort)
		return argv
	},

	parseResult(stdout: string): AgentResult {
		if (stdout.includes('"error":"authentication_failed"')) {
			return { ok: false, authFailed: true }
		}
		const summary = resultSummary(stdout)
		return summary ? { ok: true, summary } : { ok: true }
	},
}
