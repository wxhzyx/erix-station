import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {cleanupProjectProcesses} from '../lib/project-cleanup.js';
test('cleanup signals only the removed project and restores runtime identity',()=>{
  let uid=1001;const calls=[];const root=path.resolve('/home/fde');
  const procs={91:{uid:1002,cwd:path.join(root,'projects','alpha')},92:{uid:1002,cwd:path.join(root,'projects','alpha-other')},93:{uid:1001,cwd:path.join(root,'projects','alpha')},94:{uid:1000,cwd:path.join(root,'projects','alpha','web')}};
  const fsImpl={readdirSync:()=>Object.keys(procs),statSync:p=>procs[path.basename(p)],readlinkSync:p=>procs[path.basename(path.dirname(p))].cwd};
  const identity={getuid:()=>uid,setuid:v=>uid=v};
  assert.equal(cleanupProjectProcesses({name:'alpha',home:root,fsImpl,identity,kill:(pid,sig)=>calls.push([pid,sig])}),false);
  assert.deepEqual(calls,[[94,'SIGKILL'],[91,'SIGKILL']]);assert.equal(uid,1001);
  assert.throws(()=>cleanupProjectProcesses({name:'../beta',home:root,fsImpl,identity}),/Invalid/);
});
test('inspection failure is not acknowledged as successful cleanup',()=>{
  let uid=1001;const identity={getuid:()=>uid,setuid:v=>uid=v};
  assert.throws(()=>cleanupProjectProcesses({name:'alpha',home:'/home/fde',identity,fsImpl:{readdirSync(){throw new Error('proc unavailable');}}}),/proc unavailable/);
  assert.equal(uid,1001);
});
