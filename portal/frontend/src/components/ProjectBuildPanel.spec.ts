import { mount, flushPromises } from '@vue/test-utils';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import ProjectBuildPanel from './ProjectBuildPanel.vue';
const request=vi.hoisted(()=>vi.fn());
vi.mock('../api',()=>({api:request}));
beforeEach(()=>{request.mockReset();request.mockResolvedValue({builds:[]});});
afterEach(()=>vi.restoreAllMocks());
describe('Project test builds',()=>{
  it('generates a personal build without accepting a repository, branch or command from the browser',async()=>{
    const w=mount(ProjectBuildPanel,{props:{projectId:'p1',canBuild:true}});await flushPromises();
    await w.findAll('button').find(b=>b.text()==='生成测试版')!.trigger('click');await flushPromises();
    expect(request).toHaveBeenCalledWith('/api/collaboration/p1/builds',{method:'POST',body:'{}'});w.unmount();
  });
  it('only successful builds offer a protected download; admin observer cannot start personal builds',async()=>{
    request.mockResolvedValue({builds:[{id:'good',branch:'dev/u1',source_sha:'a'.repeat(40),status:'succeeded',created_at:'2026-11-05',artifact_size:1024,log:'done',error:null},
      {id:'bad',branch:'dev/u1',source_sha:'b'.repeat(40),status:'failed',created_at:'2026-11-05',artifact_size:null,log:'<script>bad</script>',error:'failed'}]});
    const w=mount(ProjectBuildPanel,{props:{projectId:'p1',canBuild:false}});await flushPromises();
    expect(w.findAll('a').map(a=>a.attributes('href'))).toEqual(['/api/project-builds/good/download']);
    expect(w.text()).not.toContain('生成测试版');w.unmount();
  });
  it('shows server errors instead of claiming a build started',async()=>{
    const w=mount(ProjectBuildPanel,{props:{projectId:'p1',canBuild:true}});await flushPromises();
    request.mockRejectedValueOnce(new Error('当前测试版正在生成'));
    await w.findAll('button').find(b=>b.text()==='生成测试版')!.trigger('click');await flushPromises();
    expect(w.get('[role=alert]').text()).toBe('当前测试版正在生成');w.unmount();
  });
});
