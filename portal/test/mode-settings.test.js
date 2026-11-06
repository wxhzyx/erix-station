import test from 'node:test';
import assert from 'node:assert/strict';
import { modeCatalog, getModeSettings, setModeSettings, resolveChatLlmProvider, resolveDocumentLlmProvider, revokeChatLlmConfig } from '../src/mode-settings.js';

const secret = 'synthetic-secret-do-not-echo';
function fixture() {
  const users = new Map([['alice', { id: 'alice', fde_name: null }], ['bob', { id: 'bob', fde_name: null }]]);
  const bindings = new Map();
  const calls = [];
  const models = [{ model_name: 'chat-one', litellm_params: { litellm_credential_name: 'provider', api_key: secret },
    model_info: { id: 'model-1', type: 'text', tool_calling: false, metadata: { secret } } }];
  const gateway = {
    listCredentials: async () => ({ credentials: [{ credential_name: 'provider', credential_values: { api_key: secret }, credential_info: { secret } }] }),
    listModels: async () => ({ data: models }),
    generateKey: async (body) => { calls.push(['generate', body]); return { key: secret }; },
    updateKey: async (body) => { calls.push(['update', body]); },
    deleteKey: async (body) => { calls.push(['delete', body]); },
  };
  let snapshot;
  const pool = {
    locked: true,
    failInsert: false,
    connect: async () => pool,
    release() {},
    async query(sql, args = []) {
      if (sql === 'BEGIN') { snapshot = new Map(bindings); return { rows: [] }; }
      if (sql === 'ROLLBACK') { bindings.clear(); for (const [k,v] of snapshot) bindings.set(k,v); return { rows: [] }; }
      if (sql === 'COMMIT') return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('DELETE FROM chat_llm_bindings')) { bindings.delete(args[0]); return { rows: [] }; }
      if (sql.includes('pg_try_advisory_xact_lock')) { assert.deepEqual(args, ['mode-chat:alice']); return { rows: [{ locked: pool.locked }] }; }
      if (sql.includes('FROM users WHERE id')) return { rows: users.has(args[0]) ? [users.get(args[0])] : [] };
      if (sql.includes('FROM chat_llm_bindings')) return { rows: bindings.has(args[0]) ? [bindings.get(args[0])] : [] };
      if (sql.includes('INSERT INTO chat_llm_bindings')) {
        if (pool.failInsert) throw new Error(secret);
        const [user_id,provider_id,model_id,model_name,model_type,api_key] = args;
        bindings.set(user_id, { user_id,provider_id,model_id,model_name,model_type,api_key });
        return { rows: [] };
      }
      throw new Error(`unexpected SQL: ${sql}`);
    },
  };
  return { pool, gateway, bindings, calls, models, users };
}
const selection = { provider_id: 'provider', main_model_id: 'model-1' };

test('chat key joins the same station identity and team used by the work quota', async () => {
  const f = fixture();
  f.gateway.teamId = 'fde-team';
  f.gateway.ensureStationMember = async ({id}) => `fde-${id}`;
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  const generated = f.calls.find(([type])=>type==='generate')[1];
  assert.equal(generated.user_id,'fde-alice');
  assert.equal(generated.metadata.fde_id,'alice');
  assert.equal(generated.metadata.mode,'chat');
});

test('catalog allow-list strips arbitrary secrets and API URLs', async () => {
  const f = fixture();
  const catalog = await modeCatalog(f.gateway);
  assert.equal(catalog[0].models[0].tool_calling, false);
  assert.ok(!JSON.stringify(catalog).includes(secret));
  assert.ok(!JSON.stringify(catalog).includes('credential_values'));
});

