import { readFile, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { parse } from 'dotenv';
const forbidden=path=>/(^|\/)(\.env(?!\.example$)|\.remote-devices|\.routing-state|\.logs|\.secrets|device\.json|node_modules)(\/|\.|$)/i.test(path);
let secrets=[];
try{secrets=Object.entries(parse(await readFile('.env'))).filter(([name,value])=>/TOKEN|SECRET|PASSWORD/i.test(name)&&value.length>=16).map(([,value])=>Buffer.from(value));}catch{}
const staged=execFileSync('git',['ls-files','-z'],{encoding:'utf8'}).split('\0').filter(Boolean);
if(!staged.length)throw Error('No staged/tracked source files to audit.');
for(const path of staged){if(forbidden(path))throw Error(`Private/runtime file is tracked: ${path}`);const bytes=await readFile(path);if(secrets.some(secret=>bytes.includes(secret)))throw Error(`Private credential detected in ${path}`);}
const archive='companion/dist/win-unpacked/resources/app.asar';
if(process.argv.includes('--source-only'))console.log(`Source audit passed: ${staged.length} files; private state and known host credentials excluded.`);
else{
  await stat(archive);
  const require=createRequire(new URL('../companion/package.json',import.meta.url));
  const {listPackage,extractFile}=require('@electron/asar');
  const files=listPackage(archive).map(path=>path.replace(/^[/\\]/,'').replaceAll('\\','/'));
  for(const path of files){if(forbidden(path))throw Error(`Forbidden file in installer application: ${path}`);try{const bytes=extractFile(archive,path);if(secrets.some(secret=>bytes.includes(secret)))throw Error(`Private credential detected in installer: ${path}`);}catch(error){if(error.message?.includes('Private credential'))throw error;}}
  for(const required of ['build/main.cjs','build/preload.cjs','ui/index.html','ui/app.js','ui/style.css','defaults.json'])if(!files.includes(required))throw Error(`Installer is missing ${required}`);
  for(const required of ['audio/ffmpeg.exe','audio/ffmpeg.exe.LICENSE','audio/ffmpeg.exe.README','audio/svcl/svcl.exe','audio/svcl/readme.txt','audio/svcl/svcl.chm','licenses/ws-LICENSE'])await stat('companion/dist/win-unpacked/resources/'+required);
  console.log(`Release audit passed: ${staged.length} source files and ${files.length} archive entries; no private state or known host credentials; runtime assets present.`);
}
