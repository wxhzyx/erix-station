import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { stopMemberContainers } from '../src/offboarding.js';
import { deleteAssignment } from '../src/managed-projects.js';

const labels = name => ({ 'station.managed':'true', 'fde.name':name, 'station.stack':'test' });
test('member removal includes stopped/orphan containers, preserves other owners and verifies completion', async () => {
  const live = new Map(['running','stopped','orphan'].map(Id => [Id,{Id,Labels:labels('alice')}]));
  live.set('bob',{Id:'bob',Labels:labels('bob')});
  live.set('other-stack',{Id:'other-stack',Labels:{...labels('alice'),'station.stack':'elsewhere'}});
  let updated = false;
  const pool={async query(sql){if(sql.startsWith('SELECT'))return {rows:[{container_name:'running'}]};updated=true;return {rows:[]};}};
  const docker={
    async listContainers(_filter,options){assert.equal(options.all,true);return {status:200,data:[...live.values()]};},
    async inspectContainer(id){const c=live.get(id);return c?{status:200,data:{Id:id,Config:{Labels:c.Labels}}}:{status:404};},
    async stopContainer(){return {status:304};},
    async removeContainer(id){live.delete(id);return {status:204};},
  };
  await stopMemberContainers(pool,{fde_id:'user',fde_name:'alice'},docker,{}, {stackId:'test'});
  assert.deepEqual([...live.keys()],['bob','other-stack']);assert.equal(updated,true);
  updated=false;
  pool.query=async sql=>{if(sql.startsWith('SELECT'))return {rows:[{container_name:'bob'}]};updated=true;return {rows:[]};};
  await assert.rejects(stopMemberContainers(pool,{fde_id:'user',fde_name:'alice'},docker,{}, {stackId:'test'}),/ownership/);
  assert.equal(updated,false);assert.equal(live.has('bob'),true);
});

async function fixture(t) {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'station-delete-project-'));
  t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const row={id:'00000000-0000-4000-8000-000000000001',package_id:'pkg',name:'alpha',user_id:'alice-id',fde_name:'alice'};
  const target=path.join(root,'alice','projects','alpha');
  await fs.mkdir(target,{recursive:true});
  await fs.writeFile(path.join(target,'.fde-assignment.json'),JSON.stringify({id:row.id,package_id:row.package_id}));
  const other=path.join(root,'alice','projects','beta');await fs.mkdir(other);await fs.writeFile(path.join(other,'work.txt'),'retain');
  const queries=[];let busy=false;
  const client={release(){},async query(sql,args){queries.push({sql,args});
    if(sql.includes('SELECT a.*'))return {rows:[row]};
    if(sql.includes('SELECT r.id'))return {rows:busy?[{id:'run'}]:[]};
    if(sql.includes('SET deleted_at='))row.deleted_at=new Date();
    if(sql.includes('SET cleanup_completed_at='))row.cleanup_completed_at=new Date();
    return {rows:[]};
  }};
  return {row,target,other,queries,setBusy(v){busy=v;},remove:confirmation=>deleteAssignment({connect:async()=>client},{id:row.id,actorId:'admin',confirmation,config:{userSpaceRoot:root}})};
}
test('project deletion is scoped, confirmed, retryable, and retains attribution without upstream writes',async t=>{
  const f=await fixture(t);await assert.rejects(f.remove('wrong'),{code:'confirmation_required'});
  f.setBusy(true);await assert.rejects(f.remove('alpha'),{code:'project_busy'});assert.equal(f.row.deleted_at,undefined);
  f.setBusy(false);await f.remove('alpha');await f.remove('alpha');
  await assert.rejects(fs.stat(f.target),{code:'ENOENT'});assert.equal(await fs.readFile(path.join(f.other,'work.txt'),'utf8'),'retain');
  assert.ok(f.row.cleanup_completed_at);
  assert.ok(f.queries.some(q=>q.sql.includes("status='archived'") && q.args[1]==='~/projects/alpha'));
  assert.equal(f.queries.some(q=>/DELETE FROM|usage_ledger|litellm|fde_git_accounts/.test(q.sql)),false);
});
test('failed assignment cannot delete an unrelated existing directory; cleanup remains retryable',async t=>{
  const f=await fixture(t);await fs.writeFile(path.join(f.target,'.fde-assignment.json'),JSON.stringify({id:'someone-else'}));
  await assert.rejects(f.remove('alpha'),/ownership/);assert.equal(f.row.cleanup_completed_at,undefined);
  assert.ok((await fs.stat(f.target)).isDirectory());
});
test('project deletion refuses a symlink marker rather than reading an external owner file',async t=>{
  if(process.platform==='win32')return t.skip('POSIX symlink test runs in Linux release validation');
  const f=await fixture(t);const marker=path.join(f.target,'.fde-assignment.json');await fs.unlink(marker);
  await fs.symlink(path.join(f.other,'work.txt'),marker);
  await assert.rejects(f.remove('alpha'),/symlink/);assert.equal(await fs.readFile(path.join(f.other,'work.txt'),'utf8'),'retain');
});