test('seatless user configures standalone chat; independent read cannot see another user', async () => {
  const f = fixture();
  const result = await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  assert.equal(result.api_key,'configured');
  assert.equal(f.calls[0][1].metadata.station_user_id,'alice');
  assert.deepEqual(f.calls[0][1].models,['chat-one']);
  const alice = await getModeSettings(f.pool,'alice',{gateway:f.gateway});
  const bob = await getModeSettings(f.pool,'bob',{gateway:f.gateway});
  assert.ok(alice.chat); assert.equal(alice.work,null); assert.equal(bob.chat,null);
  assert.ok(!JSON.stringify(alice).includes(secret));
  const provider = await resolveChatLlmProvider(f.pool,'alice',{gateway:f.gateway,gatewayUrl:'https://gateway.invalid'});
  assert.equal(provider.api_key,secret); assert.equal(provider.model,'chat-one');
  assert.equal(await resolveChatLlmProvider(f.pool,'bob',{gateway:f.gateway,gatewayUrl:'https://gateway.invalid'}),null);
  await assert.rejects(setModeSettings(f.pool,'alice','work',selection,{gateway:f.gateway}), {code:'workstation_required'});
});

test('validation rejects secrets, arbitrary URL, owner override, invalid modes and cross-provider model', async () => {
  const f = fixture();
  for (const extra of [{api_key:secret},{base_url:'http://127.0.0.1'},{user_id:'bob'},{force:true}]) {
    await assert.rejects(setModeSettings(f.pool,'alice','chat',{...selection,...extra},{gateway:f.gateway}),{code:'validation_failed'});
  }
  await assert.rejects(setModeSettings(f.pool,'alice','other',selection,{gateway:f.gateway}),{code:'validation_failed'});
  await assert.rejects(setModeSettings(f.pool,'alice','chat',{...selection,provider_id:'other'},{gateway:f.gateway}),{code:'validation_failed'});
  assert.equal(f.calls.length,0);
});

test('repeat same save does not mint keys; in-flight chat prevents settings mutation', async () => {
  const f=fixture();
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  assert.equal(f.calls.length,1);
  f.pool.locked=false;
  await assert.rejects(setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway}),{code:'chat_busy'});
  assert.equal(f.calls.length,1);
});

test('failed DB save revokes newly generated key and never echoes errors', async () => {
  const f=fixture(); f.pool.failInsert=true;
  await assert.rejects(setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway}), (e) => e.code==='llm_config_failed' && !e.message.includes(secret));
  assert.deepEqual(f.calls.map((c)=>c[0]),['generate','delete']);
  assert.equal(f.bindings.size,0);
});

test('changed model updates only chat key and compensates failed DB write', async () => {
  const f=fixture();
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  f.models[0].model_name='chat-renamed'; f.pool.failInsert=true;
  await assert.rejects(setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway}),{code:'llm_config_failed'});
  assert.deepEqual(f.calls.slice(-2).map((c)=>c[1].models),[['chat-renamed'],['chat-one']]);
  assert.equal(f.bindings.get('alice').model_name,'chat-one');
});

test('resolver fails closed for renamed/blocked models and inactive owner', async () => {
  const f=fixture();
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  const opts={gateway:f.gateway,gatewayUrl:'https://gateway.invalid'};
  f.models[0].model_name='renamed';
  await assert.rejects(resolveChatLlmProvider(f.pool,'alice',opts),{code:'llm_config_stale'});
  f.models[0].model_info.blocked=true;
  await assert.rejects(resolveChatLlmProvider(f.pool,'alice',opts),{code:'llm_model_not_found'});
  f.users.delete('alice');
  await assert.rejects(resolveChatLlmProvider(f.pool,'alice',opts),{code:'not_found'});
});

test('disable/offboard revokes chat key, removes binding, and repeated revoke is safe', async () => {
  const f=fixture();
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  await revokeChatLlmConfig(f.pool,'alice',{gateway:f.gateway});
  await revokeChatLlmConfig(f.pool,'alice',{gateway:f.gateway});
  assert.equal(f.bindings.size,0);
  assert.deepEqual(f.calls.map((c)=>c[0]),['generate','delete']);
});
test('failed gateway revocation retains key for retry without leaking upstream errors', async () => {
  const f=fixture();
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  f.gateway.deleteKey=async()=>{throw new Error(secret);};
  await assert.rejects(revokeChatLlmConfig(f.pool,'alice',{gateway:f.gateway}), (e)=>e.code==='llm_revoke_failed'&&!e.message.includes(secret));
  assert.equal(f.bindings.size,1);
});

