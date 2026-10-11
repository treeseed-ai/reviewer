import { afterEach, expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { candidate, custodyDiagnostics, fullSuiteFailures, fullSuitePassed, ownerTestCommand, participatingOwners } from '../../../src/verifiers/guarantees/prerequisites.ts';
import { planLocalGuarantees, type LocalGuaranteePlan } from '../../../src/verifiers/guarantees/command.ts';

const report = () => ({ success: true, numTotalTests: 2, numPassedTests: 2, numFailedTests: 0,
	numPendingTests: 0, numTodoTests: 0, numFailedTestSuites: 0, numPendingTestSuites: 0,
	testResults: [{ assertionResults: [{title:'unit',status:'passed',duration:1}, {title:'integration',status:'passed',duration:2}] }] });
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root,{recursive:true,force:true}); });

it('accepts only complete observed full-suite evidence without skipped pending or failed boundaries', () => {
	expect(fullSuitePassed(report())).toBe(true);
	for(const code of ['ETIMEDOUT','VERIFIER_SUBPROCESS_RESIDUE','VERIFIER_SUBPROCESS_CLOSURE_UNPROVEN']) {
		const criterion=`ACCEPTANCE_INSTALLED_EXECUTE_${code}`;
		const failed={testResults:[{assertionResults:[{title:'native installed command',status:'failed',failureMessages:[`${criterion}: Original native command boundary`]}]}]};
		expect(fullSuiteFailures(failed)).toEqual([{title:'native installed command',status:'failed',criterion}]);
	}
	const measurements=[{phase:'PACK',durationMs:125.5,remainingMs:24874.5},{phase:'INSTALL',durationMs:24875,remainingMs:-0.5}];
	const failure=(value:unknown)=>({testResults:[{assertionResults:[{title:'installed failure',status:'failed',failureMessages:[
		'Error: ACCEPTANCE_INSTALLED_INSTALL_ETIMEDOUT: private original cause',
		`Error: ACCEPTANCE_INSTALLED_PHASE_MEASUREMENTS: ${JSON.stringify(value)}`]}]}]});
	expect(fullSuiteFailures(failure(measurements))).toEqual([{title:'installed failure',status:'failed',criterion:'ACCEPTANCE_INSTALLED_INSTALL_ETIMEDOUT',measurements}]);
	for(const invalid of [null,{},[],Array(17).fill(measurements[0]),[{...measurements[0],phase:'PRIVATE_TOKEN'}],
		[{...measurements[0],durationMs:'125'}],[{...measurements[0],durationMs:-1}],[{...measurements[0],durationMs:Infinity}],
		[{...measurements[0],durationMs:1200001}],[{...measurements[0],remainingMs:null}],[{...measurements[0],remainingMs:1200001}],
		[{...measurements[0],remainingMs:-1200001}],[{...measurements[0],secret:'private token'}],[{phase:'PACK',durationMs:1}]])
		expect(fullSuiteFailures(failure(invalid))).toEqual([{title:'installed failure',status:'failed',criterion:'ACCEPTANCE_INSTALLED_INSTALL_ETIMEDOUT'}]);
	for(const extra of ['Error: ACCEPTANCE_INSTALLED_PHASE_MEASUREMENTS: invalid JSON',
		'Error: ACCEPTANCE_INSTALLED_PHASE_MEASUREMENTS: '+JSON.stringify(measurements)]) {
		const ambiguous=failure(measurements);ambiguous.testResults[0]!.assertionResults[0]!.failureMessages.push(extra);
		expect(fullSuiteFailures(ambiguous)).toEqual([{title:'installed failure',status:'failed',criterion:'ACCEPTANCE_INSTALLED_INSTALL_ETIMEDOUT'}]);
	}
	for (const patch of [{success:false},{numTotalTests:0},{numTotalTests:'2'},{numTotalTests:3},{numPassedTests:1},
		{numFailedTests:1},{numPendingTests:1},{numTodoTests:1},{numFailedTestSuites:1},{numPendingTestSuites:1},
		{testResults:[]},{testResults:[{assertionResults:[]}]},{testResults:null}])
		expect(fullSuitePassed({...report(),...patch}),JSON.stringify(patch)).toBe(false);
	for (const value of [null,{},[],true,'passed']) expect(fullSuitePassed(value)).toBe(false);
});

