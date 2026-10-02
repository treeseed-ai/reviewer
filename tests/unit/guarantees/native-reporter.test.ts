import {expect,it} from 'vitest';
import nativeReporter from '../../../src/verifiers/guarantees/node-case.ts';
import {fullSuitePassed} from '../../../src/verifiers/guarantees/prerequisites.ts';

const terminal=(name='unit')=>({type:'test:pass',data:{name,details:{type:'test',duration_ms:1}}});
const summary=()=>({type:'test:summary',data:{success:true,counts:{tests:1,passed:1,failed:0,skipped:0,todo:0,cancelled:0}}});
async function report(events:unknown[]) {
	async function* source(){for(const event of events)yield event as {type:string;data:unknown};}
	let result='';for await(const chunk of nativeReporter(source()))result+=chunk;
	return JSON.parse(result);
}

it('normalizes native terminal assertions and aggregate counts without suite containers or private output',async()=>{
	const value=await report([
		{type:'test:stdout',data:{message:'private stdout'}},{type:'test:stderr',data:{message:'private stderr'}},
		{type:'test:pass',data:{name:'suite container',details:{type:'suite',duration_ms:5}}},
		terminal(),{...summary(),data:{...summary().data,file:'tests/unit.test.ts'}},summary(),
	]);
	expect(fullSuitePassed(value)).toBe(true);expect(value.testResults[0].assertionResults).toHaveLength(1);
	expect(JSON.stringify(value)).not.toContain('private');expect(JSON.stringify(value)).not.toContain('suite container');
});

it('rejects missing duplicate malformed empty inconsistent and unsuccessful native summaries',async()=>{
	for(const events of [[],[terminal()],[terminal(),summary(),summary()],
		[terminal(),{type:'test:summary',data:{}}],[summary()],
		[terminal(),{...summary(),data:{...summary().data,success:false}}],
		[terminal(),{...summary(),data:{success:true,counts:{...summary().data.counts,tests:2,passed:2}}}],
		[terminal(),{...summary(),data:{success:true,counts:{...summary().data.counts,cancelled:1}}}],
	])expect(fullSuitePassed(await report(events))).toBe(false);
});

it('rejects skipped todo failed and unmeasured native assertions without retaining failure prose',async()=>{
	for(const event of [
		{...terminal(),data:{...terminal().data,skip:true}},
		{...terminal(),data:{...terminal().data,todo:true}},
		{type:'test:fail',data:{...terminal().data,details:{...terminal().data.details,error:{message:'private failure'}}}},
		{...terminal(),data:{...terminal().data,details:{type:'test'}}},
		{...terminal(),data:{...terminal().data,details:{type:'test',duration_ms:-1}}},
		{...terminal(),data:{...terminal().data,name:''}},
	]){const value=await report([event,summary()]);expect(fullSuitePassed(value)).toBe(false);expect(JSON.stringify(value)).not.toContain('private failure');}
});

it('blocks failed skipped and todo suite containers even when an aggregate claims every test passed',async()=>{
	for(const event of [
		{type:'test:fail',data:{details:{type:'suite'}}},
		{type:'test:pass',data:{skip:true,details:{type:'suite'}}},
		{type:'test:pass',data:{todo:true,details:{type:'suite'}}},
	])expect(fullSuitePassed(await report([terminal(),event,summary()]))).toBe(false);
});

it('rejects aborted and expired native terminals under either supported Node failure classification',async()=>{
	for(const [failed,cancelled] of [[0,1],[1,0]]) {
		const value=await report([{type:'test:fail',data:{name:'interrupted',details:{type:'test',duration_ms:25,error:{code:'ERR_TEST_FAILURE',message:'private interruption'}}}},
			{type:'test:summary',data:{success:false,counts:{tests:1,passed:0,failed,cancelled,skipped:0,todo:0}}}]);
		expect(fullSuitePassed(value)).toBe(false);
		expect(value.testResults[0].assertionResults).toEqual([{title:'interrupted',status:'failed',duration:25}]);
		expect(JSON.stringify(value)).not.toContain('private interruption');
	}
});
