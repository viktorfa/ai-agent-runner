import { describe, expect, it } from 'vitest'
import { workBranchPushArgs } from './git'

describe('workBranchPushArgs', () => {
	it('force-with-leases the current HEAD to the named origin branch', () => {
		expect(workBranchPushArgs('auto/work')).toEqual([
			'push',
			'--force-with-lease',
			'origin',
			'HEAD:auto/work',
		])
	})
})
