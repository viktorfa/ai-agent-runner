import { describe, expect, it, vi } from 'vitest'
import { defaultConfig } from './config'
import {
	discardStaging,
	promoteStaging,
	type StagingDeps,
	statusStaging,
} from './staging'

function makeDeps(
	overrides: Record<
		string,
		{ code: number; stdout?: string; stderr?: string }
	> = {},
) {
	const calls: string[] = []
	const deps: StagingDeps = {
		git: vi.fn(async (args: string[]) => {
			const key = args.join(' ')
			calls.push(key)
			return { stdout: '', stderr: '', ...(overrides[key] ?? { code: 0 }) }
		}),
		log: vi.fn(),
	}
	return { deps, calls }
}

describe('statusStaging', () => {
	it('reports absent staging without diffing', async () => {
		const { deps, calls } = makeDeps({
			'rev-parse --verify --quiet refs/remotes/origin/auto/work': {
				code: 1,
			},
		})
		await expect(statusStaging(defaultConfig(), deps)).resolves.toEqual({
			exists: false,
			baseOnly: 0,
			stagingOnly: 0,
			diffStat: '',
		})
		expect(calls).toEqual([
			'fetch origin',
			'rev-parse --verify --quiet refs/remotes/origin/auto/work',
		])
	})

	it('reports ahead/behind and diffstat for staging', async () => {
		const { deps } = makeDeps({
			'rev-list --left-right --count origin/master...origin/auto/work': {
				code: 0,
				stdout: '1\t3\n',
			},
			'diff --stat origin/master..origin/auto/work': {
				code: 0,
				stdout: ' src/a.ts | 2 ++\n',
			},
		})
		await expect(statusStaging(defaultConfig(), deps)).resolves.toEqual({
			exists: true,
			baseOnly: 1,
			stagingOnly: 3,
			diffStat: 'src/a.ts | 2 ++',
		})
	})
})

describe('promoteStaging', () => {
	it('fast-forwards base to staging and pushes base without force', async () => {
		const { deps, calls } = makeDeps()
		await promoteStaging(defaultConfig(), deps)
		expect(calls).toEqual([
			'fetch origin',
			'rev-parse --verify --quiet refs/remotes/origin/auto/work',
			'checkout -f -B master origin/master',
			'merge --ff-only origin/auto/work',
			'push origin HEAD:master',
		])
	})

	it('refuses when staging does not exist', async () => {
		const { deps } = makeDeps({
			'rev-parse --verify --quiet refs/remotes/origin/auto/work': {
				code: 1,
			},
		})
		await expect(promoteStaging(defaultConfig(), deps)).rejects.toThrow(
			/origin\/auto\/work does not exist/,
		)
	})
})

describe('discardStaging', () => {
	it('resets staging to base and force-with-leases staging only', async () => {
		const { deps, calls } = makeDeps()
		await discardStaging(defaultConfig(), deps)
		expect(calls).toEqual([
			'fetch origin',
			'checkout -f -B auto/work origin/master',
			'push --force-with-lease origin HEAD:auto/work',
		])
	})
})
