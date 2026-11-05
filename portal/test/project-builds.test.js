import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { validateDeliveryTarget } from '../src/delivery-target.js';
import { requestBuild, leasedBuild, downloadableBuild, buildArtifactPath, saveBuildArtifact } from '../src/project-builds.js';
const id='00000000-0000-4000-8000-000000000001';
const desktop={type:'desktop',build:{directory:'.',command:'npm run build:test',output:'dist/test.zip',timeout_seconds:300}};
test('old packages default to web; desktop contract is administrator-owned and bounded',()=>{
  assert.deepEqual(validateDeliveryTarget(),{type:'web'});
  assert.deepEqual(validateDeliveryTarget(desktop),desktop);
  for(const build of [{...desktop.build,output:'../private.exe'},{...desktop.build,directory:'/root'},
    {...desktop.build,output:'dist/*'},{...desktop.build,timeout_seconds:999999},{...desktop.build,command:''}]) {
    assert.throws(()=>validateDeliveryTarget({type:'desktop',build}),{code:'invalid_delivery_target'});
  }
});
test('test build pins server-resolved personal branch and ignores client branch/command',async()=>{
  const queries=[],calls=[];
  const db={async query(sql,args){queries.push({sql,args});return {rows:[{id}]};}};
  const params={project:{id,state:'active',delivery_target:desktop},member:{state:'active',branch:'dev/jxu14'},
    user:{id},repo:'/repos/fde/project',api:async(...args)=>{calls.push(args);return {commit:{id:'a'.repeat(40)}};}};
  await requestBuild(db,params);
  assert.equal(calls[0][1],'/repos/fde/project/branches/dev%2Fjxu14');
  assert.deepEqual(queries[0].args.slice(1,5),[id,id,'dev/jxu14','a'.repeat(40)]);
  assert.deepEqual(JSON.parse(queries[0].args[5]),desktop);
  await assert.rejects(requestBuild(db,{...params,member:{state:'invited'}}),{code:'forbidden'});
  await assert.rejects(requestBuild(db,{...params,project:{...params.project,delivery_target:{type:'web'}}}),{code:'not_desktop'});
  await assert.rejects(requestBuild({...db,query:async()=>({rows:[]})},params),{code:'build_in_progress'});
});
test('execution needs matching owner and live lease; revoked members cannot download',async()=>{
  const seen=[]; const db={async query(sql,args){seen.push({sql,args});return {rows:[]};}};
  await assert.rejects(leasedBuild(db,id,id,'b'.repeat(64)),{code:'build_lease_lost'});
  assert.equal(seen[0].args[1],id);assert.notEqual(seen[0].args[2],'b'.repeat(64));
  assert.match(seen[0].sql,/m.state='active'/);assert.match(seen[0].sql,/lease_expires_at>now\(\)/);
  await assert.rejects(downloadableBuild(db,{artifactsRoot:'/unused'},{id,role:'fde'},id),{code:'not_found'});
  assert.equal(seen.at(-1).args[2],false);assert.match(seen.at(-1).sql,/m.state='active'/);
  assert.throws(()=>buildArtifactPath('/unused','../../private'),{code:'not_found'});
});
test('artifact persistence records exact bytes, checksum and unique downloadable version',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'build-store-'));let written;
  const db={async query(sql,args){if(sql.startsWith('UPDATE')){written=args;return {rows:[{id}]};}
    return {rows:[{id,repo_name:'desktop',source_sha:'a'.repeat(40),delivery_target:desktop}]};}};
  try{
    await saveBuildArtifact(db,{artifactsRoot:root},id,id,'b'.repeat(64),[Buffer.from('abc'),Buffer.from('def')]);
    assert.equal((await fs.readFile(buildArtifactPath(root,id))).toString(),'abcdef');
    assert.equal(written[3],'desktop-aaaaaaaa-00000000.zip');assert.equal(written[4],6);
    assert.equal(written[5],crypto.createHash('sha256').update('abcdef').digest('hex'));
  }finally{await fs.rm(root,{recursive:true,force:true});}
});
