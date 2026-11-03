import crypto from 'node:crypto';
import { AdminError } from './admin.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function validLimit(value, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0) || value > 1_000_000_000) {
    throw new AdminError('validation_failed','每日 Token 上限必须为 0～10 亿的整数');
  }
  return value;
}
export async function quotaRequest(config, userId, dailyLimit, fetchImpl = fetch) {
  if (!UUID.test(userId)) throw new AdminError('not_found','用户不存在',{httpStatus:404});
  if (!config.quotaAdminKey) throw new AdminError('quota_unavailable','额度服务尚未配置',{httpStatus:503});
  let response;
  try {
    response = await fetchImpl(`${config.llmGatewayAdminUrl.replace(/\/$/,'')}/fde-station/quota/${userId}`, {
      method:dailyLimit === undefined ? 'GET':'PUT', redirect:'error', signal:AbortSignal.timeout(15000),
      headers:{ Authorization:`Bearer ${config.quotaAdminKey}`,'Content-Type':'application/json' },
      ...(dailyLimit === undefined ? {} : {body:JSON.stringify({daily_limit:validLimit(dailyLimit)})}),
    });
  } catch { throw new AdminError('quota_unavailable','额度服务暂时不可用，请稍后重试',{httpStatus:503}); }
  if (!response.ok) throw new AdminError('quota_unavailable',`额度服务返回 HTTP ${response.status}`,{httpStatus:502});
  return response.json();
}
export async function submitQuotaRequest(pool, config, { userId, body }) {
  const requested = validLimit(body?.requested_limit,{positive:true});
  if (typeof body.reason !== 'string' || !body.reason.trim() || body.reason.length > 2000) throw new AdminError('validation_failed','请填写申请原因（最多 2000 字）');
  const quota = await quotaRequest(config,userId);
  if(requested <= quota.daily_limit) throw new AdminError('validation_failed','申请额度必须大于当前每日上限');
  const result = await pool.query(`INSERT INTO token_quota_requests(id,user_id,requested_limit,reason) VALUES($1,$2,$3,$4)
    ON CONFLICT(user_id) WHERE status='pending' DO NOTHING RETURNING id,status`,[crypto.randomUUID(),userId,requested,body.reason.trim()]);
  if (!result.rows.length) throw new AdminError('request_pending','已有待审批申请，请等待管理员处理',{httpStatus:409});
  return result.rows[0];
}
export async function listQuotaRequests(pool, userId=null) {
  return (await pool.query(`SELECT r.id,r.user_id,u.login,r.requested_limit,r.reason,r.status,r.review_note,r.created_at,r.reviewed_at
    FROM token_quota_requests r JOIN users u ON u.id=r.user_id ${userId?'WHERE r.user_id=$1':''} ORDER BY r.created_at DESC LIMIT 200`,userId?[userId]:[])).rows;
}
export async function setQuota(pool, config, { userId, actorId, dailyLimit, requestId, approve=true }) {
  if(!UUID.test(userId) || (requestId && !UUID.test(requestId))) throw new AdminError('not_found','用户或申请不存在',{httpStatus:404});
  const client=await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`quota:${userId}`]);
    const user=(await client.query(`SELECT id FROM users WHERE id=$1 AND status='active' AND fde_name IS NOT NULL`,[userId])).rows[0];
    if(!user) throw new AdminError('not_found','用户不存在或工位未开通',{httpStatus:404});
    if(requestId) {
      const request=(await client.query(`SELECT * FROM token_quota_requests WHERE id=$1 AND user_id=$2 FOR UPDATE`,[requestId,userId])).rows[0];
      if(!request) throw new AdminError('not_found','申请不存在',{httpStatus:404});
      if(request.status!=='pending') throw new AdminError('request_reviewed','申请已处理',{httpStatus:409});
      dailyLimit=Number(request.requested_limit);
    }
    let result;
    if(approve) {
      validLimit(dailyLimit);
      // An upgrade approval must never lower a limit another administrator already raised.
      if(requestId) dailyLimit=Math.max(dailyLimit,(await quotaRequest(config,userId)).daily_limit);
      result=await quotaRequest(config,userId,dailyLimit);
    }
    if(requestId) await client.query(`UPDATE token_quota_requests SET status=$2,reviewed_by=$3,reviewed_at=now() WHERE id=$1`,
      [requestId,approve?'approved':'rejected',actorId]);
    await client.query(`INSERT INTO audit_log(actor_id,action,target,details) VALUES($1,$2,$3,$4)`,
      [actorId,approve?'quota.limit_updated':'quota.request_rejected',userId,JSON.stringify({daily_limit:dailyLimit,request_id:requestId??null})]);
    await client.query('COMMIT'); return result??{status:'rejected'};
  } catch(e) {await client.query('ROLLBACK');throw e;} finally {client.release();}
}
