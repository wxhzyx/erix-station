import { OBSERVATION_FRESHNESS_SECONDS } from './portalloc.js';

export function observedProject(cwd) {
  if (typeof cwd !== 'string' || cwd.split('/').some(p => p === '.' || p === '..')) return null;
  return /^(?:~|\/home\/[^/]+)\/projects\/([^/]+)(?:\/|$)/.exec(cwd)?.[1] ?? null;
}

/** Actual listeners, not reserved port blocks. No command lines or access tickets leave this endpoint. */
export async function listRuntimePorts(pool) {
  const limit = 500;
  const result = await pool.query(`
    SELECT o.id, o.port, o.cwd, o.branch, o.observed_at,
           u.id AS user_id, u.login, u.display_name,
           a.id AS allocation_id, count(*) OVER () AS total,
           now() AS sampled_at
      FROM port_observations o
      JOIN users u ON u.id = o.fde_id
      JOIN containers c ON c.id = o.container_id AND c.user_id = u.id
      LEFT JOIN port_allocations a ON a.fde_id = u.id AND a.port = o.port AND a.state <> 'released'
     WHERE u.deleted_at IS NULL AND u.status = 'active'
       AND c.status = 'running' AND c.revoked_at IS NULL
       AND o.observed_at > now() - ($1 * interval '1 second') AND o.observed_at <= now()
       AND (a.id IS NOT NULL OR o.cwd ~ '^(~|/home/[^/]+)/projects/[^/]+')
     ORDER BY u.login, o.port, o.id LIMIT $2`, [OBSERVATION_FRESHNESS_SECONDS, limit]);
  const iso = value => value instanceof Date ? value.toISOString() : value;
  return {
    sampled_at: iso(result.rows[0]?.sampled_at ?? new Date()),
    freshness_seconds: OBSERVATION_FRESHNESS_SECONDS,
    total: Number(result.rows[0]?.total ?? 0), limit,
    items: result.rows.map(row => ({
      id: row.id, user_id: row.user_id, login: row.login, display_name: row.display_name,
      project: observedProject(row.cwd), port: Number(row.port), branch: row.branch ?? null,
      routed: Boolean(row.allocation_id), observed_at: iso(row.observed_at),
    })),
  };
}
