import { appendFileSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { runOwnedCommand } from '../src/verifiers/guarantees/owned-command.ts';

export function prepareSceneAction(root:string,execute=runOwnedCommand,env:NodeJS.ProcessEnv=process.env) {
 const manifest=JSON.parse(readFileSync(resolve(root,'package.json'),'utf8')) as {dependencies?:Record<string,string>};
 const dependency=manifest.dependencies?.['@treeseed/sdk'];
 const sdk=typeof dependency==='string'?/^git\+https:\/\/github\.com\/treeseed-ai\/sdk\.git#([a-f0-9]{40})$/u.exec(dependency):null;
 if(!sdk)throw new Error('Executing Reviewer requires one exact declared SDK artifact commit.');
 const action=parse(readFileSync(resolve(root,'.github/actions/run-scenes/action.yml'),'utf8')) as {runs?:{steps?:Array<{uses?:string;with?:Record<string,unknown>}>}};
 const tools=action.runs?.steps?.filter(step=>step.uses==='erlef/setup-beam@v1');
 const otp=tools?.[0]?.with?.['otp-version'],elixir=tools?.[0]?.with?.['elixir-version'];
 if(tools?.length!==1||typeof otp!=='string'||!/^\d+\.\d+\.\d+\.\d+$/u.test(otp)
  ||typeof elixir!=='string'||!/^\d+\.\d+\.\d+$/u.test(elixir))throw new Error('Reviewer native toolchain pins are missing or ambiguous.');
 const expression='root=:code.root_dir(); release=:erlang.system_info(:otp_release); {:ok,patch}=File.read(Path.join([to_string(root),"releases",to_string(release),"OTP_VERSION"])); IO.puts(System.version()); IO.puts(String.trim(patch))';
 const observed=execute('elixir',['--erl','+S 2:2','-e',expression],{cwd:root,env,encoding:'utf8',timeout:5_000,maxBuffer:1_048_576});
 if((observed.error as NodeJS.ErrnoException|undefined)?.code==='ENOENT'&&!env.INSTALL_DIR_FOR_OTP&&!env.INSTALL_DIR_FOR_ELIXIR)
  return {sdkCommit:sdk[1]!,toolchainReady:false};
 if(observed.error||observed.signal||observed.status!==0||observed.stdout.trimEnd()!==`${elixir}\n${otp}`)
  throw new Error('Existing native toolchain is unhealthy or differs from exact Reviewer pins; live binaries cannot be replaced.');
 return {sdkCommit:sdk[1]!,toolchainReady:true};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href) {
 const root=resolve(fileURLToPath(new URL('..',import.meta.url))),output=process.env.GITHUB_OUTPUT;
 if(!output)throw new Error('GitHub action output custody is required.');
 const result=prepareSceneAction(root);
 appendFileSync(output,`sdk-commit=${result.sdkCommit}\ntoolchain-ready=${result.toolchainReady}\n`);
}
