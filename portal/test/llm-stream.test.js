import test from 'node:test';
import assert from 'node:assert/strict';
import { chatCompletion } from '../src/llm-chat.js';
import { createSecretFilter } from '../src/llm-stream.js';
const provider = { base_url: 'https://synthetic.invalid', api_key: 'synthetic-secret', model: 'test' };
const encode = s => new TextEncoder().encode(s);
const chunk = text => `data: ${JSON.stringify({choices:[{delta:{content:text}}]})}\r\n\r\n`;
test('emits UTF-8 deltas before upstream completion and requests usage accounting', async () => {
  let stream, request, firstResolve;
  const first = new Promise(r => { firstResolve = r; });
  const seen = [];
  const result = chatCompletion({ provider, messages:[{role:'user',content:'test'}], stream:true, log:null,
    fetchImpl: async (_url, init) => { request=JSON.parse(init.body); return new Response(new ReadableStream({start(c){stream=c;}}),{headers:{'content-type':'text/event-stream'}}); },
    onDelta: text => {seen.push(text);firstResolve();} });
  await new Promise(r=>setImmediate(r));
  for(const byte of encode(chunk('你好'))) stream.enqueue(Uint8Array.of(byte));
  await first; assert.deepEqual(seen,['你好']);
  stream.enqueue(encode(chunk('世界')+'data: {"choices":[],"usage":{"total_tokens":8}}\n\ndata: [DONE]\n\n'));
  assert.equal((await result).text,'你好世界');
  assert.equal(request.stream,true);assert.deepEqual(request.stream_options,{include_usage:true});assert.equal(request.max_tokens,512);
});
test('truncated/error streams are failures, not successfully completed text',async()=>{
  for(const tail of ['', 'data: {"error":{"message":"hidden"}}\n\n']){
    await assert.rejects(chatCompletion({provider,messages:[{role:'user'}],stream:true,log:null,fetchImpl:async()=>new Response(chunk('partial')+tail,{headers:{'content-type':'text/event-stream'}})}),{code:'llm_upstream_failed'});
  }
});
test('caller cancellation and deadline cancel stalled response consumption',async()=>{
  for(const cancelled of [true,false]){
    let wasCancelled=false;const controller=new AbortController();
    const pending=chatCompletion({provider,messages:[{role:'user'}],stream:true,signal:controller.signal,timeoutMs:50,log:null,
      fetchImpl:async()=>new Response(new ReadableStream({cancel(){wasCancelled=true;}}),{headers:{'content-type':'text/event-stream'}})});
    if(cancelled)setTimeout(()=>controller.abort(),10);
    await assert.rejects(pending,{code:'llm_upstream_failed'});assert.equal(wasCancelled,true);
  }
});
test('known credential is redacted across every possible token boundary',async()=>{
  for(let split=1;split<provider.api_key.length;split++){
    let text='';const filter=createSecretFilter(provider.api_key,s=>{text+=s;});
    await filter.push('Answer '+provider.api_key.slice(0,split));assert.equal(text,'Answer ');
    await filter.push(provider.api_key.slice(split)+' end');await filter.finish();assert.equal(text,'Answer [redacted] end');
  }
});