it('rejects malformed skipped failed absent and unmeasured assertion evidence', () => {
	for (const patch of [{status:'skipped'},{status:'failed'},{status:'todo'},{title:''},{duration:-1},
		{duration:undefined},{duration:Infinity},{duration:Number.NaN},{duration:'1'}]) {
		const value = report(); Object.assign(value.testResults[0]!.assertionResults[0]!,patch);
		expect(fullSuitePassed(value),JSON.stringify(patch)).toBe(false);
	}
});

it('resolves the declared complete test entrypoint without filters and rejects cyclic missing or hooked delegation', () => {
	const root = mkdtempSync(resolve(tmpdir(),'prerequisite-script-')); roots.push(root);
	const save = (scripts: Record<string,string>) => writeFileSync(resolve(root,'package.json'),JSON.stringify({scripts}));
	save({test:'npm run test:all','test:all':'vitest run --config vitest.config.ts'});
	expect(ownerTestCommand(root)).toBe('vitest run --config vitest.config.ts');
	const invalid: Record<string,string>[] = [{},{test:'npm run missing'},{test:'npm run cycle',cycle:'npm run test'},
		{test:'vitest run',pretest:'echo partial'},{test:'vitest run',posttest:'echo extra'},
		{test:'npm run all',all:'vitest run',preall:'echo partial'}];
	for (const scripts of invalid) {
		save(scripts); expect(() => ownerTestCommand(root)).toThrow();
	}
});

it('resolves declared native shell and Elixir whole suites without admitting arguments or shell expressions', () => {
	const root=mkdtempSync(resolve(tmpdir(),'prerequisite-native-script-'));roots.push(root);
	for(const [path,command] of [['scripts/verification/test-all.sh','bash scripts/verification/test-all.sh'],['verify.exs','elixir verify.exs']]) {
		writeFileSync(resolve(root,'treeseed.package.yaml'),`verify: {local: ${JSON.stringify(path)}}\n`);
		expect(ownerTestCommand(root)).toBe(command);
	}
	for(const path of ['',null,42,'./verify.sh --only selected','verify.sh && true','verify.sh; true','/tmp/verify.sh','../verify.sh','verify.js']) {
		writeFileSync(resolve(root,'treeseed.package.yaml'),`verify: {local: ${JSON.stringify(path)}}\n`);
		expect(()=>ownerTestCommand(root)).toThrow();
	}
});

