import { afterEach, expect, it } from 'vitest';
import { appendFileSync, cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { planLocalGuarantees, runLocalGuarantees } from '../../src/verifiers/guarantees/command.ts';
import { candidate, participatingOwners } from '../../src/verifiers/guarantees/prerequisites.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(failing = false, skipped = false) {
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

it('runs every owning unit and integration assertion before any scene and repeats suites for a fresh invocation', () => {
	const root = fixture(); const plan = planLocalGuarantees(root, ['proof']);
	for (const runId of ['first', 'second']) expect(runLocalGuarantees(root, plan, runId).ok).toBe(true);
	const order = readFileSync(resolve(root, '.treeseed/order'), 'utf8').trim().split('\n');
	expect(order).toHaveLength(6);
	for (const start of [0, 3]) {
		expect(order.slice(start, start + 2).sort()).toEqual(['integration', 'unit']);
		expect(order[start + 2]).toBe('scene');
	}
});

it('blocks native scene side effects when an unselected unit test fails', () => {
	const root = fixture(true); const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'unit-red');
	expect(report.ok).toBe(false);
	expect(readFileSync(resolve(root, '.treeseed/order'), 'utf8')).not.toContain('scene');
	expect(report.diagnostics).toBeDefined();
	expect(report.diagnostics!.map(item => item.message).join(' ')).toContain('prerequisite');
});

it('blocks acceptance when the complete integration suite contains a skipped assertion', () => {
	const root = fixture(false, true); const report = runLocalGuarantees(root, planLocalGuarantees(root, ['proof']), 'integration-skipped');
	expect(report.ok).toBe(false);
	expect(readFileSync(resolve(root, '.treeseed/order'), 'utf8')).not.toContain('scene');
});

it('does not execute prerequisites while planning and rejects a missing full test entrypoint before scenes', () => {
	const root = fixture(); const plan = planLocalGuarantees(root, ['proof']);
	expect(plan.ok).toBe(true); expect(existsSync(resolve(root, '.treeseed/order'))).toBe(false);
	writeFileSync(resolve(root, 'package.json'), JSON.stringify({ type: 'module', scripts: {} }));
	expect(runLocalGuarantees(root, plan, 'missing-suite').ok).toBe(false);
	expect(existsSync(resolve(root, '.treeseed/order'))).toBe(false);
});

it('rejects empty suites and filtered test entrypoints before native scene execution', () => {
	for (const mode of ['empty','filtered','unsupported']) {
		const root = fixture();
		if (mode === 'empty') writeFileSync(resolve(root,'vitest.config.ts'),'export default {test:{include:["missing/**/*.test.ts"]}};');
		else writeFileSync(resolve(root,'package.json'),JSON.stringify({scripts:{test:mode === 'filtered' ? 'vitest run tests/unit.test.ts' : 'node --test'}}));
		expect(runLocalGuarantees(root,planLocalGuarantees(root,['proof']),mode).ok).toBe(false);
		expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
	}
});

it('rejects a candidate mutation performed by a passing full suite and retains exact prerequisite custody', () => {
	const root = fixture();
	appendFileSync(resolve(root,'tests/unit.test.ts'),"\nimport {writeFileSync} from 'node:fs'; it('hidden candidate mutation',()=>{writeFileSync('candidate.ts','changed');});");
	const report = runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'mutation');
	expect(report.ok).toBe(false);
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
	const receipt = JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs/mutation',report.results[0]!.evidence[0]!), 'utf8'));
	expect(receipt).toMatchObject({passed:false,exitCode:0,checks:{total:3,passed:3,failed:0}});
	expect(receipt.commit).toMatch(/^[a-f0-9]{40}$/u); expect(receipt.sourceDigest).toMatch(/^[a-f0-9]{64}$/u);
});

it('deduplicates prerequisite suites across dependent guarantees only within the same invocation', () => {
	const root = fixture();
	writeFileSync(resolve(root,'guarantees/downstream.guarantee.yaml'),'id: downstream\ndependencies: {guarantees: [proof]}\napi: {verifierRefs: [proof.scene]}\n');
	const report = runLocalGuarantees(root,planLocalGuarantees(root,['downstream']),'dependency');
	expect(report.ok).toBe(true);
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\n').sort()).toEqual(['integration','scene','unit']);
	expect(report.results[0]!.evidence.at(-1)).toEqual(report.results[1]!.evidence.at(-1));
});

