import {createHash} from 'node:crypto';
import {constants,openSync,closeSync,lstatSync,fstatSync,readFileSync} from 'node:fs';

/** Retain only explicitly written JSON; stdout and assertion payloads stay private. */
export function nativeObservation(path:string):{sha256:string}|undefined {
 let original:ReturnType<typeof lstatSync>;
 try{original=lstatSync(path);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
 const valid=(value:ReturnType<typeof lstatSync>)=>value.isFile()&&!value.isSymbolicLink()&&value.nlink===1&&(value.mode&0o444)!==0&&value.size>0&&value.size<=8*1024*1024;
 if(!valid(original))throw new Error('Native owner observation is not a bounded readable regular file.');
 const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
 try{
  const before=fstatSync(fd);if(!valid(before)||before.dev!==original.dev||before.ino!==original.ino)throw new Error('Native owner observation moved before inspection.');
  const bytes=readFileSync(fd);JSON.parse(bytes.toString('utf8'));const after=fstatSync(fd),current=lstatSync(path);
  for(const value of [after,current])if(!valid(value)||value.dev!==before.dev||value.ino!==before.ino||value.size!==before.size||value.mode!==before.mode||value.mtimeMs!==before.mtimeMs||value.ctimeMs!==before.ctimeMs)throw new Error('Native owner observation changed during inspection.');
  return{sha256:createHash('sha256').update(bytes).digest('hex')};
 }finally{closeSync(fd);}
}
