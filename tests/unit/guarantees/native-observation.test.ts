import {afterEach,expect,it,vi} from 'vitest';
import {mkdtempSync,writeFileSync,readFileSync,rmSync,mkdirSync,chmodSync,symlinkSync,linkSync,truncateSync,unlinkSync,renameSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {nativeObservation} from '../../../src/verifiers/guarantees/native-observation.ts';
const roots:string[]=[];const fixture=()=>{const root=mkdtempSync(resolve(tmpdir(),'reviewer-owner-observation-'));roots.push(root);return root;};
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
it('retains exact bounded owner JSON bytes and digest without interpreting the owner observation or creating absent files',()=>{
 const root=fixture(),path=resolve(root,'observation.json');expect(nativeObservation(path)).toBeUndefined();
 for(const value of [null,true,3,'original',['retained'],{original:{failed:true,details:['public',1]}}]){
  const bytes=Buffer.from(JSON.stringify(value)+'\n');writeFileSync(path,bytes,{mode:0o400});
  expect(nativeObservation(path)).toEqual({sha256:createHash('sha256').update(bytes).digest('hex')});expect(readFileSync(path)).toEqual(bytes);chmodSync(path,0o600);
 }
});
it('denies malformed truncated empty invalid UTF8 unreadable and oversized owner observations while preserving original bytes',()=>{
 const root=fixture(),path=resolve(root,'observation.json');
 const invalid=[Buffer.alloc(0),Buffer.from('{'),Buffer.from('null null'),Buffer.from([0x22,0xc0,0xaf,0x22]),Buffer.from([0x22,0xff,0x22])];
 for(const bytes of invalid){writeFileSync(path,bytes);expect(()=>nativeObservation(path)).toThrow();expect(readFileSync(path)).toEqual(bytes);}
 writeFileSync(path,'{}');chmodSync(path,0);expect(()=>nativeObservation(path)).toThrow();chmodSync(path,0o600);expect(readFileSync(path,'utf8')).toBe('{}');
 truncateSync(path,8*1024*1024+1);expect(()=>nativeObservation(path)).toThrow();
});
it('denies directory symbolic link dangling link and hard link owner output without touching the original target',()=>{
 const root=fixture(),path=resolve(root,'observation.json'),target=resolve(root,'original.json');writeFileSync(target,'{"original":true}');
 mkdirSync(path);expect(()=>nativeObservation(path)).toThrow();rmSync(path,{recursive:true});
 for(const value of [target,resolve(root,'absent.json')]){symlinkSync(value,path);expect(()=>nativeObservation(path)).toThrow();unlinkSync(path);}
 linkSync(target,path);expect(()=>nativeObservation(path)).toThrow();expect(readFileSync(target,'utf8')).toBe('{"original":true}');
});

it('denies owner observation replacement mutation deletion and permission changes during inspection while closing the original descriptor',()=>{
 const parse=JSON.parse;
 for(const mode of ['replace','mutate','delete','permissions']as const){
  const root=fixture(),path=resolve(root,'observation.json'),original='{"original":true}';writeFileSync(path,original);
  const spy=vi.spyOn(JSON,'parse').mockImplementation((text:string)=>{spy.mockRestore();if(mode==='replace'){renameSync(path,path+'.retained');writeFileSync(path,original);}else if(mode==='mutate')writeFileSync(path,'{"original":false}');else if(mode==='delete')unlinkSync(path);else chmodSync(path,0);return parse(text);});
  try{expect(()=>nativeObservation(path)).toThrow();}finally{spy.mockRestore();if(mode==='permissions')chmodSync(path,0o600);}
  if(mode==='replace')expect(readFileSync(path+'.retained','utf8')).toBe(original);
  // A failed inspection must release its descriptor so independent exact retry can proceed.
  writeFileSync(path,original);expect(nativeObservation(path)).toEqual({sha256:createHash('sha256').update(original).digest('hex')});
 }
});