it('blocks every scene when a different participating owner has failing prerequisites', () => {
	const good = fixture(), bad = fixture(true);
	const plan = planLocalGuarantees(good,['proof']);
	plan.verifiers['other.scene'] = {...plan.verifiers['proof.scene']!, root:bad};
	plan.entries.push({...plan.entries[0]!,id:'other',verifierRefs:['other.scene']});
	const report = runLocalGuarantees(good,plan,'two-owners');
	expect(report.ok).toBe(false); expect(report.counts.blocked).toBe(2);
	for (const root of [good,bad]) expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
});

it('rejects an escaped test config and missing Git custody without scene side effects', () => {
	for (const mode of ['escaped','missing-git']) {
		const root = fixture();
		if (mode === 'missing-git') rmSync(resolve(root,'.git'),{recursive:true,force:true});
		else { const other = fixture(); symlinkSync(resolve(other,'vitest.config.ts'),resolve(root,'outside.config.ts'));
			writeFileSync(resolve(root,'package.json'),JSON.stringify({scripts:{test:'vitest run --config outside.config.ts'}})); }
		const stage=mode==='escaped'?'ESCAPED':'MISSING_GIT';
		expect(runLocalGuarantees(root,planLocalGuarantees(root,['proof']),mode).ok,`ACCEPTANCE_PREREQUISITE_${stage}_DISPOSITION: custody must fail closed`).toBe(false);
		expect(existsSync(resolve(root,'.treeseed/order')),`ACCEPTANCE_PREREQUISITE_${stage}_SIDE_EFFECT: no suite side effect`).toBe(false);
	}
});

it('retains a real full-suite controlled failure stage without copying native failure prose',()=>{
	const root=fixture();
	appendFileSync(resolve(root,'tests/unit.test.ts'),"\nit('controlled failure',()=>{throw new Error('ACCEPTANCE_PREREQUISITE_FIXTURE: private native error');});\n");
	const report=runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'controlled-failure');
	expect(report.ok).toBe(false);
	const receipt=JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs/controlled-failure',report.results[0]!.evidence[0]!),'utf8'));
	expect(receipt.checks.failures).toEqual([{title:'controlled failure',status:'failed',criterion:'ACCEPTANCE_PREREQUISITE_FIXTURE'}]);
	expect(JSON.stringify(receipt)).not.toContain('private native error');
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
});

it('blocks all scenes when a later owner suite changes an earlier tested candidate', () => {
	for (const mode of ['tracked', 'untracked', 'head']) {
		const first = fixture(), second = fixture();
		const mutation = mode === 'head'
			? `spawnSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Moved'],{cwd:${JSON.stringify(first)}});`
			: `writeFileSync(${JSON.stringify(resolve(first, mode === 'tracked' ? 'tests/unit.test.ts' : 'hidden.ts'))},'changed');`;
		appendFileSync(resolve(second, 'tests/unit.test.ts'), `\nimport {writeFileSync} from 'node:fs'; import {spawnSync} from 'node:child_process'; it('cross-owner mutation',()=>{${mutation}});`);
		const plan = planLocalGuarantees(first, ['proof']);
		plan.verifiers['other.scene'] = {...plan.verifiers['proof.scene']!,root:second};
		plan.entries.push({...plan.entries[0]!,id:'other',verifierRefs:['other.scene']});
		const report = runLocalGuarantees(first,plan,`cross-${mode}`);
		expect(report.ok,mode).toBe(false); expect(report.counts.blocked).toBe(2);
		for (const root of [first,second]) expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
	}
});

