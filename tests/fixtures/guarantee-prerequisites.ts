import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { expect } from 'vitest';
import ts from 'typescript';

/** Offline native npm collision: version one must remain under its owning package. */
export function productionDependencyArchives(root:string, pack:(args:string[])=>{status:number|null;stdout:string;stderr:string}) {
	const sources:string[]=[];
	for(const name of ['native-transitive','native-external']) for(const version of ['1.0.0','2.0.0']) {
		const source=resolve(root,`${name}-${version}`);mkdirSync(source,{recursive:true});sources.push(source);
		const external=name==='native-external';
		writeFileSync(resolve(source,'package.json'),JSON.stringify({name,version,files:['value.json','index.mjs'],
			exports:external?'./index.mjs':'./value.json',...(external?{dependencies:{'native-transitive':`file:${resolve(root,`native-transitive-${version}.tgz`)}`}}:{})}));
		writeFileSync(resolve(source,'value.json'),JSON.stringify({version:Number(version[0])}));
		if(external)writeFileSync(resolve(source,'index.mjs'),ts.transpileModule(
			"import data from 'native-transitive' with {type:'json'};export const value:number=data.version;",
			{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText);
	}
	const packed=pack(['pack',...sources,'--ignore-scripts','--json','--pack-destination',root]);expect(packed.status,packed.stderr).toBe(0);
	const records=JSON.parse(packed.stdout) as {name:string;version:string;filename:string}[];expect(records).toHaveLength(4);
	const archive=(name:string,version:string)=>{const matches=records.filter(record=>record.name===name&&record.version===version);
		expect(matches).toHaveLength(1);return resolve(root,matches[0]!.filename);};
	return {dependency:`file:${archive('native-external','1.0.0')}`,
		rootDependencies:{'native-external':`file:${archive('native-external','2.0.0')}`,'native-transitive':`file:${archive('native-transitive','2.0.0')}`}};
}

// Same native fixture; callers retain ownership of every allocated root and cleanup.
export const roots: string[] = [];
export const productionInstallFlags = ['--omit=dev','--ignore-scripts','--package-lock=false','--no-save','--no-audit','--no-fund','--prefer-offline'] as const;
export function fixture(failing = false, skipped = false) {
	const root = mkdtempSync(resolve(tmpdir(), 'guarantee-full-suite-')); roots.push(root);
	for (const directory of ['tests', 'guarantees', '.treeseed', 'node_modules']) mkdirSync(resolve(root, directory), { recursive: true });
	symlinkSync(resolve(import.meta.dirname, '../../node_modules/vitest'), resolve(root, 'node_modules/vitest'));
	writeFileSync(resolve(root, 'package.json'), JSON.stringify({ type: 'module', scripts: { test: 'vitest run --config vitest.config.ts' } }));
	writeFileSync(resolve(root, 'vitest.config.ts'), 'export default {test:{include:["tests/**/*.test.ts"]}};');
	writeFileSync(resolve(root, '.gitignore'), 'node_modules\n.treeseed\n');
	writeFileSync(resolve(root, 'tests/unit.test.ts'), `import {it,expect} from 'vitest'; import {appendFileSync} from 'node:fs'; it('unit boundary',()=>{appendFileSync('.treeseed/order','unit\\n');expect(${failing}).toBe(false);});`);
	writeFileSync(resolve(root, 'tests/integration.test.ts'), `import {it,expect} from 'vitest'; import {appendFileSync} from 'node:fs'; it${skipped ? '.skip' : ''}('integration boundary',()=>{appendFileSync('.treeseed/order','integration\\n');expect(1).toBe(1);});`);
	writeFileSync(resolve(root, 'scene.ts'), "import test from 'node:test'; import {appendFileSync} from 'node:fs'; test('scene boundary',()=>{appendFileSync('.treeseed/order','scene\\n');});");
	writeFileSync(resolve(root, 'guarantees/proof.guarantee.yaml'), 'id: proof\napi: {verifierRefs: [proof.scene]}\n');
	writeFileSync(resolve(root, 'guarantees/proof.verifiers.yaml'), 'verifiers:\n  proof.scene: {kind: nodeTestCase, ownerPackage: fixture, testFile: scene.ts, testName: scene boundary}\n');
	for (const args of [['init', '-q'], ['add', '.'], ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-qm', 'Exact test candidate']]) {
		const stage=args.includes('commit')?'COMMIT':args[0]!.toUpperCase();
		expect(spawnSync('git', args, { cwd: root }).status,`ACCEPTANCE_PREREQUISITE_GIT_${stage}: exact fixture Git stage`).toBe(0);
	}
	return root;
}
