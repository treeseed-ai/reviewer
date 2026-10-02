import {afterEach,expect,it} from 'vitest';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {ownerTestCommand} from '../../../src/verifiers/guarantees/prerequisites.ts';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture() {
	const root=mkdtempSync(resolve(tmpdir(),'exunit-entrypoint-'));roots.push(root);return root;
}

it('resolves one complete native Elixir entrypoint from the existing owner verification declaration',()=>{
	const root=fixture();writeFileSync(resolve(root,'treeseed.package.yaml'),'verify: {local: scripts/verify.exs}\n');
	expect(ownerTestCommand(root)).toBe('elixir scripts/verify.exs');
});

it('rejects missing malformed filtered and shell native declarations without borrowing an npm identity',()=>{
	const root=fixture();
	for(const value of ['{}','verify: null','verify: {local: null}','verify: {local: [verify.exs]}',
		'verify: {local: verify.sh}','verify: {local: "verify.exs --only selected"}',
		'verify: {local: "elixir verify.exs"}','verify: {local: "verify.exs && true"}',
		'verify: {local: /tmp/verify.exs}','verify: {local: -verify.exs}']) {
		writeFileSync(resolve(root,'treeseed.package.yaml'),value);
		expect(()=>ownerTestCommand(root),value).toThrow();
	}
	writeFileSync(resolve(root,'treeseed.package.yaml'),'verify: {local: verify.exs}\n');
	writeFileSync(resolve(root,'package.json'),JSON.stringify({scripts:{}}));
	expect(()=>ownerTestCommand(root)).toThrow();
});
