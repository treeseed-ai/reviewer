import { expect, it } from 'vitest';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { assetPaths, inspectInstalledOwner, installedCustodyDiagnostics, installedDirectory } from '../../../src/verifiers/guarantees/installed-custody.ts';
import { productionInstallFlags } from '../../fixtures/guarantee-prerequisites.ts';

it('matches actual npm archive and production installation bytes and rejects changed missing redirected and unarchived assets',()=>{
 const root=mkdtempSync(resolve(tmpdir(),'installed-owner-custody-')),source=resolve(root,'source'),installation=resolve(root,'installation'),installed=resolve(installation,'node_modules');
 try {
  mkdirSync(resolve(source,'assets'),{recursive:true});
  writeFileSync(resolve(source,'package.json'),JSON.stringify({name:'@fixture/owner',version:'1.0.0',type:'module',files:['assets']}));
  writeFileSync(resolve(source,'assets/proof.ts'),'export const exact="archive bytes";\n');
  mkdirSync(installation);
  const pack=spawnSync('npm',['pack','--ignore-scripts','--json','--pack-destination',installation],{cwd:source,encoding:'utf8'});expect(pack.status).toBe(0);
  const archive=resolve(installation,JSON.parse(pack.stdout)[0].filename),bytes=readFileSync(archive);
  const install=spawnSync('npm',['install','--prefix',installation,...productionInstallFlags,archive],{encoding:'utf8'});expect(install.status,install.stderr).toBe(0);
  expect(installedDirectory(installed,source)).toBe(installed);
  const held=inspectInstalledOwner(source,installed),asset=resolve(held.root,'assets/proof.ts'),original=readFileSync(asset);
  expect(held.name).toBe('@fixture/owner');expect(held.archiveSha256).toMatch(/^[a-f0-9]{64}$/u);
  expect(held.files.map(file=>file.path).sort()).toEqual(['assets/proof.ts','package.json']);
  expect(installedCustodyDiagnostics([held])).toEqual([]);
  for(const mode of ['changed','missing','symlink','mode','extra','archive','source']) {
   if(mode==='changed')writeFileSync(asset,'changed');
   if(mode==='missing')rmSync(asset);
   if(mode==='symlink'){rmSync(asset);symlinkSync(resolve(source,'assets/proof.ts'),asset);}
   if(mode==='mode')chmodSync(asset,0o755);
   if(mode==='extra')writeFileSync(resolve(held.root,'unarchived.ts'),'private helper');
   if(mode==='archive')writeFileSync(archive,'truncated archive');
   if(mode==='source')writeFileSync(resolve(source,'assets/proof.ts'),'source mutation');
   expect(()=>inspectInstalledOwner(source,installed),mode).toThrow();
   if(mode!=='source')expect(installedCustodyDiagnostics([held]).length,mode).toBeGreaterThan(0);
   rmSync(asset,{force:true});writeFileSync(asset,original,{mode:0o644});
   rmSync(resolve(held.root,'unarchived.ts'),{force:true});writeFileSync(archive,bytes);
   writeFileSync(resolve(source,'assets/proof.ts'),original);
   expect(installedCustodyDiagnostics([held]),mode).toEqual([]);
  }
  expect(()=>installedDirectory(source,source)).toThrow();
  expect(()=>installedDirectory('relative',source)).toThrow();
  const alias=resolve(root,'alias');symlinkSync(installed,alias,'dir');
  expect(()=>installedDirectory(alias,source)).toThrow();
  const dependenciesRoot=resolve(held.root,'node_modules');symlinkSync(source,dependenciesRoot,'dir');
  expect(()=>inspectInstalledOwner(source,installed)).toThrow('redirected assets');
  expect(installedCustodyDiagnostics([held]).length).toBeGreaterThan(0);
  rmSync(dependenciesRoot,{recursive:true,force:true});
  expect(installedCustodyDiagnostics([held])).toEqual([]);
  writeFileSync(dependenciesRoot,'unarchived file');
  expect(()=>inspectInstalledOwner(source,installed)).toThrow('regular directory');
  expect(installedCustodyDiagnostics([held]).length).toBeGreaterThan(0);rmSync(dependenciesRoot);
  mkdirSync(dependenciesRoot);expect(installedCustodyDiagnostics([held])).toEqual([]);rmSync(dependenciesRoot,{recursive:true});
  const payload=resolve(root,'payload'),external=resolve(payload,'node_modules/external');
  mkdirSync(resolve(payload,'node_modules/bundled'),{recursive:true});mkdirSync(external);
  writeFileSync(resolve(payload,'package.json'),JSON.stringify({dependencies:{bundled:'1.0.0',external:'1.0.0'}}));
  writeFileSync(resolve(payload,'node_modules/bundled/package.json'),JSON.stringify({name:'bundled',version:'1.0.0'}));
  writeFileSync(resolve(external,'package.json'),JSON.stringify({name:'external',version:'1.0.0'}));
  const files=['package.json','node_modules/bundled/package.json'].map(path=>({path,sha256:'not-used-by-inventory',mode:0}));
  expect(assetPaths(payload,files,[])).toEqual(['node_modules/bundled/package.json','package.json']);
  for(const dependency of [undefined,'',false,{},[]]){
   writeFileSync(resolve(payload,'package.json'),JSON.stringify({dependencies:{bundled:'1.0.0',external:dependency}}));
   expect(()=>assetPaths(payload,files,[])).toThrow('undeclared dependency');
  }
  writeFileSync(resolve(payload,'package.json'),JSON.stringify({dependencies:{bundled:'1.0.0',external:'1.0.0'}}));
  writeFileSync(resolve(external,'package.json'),JSON.stringify({name:'foreign'}));
  expect(()=>assetPaths(payload,files,[])).toThrow('dependency identity');
  rmSync(external,{recursive:true});symlinkSync(source,external,'dir');
  expect(()=>assetPaths(payload,files,[])).toThrow('redirected assets');
  rmSync(external,{recursive:true});mkdirSync(external);writeFileSync(resolve(external,'package.json'),JSON.stringify({name:'external'}));
  const commands=resolve(root,'.bin'),savedCommands=resolve(root,'saved-bin');mkdirSync(commands);
  writeFileSync(resolve(payload,'command.ts'),'export const authority="held owner command";');
  const commandFiles=[...files,{path:'command.ts',sha256:'not-used-by-inventory',mode:0}];
  const bins=[{path:'../.bin/owner-command',target:'../payload/command.ts'}];
  symlinkSync('../payload/command.ts',resolve(commands,'owner-command'));
  expect(assetPaths(payload,commandFiles,bins)).toEqual(['command.ts','node_modules/bundled/package.json','package.json']);
  renameSync(commands,savedCommands);symlinkSync(savedCommands,commands,'dir');
  expect(()=>assetPaths(payload,commandFiles,bins)).toThrow('command directory');rmSync(commands,{recursive:true});renameSync(savedCommands,commands);
  rmSync(resolve(commands,'owner-command'));symlinkSync(resolve(source,'assets/proof.ts'),resolve(commands,'owner-command'));
  expect(()=>assetPaths(payload,commandFiles,bins)).toThrow('command links');
  rmSync(resolve(commands,'owner-command'));symlinkSync('../payload/command.ts',resolve(commands,'owner-command'));
  expect(assetPaths(payload,commandFiles,bins)).toEqual(['command.ts','node_modules/bundled/package.json','package.json']);
 } finally {rmSync(root,{recursive:true,force:true});}
});
