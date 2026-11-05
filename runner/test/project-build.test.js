import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {sourcePath,buildEnvironment,readBuildOutput,executeProjectBuild} from '../lib/project-build.js';
test('build environment excludes credentials and source paths cannot escape',()=>{
  assert.equal(buildEnvironment('/tmp/build').ERIX_STATION_TOKEN,undefined);
  for(const name of ['../x','/etc/passwd','a/../../x','a\\b','.git/config','a/.git/config'])assert.throws(()=>sourcePath('/tmp/build',name));
});
test('artifact reads reject links and directories while accepting actual bytes',{skip:process.platform!=='linux'},async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'build-output-test-'));
  try{
    await fs.writeFile(path.join(root,'test.zip'),'binary');
    assert.equal((await readBuildOutput(root,'.','test.zip')).toString(),'binary');
    await fs.symlink('test.zip',path.join(root,'link.zip'));await assert.rejects(readBuildOutput(root,'.','link.zip'));
    await fs.mkdir(path.join(root,'out'));await fs.symlink('out',path.join(root,'redirect'));await fs.writeFile(path.join(root,'out','test.zip'),'no');
    await assert.rejects(readBuildOutput(root,'redirect','test.zip'));
    await assert.rejects(readBuildOutput(root,'.','out'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
test('real deterministic pipeline uploads only successful artifact; failed compile stays failed',{skip:process.platform!=='linux'},async()=>{
  async function run(command){
    const calls=[];await executeProjectBuild({id:'id',lease:'lease',delivery_target:{build:{directory:'.',output:'test.zip',command,timeout_seconds:30}}},
      {uid:process.getuid(),gid:process.getgid(),request:async(method,p,options)=>{calls.push({method,p,options});return {data:{files:[{name:'source.txt',data:Buffer.from('snapshot').toString('base64')}]}};}});return calls;
  }
  const good=await run('cat source.txt > test.zip');
  assert.equal(good.find(c=>c.p.endsWith('/artifact')).options.body.toString(),'snapshot');
  const bad=await run('exit 7');assert.ok(!bad.some(c=>c.p.endsWith('/artifact')));assert.equal(bad.at(-1).options.body.failed,true);
});
