import test from 'node:test';
import assert from 'node:assert/strict';
import { observedProject, listRuntimePorts } from '../src/runtime-ports.js';
test('project attribution uses observed project roots, never arbitrary directories or traversal',()=>{
 assert.equal(observedProject('~/projects/alpha/apps/web'),'alpha');
 assert.equal(observedProject('/home/fde/projects/beta'),'beta');
 for(const cwd of [null,'/opt/agent','~/projects/../private','~/projects/alpha/../../secret','~/projects/'])assert.equal(observedProject(cwd),null);
});
test('runtime DTO exposes domain identity and project, not internal names, commands or tickets',async()=>{
 const at=new Date();
 const result=await listRuntimePorts({async query(sql,params){
  assert.deepEqual(params,[45,500]);
  for(const predicate of ["u.deleted_at IS NULL", "u.status = 'active'", "c.status = 'running'", 'c.revoked_at IS NULL', 'c.user_id = u.id', 'o.observed_at >', "a.state <> 'released'"]) assert.ok(sql.includes(predicate));
  return {rows:[{id:'one',user_id:'u',login:'JXu14',display_name:'Xu, Jim(IT)',cwd:'~/projects/project/web',port:22020,branch:'dev/JXu14',allocation_id:'allocation',sampled_at:at,observed_at:at,total:'1',cmd:'secret'}]};
 }});
 assert.deepEqual(result.items,[{id:'one',user_id:'u',login:'JXu14',display_name:'Xu, Jim(IT)',project:'project',port:22020,branch:'dev/JXu14',routed:true,observed_at:at.toISOString()}]);
 assert.equal(result.total,1);
});
test('empty observations are empty, and DB failure is not disguised as no running services',async()=>{
 assert.deepEqual((await listRuntimePorts({query:async()=>({rows:[]})})).items,[]);
 await assert.rejects(()=>listRuntimePorts({query:async()=>{throw new Error('db unavailable');}}),/db unavailable/);
});
