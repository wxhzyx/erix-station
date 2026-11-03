// A withdrawn project must not stay reachable through a previously issued preview cookie.
export async function collaborationPreviewDenied(pool,config,allocation) {
  if(!config?.collaborationConfigFile)return false;
  const rows=await pool.query(`SELECT 1 FROM port_allocations a JOIN port_observations o ON o.fde_id=a.fde_id AND o.port=a.port
    JOIN project_assignments w ON w.user_id=a.fde_id JOIN project_memberships m ON m.assignment_id=w.id
    WHERE a.id=$1 AND m.state<>'active' AND split_part(split_part(o.cwd,'/projects/',2),'/',1)=w.name LIMIT 1`,[allocation.id]);
  return rows.rows.length>0;
}
