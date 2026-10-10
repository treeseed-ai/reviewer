import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync, readlinkSync, readdirSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const digest=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
const member=(path:string)=>Boolean(path)&&!isAbsolute(path)&&!path.split(/[\\/]/u).some(part=>part==='..'||part==='')&&!/[\r\n\0]/u.test(path);
function regular(root:string,path:string) {
 const absolute=resolve(root,path),local=relative(root,absolute);
 if(local==='..'||local.startsWith(`..${sep}`)||isAbsolute(local)||realpathSync(absolute)!==absolute)
  throw new Error('Installed custody cannot use redirected or escaping paths.');
 const stat=lstatSync(absolute);
 if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o444)===0)throw new Error('Installed custody requires readable regular assets.');
 return {bytes:readFileSync(absolute),mode:stat.mode&0o111};
}
export function installedDirectory(directory:string,workspace:string) {
 if(!isAbsolute(directory)||realpathSync(directory)!==resolve(directory)||!lstatSync(directory).isDirectory())
  throw new Error('Installed packages require an absolute independent directory.');
 const local=relative(realpathSync(workspace),directory);
 if(local===''||(!local.startsWith(`..${sep}`)&&local!=='..'&&!isAbsolute(local)))
  throw new Error('Installed packages must be isolated from the source workspace.');
 return directory;
}
export function executingPackage(file:string) {
 let root=dirname(realpathSync(file));
 while(!existsSync(resolve(root,'treeseed.package.yaml'))||!existsSync(resolve(root,'package.json'))) {
  const parent=dirname(root);if(parent===root)throw new Error('Executing package identity is unavailable.');root=parent;
 }
 const manifest=JSON.parse(regular(root,'package.json').bytes.toString('utf8')) as {name:string;version:string};
 if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(manifest.name)||typeof manifest.version!=='string'||!manifest.version)
  throw new Error('Executing package identity is malformed.');
 return {root,name:manifest.name,version:manifest.version};
}
export function installedRunnerSource(workspace:string,installed:string,file:string) {
 const runner=executingPackage(file);
 if(runner.root!==resolve(installed,runner.name))throw new Error('Installed execution cannot fall back to the source runner.');
 const directory=resolve(workspace,'packages');
 const roots=existsSync(directory)?readdirSync(directory).map(name=>resolve(directory,name)):[workspace];
 const matches=roots.filter(root=>existsSync(resolve(root,'package.json'))&&JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')).name===runner.name);
 if(matches.length!==1)throw new Error('Executing package source owner is missing or ambiguous.');
 return realpathSync(matches[0]!);
}
export interface InstalledOwner {
 sourceRoot:string;root:string;archive:string;archiveSha256:string;name:string;version:string;
 files:Array<{path:string;sha256:string;mode:number}>;
 bins:Array<{path:string;target:string}>;
 pack:unknown;
}
function declaredBins(root:string,files:readonly {path:string}[]) {
 const paths=new Set(files.map(file=>file.path)),links=new Map<string,string>();
 for(const file of files) {
  const match=/^(.*(?:^|\/)node_modules\/)((?:@[^/]+\/)?[^/]+)\/package\.json$/u.exec(file.path);
  if(!match)continue;
  const manifest=JSON.parse(regular(root,file.path).bytes.toString('utf8')) as {name?:unknown;bin?:unknown};
  if(manifest.bin===undefined)continue;
  if(manifest.name!==match[2])throw new Error('Bundled command package identity differs from its archived location.');
  const bins=typeof manifest.bin==='string'?{[match[2]!.split('/').at(-1)!]:manifest.bin}:manifest.bin;
  if(!bins||typeof bins!=='object'||Array.isArray(bins))throw new Error('Archived command declarations are malformed.');
  const packageRoot=dirname(resolve(root,file.path));
  for(const [name,value]of Object.entries(bins)) {
   if(!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/u.test(name)||typeof value!=='string'||!value||isAbsolute(value)||/[\r\n\0]/u.test(value))
    throw new Error('Archived command identity or target is malformed.');
   const absolute=resolve(packageRoot,value),local=relative(packageRoot,absolute),target=relative(root,absolute);
   if(!local||local==='..'||local.startsWith(`..${sep}`)||isAbsolute(local)||!paths.has(target))
    throw new Error('Installed commands require regular targets held in their own archived package.');
   regular(root,target);
   const path=`${match[1]}.bin/${name}`,link=relative(dirname(resolve(root,path)),absolute);
   if(links.has(path))throw new Error('Bundled command identity is ambiguous.');links.set(path,link);
  }
 }
 return [...links].sort(([a],[b])=>a<b?-1:a>b?1:0).map(([path,target])=>({path,target}));
}
export function assetPaths(root:string,files:InstalledOwner['files'],bins:InstalledOwner['bins']):string[] {
 const archived=new Set(files.map(file=>file.path)),bundled=files.some(file=>file.path.startsWith('node_modules/'));
 const dependencies=(JSON.parse(regular(root,'package.json').bytes.toString('utf8')) as {dependencies?:Record<string,unknown>}).dependencies??{};
 const links=new Map(bins.map(bin=>[bin.path,bin.target]));
 for(const bin of bins) {
  const path=resolve(root,bin.path),target=resolve(dirname(path),bin.target);
  if(!lstatSync(path).isSymbolicLink()||readlinkSync(path)!==bin.target||realpathSync(path)!==target)
   throw new Error('Installed command links differ from their exact archived declarations.');
  regular(root,relative(root,target));
 }
 const walk=(directory:string):string[]=>readdirSync(resolve(root,directory),{withFileTypes:true}).flatMap(entry=>{
  const path=directory?`${directory}/${entry.name}`:entry.name;
  if(entry.isSymbolicLink()) {
   if(links.has(path))return [];
   throw new Error('Installed owner contains redirected assets.');
  }
  if(!directory&&entry.name==='node_modules'&&!bundled) {
   if(!entry.isDirectory())throw new Error('Installed dependencies require a regular directory.');
   return [];
  }
  if(entry.isDirectory()) {
   const dependency=/^node_modules\/((?:@[^/]+\/)?[^/.@][^/]*)$/u.exec(path)?.[1];
   if(dependency&&!archived.has(`${path}/package.json`)) {
    if(!Object.hasOwn(dependencies,dependency)||typeof dependencies[dependency]!=='string'||!dependencies[dependency])
     throw new Error('Installed owner contains an undeclared dependency directory.');
    const manifest=JSON.parse(regular(root,`${path}/package.json`).bytes.toString('utf8')) as {name?:unknown};
    if(manifest.name!==dependency)throw new Error('Installed production dependency identity differs from its declared location.');
    // npm may nest separately installed dependencies beside bundled payload.
    // Their bytes are not this owner's archive; never certify them as such.
    return [];
   }
   return walk(path);
  }
  return [path];
 });
 return walk('').sort();
}
/** Native npm inventory and the actual held archive remain the packaging authority. */
export function inspectInstalledOwner(sourceRoot:string,installed:string):InstalledOwner {
 const source=JSON.parse(regular(sourceRoot,'package.json').bytes.toString('utf8')) as {name:string;version:string};
 if(!/^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/u.test(source.name)||typeof source.version!=='string'||!source.version)
  throw new Error('Installed source package identity is malformed.');
 const root=resolve(installed,source.name);
 if(realpathSync(root)!==root||!lstatSync(root).isDirectory())throw new Error('Installed owner cannot be a workspace symlink.');
 const inventory=spawnSync('npm',['pack','--dry-run','--ignore-scripts','--json'],{cwd:sourceRoot,encoding:'utf8',timeout:120_000,maxBuffer:32*1024*1024});
 if(inventory.status!==0||inventory.error||inventory.signal)throw new Error('Native package inventory is unavailable.');
 const records=JSON.parse(inventory.stdout) as Array<{name:string;version:string;filename:string;integrity:string;entryCount:number;files:Array<{path:string;size:number;mode:number}>}>;
 if(records.length!==1)throw new Error('Native package inventory is ambiguous.');
 const pack=records[0]!;
 if(pack.name!==source.name||pack.version!==source.version||basename(pack.filename)!==pack.filename||!pack.filename.endsWith('.tgz')
  ||!Array.isArray(pack.files)||!pack.files.length||pack.entryCount!==pack.files.length
  ||pack.files.some(file=>!member(file.path)||!Number.isSafeInteger(file.size)||file.size<0||!Number.isSafeInteger(file.mode))
  ||new Set(pack.files.map(file=>file.path)).size!==pack.files.length)throw new Error('Native package inventory is incomplete.');
 const archive=resolve(installed,'..',pack.filename),archiveBytes=regular(dirname(installed),pack.filename).bytes;
 if(pack.integrity!==`sha512-${createHash('sha512').update(archiveBytes).digest('base64')}`)
  throw new Error('Held archive differs from current source package assets.');
 const listing=spawnSync('tar',['--list','--gzip','--file',archive,'--quoting-style=literal'],{encoding:'utf8',timeout:120_000,maxBuffer:32*1024*1024});
 const entries=listing.stdout.trimEnd().split('\n').filter(path=>!path.endsWith('/'));
 if(listing.status!==0||listing.error||listing.signal||JSON.stringify([...entries].sort())!==JSON.stringify(pack.files.map(file=>`package/${file.path}`).sort()))
  throw new Error('Held archive members do not match native package inventory.');
 const verbose=spawnSync('tar',['--list','--verbose','--gzip','--file',archive],{encoding:'utf8',timeout:120_000,maxBuffer:32*1024*1024});
 if(verbose.status!==0||verbose.error||verbose.signal||verbose.stdout.trimEnd().split('\n').some(line=>!['-','d'].includes(line[0]??'')))
  throw new Error('Held archive cannot contain redirected assets.');
 const files=pack.files.map(file=>{
  const unpacked=spawnSync('tar',['--extract','--to-stdout','--gzip','--file',archive,'--',`package/${file.path}`],{timeout:120_000,maxBuffer:Math.max(32*1024*1024,file.size+1)});
  const asset=regular(root,file.path);
  if(unpacked.status!==0||unpacked.error||unpacked.signal||unpacked.stdout.length!==file.size||!asset.bytes.equals(unpacked.stdout)||asset.mode!==(file.mode&0o111))
   throw new Error('Installed assets differ from the held archive.');
  return {path:file.path,sha256:digest(asset.bytes),mode:asset.mode};
 });
 const bins=declaredBins(root,files);
 if(JSON.stringify(assetPaths(root,files,bins))!==JSON.stringify(files.map(file=>file.path).sort()))
  throw new Error('Installed owner contains missing or unarchived assets.');
 const manifest=JSON.parse(regular(root,'package.json').bytes.toString('utf8')) as {name:string;version:string};
 if(manifest.name!==source.name||manifest.version!==source.version)throw new Error('Installed package identity differs from its source.');
 return {sourceRoot,root,archive,archiveSha256:digest(archiveBytes),name:source.name,version:source.version,files,bins,pack};
}
export function installedCustodyDiagnostics(owners:readonly InstalledOwner[]) {
 return owners.flatMap(owner=>{
  try {
   if(digest(regular(dirname(owner.archive),basename(owner.archive)).bytes)!==owner.archiveSha256)throw new Error();
   for(const file of owner.files) {
    const asset=regular(owner.root,file.path);
    if(digest(asset.bytes)!==file.sha256||asset.mode!==file.mode)throw new Error();
   }
   if(JSON.stringify(assetPaths(owner.root,owner.files,owner.bins))!==JSON.stringify(owner.files.map(file=>file.path).sort()))throw new Error();
   return [];
  } catch {return [`${owner.name}: Installed assets or held archive changed or became unavailable.`];}
 });
}
