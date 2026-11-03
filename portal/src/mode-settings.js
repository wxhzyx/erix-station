// Administrator-managed, user-scoped model assignments. Upstream credentials remain exclusively in LiteLLM;
// only the server stores chat virtual keys, never the browser or FDE container.
import { randomUUID } from 'node:crypto';
import { createLlmGatewayClient } from './llm-gateway.js';
import { LlmError, listProviders, getFdeLlmEcho, setFdeLlmConfig } from './llm.js';

const invalid = (message) => new LlmError('validation_failed', message);
const unavailable = () => new LlmError('llm_catalog_unavailable', '模型目录暂时不可用，请稍后重试', { httpStatus: 503 });
const echo = (row) => row ? {
  provider_id: row.provider_id,
  main: { model_id: row.model_id, name: row.model_name, type: row.model_type },
  api_key: 'configured',
} : null;

export async function modeCatalog(gateway) {
  let catalog;
  try { catalog = (await listProviders(gateway)).items; } catch { throw unavailable(); }
  // Explicit allow-list: credential info/values and arbitrary model metadata are
  // not public, even if the admin adapter currently redacts some of their keys.
  return catalog.map((p) => ({ id: p.id, name: p.name,
    models: p.models.map((m) => ({ id: m.id, model_id: m.model_id,
      model_name: m.model_name, name: m.name, display_name: m.name,
      type: m.type, enabled: m.enabled, tool_calling: m.tool_calling, supports_vision: m.supports_vision })) }));
}

async function activeUser(pool, userId) {
  const { rows } = await pool.query("SELECT id, fde_name FROM users WHERE id = $1 AND status = 'active'", [userId]);
  if (!rows[0]) throw new LlmError('not_found', '用户不可用', { httpStatus: 404 });
  return rows[0];
}

export async function getModeSettings(pool, userId, { gateway } = {}) {
  const user = await activeUser(pool, userId);
  const chat = await pool.query('SELECT provider_id, model_id, model_name, model_type FROM chat_llm_bindings WHERE user_id = $1', [userId]);
  const work = user.fde_name ? await getFdeLlmEcho(pool, user.fde_name) : null;
  return { chat: echo(chat.rows[0]), work: work ? {
    provider_id: work.provider_id, main: work.main, embedding: work.embedding,
    vision: work.vision, api_key: 'configured',
  } : null, providers: await modeCatalog(gateway) };
}

function validateInput(mode, input) {
  if (!['chat', 'work'].includes(mode)) throw invalid('模式必须是 chat 或 work');
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('配置必须是对象');
  const allowed = mode === 'chat' ? ['provider_id', 'main_model_id']
    : ['provider_id', 'main_model_id', 'embedding_model_id', 'vision_model_id'];
  if (Object.keys(input).some((key) => !allowed.includes(key))) throw invalid('不支持的配置字段；API 密钥由管理员在网关管理');
  for (const field of ['provider_id', 'main_model_id']) {
    if (typeof input[field] !== 'string' || !input[field].trim() || input[field].length > 255) throw invalid(`${field} 非法`);
  }
}

