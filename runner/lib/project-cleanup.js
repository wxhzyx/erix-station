import fs from 'node:fs';
import path from 'node:path';

/** Stop only processes whose actual cwd is inside the explicitly removed project.
 * Runs have already settled before portal requests this; do not kill other projects
 * or agentd, and do not claim success when /proc inspection is unavailable. */
export function cleanupProjectProcesses({name,home,procPath='/proc',uids=[1000,1002],kill=process.kill,fsImpl=fs,identity=process}) {
  if(!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(name??''))throw new Error('Invalid cleanup project');
  const target=path.join(home,'projects',name),original=identity.getuid();
  let remaining=0;
  for(const uid of uids) {
    try {
      if(original!==uid)identity.setuid(uid);
      for(const entry of fsImpl.readdirSync(procPath)) {
        if(!/^\d+$/.test(entry)||Number(entry)<=1||Number(entry)===process.pid)continue;
        const dir=path.join(procPath,entry);
        try {
          if(fsImpl.statSync(dir).uid!==uid)continue;
          const cwd=fsImpl.readlinkSync(path.join(dir,'cwd'));
          if(cwd!==target&&!cwd.startsWith(target+path.sep))continue;
          // Recheck identity/cwd immediately before signalling; never use a shell or PID group.
          if(fsImpl.statSync(dir).uid!==uid||fsImpl.readlinkSync(path.join(dir,'cwd'))!==cwd)continue;
          kill(Number(entry),'SIGKILL');remaining++;
        } catch(e) { if(!['ENOENT','ESRCH'].includes(e.code))throw e; }
      }
    } finally {if(identity.getuid()!==original)identity.setuid(original);}
  }
  // A later heartbeat must observe no processes before acknowledging cleanup.
  return remaining===0;
}