test('member deletion blocks the chat key and retains LiteLLM historical key records',async()=>{
  const f=fixture();await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  const blocked=[];f.gateway.blockKey=async body=>{blocked.push(body);};
  f.gateway.deleteKey=async()=>assert.fail('historical key must not be deleted');
  await revokeChatLlmConfig(f.pool,'alice',{gateway:f.gateway,preserveHistory:true});
  await revokeChatLlmConfig(f.pool,'alice',{gateway:f.gateway,preserveHistory:true});
  assert.equal(blocked.length,1);assert.ok(blocked[0].key);assert.equal(f.bindings.size,0);
});

test('failed save compensates while advisory lock is held, then rolls back', async () => {
  const f=fixture();
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  f.models[0].model_name='chat-renamed'; f.pool.failInsert=true;
  const events=[];
  const query=f.pool.query.bind(f.pool);
  f.pool.query=async(sql,args)=>{ if(sql==='ROLLBACK') events.push('rollback'); return query(sql,args); };
  f.gateway.updateKey=async(body)=>{ events.push(body.models[0]); };
  await assert.rejects(setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway}),{code:'llm_config_failed'});
  assert.deepEqual(events,['chat-renamed','chat-one','rollback']);
});

test('compensation failure still rolls back before returning sanitized recovery error', async () => {
  const f=fixture();
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  f.models[0].model_name='chat-renamed'; f.pool.failInsert=true;
  const events=[];
  const query=f.pool.query.bind(f.pool);
  f.pool.query=async(sql,args)=>{ if(sql==='ROLLBACK') events.push('rollback'); return query(sql,args); };
  f.gateway.updateKey=async(body)=>{ events.push(body.models[0]); if(body.models[0]==='chat-one') throw new Error(secret); };
  await assert.rejects(setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway}),e=>e.code==='llm_config_recovery_required'&&!e.message.includes(secret));
  assert.deepEqual(events,['chat-renamed','chat-one','rollback']);
});


test('Qwen text models use explicit gateway vision capability, with false overriding legacy type', async () => {
  const f = fixture();
  f.models[0].model_info.supports_vision = true;
  await setModeSettings(f.pool,'alice','chat',selection,{gateway:f.gateway});
  const resolve = () => resolveChatLlmProvider(f.pool,'alice',{gateway:f.gateway,gatewayUrl:'https://gateway.invalid'});
  assert.equal((await modeCatalog(f.gateway))[0].models[0].type,'text');
  assert.equal((await resolve()).supportsImages,true);
  f.models[0].model_info.supports_vision = false;
  f.models[0].model_info.type = 'vision';
  assert.equal((await resolve()).supportsImages,false);
  delete f.models[0].model_info.supports_vision;
  assert.equal((await resolve()).supportsImages,true);
  f.models[0].model_info.type = 'text';
  f.models[0].model_info.metadata.supports_vision = true;
  assert.equal((await resolve()).supportsImages,true);
  delete f.models[0].model_info.metadata.supports_vision;
  assert.equal((await resolve()).supportsImages,false);
});

test('document vision uses only the requested member mode binding and respects catalog capability', async () => {
  const f = fixture();
  f.models[0].model_info.supports_vision = true;
  await setModeSettings(f.pool, 'alice', 'chat', selection, { gateway: f.gateway });
  const options = { gateway: f.gateway, gatewayUrl: 'https://gateway.invalid' };
  assert.equal((await resolveDocumentLlmProvider(f.pool, 'alice', 'chat', options)).api_key, secret);
  const original = f.pool.query;
  const binding = { provider_id: 'provider', api_key: 'work-personal-key', main_model_id: 'model-1', main_model_name: 'chat-one' };
  f.pool.query = async (sql, args) => sql.includes('FROM fde_llm_bindings') ? { rows: args[0] === 'alice' ? [binding] : [] } : original(sql, args);
  assert.equal((await resolveDocumentLlmProvider(f.pool, 'alice', 'work', options)).api_key, 'work-personal-key');
  assert.equal(await resolveDocumentLlmProvider(f.pool, 'bob', 'work', options), null);
  f.models[0].model_info.supports_vision = false;
  assert.equal(await resolveDocumentLlmProvider(f.pool, 'alice', 'work', options), null);
  await assert.rejects(resolveDocumentLlmProvider(f.pool, 'alice', 'other', options), { code: 'validation_failed' });
});
