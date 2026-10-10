import {afterEach,beforeAll,expect,it} from 'vitest';
import {cpSync,mkdtempSync,mkdirSync,symlinkSync,writeFileSync,readFileSync,existsSync,rmSync} from 'node:fs';
import {spawnSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {sourceRunnerFixture} from '../fixtures/source-runner.ts';
import {roots as runnerRoots} from '../fixtures/guarantee-prerequisites.ts';

const repository=resolve(import.meta.dirname,'../..');
const roots:string[]=[];
beforeAll(()=>{expect(spawnSync(process.execPath,['--import','tsx','scripts/build-server.ts'],{cwd:repository,encoding:'utf8'}).status).toBe(0);});
afterEach(()=>{for(const root of [...roots.splice(0),...runnerRoots.splice(0)])rmSync(root,{recursive:true,force:true});});
function fixture(mode='pass') {
	const root=mkdtempSync(resolve(tmpdir(),'reviewer-native-suite-')); roots.push(root);
	for(const dir of ['tests','.treeseed','guarantees'])mkdirSync(resolve(root,dir),{recursive:true});
	symlinkSync(resolve(repository,'node_modules'),resolve(root,'node_modules'));
	writeFileSync(resolve(root,'package.json'),JSON.stringify({type:'module',scripts:{test:'npm run build:fixture && node --import tsx runner.ts','build:fixture':'node --import tsx build.ts'}}));
	writeFileSync(resolve(root,'.gitignore'),'node_modules\n.treeseed\n');
	writeFileSync(resolve(root,'build.ts'),"import {appendFileSync} from 'node:fs'; appendFileSync('.treeseed/order','build\\n');");
	writeFileSync(resolve(root,'runner.ts'),"import {spawnSync} from 'node:child_process'; import {readdirSync} from 'node:fs'; const r=spawnSync(process.execPath,['--import','tsx','--test',...process.argv.slice(2),...readdirSync('tests').map(f=>'tests/'+f)],{stdio:'inherit'});process.exit(r.status??1);");
	writeFileSync(resolve(root,'tests/unit.test.ts'),"import test from 'node:test'; import {appendFileSync} from 'node:fs'; test('unit',()=>{console.log('private fixture stdout');appendFileSync('.treeseed/order','unit\\n');});");
	writeFileSync(resolve(root,'tests/integration.test.ts'),mode==='crash' ? "throw new Error('private fixture error');" : mode==='cancelled' ? "import test from 'node:test'; const controller=new AbortController(); test('cancelled',{signal:controller.signal},()=>new Promise(()=>{}));setTimeout(()=>controller.abort(),25);" : mode==='expired' ? "import test from 'node:test';test('cancelled',{timeout:25},()=>new Promise(()=>{}));" : `import {suite,test} from 'node:test'; import {appendFileSync,writeFileSync} from 'node:fs'; import assert from 'node:assert/strict'; suite('integration suite',()=>{test${mode==='skip'?'.skip':mode==='todo'?'.todo':''}('integration',()=>{appendFileSync('.treeseed/order','integration\\n');${mode==='mutation'?"writeFileSync('hidden.ts','mutated');":''}assert.equal(${mode==='failure'},false,'private fixture error');});});`);
	if(mode==='empty'){rmSync(resolve(root,'tests/unit.test.ts'));rmSync(resolve(root,'tests/integration.test.ts'));writeFileSync(resolve(root,'runner.ts'),"process.exit(0);");}
	if(mode==='missing')writeFileSync(resolve(root,'runner.ts'),"process.exit(0);");
	if(mode==='malformed'||mode==='duplicate')writeFileSync(resolve(root,'runner.ts'),`import {writeFileSync} from 'node:fs';const destination=process.argv.find(arg=>arg.startsWith('--test-reporter-destination='))?.split('=').slice(1).join('=');writeFileSync(destination,${JSON.stringify(mode==='malformed'?'invalid':'{}{}')});`);
	if(mode==='reporter-mutation')writeFileSync(resolve(root,'runner.ts'),"import {spawnSync} from 'node:child_process';import {readdirSync,writeFileSync} from 'node:fs';const r=spawnSync(process.execPath,['--import','tsx','--test',...process.argv.slice(2),...readdirSync('tests').map(f=>'tests/'+f)],{stdio:'inherit'});writeFileSync(process.argv.find(arg=>arg.startsWith('--test-reporter='))!.slice('--test-reporter='.length),'changed ignored artifact');process.exit(r.status??1);");
	if(mode==='filtered') {const manifest=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8'));manifest.scripts.test+=' --test-name-pattern=unit';writeFileSync(resolve(root,'package.json'),JSON.stringify(manifest));}
	if(mode==='escaped') {const outside=mkdtempSync(resolve(tmpdir(),'reviewer-native-outside-'));roots.push(outside);writeFileSync(resolve(outside,'runner.ts'),"process.exit(0);");rmSync(resolve(root,'runner.ts'));symlinkSync(resolve(outside,'runner.ts'),resolve(root,'runner.ts'));}
	writeFileSync(resolve(root,'scene.ts'),"import test from 'node:test'; import {appendFileSync} from 'node:fs'; test('scene',()=>{appendFileSync('.treeseed/order','scene\\n');});");
	writeFileSync(resolve(root,'guarantees/native.guarantee.yaml'),'id: native\napi: {verifierRefs: [native.scene]}\n');
	writeFileSync(resolve(root,'guarantees/native.verifiers.yaml'),'verifiers:\n  native.scene: {kind: nodeTestCase, testFile: scene.ts, testName: scene}\n');
	for(const args of [['init','-q'],['add','.'],['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-qm','Candidate']])expect(spawnSync('git',args,{cwd:root}).status).toBe(0);
	return root;
}
function invoke(root:string,id:string,source=false) {
	const runner=sourceRunnerFixture(),runtime=resolve(runner,'dist/verifiers/guarantees');
	cpSync(resolve(repository,'dist/verifiers/guarantees'),runtime,{recursive:true});
	const result=spawnSync(process.execPath,[...(source ? ['--import',resolve(repository,'node_modules/tsx/dist/loader.mjs'),resolve(runner,'src/verifiers/guarantees/command.ts')] : [resolve(runtime,'command.js')]),'--workspace',root,'--environment','local','--ids','native','--run-id',id],{encoding:'utf8',timeout:10_000});
	expect(result.error,'fixture subprocess must close with native terminal evidence, not hang').toBeUndefined();
	const report=JSON.parse(result.stdout);
	const receipts=report.results[0].evidence.filter((path:string)=>path.includes('prerequisite-')).map((path:string)=>JSON.parse(readFileSync(resolve(root,'.treeseed/guarantees/runs',id,path),'utf8')));
	return {report,status:result.status,receipt:receipts.find((receipt:{root:string})=>receipt.root===root)};
}

it('admits complete native suites through their original build and one root reporter before scenes',()=>{
	const root=fixture();
	for(const id of ['first','second']) {
		const {report,status,receipt}=invoke(root,id);
		expect(report.ok).toBe(true);expect(status).toBe(0);
		expect(receipt).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0,skipped:0,todo:0}});
		expect(receipt.command.slice(0,3)).toEqual(['npm','test','--']);
		expect(JSON.stringify(receipt)).not.toContain('private fixture');
	}
	const order=readFileSync(resolve(root,'.treeseed/order'),'utf8').trim().split('\n');
	expect(order).toHaveLength(8);
	for(const start of [0,4]){expect(order[start]).toBe('build');expect(order.slice(start+1,start+3).sort()).toEqual(['integration','unit']);expect(order[start+3]).toBe('scene');}
});