it('rejects zero-exit scene candidate changes before another scene can execute', () => {
	for (const mode of ['tracked', 'untracked', 'deleted']) {
		const root = fixture();
		const mutation = mode === 'deleted' ? "rmSync('tests/unit.test.ts');" : `writeFileSync('${mode === 'tracked' ? 'tests/unit.test.ts' : 'hidden.ts'}','changed');`;
		writeFileSync(resolve(root,'scene.ts'), `import test from 'node:test'; import {writeFileSync,rmSync} from 'node:fs'; test('scene boundary',()=>{${mutation}}); test('next boundary',()=>{writeFileSync('.treeseed/next','ran');});`);
		const plan = planLocalGuarantees(root,['proof']);
		const binding = plan.verifiers['proof.scene']!;
		if (binding.definition.kind !== 'nodeTestCase') throw new Error('Fixture must bind a native Node case.');
		plan.verifiers['next.scene'] = {...binding,definition:{...binding.definition,testName:'next boundary'}};
		plan.entries[0]!.verifierRefs.push('next.scene');
		const report = runLocalGuarantees(root,plan,`scene-${mode}`);
		expect(report.ok,mode).toBe(false);
		expect(report.results[0]!.steps[0]!.status).toBe('failed');
		expect(report.results[0]!.steps[1]!.status).toBe('blocked');
		expect(existsSync(resolve(root,'.treeseed/next'))).toBe(false);
	}
});

it('retains passed suite receipts but fails a final scene that destroys Git custody', () => {
	const root = fixture();
	writeFileSync(resolve(root,'scene.ts'), "import test from 'node:test'; import {rmSync} from 'node:fs'; test('scene boundary',()=>{rmSync('.git',{recursive:true,force:true});});");
	const report = runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'lost-custody');
	expect(report.ok).toBe(false); expect(report.results[0]!.steps[0]!.status).toBe('failed');
	const receipt = JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs/lost-custody',report.results[0]!.evidence.at(-1)!), 'utf8'));
	expect(receipt).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0}});
});

function compositionFixture(failing = false) {
	const owner = fixture(), dependency = fixture(failing), transitive = fixture();
	for (const [root, name, dependencies] of [
		[owner, 'owner', [{id:'dependency',target:'runtime'}, {id:'transitive',target:'runtime'}]],
		[dependency, 'dependency', [{id:'transitive',target:'runtime'}]],
		[transitive, 'transitive', [{id:'owner',target:'runtime'}]],
	] as const) {
		const manifest = JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));
		writeFileSync(resolve(root,'package.json'),JSON.stringify({...manifest,name}));
		writeFileSync(resolve(root,'treeseed.package.yaml'),JSON.stringify({development:{project:{id:name},targets:[{id:'runtime',dependencies}]}}));
	}
	const plan = planLocalGuarantees(owner,['proof']); plan.entries[0]!.scope = 'local-integrated-runtime';
	for (const [name, root] of [['dependency',dependency],['transitive',transitive]])
		plan.verifiers[name!] = {...plan.verifiers['proof.scene']!,root:root!};
	return {owner,dependency,transitive,plan};
}

