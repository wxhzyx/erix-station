import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { streamChatResponse } from '../src/chat-response.js';
test('HTTP response flushes deltas before done and cancels work on client disconnect',async t=>{
  let finish, aborted;
  const cancelled=new Promise(r=>{aborted=r;});
  const gate=new Promise(r=>{finish=r;});
  const server=http.createServer((req,res)=>{void streamChatResponse(res,async({onStart,onDelta,signal})=>{
    signal.addEventListener('abort',()=>{aborted();finish();},{once:true});
    onStart();await onDelta('first');await gate;signal.throwIfAborted();return {messages:[]};
  });});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.closeAllConnections();server.close();});
  const controller=new AbortController();const response=await fetch(`http://127.0.0.1:${server.address().port}`,{signal:controller.signal});
  assert.equal(response.headers.get('x-accel-buffering'),'no');
  const reader=response.body.getReader();assert.match(new TextDecoder().decode((await reader.read()).value),/event: delta/);
  controller.abort();await cancelled;
});
