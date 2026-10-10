import { expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { inspectInstalledOwner, installedCustodyDiagnostics } from '../../../src/verifiers/guarantees/installed-custody.ts';
import { runOwnedCommand } from '../../../src/verifiers/guarantees/owned-command.ts';

it('native production bundled command links bind only declared archived regular targets and reject missing renamed foreign or substituted links without source fallback',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'reviewer-installed-bin-')),source=resolve(root,'source'),installation=resolve(root,'installation'),installed=resolve(installation,'node_modules');
 const deadline=performance.now()+25_000;
 const native=(command:string,args:string[],cwd=root)=>{
  const timeout=Math.floor(deadline-performance.now());expect(timeout).toBeGreaterThan(0);
  const result=runOwnedCommand(command,args,{cwd,encoding:'utf8',timeout,maxBuffer:8*1024*1024});
  expect(result.error).toBeUndefined();expect(result.signal).toBeNull();expect(result.status,result.stderr).toBe(0);return result;
 };
 try{
  const dependency=resolve(source,'node_modules/@fixture/tool'),runtime=resolve(root,'runtime');mkdirSync(dependency,{recursive:true});mkdirSync(installation);mkdirSync(runtime);
  writeFileSync(resolve(runtime,'package.json'),JSON.stringify({name:'@fixture/runtime',version:'1.0.0',main:'index.cjs'}));
  writeFileSync(resolve(runtime,'index.cjs'),ts.transpileModule("exports.exact='installed production dependency';",{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText);
  const runtimePack=native('npm',['pack','--ignore-scripts','--json','--pack-destination',installation],runtime),runtimeArchive=resolve(installation,JSON.parse(runtimePack.stdout)[0].filename);
  writeFileSync(resolve(source,'package.json'),JSON.stringify({name:'@fixture/owner',version:'1.0.0',files:[],dependencies:{'@fixture/tool':'1.0.0','@fixture/runtime':`file:${runtimeArchive}`},bundledDependencies:['@fixture/tool']}));
  writeFileSync(resolve(dependency,'package.json'),JSON.stringify({name:'@fixture/tool',version:'1.0.0',bin:{'exact-tool':'./command.cjs'}}));
  const code=ts.transpileModule("process.stdout.write('actual archived command');",{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  writeFileSync(resolve(dependency,'command.cjs'),code);chmodSync(resolve(dependency,'command.cjs'),0o755);
  const packed=native('npm',['pack','--ignore-scripts','--json','--pack-destination',installation],source),archive=resolve(installation,JSON.parse(packed.stdout)[0].filename),bytes=readFileSync(archive);
  native('npm',['install','--prefix',installation,'--install-strategy=nested','--omit=dev','--ignore-scripts','--package-lock=false','--no-save','--no-audit','--no-fund',archive]);
  const owner=resolve(installed,'@fixture/owner'),link=resolve(owner,'node_modules/.bin/exact-tool'),target=readlinkSync(link);
  // A separately installed production dependency can be nested alongside the
  // owner's bundled payload. It is not part of that owner's archive inventory.
  const nested=resolve(owner,'node_modules/@fixture/runtime');
  expect(existsSync(nested)).toBe(true);
  expect(target).toBe('../@fixture/tool/command.cjs');
  const held=inspectInstalledOwner(source,installed);expect(installedCustodyDiagnostics([held])).toEqual([]);
  expect(held.files.some(file=>file.path.startsWith('node_modules/@fixture/runtime/'))).toBe(false);
  expect(native(process.execPath,['-e',"process.stdout.write(require('@fixture/runtime').exact)"],owner).stdout).toBe('installed production dependency');
  const runtimeManifest=resolve(nested,'package.json'),runtimeBytes=readFileSync(runtimeManifest),saved=resolve(root,'saved-runtime');
  for(const mode of ['missing-manifest','foreign-identity','redirected-root','undeclared-package','loose-file']){
   if(mode==='missing-manifest')rmSync(runtimeManifest);
   if(mode==='foreign-identity')writeFileSync(runtimeManifest,JSON.stringify({name:'@fixture/foreign',version:'1.0.0'}));
   if(mode==='redirected-root'){renameSync(nested,saved);symlinkSync(runtime,nested,'dir');}
   if(mode==='undeclared-package'){mkdirSync(resolve(owner,'node_modules/@fixture/undeclared'));writeFileSync(resolve(owner,'node_modules/@fixture/undeclared/package.json'),JSON.stringify({name:'@fixture/undeclared',version:'1.0.0'}));}
   if(mode==='loose-file')writeFileSync(resolve(owner,'node_modules/@fixture/invented.cjs'),code);
   expect(()=>inspectInstalledOwner(source,installed),mode).toThrow();expect(installedCustodyDiagnostics([held]).length,mode).toBeGreaterThan(0);
   if(mode==='redirected-root'){rmSync(nested);renameSync(saved,nested);}
   writeFileSync(runtimeManifest,runtimeBytes);rmSync(resolve(owner,'node_modules/@fixture/undeclared'),{recursive:true,force:true});rmSync(resolve(owner,'node_modules/@fixture/invented.cjs'),{force:true});
   expect(installedCustodyDiagnostics([held]),mode).toEqual([]);
  }
  expect(native(process.execPath,[link]).stdout).toBe('actual archived command');
  const replacement=resolve(owner,'node_modules/@fixture/tool/other.cjs');
  for(const mode of ['missing','foreign','absolute','renamed','substituted','directory']){
   rmSync(link);
   if(mode==='foreign')symlinkSync(resolve(dependency,'command.cjs'),link);
   if(mode==='absolute')symlinkSync(resolve(owner,'node_modules/@fixture/tool/command.cjs'),link);
   if(mode==='substituted'){writeFileSync(replacement,code);symlinkSync('../@fixture/tool/other.cjs',link);}
   if(mode==='renamed')symlinkSync(target,resolve(owner,'node_modules/.bin/invented-tool'));
   if(mode==='directory')mkdirSync(link);
   expect(()=>inspectInstalledOwner(source,installed),mode).toThrow();expect(installedCustodyDiagnostics([held]).length,mode).toBeGreaterThan(0);
   rmSync(link,{recursive:true,force:true});rmSync(replacement,{force:true});rmSync(resolve(owner,'node_modules/.bin/invented-tool'),{force:true});symlinkSync(target,link);
   expect(installedCustodyDiagnostics([held]),mode).toEqual([]);
  }
  expect(readFileSync(archive)).toEqual(bytes);expect(native(process.execPath,[link]).stdout).toBe('actual archived command');
 }finally{rmSync(root,{recursive:true,force:true});expect(existsSync(root)).toBe(false);expect(performance.now()).toBeLessThan(deadline);}
});