export async function setModeSettings(pool, userId, mode, input, { gateway, actorId = userId } = {}) {
  validateInput(mode, input);
  const user = await activeUser(pool, userId);
  if (mode === 'work') {
    if (!user.fde_name) throw new LlmError('workstation_required', '工作模式需要工位', { httpStatus: 409 });
    const result = await setFdeLlmConfig(pool, { ...input, actorId, fdeName: user.fde_name, gateway });
    return { provider_id: result.provider_id, main: result.main, embedding: result.embedding,
      vision: result.vision, api_key: 'configured' };
  }
  const providers = await modeCatalog(gateway);
  const model = providers.find((p) => p.id === input.provider_id)?.models.find((m) => m.id === input.main_model_id);
  if (!model?.enabled || !['text', 'vision'].includes(model.type)) throw invalid('聊天模型不存在、已禁用或不支持聊天');
  const client = await pool.connect();
  let generated = null;
  let old = null;
  let changedExisting = false;
  try {
    await client.query('BEGIN');
    const lock = await client.query('SELECT pg_try_advisory_xact_lock(hashtext($1)) AS locked', [`mode-chat:${userId}`]);
    if (!lock.rows[0]?.locked) throw new LlmError('chat_busy', '聊天正在发送或配置正在更新，请稍后重试', { httpStatus: 409 });
    await activeUser(client, userId); // recheck after lock: disable may have raced validation
    const current = await client.query('SELECT * FROM chat_llm_bindings WHERE user_id = $1 FOR UPDATE', [userId]);
    old = current.rows[0] ?? null;
    if (old?.model_id === model.id && old.provider_id === input.provider_id && old.model_name === model.model_name) {
      await client.query('COMMIT');
      return echo(old);
    }
    let key = old?.api_key;
    const gatewayUserId = gateway.teamId
      ? await gateway.ensureStationMember({id:userId,login:user.fde_name??`user-${userId}`}) : null;
    if (key) {
      await gateway.updateKey({ key, models: [model.model_name], ...(gatewayUserId ? {
        user_id:gatewayUserId,team_id:gateway.teamId,metadata:{fde_id:userId,mode:'chat'},
      } : {}) });
      changedExisting = true;
    } else {
      const result = await gateway.generateKey({ models: [model.model_name],
        key_alias: `station-chat-${randomUUID()}`, ...(gatewayUserId?{user_id:gatewayUserId}:{}),
        metadata: { station_user_id: userId, fde_id:userId, mode: 'chat' } });
      if (typeof result?.key !== 'string' || !result.key) throw unavailable();
      key = generated = result.key;
    }
    await client.query(`INSERT INTO chat_llm_bindings (user_id, provider_id, model_id, model_name, model_type, api_key)
      VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (user_id) DO UPDATE SET
      provider_id=EXCLUDED.provider_id, model_id=EXCLUDED.model_id, model_name=EXCLUDED.model_name,
      model_type=EXCLUDED.model_type, api_key=EXCLUDED.api_key, updated_at=now()`,
    [userId, input.provider_id, model.id, model.model_name, model.type, key]);
    await client.query('COMMIT');
    return echo({ provider_id: input.provider_id, model_id: model.id, model_name: model.model_name, model_type: model.type });
  } catch (error) {
    // Keep the transaction's advisory lock through compensation. Releasing it
    // first lets another save commit a newer whitelist that recovery overwrites.
    let recoveryFailed = false;
    try {
      if (generated) await gateway.deleteKey({ keys: [generated] });
      if (changedExisting) await gateway.updateKey({ key: old.api_key, models: [old.model_name] });
    } catch { recoveryFailed = true; }
    finally { await client.query('ROLLBACK').catch(() => {}); }
    if (recoveryFailed) throw new LlmError('llm_config_recovery_required', '配置保存失败，网关恢复失败，请联系管理员', { httpStatus: 503 });
    if (error instanceof LlmError) throw error;
    // Never propagate gateway/network/database errors carrying secrets.
    throw new LlmError('llm_config_failed', '配置保存失败，请稍后重试', { httpStatus: 502 });
  } finally { client.release(); }
}

/** Internal-only provider resolver: no fallback to work's key or model. */
export async function resolveChatLlmProvider(pool, userId, { gatewayUrl, gateway } = {}) {
  await activeUser(pool, userId);
  const { rows } = await pool.query('SELECT * FROM chat_llm_bindings WHERE user_id = $1', [userId]);
  const row = rows[0];
  if (!row) return null;
  const catalog = await modeCatalog(gateway);
  const model = catalog.find((p) => p.id === row.provider_id)?.models.find((m) => m.id === row.model_id);
  if (!model?.enabled || !['text', 'vision'].includes(model.type)) {
    throw new LlmError('llm_model_not_found', '聊天模型不可用，请联系管理员', { httpStatus: 409 });
  }
  // A renamed gateway model requires a deliberate settings save; fail closed,
  // rather than silently widening the key whitelist during a chat request.
  if (model.model_name !== row.model_name) {
    throw new LlmError('llm_config_stale', '聊天模型已变更，请联系管理员更新配置', { httpStatus: 409 });
  }
  if (!gatewayUrl || !row.api_key) throw new LlmError('llm_not_configured', '聊天 API 未配置', { httpStatus: 409 });
  return { base_url: gatewayUrl, api_key: row.api_key, model: row.model_name, supportsImages: model.supports_vision === true };
}

/** Disabled users cannot send; revoke their server-only virtual key as well.
 * Called by admin HTTP paths and the retryable offboarding step. */
export async function revokeChatLlmConfigTx(client, userId, { gateway } = {}) {
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`mode-chat:${userId}`]);
  const { rows } = await client.query('SELECT api_key FROM chat_llm_bindings WHERE user_id = $1 FOR UPDATE', [userId]);
  if (!rows[0]) return;
  const gw = typeof gateway?.deleteKey === 'function' ? gateway : createLlmGatewayClient({
    adminUrl: gateway?.llmGatewayAdminUrl, masterKey: gateway?.llmGatewayMasterKey,
  });
  try { await gw.deleteKey({ keys: [rows[0].api_key] }); }
  catch { throw new LlmError('llm_revoke_failed', '聊天 API 密钥撤销失败，请重试禁用操作', { httpStatus: 502 }); }
  await client.query('DELETE FROM chat_llm_bindings WHERE user_id = $1', [userId]);
}

export async function revokeChatLlmConfig(pool, userId, { gateway } = {}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await revokeChatLlmConfigTx(client, userId, { gateway });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    if (error instanceof LlmError) throw error;
    throw new LlmError('llm_revoke_failed', '聊天 API 密钥撤销失败，请重试禁用操作', { httpStatus: 502 });
  } finally { client.release(); }
}
