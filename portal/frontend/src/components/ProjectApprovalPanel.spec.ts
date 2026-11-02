import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import ProjectApprovalPanel from './ProjectApprovalPanel.vue';
import type { ProjectApproval } from '../lib/projectApprovals';
vi.mock('../api', () => ({api:vi.fn()}));
const request = vi.mocked(api);
const row: ProjectApproval = {id:'a1',requester_id:'u1',cwd:'~/projects/demo',git_host:'github.com',repository:'owner/demo',source_ref:'feature',target_ref:'main',source_sha:'a'.repeat(40),target_sha:'b'.repeat(40),status:'reviewed',ai_review:'<script>alert(1)</script> Review',error:null,diff:'diff --git a/a b/a\n+safe',web_url:'https://github.com/owner/demo',merge_sha:null,created_at:'2026-11-02',updated_at:'2026-11-02'};
let wrapper: ReturnType<typeof mount>;
beforeEach(() => { request.mockReset(); setLocale('zh-CN'); request.mockImplementation(async (path) => path.split('?')[0] === '/api/project-approvals' ? {items:[row]} : row); });
afterEach(() => wrapper?.unmount());
async function setup(admin=true,versions=false) { const pinia=createPinia();setActivePinia(pinia);const auth=useAuthStore();auth.user={id:'u1',login:'a',display_name:null,role:admin?'admin':'fde',fde_name:'a',auth_source:'local'};wrapper=mount(ProjectApprovalPanel,{props:{admin,versions},global:{plugins:[pinia,i18n]}});await flushPromises();return auth; }
async function select() { await wrapper.get('.approval-row').trigger('click');await flushPromises(); }
describe('Project approval review', () => {
  it('shows actual diff and pinned SHAs, renders AI text safely, requires explicit approval',async()=>{
    await setup();await select();expect(wrapper.get('pre').text()).toContain('+safe');expect(wrapper.text()).toContain('a'.repeat(40));expect(wrapper.find('script').exists()).toBe(false);
    const approve=wrapper.findAll('button').find(b=>b.text()==='批准')!;expect(approve.attributes('disabled')).toBeDefined();await approve.trigger('click');expect(request.mock.calls.some(([,opts])=>opts?.method==='POST')).toBe(false);
    await wrapper.get('input[type=checkbox]').setValue(true);request.mockResolvedValueOnce({...row,status:'approved'});await approve.trigger('click');await flushPromises();
    expect(request.mock.calls.find(([url])=>url.endsWith('/approve'))?.[1]?.body).toBe('{"confirm":true}');
    expect(request.mock.calls.some(([url])=>url.endsWith('/merge'))).toBe(false);expect(wrapper.text()).toContain('确认合并');
    expect((wrapper.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false);
  });
  it('blocks repeated AI actions and reconciles stale state without retrying mutation',async()=>{
    request.mockImplementation(async path=>path.split('?')[0]==='/api/project-approvals'?{items:[{...row,status:'pending'}]}:{...row,status:'pending'});await setup();await select();let reject: (error:Error)=>void=()=>{};request.mockImplementationOnce(()=>new Promise((_r,j)=>{reject=j;}));
    const review=wrapper.findAll('button').find(b=>b.text()==='运行 AI 审查')!;await review.trigger('click');await review.trigger('click');expect(request.mock.calls.filter(([url])=>url.endsWith('/review'))).toHaveLength(1);
    request.mockResolvedValueOnce({...row,status:'stale'});reject(new Error('branch changed'));await flushPromises();expect(wrapper.text()).toContain('分支已更新');expect(wrapper.text()).not.toContain('确认合并');expect(wrapper.get('[role=alert]').text()).toContain('branch changed');
  });
  it('never offers mutations to requesters or unconfirmed merging rows',async()=>{
    await setup(false);await select();expect(wrapper.find('input[type=checkbox]').exists()).toBe(false);expect(wrapper.findAll('button').some(b=>b.text()==='批准')).toBe(false);wrapper.unmount();
    request.mockImplementation(async path=>path.split('?')[0]==='/api/project-approvals'?{items:[{...row,status:'merging'}]}:{...row,status:'merging'});await setup();await select();expect(wrapper.text()).toContain('勿重复提交');expect(wrapper.findAll('button').some(b=>b.text()==='确认合并')).toBe(false);
  });
  it('reconciles an uncertain merge only on explicit check-result action',async()=>{
    request.mockImplementation(async path=>path.split('?')[0]==='/api/project-approvals'?{items:[{...row,status:'merging'}]}:{...row,status:'merging'});await setup();await select();
    const check=wrapper.findAll('button').find(b=>b.text()==='核对合并结果')!;request.mockResolvedValueOnce({...row,status:'merged',merge_sha:'c'.repeat(40)});await check.trigger('click');await flushPromises();
    expect(request.mock.calls.filter(([url,opts])=>url.endsWith('/merge') && opts?.method==='POST')).toHaveLength(1);expect(wrapper.text()).toContain('已合并');
  });
  it('does not permit actions before fresh detail arrives',async()=>{
    await setup();let resolve:(value:unknown)=>void=()=>{};request.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await wrapper.get('.approval-row').trigger('click');
    expect(wrapper.find('input[type=checkbox]').exists()).toBe(false);resolve(row);await flushPromises();expect(wrapper.find('input[type=checkbox]').exists()).toBe(true);
  });
  it('refresh cancels a pending detail without leaving action controls permanently locked',async()=>{
    await setup();let resolve:(value:unknown)=>void=()=>{};request.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await wrapper.get('.approval-row').trigger('click');
    request.mockResolvedValueOnce({items:[row]});await wrapper.findAll('button').find(b=>b.text()==='刷新')!.trigger('click');await flushPromises();expect(wrapper.find('input[type=checkbox]').exists()).toBe(true);
    resolve({...row,diff:'stale private diff'});await flushPromises();expect(wrapper.text()).not.toContain('stale private diff');
  });
  it('only offers interrupted-review recovery when the server permits it',async()=>{
    request.mockImplementation(async path=>path.split('?')[0]==='/api/project-approvals'?{items:[{...row,status:'reviewing',can_retry_review:true}]}:{...row,status:'reviewing',can_retry_review:true});await setup();await select();expect(wrapper.findAll('button').some(b=>b.text()==='重新审查')).toBe(true);
  });
  it('refresh reloads full evidence instead of enabling actions on a list summary',async()=>{
    await setup();await select();await wrapper.get('input[type=checkbox]').setValue(true);
    request.mockResolvedValueOnce({items:[{...row,diff:'',ai_review:null}]});let resolve:(value:unknown)=>void=()=>{};request.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
    await wrapper.findAll('button').find(b=>b.text()==='刷新')!.trigger('click');await flushPromises();
    expect(request.mock.calls.at(-1)![0]).toBe('/api/project-approvals/a1');expect(wrapper.find('input[type=checkbox]').exists()).toBe(false);
    expect(wrapper.findAll('button').some(b=>b.text()==='批准')).toBe(false);
    resolve({...row,diff:'fresh reviewed diff',ai_review:'fresh AI review'});await flushPromises();
    expect(wrapper.get('pre').text()).toBe('fresh reviewed diff');expect(wrapper.text()).toContain('fresh AI review');
    expect((wrapper.get('input[type=checkbox]').element as HTMLInputElement).checked).toBe(false);
  });
  it('refresh detail failure fails closed rather than allowing approval on a summary',async()=>{
    await setup();await select();request.mockResolvedValueOnce({items:[{...row,diff:'',ai_review:null}]});request.mockRejectedValueOnce(new Error('detail unavailable'));
    await wrapper.findAll('button').find(b=>b.text()==='刷新')!.trigger('click');await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('detail unavailable');expect(wrapper.find('article').exists()).toBe(false);expect(wrapper.find('input[type=checkbox]').exists()).toBe(false);
  });
  it('fails closed if even the detail endpoint returns incomplete review evidence',async()=>{
    request.mockImplementation(async path=>path.split('?')[0]==='/api/project-approvals'?{items:[row]}:{...row,diff:'',ai_review:null});await setup();await select();await wrapper.get('input[type=checkbox]').setValue(true);
    const approve=wrapper.findAll('button').find(b=>b.text()==='批准')!;expect(approve.attributes('disabled')).toBeDefined();await approve.trigger('click');expect(request.mock.calls.some(([,opts])=>opts?.method==='POST')).toBe(false);
  });
  it('versions show merged commits, never assert deployment success',async()=>{
    request.mockImplementation(async path=>path.split('?')[0]==='/api/project-approvals'?{items:[row,{...row,id:'m1',status:'merged',merge_sha:'c'.repeat(40),merged_by_login:'review-admin',merged_at:'2026-11-02T09:00:00Z'}]}:{...row,id:'m1',status:'merged',merge_sha:'c'.repeat(40),merged_by_login:'review-admin',merged_at:'2026-11-02T09:00:00Z'});await setup(false,true);expect(request.mock.calls[0]![0]).toContain('status=merged');expect(wrapper.findAll('.approval-row')).toHaveLength(1);await select();expect(wrapper.text()).toContain('c'.repeat(40));expect(wrapper.text()).toContain('上线状态未确认');expect(wrapper.text()).toContain('review-admin');expect(wrapper.text()).toContain('2026-11-02T09:00:00Z');
  });
  it('does not turn unsafe repository URLs into executable links',async()=>{
    request.mockImplementation(async path=>path.split('?')[0]==='/api/project-approvals'?{items:[{...row,web_url:'javascript:alert(1)'}]}:{...row,web_url:'javascript:alert(1)'});await setup();await select();expect(wrapper.find('a').exists()).toBe(false);
  });
  it('clears private state on account change and ignores stale detail responses',async()=>{
    const auth=await setup();let resolve:(value:unknown)=>void=()=>{};request.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await wrapper.get('.approval-row').trigger('click');request.mockResolvedValueOnce({items:[]});auth.user={...auth.user!,id:'u2'};await flushPromises();resolve({...row,diff:'private previous account'});await flushPromises();expect(wrapper.text()).not.toContain('private previous account');expect(wrapper.find('article').exists()).toBe(false);
  });
});
