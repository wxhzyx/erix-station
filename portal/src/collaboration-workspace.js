import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { assertSafePath } from './fsutil.js';
import { readDeliveryPackage } from './delivery-package.js';
import { failure } from './collaboration-gitea.js';
const exec = promisify(execFile);

/** Only run privileged git inside a new, portal-owned staging directory.
 * Never run git with service credentials in an existing user-controlled checkout. */
export async function stageWorkspace(config, identity, url, operation, { fdeName } = {}) {
  const root = path.resolve(config.userSpaceRoot);
  // Member roots inherit distinct XFS project quotas. Staging for a final
  // rename must inherit that member's project ID (same st_dev is insufficient).
  // This sibling of home/projects is never mounted in the member container.
  const stagingRoot = path.join(root, fdeName ?? '', '.collaboration-staging');
  assertSafePath(root,stagingRoot); await fs.mkdir(stagingRoot,{recursive:true,mode:0o700});
  const staging = await fs.mkdtemp(path.join(stagingRoot,'workspace-'));
  const env = { ...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_TERMINAL_PROMPT:'0',
    GIT_CONFIG_COUNT:'4',GIT_CONFIG_KEY_0:'http.extraHeader',GIT_CONFIG_VALUE_0:`Authorization: Basic ${Buffer.from(`${identity.login}:${identity.token}`).toString('base64')}`,
    GIT_CONFIG_KEY_1:'core.hooksPath',GIT_CONFIG_VALUE_1:'/dev/null',
    GIT_CONFIG_KEY_2:'http.followRedirects',GIT_CONFIG_VALUE_2:'false',GIT_CONFIG_KEY_3:'core.symlinks',GIT_CONFIG_VALUE_3:'false' };
  const git = async args => { try { return await exec('git',args,{cwd:staging,env,timeout:120000,maxBuffer:2097152}); }
    catch { throw failure('git_workspace_failed','Git 工作副本准备失败，可重试',502); } };
  try { return await operation({staging,git,url}); }
  finally { await fs.rm(staging,{recursive:true,force:true}); }
}
export async function initializeRepository(pool, config, c, project) {
  const pkg = (await pool.query('SELECT archive FROM delivery_packages WHERE id=$1',[project.package_id])).rows[0];
  await stageWorkspace(config,c,project.repo_url,async({staging,git,url})=>{
    await git(['init','-b','main']); await git(['remote','add','origin',url]);
    const heads = await git(['ls-remote','--heads','origin']);
    if (heads.stdout.trim()) return; // Durable repository identity was verified by the caller.
    for (const file of await readDeliveryPackage(pkg.archive)) {
      const target = path.join(staging,file.name); assertSafePath(staging,target);
      await fs.mkdir(path.dirname(target),{recursive:true}); await fs.writeFile(target,file.data,{flag:'wx',mode:0o600});
    }
    await fs.appendFile(path.join(staging,'AGENTS.md'),`\n\n## 共享项目协作\n先阅读交付包要求。只在分配给自己的 dev 分支开发并推送；通过 FDE Station 提交合并请求，禁止直接推送 main。同步前检查本地修改，不丢弃未提交内容。\n${project.instructions}\n`);
    await fs.writeFile(path.join(staging,'.fde-project.json'),JSON.stringify({project_id:project.id,package_id:project.package_id}));
    await git(['add','--all','--force']);
    await git(['-c','user.name=FDE Station','-c','user.email=station@inteva.invalid','commit','-m','chore: 初始化共享开发交付包']);
    await git(['push','origin','main']);
  });
}
export async function prepareWorkspace(config, c, project, member) {
  const root=path.resolve(config.userSpaceRoot),target=path.join(root,member.fde_name,'projects',project.name);
  assertSafePath(root,target);
  try {
    assertSafePath(root,path.join(target,'.fde-assignment.json'));
    const marker=JSON.parse(await fs.readFile(path.join(target,'.fde-assignment.json'),'utf8'));
    if(marker.id===member.assignment_id && marker.project_id===project.id && marker.user_id===member.user_id) return;
    throw failure('workspace_conflict','已有同名目录，拒绝覆盖');
  } catch(e) { if(e.code!=='ENOENT') throw e; }
  try { await fs.lstat(target); throw failure('workspace_conflict','已有同名目录，拒绝覆盖'); } catch(e) { if(e.code!=='ENOENT')throw e; }
  await stageWorkspace(config,c,project.repo_url,async({staging,git,url})=>{
    await git(['clone','--branch',member.branch,url,'.']);
    // Neither token nor service identity is saved in the checkout's config.
    await fs.writeFile(path.join(staging,'.fde-assignment.json'),JSON.stringify({id:member.assignment_id,package_id:project.package_id,project_id:project.id,user_id:member.user_id}));
    await fs.appendFile(path.join(staging,'.git','info','exclude'),'\n.fde-assignment.json\n');
    const own=async dir=>{for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      const file=path.join(dir,entry.name);if(entry.isSymbolicLink())throw failure('unsafe_workspace','工作副本含不允许的符号链接');
      if(entry.isDirectory())await own(file);
      await fs.chown(file,config.workerUid??1002,config.fdeGid??1000);await fs.chmod(file,entry.isDirectory()?0o770:0o660);
    }};
    await own(staging);await fs.chown(staging,config.workerUid??1002,config.fdeGid??1000);await fs.chmod(staging,0o770);
    assertSafePath(root,target);await fs.rename(staging,target);
  }, { fdeName: member.fde_name });
}
