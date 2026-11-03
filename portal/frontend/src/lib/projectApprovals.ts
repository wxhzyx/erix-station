export interface ProjectApproval {
  id: string;
  requester_id: string;
  cwd: string;
  git_host: string;
  repository: string;
  source_ref: string;
  target_ref: string;
  source_sha: string;
  target_sha: string;
  status: 'pending' | 'reviewing' | 'reviewed' | 'approved' | 'merging' | 'merged' | 'failed' | 'stale' | 'rejected';
  ai_review: string | null;
  can_retry_review?: boolean;
  error: string | null;
  diff: string;
  web_url: string | null;
  merge_sha: string | null;
  requester_login?: string | null;
  approved_by_login?: string | null;
  merged_by_login?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  merged_by?: string | null;
  merged_at?: string | null;
  created_at: string;
  updated_at: string;
}
export function approvalStatus(status: ProjectApproval['status'], english = false): string {
  const labels: Record<ProjectApproval['status'], [string, string]> = {
    pending:['待审查','Pending review'],reviewing:['AI 审查中','AI reviewing'],reviewed:['待批准','Awaiting approval'],approved:['已批准','Approved'],merging:['合并处理中','Merge in progress'],merged:['已合并','Merged'],failed:['审查失败','Review failed'],stale:['分支已更新','Branches changed'],rejected:['已拒绝','Rejected'],
  };
  return labels[status]?.[english ? 1 : 0] ?? status;
}
// Never expose a backend-provided javascript/data URL as a clickable link.
export function approvalWebUrl(value: string | null): string | undefined {
  if (!value) return undefined;
  try { const url = new URL(value); return url.protocol === 'https:' ? url.href : undefined; } catch { return undefined; }
}