it('runs declared transitive integrated owners once and blocks every scene on an indirect failure', () => {
	for (const failing of [false,true]) {
		const {owner,dependency,transitive,plan} = compositionFixture(failing);
		const report = runLocalGuarantees(owner,plan,`composition-${failing}`);
		expect(report.ok).toBe(!failing);
		for (const root of [dependency,transitive])
			expect(readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\n').sort()).toEqual(['integration','unit']);
		expect(readFileSync(resolve(owner,'.treeseed/order'),'utf8').includes('scene')).toBe(!failing);
		expect(new Set(report.results[0]!.evidence.filter(path=>path.includes('prerequisite-'))).size).toBe(3);
	}
});

it('blocks unknown and ambiguous integrated dependencies before any native side effect', () => {
	for (const mode of ['missing-owner','missing-target','ambiguous-owner','missing-composition']) {
		const {owner,dependency,transitive,plan} = compositionFixture();
		if (mode === 'missing-composition') rmSync(resolve(owner,'treeseed.package.yaml'));
		else {
			const document = JSON.parse(readFileSync(resolve(dependency,'treeseed.package.yaml'),'utf8'));
			if (mode === 'ambiguous-owner') document.development.project.id = 'transitive';
			else document.development.targets[0].dependencies = [{id:mode === 'missing-owner' ? 'absent' : 'transitive',target:'absent',locality:'remote'}];
			writeFileSync(resolve(dependency,'treeseed.package.yaml'),JSON.stringify(document));
		}
		const report = runLocalGuarantees(owner,plan,mode);
		expect(report.ok,mode).toBe(false);
		for (const root of [owner,dependency,transitive]) expect(existsSync(resolve(root,'.treeseed/order')),mode).toBe(false);
	}
});

it('tests the declared guarantee owner even when its verifier belongs to another package', () => {
	const {owner,dependency,plan} = compositionFixture(true); plan.entries[0]!.scope = 'local-component-tests';
	plan.entries[0]!.ownerPackage = 'dependency';
	const report = runLocalGuarantees(owner,plan,'declared-owner');
		expect(report.ok).toBe(false);
		expect(readFileSync(resolve(dependency,'.treeseed/order'),'utf8')).not.toContain('scene');
		expect(readFileSync(resolve(owner,'.treeseed/order'),'utf8')).not.toContain('scene');
});

it('retains ongoing custody of transitive owners throughout native scene execution', () => {
	const {owner,transitive,plan} = compositionFixture();
	writeFileSync(resolve(owner,'scene.ts'),`import test from 'node:test'; import {writeFileSync} from 'node:fs'; test('scene boundary',()=>{writeFileSync(${JSON.stringify(resolve(transitive,'tests/unit.test.ts'))},'changed after complete suite');});`);
	const report = runLocalGuarantees(owner,plan,'transitive-custody');
	expect(report.ok).toBe(false); expect(report.results[0]!.steps[0]!.status).toBe('failed');
	expect(report.results[0]!.evidence.filter(path=>path.includes('prerequisite-'))).toHaveLength(3);
	for (const path of report.results[0]!.evidence.filter(path=>path.includes('prerequisite-')))
		expect(JSON.parse(readFileSync(resolve(owner,'.treeseed/guarantees/runs/transitive-custody',path),'utf8')).passed).toBe(true);
});

it('retains exact discovered native source custody and blocks incomplete native evidence before every owner suite',()=>{
	const {owner,dependency,transitive,plan}=compositionFixture();
	rmSync(resolve(dependency,'package.json'));
	const document=JSON.parse(readFileSync(resolve(dependency,'treeseed.package.yaml'),'utf8'));
	document.verify={local:'verify-native.sh'};
	writeFileSync(resolve(dependency,'treeseed.package.yaml'),JSON.stringify(document));
	writeFileSync(resolve(dependency,'verify-native.sh'),"#!/bin/sh\nprintf ran > .treeseed/native-ran\nexit 0\n");
	for(const args of [['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Declared native owner']])
		expect(spawnSync('git',args,{cwd:dependency}).status).toBe(0);
	const exact=candidate(dependency);
	expect(participatingOwners(plan,owner)).toEqual([owner,dependency,transitive]);
	const report=runLocalGuarantees(owner,plan,'native-owner-unreported');
	expect(report.ok).toBe(false);
	const receipts=report.results[0]!.evidence.filter(path=>path.includes('prerequisite-'))
		.map(path=>JSON.parse(readFileSync(resolve(owner,'.treeseed/guarantees/runs/native-owner-unreported',path),'utf8')));
	expect(receipts).toHaveLength(3);
	expect(receipts.find(receipt=>receipt.root===dependency)).toMatchObject({root:dependency,...exact,passed:false,command:[],checks:null});
	for(const root of [owner,dependency,transitive])expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
	expect(existsSync(resolve(dependency,'.treeseed/native-ran'))).toBe(false);
});

it('preflights every declared entrypoint before spending capacity on an earlier valid full suite',()=>{
	for(const mode of ['missing','filtered','hooked','escaped']) {
		const {owner,dependency,transitive,plan}=compositionFixture();
		const scripts=mode==='missing'?{}:mode==='filtered'?{test:'vitest run tests/unit.test.ts'}:
			mode==='hooked'?{test:'vitest run',pretest:'node side-effect.ts'}:{test:'vitest run --config outside.config.ts'};
		writeFileSync(resolve(dependency,'package.json'),JSON.stringify({name:'dependency',scripts}));
		if(mode==='escaped')symlinkSync(resolve(owner,'vitest.config.ts'),resolve(dependency,'outside.config.ts'));
		const report=runLocalGuarantees(owner,plan,`admission-${mode}`);
		expect(report.ok,mode).toBe(false);
		for(const root of [owner,dependency,transitive])expect(existsSync(resolve(root,'.treeseed/order')),mode).toBe(false);
		for(const path of report.results[0]!.evidence.filter(path=>path.includes('prerequisite-'))) {
			const receipt=JSON.parse(readFileSync(resolve(owner,`.treeseed/guarantees/runs/admission-${mode}`,path),'utf8'));
			expect(receipt).toMatchObject({passed:false,command:[],exitCode:null,checks:null});
		}
	}
});

it('recognizes canonical non-npm dependency aliases while refusing parent Git custody for copied native source',()=>{
	const {owner,dependency,transitive,plan}=compositionFixture();rmSync(resolve(dependency,'package.json'));
	const nested=resolve(owner,'native-copy');cpSync(dependency,nested,{recursive:true});rmSync(resolve(nested,'.git'),{recursive:true,force:true});
	plan.verifiers['dependency']={...plan.verifiers['dependency']!,root:nested};
	const roots=participatingOwners(plan,owner);
	expect(roots).toContain(nested);
	expect(()=>candidate(nested)).toThrow();
	const report=runLocalGuarantees(owner,plan,'native-copy');expect(report.ok).toBe(false);
	for(const root of [owner,nested,transitive])expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
});

it('blocks a copied nested owner before suites instead of borrowing its parent repository custody',()=>{
	const parent=fixture(),root=resolve(parent,'copied-owner');
	cpSync(fixture(),root,{recursive:true});rmSync(resolve(root,'.git'),{recursive:true,force:true});
	const report=runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'inherited-root');
	expect(report.ok).toBe(false);
	expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
	const receipt=JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs/inherited-root',report.results[0]!.evidence.at(-1)!),'utf8'));
	expect(receipt.passed).toBe(false);expect(receipt.command).toEqual([]);
});

