import { parseArgs } from './args'
import { makeDeps } from './io'
import { runLoop } from './run'

async function main(): Promise<void> {
	const [command, ...rest] = process.argv.slice(2)
	if (command !== 'run') {
		process.stderr.write('usage: agent-runner run [options]\n')
		process.exit(1)
	}

	const args = parseArgs(rest)

	// Route the agent (and its children) through the host egress proxy.
	if (args.proxy) {
		process.env.HTTPS_PROXY = args.proxy
		process.env.HTTP_PROXY = args.proxy
		process.env.https_proxy = args.proxy
		process.env.http_proxy = args.proxy
	}

	const outcomes = await runLoop(args, makeDeps(args))
	const ok = outcomes.every((o) => o.result.ok)
	process.stderr.write(
		`\nDone: ${outcomes.length} iteration(s), ${ok ? 'ok' : 'with failures'}.\n`,
	)
	process.exit(ok ? 0 : 1)
}

main().catch((err: unknown) => {
	process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
	process.exit(1)
})
