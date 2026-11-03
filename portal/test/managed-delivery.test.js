import test from 'node:test';
import assert from 'node:assert/strict';
import { readDeliveryPackage, validatePackagePath } from '../src/delivery-package.js';
import { validateAssignment, assertAssigned } from '../src/managed-projects.js';
import { createSession } from '../src/sessions.js';
import { validLimit, quotaRequest, submitQuotaRequest } from '../src/token-quota.js';

function zipStored(entries) {
  const local=[], central=[];let offset=0;
  for(const [name,body='hello',mode=0o100644] of entries) {
    const n=Buffer.from(name),data=Buffer.from(body); const h=Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50);h.writeUInt16LE(20,4);h.writeUInt16LE(0x800,6);
    h.writeUInt32LE(data.length,18);h.writeUInt32LE(data.length,22);h.writeUInt16LE(n.length,26);
    local.push(h,n,data); const c=Buffer.alloc(46); c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x314,4);c.writeUInt16LE(20,6);c.writeUInt16LE(0x800,8);
    c.writeUInt32LE(data.length,20);c.writeUInt32LE(data.length,24);c.writeUInt16LE(n.length,28);
    c.writeUInt32LE((mode*65536)>>>0,38);c.writeUInt32LE(offset,42);central.push(c,n);offset+=h.length+n.length+data.length;
  }
  const dir=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(dir.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...local,dir,end]);
}
test('ZIP package unwraps common folder and preserves Chinese instructions and binary bytes',async()=>{
  const result=await readDeliveryPackage(zipStored([['crg/AGENTS.md','开发规范'],['crg/config/example.json','{}']]));
  assert.deepEqual(result.map(x=>x.name),['AGENTS.md','config/example.json']);assert.equal(result[0].data.toString(),'开发规范');
});
test('ZIP rejects traversal, git metadata, links, duplicate paths and invalid archives',async()=>{
  for(const name of ['../secret','/etc/passwd','a/../../secret','a\\b','a/.git/config','C:/a','a//b','a/./b']) assert.throws(()=>validatePackagePath(name));
  for(const entries of [[['a/link','target',0o120777]],[['a.md','1'],['A.md','2']],[['.git/config','bad']]]) await assert.rejects(readDeliveryPackage(zipStored(entries)),{code:'invalid_package'});
  await assert.rejects(readDeliveryPackage(Buffer.from('invalid')),{code:'invalid_package'});
});
test('assignment validation rejects caller supplied arbitrary filesystem paths',()=>{
  const base={user_id:'00000000-0000-4000-8000-000000000001',package_id:'00000000-0000-4000-8000-000000000002',name:'crg-dev'};
  assert.equal(validateAssignment(base).instructions,'');
  for(const name of ['../a','/tmp/x','--config','A','a/b','a\nb']) assert.throws(()=>validateAssignment({...base,name}));
});
test('managed sessions reject unassigned project before any filesystem/user writes',async()=>{
  const queries=[]; const pool={release(){},async connect(){return this;},async query(sql,args){queries.push({sql,args});return {rows:[]};}};
  await assert.rejects(createSession(pool,{userId:'u1',projectId:'~/projects/manual',config:{managedProjects:true,userSpaceRoot:'/must/not/write'}}),{code:'project_not_assigned'});
  assert.deepEqual(queries.find(x=>x.sql.includes('FROM project_assignments')).args,['u1','manual']);
  assert.equal(queries.at(-1).sql,'ROLLBACK');
  await assertAssigned({query:async()=>({rows:[{id:'assigned'}]})},'u1','~/projects/assigned');
});
test('quota limits are integers, zero blocks use, and unavailable gateway fails closed',async()=>{
  assert.equal(validLimit(0),0);assert.equal(validLimit(2000000),2000000);
  for(const n of [-1,1.5,'2000000',NaN,1000000001])assert.throws(()=>validLimit(n));
  await assert.rejects(quotaRequest({},'00000000-0000-4000-8000-000000000001'),{code:'quota_unavailable'});
  await assert.rejects(quotaRequest({quotaAdminKey:'secret',llmGatewayAdminUrl:'https://gateway.invalid'},'00000000-0000-4000-8000-000000000001',undefined,async()=>{throw new Error('secret');}),e=>e.code==='quota_unavailable'&&!e.message.includes('secret'));
});
test('invalid upgrade request never reaches external quota service or writes DB',async()=>{
  await assert.rejects(submitQuotaRequest({query(){throw new Error('must not write');}},{},{userId:'u',body:{requested_limit:0,reason:'more'}}),{code:'validation_failed'});
});
