import fs from 'node:fs/promises';
import path from 'node:path';
import { AdminError } from './admin.js';
import { assertSafePath } from './fsutil.js';

export function failure(code, message, httpStatus = 409) { return new AdminError(code, message, { httpStatus }); }
export const segment = value => encodeURIComponent(value);
export function branchFor(login, userId) {
  // Bind once in DB: later SSO renames never create another branch or identity.
  return `dev/${/^[A-Za-z0-9][A-Za-z0-9_-]{0,60}$/.test(login) ? login : `member-${userId}`}`;
}
export function protectionRules(service, reviewers, members) {
  return [
    { rule_name:'main', priority:1, enable_push:false, enable_force_push:false,
      required_approvals:1, dismiss_stale_approvals:true, ignore_stale_approvals:true,
      block_admin_merge_override:true, block_on_rejected_reviews:true, block_on_outdated_branch:true,
      enable_merge_whitelist:true, merge_whitelist_usernames:[service],
      enable_approvals_whitelist:true, approvals_whitelist_username:[...new Set(reviewers)],
      enable_bypass_allowlist:false },
    ...members.map(m => ({ rule_name:m.branch, priority:10, enable_push:true, enable_push_whitelist:true,
      push_whitelist_usernames:m.state === 'active' ? [m.remote_login] : m.state === 'provisioning' ? [service] : [],
      enable_force_push:false, enable_bypass_allowlist:false })),
    { rule_name:'**', priority:100, enable_push:false, enable_force_push:false, enable_bypass_allowlist:false },
  ];
}
export async function loadCollaborationConfig(config) {
  if (!config.collaborationConfigFile) throw failure('collaboration_unavailable','共享项目服务尚未配置',503);
  const c = JSON.parse(await fs.readFile(config.collaborationConfigFile,'utf8'));
  const url = new URL(c.baseUrl);
  if (!['http:','https:'].includes(url.protocol) || url.username || url.password || !c.token
    || !/^[a-zA-Z0-9_-]+$/.test(c.organization) || !c.login) throw new Error('Invalid collaboration service configuration');
  return {...c,baseUrl:c.baseUrl.replace(/\/$/,'')};
}
export function gitea(c, token = c.token, fetchImpl = fetch) {
  return async (method, route, body, { text = false, missing = false } = {}) => {
    let res;
    try {
      res = await fetchImpl(`${c.baseUrl}/api/v1${route}`, { method,redirect:'error',
        headers:{Authorization:`token ${token}`,'Content-Type':'application/json'},
        ...(body === undefined ? {} : {body:JSON.stringify(body)}), signal:AbortSignal.timeout(25000) });
    } catch { throw failure('git_unavailable','Gitea 暂不可用；操作状态保留，可重试',502); }
    if (missing && res.status === 404) return null;
    if (!res.ok) throw failure('git_operation_failed',`Gitea 操作未完成（HTTP ${res.status}）`,502);
    if (res.status === 204) return null;
    if (text) {
      const chunks=[];let size=0;
      for await(const chunk of res.body){size+=chunk.length;if(size>1048576)throw failure('diff_too_large','变更过大，请拆分 PR');chunks.push(chunk);}
      return Buffer.concat(chunks).toString('utf8');
    }
    return res.json();
  };
}
export async function personalIdentity(pool, config, c, userId) {
  const u = (await pool.query(`SELECT u.fde_name,g.remote_login FROM users u JOIN fde_git_accounts g ON g.fde_id=u.id
    JOIN git_hosts h ON h.id=g.git_host_id WHERE u.id=$1 AND u.status='active' AND u.deleted_at IS NULL
    AND h.enabled=true AND rtrim(h.base_url,'/')=$2`,[userId,c.baseUrl])).rows[0];
  if (!u) throw failure('git_not_ready','成员的 Gitea 账号尚未就绪');
  const file = path.join(config.userSpaceRoot,u.fde_name,'platform','git','credentials');
  assertSafePath(config.userSpaceRoot,file);
  const lines = (await fs.readFile(file,'utf8')).split(/\r?\n/).filter(Boolean);
  const credential = lines.map(s=>new URL(s)).find(v=>v.host===new URL(c.baseUrl).host && decodeURIComponent(v.username)===u.remote_login);
  if (!credential?.password) throw failure('git_not_ready','成员 Git 凭据尚未就绪');
  return {...u,token:decodeURIComponent(credential.password)};
}
/** Display SSO identities without rewriting historical Gitea authors. Deleted
 * members remain resolvable so retained PRs keep their original attribution. */
export async function withStationAuthors(db, c, records) {
  const logins=[...new Set(records.map(row=>row.user?.login).filter(Boolean))];
  if(!logins.length)return records;
  const identities=(await db.query(`SELECT g.remote_login,u.login,u.display_name FROM fde_git_accounts g
    JOIN users u ON u.id=g.fde_id JOIN git_hosts h ON h.id=g.git_host_id
    WHERE rtrim(h.base_url,'/')=$1 AND g.remote_login=ANY($2::text[])`,[c.baseUrl,logins])).rows;
  const byLogin=new Map(identities.map(u=>[u.remote_login,u]));
  return records.map(row=>{
    const u=byLogin.get(row.user?.login);
    return u?{...row,user:{...row.user,station_login:u.login,station_display_name:u.display_name}}:row;
  });
}
export async function applyProtections(api, repo, rules) {
  const current = await api('GET',`${repo}/branch_protections`);
  for (const rule of rules) {
    const old = current.find(x=>x.rule_name===rule.rule_name);
    await api(old?'PATCH':'POST',`${repo}/branch_protections${old?'/'+segment(rule.rule_name):''}`,rule);
  }
  const actual = await api('GET',`${repo}/branch_protections`);
  for (const rule of rules) {
    const found = actual.find(x=>x.rule_name===rule.rule_name);
    for (const [key,value] of Object.entries(rule)) {
      const normalize=v=>JSON.stringify(Array.isArray(v)?[...v].sort():v);
      if (normalize(found?.[key]) !== normalize(value)) throw failure('branch_protection_mismatch','分支保护回读不一致，协作操作已阻止',502);
    }
  }
}