it('compares both exact HEAD and source bytes without disclosing source contents', () => {
	const root = mkdtempSync(resolve(tmpdir(),'prerequisite-custody-')); roots.push(root);
	writeFileSync(resolve(root,'candidate.ts'),'private source content');
	for (const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Candidate']])
		expect(spawnSync('git',args,{cwd:root}).status).toBe(0);
	const expected = candidate(root);
	expect(custodyDiagnostics(new Map([[root,expected]]))).toEqual([]);
	for (const patch of [{commit:'0'.repeat(40)},{sourceDigest:'0'.repeat(64)}]) {
		const errors = custodyDiagnostics(new Map([[root,{...expected,...patch}]]));
		expect(errors).toHaveLength(1); expect(errors.join(' ')).not.toContain('private source content');
	}
	writeFileSync(resolve(root,'candidate.ts'),'changed private content');
	expect(custodyDiagnostics(new Map([[root,expected]]))).toHaveLength(1);
});

it('rejects missing candidate custody without throwing or substituting an old receipt', () => {
	const root = mkdtempSync(resolve(tmpdir(),'prerequisite-no-git-')); roots.push(root);
	expect(custodyDiagnostics(new Map([[root,{commit:'0'.repeat(40),sourceDigest:'0'.repeat(64)}]]))).toHaveLength(1);
	const donor=sourceFixture(), owned=sourceFixture(), before={GIT_DIR:process.env.GIT_DIR,GIT_WORK_TREE:process.env.GIT_WORK_TREE};
	writeFileSync(resolve(root,'first.ts'),'same private bytes'); writeFileSync(resolve(root,'second.ts'),'same private bytes');
	process.env.GIT_DIR=resolve(donor,'.git');
	try { const observed=[root,owned].map(target=>{process.env.GIT_WORK_TREE=target;try {candidate(target);return true;}catch{return false;}}); expect(observed).toEqual([false,false]); }
	finally { for(const key of ['GIT_DIR','GIT_WORK_TREE'] as const) { if(before[key]===undefined)delete process.env[key];else process.env[key]=before[key]; } }
});

function sourceFixture() {
	const root=mkdtempSync(resolve(tmpdir(),'prerequisite-source-metadata-'));roots.push(root);
	for(const name of ['first.ts','second.ts'])writeFileSync(resolve(root,name),'same private bytes');
	for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Metadata source']])
		expect(spawnSync('git',args,{cwd:root}).status).toBe(0);
	return root;
}

it('binds initialized Gitlink commits and nested source bytes while denying absent moved or escaped submodules',()=>{
	const root=sourceFixture(), dependency=sourceFixture(), nested=resolve(root,'dependency');
	const git=(cwd:string,...args:string[])=>spawnSync('git',args,{cwd,encoding:'utf8'});
	expect(git(root,'-c','protocol.file.allow=always','submodule','add',dependency,'dependency').status).toBe(0);
	expect(git(root,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qam','Pinned dependency').status).toBe(0);
	const before=candidate(root), pin=git(nested,'rev-parse','HEAD').stdout.trim();
	expect(candidate(root)).toEqual(before);
	writeFileSync(resolve(nested,'first.ts'),'changed private dependency');
	expect(candidate(root).sourceDigest).not.toBe(before.sourceDigest);
	expect(custodyDiagnostics(new Map([[root,before]]))).toHaveLength(1);
	writeFileSync(resolve(nested,'first.ts'),'same private bytes');
	expect(candidate(root)).toEqual(before);
	expect(git(nested,'-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','--allow-empty','-qm','Moved').status).toBe(0);
	expect(()=>candidate(root)).toThrow();
	expect(git(nested,'switch','--detach',pin).status).toBe(0);
	expect(candidate(root)).toEqual(before);
	rmSync(nested,{recursive:true,force:true});mkdirSync(nested);
	expect(()=>candidate(root)).toThrow();
	rmSync(nested,{recursive:true,force:true});symlinkSync(dependency,nested,'dir');
	expect(()=>candidate(root)).toThrow();
});

it('binds executable modes for tracked and untracked files even when Git ignores file modes',()=>{
	for(const name of ['first.ts','untracked.ts']) {
		const root=sourceFixture(),path=resolve(root,name);writeFileSync(path,'same private bytes');chmodSync(path,0o644);
		expect(spawnSync('git',['config','core.filemode','false'],{cwd:root}).status).toBe(0);
		const captured=candidate(root);chmodSync(path,0o755);
		expect(candidate(root).commit).toBe(captured.commit);
		expect(candidate(root).sourceDigest).not.toBe(captured.sourceDigest);
		expect(custodyDiagnostics(new Map([[root,captured]]))).toHaveLength(1);
	}
});

it('binds readable access permissions and special mode bits without relying on Git executable state',()=>{
	const root=sourceFixture(),path=resolve(root,'first.ts');chmodSync(path,0o644);const captured=candidate(root);
	for(const mode of [0o600,0o666,0o4644]) {
		chmodSync(path,mode);expect(candidate(root).sourceDigest,mode.toString(8)).not.toBe(captured.sourceDigest);
		expect(custodyDiagnostics(new Map([[root,captured]]))).toHaveLength(1);
	}
});

it('binds symlink identity and file kind even when both targets have identical readable bytes',()=>{
	const root=sourceFixture(),link=resolve(root,'linked.ts');symlinkSync('first.ts',link);
	const captured=candidate(root);rmSync(link);symlinkSync('second.ts',link);
	expect(candidate(root).sourceDigest).not.toBe(captured.sourceDigest);
	const moved=candidate(root);rmSync(link);writeFileSync(link,'same private bytes');
	expect(candidate(root).sourceDigest).not.toBe(moved.sourceDigest);
});

it('rejects escaped broken cyclic directory and unreadable source instead of claiming byte custody',()=>{
	for(const mode of ['escaped','broken','cycle','directory','unreadable']) {
		const root=sourceFixture(),path=resolve(root,mode==='directory'?'first.ts':'unsafe.ts');
		if(mode==='escaped')symlinkSync(resolve(sourceFixture(),'first.ts'),path);
		else if(mode==='broken')symlinkSync('absent.ts',path);
		else if(mode==='cycle')symlinkSync('unsafe.ts',path);
		else if(mode==='directory'){rmSync(path);mkdirSync(path);}
		else {writeFileSync(path,'private bytes');chmodSync(path,0o000);}
		expect(()=>candidate(root),mode).toThrow();
	}
});

it('rejects inherited parent Git custody instead of attributing a copied owner to its parent',()=>{
	const parent=mkdtempSync(resolve(tmpdir(),'prerequisite-parent-'));roots.push(parent);
	const nested=resolve(parent,'copied-owner');mkdirSync(nested);
	writeFileSync(resolve(nested,'candidate.ts'),'copied bytes');
	for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Parent only']])
		expect(spawnSync('git',args,{cwd:parent}).status).toBe(0);
	expect(()=>candidate(nested)).toThrow();
});

it('rejects unreadable tracked bytes without colliding with literal missing source content',()=>{
	const root=mkdtempSync(resolve(tmpdir(),'prerequisite-missing-bytes-'));roots.push(root);
	writeFileSync(resolve(root,'candidate.ts'),'missing');
	for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Readable source']])
		expect(spawnSync('git',args,{cwd:root}).status).toBe(0);
	const captured=candidate(root);rmSync(resolve(root,'candidate.ts'));
	expect(()=>candidate(root)).toThrow();
	expect(custodyDiagnostics(new Map([[root,captured]]))).toHaveLength(1);
});

it('retains canonical own-root custody for linked Git worktrees and symlink aliases',()=>{
	const parent=mkdtempSync(resolve(tmpdir(),'prerequisite-worktree-'));roots.push(parent);
	writeFileSync(resolve(parent,'candidate.ts'),'worktree source');
	for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Worktree source']])
		expect(spawnSync('git',args,{cwd:parent}).status).toBe(0);
	const worktree=resolve(parent,'linked-worktree');
	expect(spawnSync('git',['worktree','add','--detach',worktree,'HEAD'],{cwd:parent}).status).toBe(0);
	const alias=resolve(parent,'alias');symlinkSync(worktree,alias,'dir');
	expect(candidate(alias)).toEqual(candidate(worktree));
	expect(custodyDiagnostics(new Map([[alias,candidate(worktree)]]))).toEqual([]);
});

function ownerCatalog() {
	const workspace = mkdtempSync(resolve(tmpdir(),'prerequisite-owners-')); roots.push(workspace);
	const make = (id: string, targets: unknown = [{id:'runtime',dependencies:[]}]) => {
		const root = resolve(workspace,'packages',id); mkdirSync(root,{recursive:true});
		writeFileSync(resolve(root,'package.json'),JSON.stringify({name:`@fixture/${id}`}));
		writeFileSync(resolve(root,'treeseed.package.yaml'),JSON.stringify({development:{project:{id},targets}}));
		return root;
	};
	const root = make('owner');
	const plan = {entries:[{ownerPackage:'@fixture/owner',verifierRefs:['proof'],scope:'local-integrated-runtime'}],
		verifiers:{proof:{root}},diagnostics:[],ok:true} as unknown as LocalGuaranteePlan;
	return {workspace,root,plan,make};
}

it('resolves arbitrary workspace owners and only the declared transitive target closure', () => {
	const {workspace,root,plan,make} = ownerCatalog();
	const dependency = make('dependency',[{id:'runtime',dependencies:[{id:'owner',target:'runtime'}]},
		{id:'unused',dependencies:[{id:'unknown',target:'runtime'}]}]);
	writeFileSync(resolve(root,'treeseed.package.yaml'),JSON.stringify({development:{project:{id:'owner'},targets:[
		{id:'runtime',dependencies:[{id:'dependency',target:'runtime'},{id:'dependency',target:'runtime'}]}]}}));
	const unrelated = make('unrelated');
	expect(participatingOwners(plan,workspace)).toEqual([root,dependency]);
	expect(participatingOwners(plan,workspace)).not.toContain(unrelated);
	const native = make('native-boundary',[{id:'package-watch',dependencies:[{id:'absent-companion',target:'browser'}]}]);
	plan.verifiers.native = {...plan.verifiers.proof!,root:native};
	plan.entries[0]!.verifierRefs.push('native');
	expect(participatingOwners(plan,workspace)).toEqual([root,native,dependency]);
	plan.entries[0]!.ownerPackage = '';
	expect(()=>participatingOwners(plan,workspace)).toThrow();
	plan.entries[0]!.ownerPackage = '@fixture/owner';
	const document = JSON.parse(readFileSync(resolve(root,'treeseed.package.yaml'),'utf8'));
	document.development.targets[0].dependencies.push({id:'native-boundary',target:'package-watch'});
	writeFileSync(resolve(root,'treeseed.package.yaml'),JSON.stringify(document));
	expect(()=>participatingOwners(plan,workspace)).toThrow();
	document.development.targets[0].dependencies.pop();
	writeFileSync(resolve(root,'treeseed.package.yaml'),JSON.stringify(document));
	plan.entries[0]!.scope = 'local-component-tests';
	expect(participatingOwners(plan,workspace)).toEqual([root,native]);
});

it('rejects missing duplicate malformed and unbound owner or target declarations', () => {
	for (const targets of [[],null,[{id:''}],[{id:'runtime'},{id:'runtime'}],
		[{id:'runtime',dependencies:{}}],[{id:'runtime',dependencies:[{}]}],
		[{id:'runtime',dependencies:[{id:'owner',target:'missing'}]}]]) {
		const {workspace,plan,make} = ownerCatalog(); make('owner',targets);
		expect(()=>participatingOwners(plan,workspace)).toThrow();
	}
	for (const mode of ['unknown-package','duplicate-package','duplicate-project','alias']) {
		const {workspace,root,plan,make} = ownerCatalog();
		if (mode === 'unknown-package') plan.entries[0]!.ownerPackage = '@fixture/unknown';
		else if (mode === 'alias') { symlinkSync(root,resolve(workspace,'packages','alias')); expect(participatingOwners(plan,workspace)).toEqual([root]); continue; }
		else {
			const other = make('other');
			writeFileSync(resolve(other,mode === 'duplicate-package' ? 'package.json' : 'treeseed.package.yaml'),JSON.stringify(
				mode === 'duplicate-package' ? {name:'@fixture/owner'} : {development:{project:{id:'owner'},targets:[{id:'runtime'}]}}));
		}
		expect(()=>participatingOwners(plan,workspace)).toThrow();
	}
});

it('discovers declared non-npm projects through their own YAML target closure without substituting a nested package',()=>{
	const {workspace,root,plan,make}=ownerCatalog();
	const native=make('native',[{id:'service',dependencies:[{id:'owner',target:'runtime'}]},
		{id:'unused',dependencies:[{id:'absent',target:'runtime'}]}]);
	rmSync(resolve(native,'package.json'));
	writeFileSync(resolve(root,'treeseed.package.yaml'),JSON.stringify({development:{project:{id:'owner'},targets:[
		{id:'runtime',dependencies:[{id:'native',target:'service'},{id:'native',target:'service'}]}]}}));
	const nested=resolve(native,'packages','client');mkdirSync(nested,{recursive:true});
	writeFileSync(resolve(nested,'package.json'),JSON.stringify({name:'@fixture/native-client'}));
	symlinkSync(native,resolve(workspace,'packages','native-alias'),'dir');
	expect(participatingOwners(plan,workspace)).toEqual([root,native]);
	expect(participatingOwners(plan,workspace)).not.toContain(nested);
});

it('rejects ambiguous native YAML identities instead of preferring an npm project with the same identity',()=>{
	for(const mode of ['native-duplicate','npm-duplicate','missing-target']) {
		const {workspace,root,plan,make}=ownerCatalog();
		const native=make('native',[{id:'service',dependencies:[]}]);rmSync(resolve(native,'package.json'));
		writeFileSync(resolve(root,'treeseed.package.yaml'),JSON.stringify({development:{project:{id:'owner'},targets:[
			{id:'runtime',dependencies:[{id:'native',target:mode==='missing-target'?'absent':'service'}]}]}}));
		if(mode!=='missing-target') {
			const duplicate=make('duplicate',[{id:'service',dependencies:[]}]);
			if(mode==='native-duplicate')rmSync(resolve(duplicate,'package.json'));
			writeFileSync(resolve(duplicate,'treeseed.package.yaml'),JSON.stringify({development:{project:{id:'native'},targets:[{id:'service'}]}}));
		}
		expect(()=>participatingOwners(plan,workspace),mode).toThrow();
	}
});

it('discovers a declared native root beside companion packages and binds only its unique existing package identity',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'prerequisite-native-root-'));roots.push(root);
 mkdirSync(resolve(root,'packages/companion'),{recursive:true});mkdirSync(resolve(root,'guarantees'));
 writeFileSync(resolve(root,'scene.ts'),'export const fixture=true;');
 writeFileSync(resolve(root,'treeseed.package.yaml'),'id: native-owner\nverify: {local: verify.sh}\n');
 writeFileSync(resolve(root,'guarantees/native.guarantee.yaml'),'id: native-root\nownerPackage: native-owner\napi: {verifierRefs: [native.scene]}\n');
 writeFileSync(resolve(root,'guarantees/native.verifiers.yaml'),'verifiers:\n  native.scene: {kind: nodeTestCase, ownerPackage: native-owner, testFile: scene.ts, testName: fixture}\n');
 const companion=resolve(root,'packages/companion/package.json');writeFileSync(companion,JSON.stringify({name:'@fixture/companion'}));
 const plan=planLocalGuarantees(root,['native-root']);expect(plan.ok).toBe(true);expect(plan.verifiers['native.scene']!.root).toBe(root);expect(participatingOwners(plan,root)).toEqual([root]);
 for(const metadata of ['id: native-owner\n','id: ""\n','id: [native-owner]\n']){
  writeFileSync(resolve(root,'packages/companion/treeseed.package.yaml'),metadata);
  if(metadata==='id: native-owner\n'){rmSync(companion);expect(()=>participatingOwners(plan,root)).toThrow();writeFileSync(companion,JSON.stringify({name:'native-owner'}));expect(()=>participatingOwners(plan,root)).toThrow();}
  else{writeFileSync(companion,JSON.stringify({name:'@fixture/companion'}));expect(participatingOwners(plan,root)).toEqual([root]);}
 }
 rmSync(resolve(root,'packages/companion/treeseed.package.yaml'));writeFileSync(resolve(root,'treeseed.package.yaml'),'id: ""\nverify: {local: verify.sh}\n');expect(()=>participatingOwners(plan,root)).toThrow();
});