it('fails final-scene deletion of literal missing bytes without rewriting a passed suite receipt',()=>{
	const root=fixture();writeFileSync(resolve(root,'candidate.ts'),'missing');
	writeFileSync(resolve(root,'scene.ts'),"import test from 'node:test';import {rmSync} from 'node:fs';test('scene boundary',()=>{rmSync('candidate.ts');});");
	for(const args of [['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Literal tracked bytes']])
		expect(spawnSync('git',args,{cwd:root}).status).toBe(0);
	const report=runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'literal-missing-deleted');
	expect(report.ok).toBe(false);expect(report.results[0]!.steps[0]!.status).toBe('failed');
	const receipt=JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs/literal-missing-deleted',report.results[0]!.evidence.at(-1)!),'utf8'));
	expect(receipt).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0}});
});

it('blocks owner Git loss even when the inherited parent has the same commit and readable source bytes',()=>{
	const parent=fixture(),root=resolve(parent,'nested-owner');
	cpSync(fixture(),root,{recursive:true});
	writeFileSync(resolve(root,'scene.ts'),"import test from 'node:test';import {rmSync} from 'node:fs';test('scene boundary',()=>{rmSync('.git',{recursive:true,force:true});});");
	for(const args of [['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Root custody loss']])
		expect(spawnSync('git',args,{cwd:root}).status).toBe(0);
	for(const args of [['fetch',root,'HEAD'],['switch','--detach','FETCH_HEAD']])
		expect(spawnSync('git',args,{cwd:parent}).status).toBe(0);
	const report=runLocalGuarantees(root,planLocalGuarantees(root,['proof']),'same-parent-head');
	expect(report.ok).toBe(false);expect(report.results[0]!.steps[0]!.status).toBe('failed');
	const receipt=JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs/same-parent-head',report.results[0]!.evidence.at(-1)!),'utf8'));
	expect(receipt).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0}});
});

it('admits complete native suites and scenes for independently rooted linked worktrees through aliases',()=>{
	const parent=fixture(),root=resolve(parent,'linked-owner'),alias=resolve(parent,'alias');
	expect(spawnSync('git',['worktree','add','--detach',root,'HEAD'],{cwd:parent}).status).toBe(0);
	symlinkSync(resolve(parent,'node_modules'),resolve(root,'node_modules'),'dir');symlinkSync(root,alias,'dir');
	for(const [workspace,id] of [[root,'linked'],[alias,'alias']])
		expect(runLocalGuarantees(workspace!,planLocalGuarantees(workspace!,['proof']),id!).ok).toBe(true);
	const order=readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\n');
	expect(order).toHaveLength(6);
	for(const start of [0,3]){expect(order.slice(start,start+2).sort()).toEqual(['integration','unit']);expect(order[start+2]).toBe('scene');}
});