it('uses the same native terminal reporter from TypeScript source without copying stale build output',()=>{
	const root=fixture();const {report,status,receipt}=invoke(root,'source',true);
	expect(report.ok).toBe(true);expect(status).toBe(0);
	expect(receipt).toMatchObject({passed:true,checks:{total:2,passed:2,failed:0}});
	expect(receipt.command[3]).toContain('data:text/javascript,');
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).toContain('scene');
});

it('blocks native scene side effects for failed skipped todo cancelled crashed missing empty and filtered full suites',()=>{
	for(const mode of ['failure','skip','todo','cancelled','crash','missing','empty','malformed','duplicate','filtered','escaped']) {
		const root=fixture(mode);const {report,receipt}=invoke(root,mode);
		expect(report.ok,mode).toBe(false);expect(receipt.passed,mode).toBe(false);
		if(existsSync(resolve(root,'.treeseed/order')))expect(readFileSync(resolve(root,'.treeseed/order'),'utf8'),mode).not.toContain('scene');
		if(mode==='filtered'||mode==='escaped')expect(existsSync(resolve(root,'.treeseed/order'))).toBe(false);
		expect(JSON.stringify(receipt),mode).not.toContain('private fixture');
		if(mode==='failure')expect(receipt.checks.failures).toEqual([{title:'integration',status:'failed'}]);
	}
});

it('blocks changed native reporter artifact custody even when all source tests pass',()=>{
	const root=fixture('reporter-mutation');const {report,receipt}=invoke(root,'reporter-mutation');
	expect(report.ok).toBe(false);expect(receipt).toMatchObject({passed:false,exitCode:0,checks:{total:2,passed:2}});
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
});

it('blocks explicit native abort and deadline expiry with complete terminal evidence before scenes',()=>{
	for(const mode of ['cancelled','expired']) {
		const root=fixture(mode);const {report,status,receipt}=invoke(root,`terminal-${mode}`);
		expect(status).toBe(1);expect(report.ok).toBe(false);
		expect(receipt).toMatchObject({passed:false,exitCode:1,signal:null,checks:{total:2,passed:1,failures:[{title:'cancelled',status:'failed'}]}});
		expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
	}
});

it('blocks a zero-exit native suite that changes the exact source candidate',()=>{
	const root=fixture('mutation');const {report,receipt}=invoke(root,'mutated');
	expect(report.ok).toBe(false);expect(receipt).toMatchObject({passed:false,exitCode:0,checks:{total:2,passed:2}});
	expect(readFileSync(resolve(root,'.treeseed/order'),'utf8')).not.toContain('scene');
});
