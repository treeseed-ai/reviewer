import { describe, expect, it } from 'vitest';
import { safeCliFailure } from '../../src/verifiers/guarantees/safe-cli-failure.ts';

describe('immutable golden CLI failure classification', () => {
	it('keeps a bounded command and code without retaining a dynamic discussion channel', () => {
		expect(safeCliFailure('ACCEPTANCE_CLI_COMMAND: workdays.show ETIMEDOUT')).toBe('workdays.show ETIMEDOUT');
		expect(safeCliFailure('ACCEPTANCE_CLI_COMMAND: send.sdk-golden-workday-private-channel identity_authentication_failed'))
			.toBe('send identity_authentication_failed');
	});
	it('rejects secret-bearing or malformed error text', () => {
		for (const message of ['ACCEPTANCE_CLI_COMMAND: workdays.show ETIMEDOUT token=secret',
			'ACCEPTANCE_CLI_COMMAND: workdays.show token:secret',
			'ACCEPTANCE_CLI_COMMAND: unknown.show ETIMEDOUT',
			'ACCEPTANCE_CLI_COMMAND: workdays.show ' + 'x'.repeat(81)]) {
			expect(safeCliFailure(message)).toBeNull();
		}
	});
});
