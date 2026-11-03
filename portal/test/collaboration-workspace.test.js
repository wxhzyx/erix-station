import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareWorkspace } from '../src/collaboration-workspace.js';

test('shared checkout publishes inside the member quota domain and keeps credentials out of Git config', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'station-collab-quota-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const source=path.join(root,'source'),memberRoot=path.join(root,'alice');
  await fs.mkdir(source);await fs.mkdir(path.join(memberRoot,'projects'),{recursive:true});
  const exec=promisify(execFile),git=(...args)=>exec('git',args,{cwd:source});
  await git('init','-b','main');await fs.writeFile(path.join(source,'README.md'),'retained source');
  await git('add','.');await git('-c','user.name=Test','-c','user.email=test@example.invalid','commit','-m','initial');
  await git('branch','dev/alice');
  const rename=fs.rename.bind(fs);let published=false;
  t.mock.method(fs,'rename',async(from,to)=>{
    // Emulate XFS project-ID isolation: same device does not allow crossing
    // member quota domains. The old global staging path must fail this probe.
    if(!from.startsWith(memberRoot+path.sep)||!to.startsWith(memberRoot+path.sep))throw Object.assign(new Error('quota domain'),{code:'EXDEV'});
    assert.ok(!from.startsWith(path.join(memberRoot,'projects')+path.sep));
    published=true;return rename(from,to);
  });
  await prepareWorkspace({userSpaceRoot:root,workerUid:process.getuid?.()??1002,fdeGid:process.getgid?.()??1000},
    {login:'service',token:'never-persist-this-secret'},
    {id:'project',package_id:'package',name:'alpha',repo_url:source},
    {fde_name:'alice',branch:'dev/alice',assignment_id:'assignment',user_id:'user'});
  assert.equal(published,true);
  const target=path.join(memberRoot,'projects','alpha');
  assert.equal(await fs.readFile(path.join(target,'README.md'),'utf8'),'retained source');
  assert.equal(JSON.parse(await fs.readFile(path.join(target,'.fde-assignment.json'),'utf8')).id,'assignment');
  assert.ok(!(await fs.readFile(path.join(target,'.git','config'),'utf8')).includes('never-persist-this-secret'));
  assert.deepEqual(await fs.readdir(path.join(memberRoot,'.collaboration-staging')),[]);
});
