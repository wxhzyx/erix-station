import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import ChatView from './ChatView.vue';
vi.mock('../api', () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);
const user = { id:'u1',login:'alice',display_name:null,role:'fde',fde_name:null,auth_source:'local' };
let wrappers: ReturnType<typeof mount>[] = [];
beforeEach(() => { mockApi.mockReset(); setLocale('zh-CN'); mockApi.mockImplementation(async (path, opts) => {
  if (path.endsWith('/messages')) return { messages: [] };
  if (opts?.method === 'POST') return { conversation: { id:'c1',title:'新对话' } };
  if (path.endsWith('/c1')) return { messages:[{id:'m1',role:'user',content:'你好'}] };
  return { conversations: [] };
}); });
afterEach(() => { wrappers.forEach(w => w.unmount()); wrappers = []; });
async function setup() {
  const pinia = createPinia(); setActivePinia(pinia); const auth = useAuthStore(); auth.user = user; auth.ready = true;
  const router = createRouter({ history:createMemoryHistory(), routes:[{path:'/chat/:id?', component:ChatView},{path:'/',component:{template:'<div>Work</div>'}},{path:'/mode-settings',component:{template:'<div>Settings</div>'}},{path:'/login',component:{template:'<div>Login</div>'}}] });
  await router.push('/chat'); const wrapper = mount(ChatView,{global:{plugins:[pinia,router,i18n]}}); wrappers.push(wrapper); await flushPromises(); return { wrapper, router, auth };
}
describe('Standalone chat', () => {
  it('needs no project, has a mode switch and supports multiple attachments', async () => {
    const { wrapper } = await setup();
    expect(wrapper.find('.conversation-sidebar').exists()).toBe(true);
    expect(wrapper.find('.directory-tree').exists()).toBe(false);
    expect(wrapper.text()).toContain('新对话');
    expect(wrapper.text()).not.toContain('文件可直接拖入');
    expect(wrapper.get('input[type=file]').attributes('multiple')).toBeDefined();
    expect(wrapper.findAll('[role=menuitem]').some(item => item.text().includes('开发工作台'))).toBe(true);
    expect(wrapper.find('a[href="/mode-settings"]').exists()).toBe(false);
    expect(mockApi.mock.calls.every(([url]) => !url.includes('/dirs') && !url.includes('/sessions'))).toBe(true);
  });
  it('creates once, prevents repeated submit and keeps canonical history', async () => {
    const { wrapper, router } = await setup();
    let resolveSend: (value: unknown) => void = () => {};
    const pending = new Promise(resolve => { resolveSend = resolve; });
    mockApi.mockImplementation(async (path, opts) => {
      if (path.endsWith('/messages')) return pending;
      if (opts?.method === 'POST') return {conversation:{id:'c1',title:'test'}};
      if (path.endsWith('/c1')) return { messages:[{id:'m1',role:'user',content:'你好'}] };
      return {conversations:[]};
    });
    await wrapper.get('textarea').setValue('你好'); await wrapper.get('form').trigger('submit'); await flushPromises();
    await wrapper.get('form').trigger('submit');
    expect(mockApi.mock.calls.filter(([url]) => url.endsWith('/messages'))).toHaveLength(1);
    expect(router.currentRoute.value.path).toBe('/chat/c1');
    resolveSend({messages:[]}); await flushPromises();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    expect(wrapper.find('article').text()).toContain('你好');
  });
  it('retains failed draft and reuses request identity for unchanged retry', async () => {
    const { wrapper } = await setup();
    mockApi.mockImplementation(async (path, opts) => {
      if (path.endsWith('/messages')) throw new Error('模型暂不可用');
      if (opts?.method === 'POST') return {conversation:{id:'c1',title:'test'}};
      return {conversations:[],messages:[]};
    });
    await wrapper.get('textarea').setValue('重试'); await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('模型暂不可用');
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('重试');
    await wrapper.get('form').trigger('submit'); await flushPromises();
    const sends = mockApi.mock.calls.filter(([url]) => url.endsWith('/messages'));
    expect(sends).toHaveLength(2);
    expect(JSON.parse(sends[0]![1]!.body as string).request_id).toBe(JSON.parse(sends[1]![1]!.body as string).request_id);
  });
  it('clears account-scoped drafts and ignores old requests after account change', async () => {
    const { wrapper, auth } = await setup();
    await wrapper.get('textarea').setValue('Alice private draft');
    let resolveOld: (value: unknown) => void = () => {};
    mockApi.mockImplementationOnce(() => new Promise(resolve => { resolveOld = resolve; }));
    auth.user = {...user,id:'u2',login:'bob'}; await flushPromises();
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
    auth.user = {...user,id:'u3',login:'charlie'}; await flushPromises();
    resolveOld({conversations:[{id:'old',title:'Bob private'}]}); await flushPromises();
    expect(wrapper.text()).not.toContain('Bob private');
  });
  it('reads multiple files, sends their bytes, and retains them on failed send', async () => {
    const { wrapper } = await setup();
    const input = wrapper.get('input[type=file]');
    Object.defineProperty(input.element, 'files', { configurable:true, value:[new File(['first'], 'one.txt', {type:'text/plain'}),new File(['second'], 'two.txt',{type:'text/plain'})] });
    await input.trigger('change');
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('one.txt');
      expect(wrapper.text()).toContain('two.txt');
      expect(wrapper.text()).not.toContain('读取中');
    }, { timeout: 3000 });
    mockApi.mockImplementation(async (path, opts) => {
      if (path.endsWith('/messages')) throw new Error('offline');
      if (opts?.method === 'POST') return {conversation:{id:'c1',title:'test'}};
      return {conversations:[],messages:[]};
    });
    await wrapper.get('form').trigger('submit'); await flushPromises();
    const body = JSON.parse(mockApi.mock.calls.find(([url]) => url.endsWith('/messages'))![1]!.body as string);
    expect(body.attachments.map((f: {data_base64:string}) => atob(f.data_base64))).toEqual(['first','second']);
    expect(wrapper.text()).toContain('one.txt'); expect(wrapper.text()).toContain('two.txt');
    await wrapper.get('button[aria-label="移除 one.txt"]').trigger('click'); expect(wrapper.text()).not.toContain('one.txt');
  });
  it('rejects excessive and unsupported files without sending or silently accepting', async () => {
    const { wrapper } = await setup(); const input = wrapper.get('input[type=file]');
    Object.defineProperty(input.element, 'files', {configurable:true,value:[new File(['binary'], 'file.bin', {type:'application/octet-stream'})]});
    await input.trigger('change'); await flushPromises(); expect(wrapper.get('[role=alert]').text()).toContain('暂不支持');
    Object.defineProperty(input.element, 'files', {configurable:true,value:Array.from({length:11}, (_,i) => new File(['x'], `${i}.txt`))});
    await input.trigger('change'); await flushPromises(); expect(wrapper.get('[role=alert]').text()).toContain('最多 10');
    expect(mockApi.mock.calls.some(([,opts]) => opts?.method === 'POST')).toBe(false);
  });
  it('back navigation clears an unsent draft and does not resurrect old history', async () => {
    const { wrapper, router } = await setup();
    await router.push('/chat/c1'); await flushPromises(); expect(wrapper.find('article').exists()).toBe(true);
    await wrapper.get('textarea').setValue('unsent'); router.back(); await new Promise(r => setTimeout(r, 10)); await flushPromises();
    expect(wrapper.find('article').exists()).toBe(false);
    expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('');
  });
});

describe('document extraction', () => {
  async function upload(wrapper: ReturnType<typeof mount>, name = 'report.pdf') {
    const input = wrapper.get('input[type=file]');
    Object.defineProperty(input.element, 'files', { configurable: true, value: [new File(['synthetic document'], name)] });
    await input.trigger('change');
    await flushPromises();
  }
  it('sends extracted Unicode text, not document bytes, and displays warnings', async () => {
    const { wrapper } = await setup();
    const original = mockApi.getMockImplementation()!;
    mockApi.mockImplementation(async (path, opts) => path === '/api/attachments/extract'
      ? { name: 'report.pdf', text: '表格内容\n[已截断]', warnings: ['已截断'] } : original(path, opts));
    await upload(wrapper);
    await vi.waitFor(() => expect(wrapper.text()).toContain('已截断'), { timeout: 3000 });
    await wrapper.get('form').trigger('submit'); await flushPromises();
    const body = JSON.parse(mockApi.mock.calls.find(([url]) => url.endsWith('/messages'))![1]!.body as string);
    expect(body.attachments[0].mime_type).toBe('text/plain');
    expect(new TextDecoder().decode(Uint8Array.from(atob(body.attachments[0].data_base64), c => c.charCodeAt(0)))).toBe('表格内容\n[已截断]');
  });
  it.each(['account', 'navigation'])('ignores extraction after %s changes and prevents sending while pending', async change => {
    const { wrapper, auth, router } = await setup();
    let resolve!: (value: unknown) => void;
    const original = mockApi.getMockImplementation()!;
    mockApi.mockImplementation((path, opts) => path === '/api/attachments/extract'
      ? new Promise(r => { resolve = r; }) : original(path, opts));
    await upload(wrapper);
    await vi.waitFor(() => expect(mockApi.mock.calls.some(([url]) => url === '/api/attachments/extract')).toBe(true), { timeout: 3000 });
    await wrapper.get('form').trigger('submit'); await flushPromises();
    expect(mockApi.mock.calls.some(([url]) => url.endsWith('/messages'))).toBe(false);
    const extractionOpts = mockApi.mock.calls.find(([url]) => url === '/api/attachments/extract')![1]!;
    if (change === 'account') {
      auth.user = { ...user, id: 'u2' };
      expect(extractionOpts.signal?.aborted).toBe(true); // Synchronous, before next promise tick.
    }
    else await router.push('/chat/c1');
    await flushPromises();
    expect(extractionOpts.signal?.aborted).toBe(true);
    resolve({ name: 'report.pdf', text: 'private', warnings: ['private warning'] }); await flushPromises();
    expect(wrapper.text()).not.toContain('report.pdf'); expect(wrapper.text()).not.toContain('private warning');
  });
  it('rejects legacy and oversized documents before calling extraction', async () => {
    const { wrapper } = await setup();
    await upload(wrapper, 'old.doc'); expect(wrapper.get('[role=alert]').text()).toContain('转换');
    const input = wrapper.get('input[type=file]');
    Object.defineProperty(input.element, 'files', { configurable:true, value:[{name:'large.pdf',size:10 * 1024 * 1024 + 1}] });
    await input.trigger('change'); await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('10 MiB');
    expect(mockApi.mock.calls.some(([url]) => url === '/api/attachments/extract')).toBe(false);
  });
});


describe('chat file drop', () => {
  it('stages dropped original image bytes without document extraction or automatic send', async () => {
    const { wrapper } = await setup();
    const dataTransfer = { types:['Files'], files:[new File(['image bytes'], 'screen.png', {type:'image/png'})] };
    await wrapper.get('.file-drop-region').trigger('dragenter', {dataTransfer});
    expect(wrapper.text()).toContain('松开鼠标');
    await wrapper.get('textarea').trigger('drop', {dataTransfer});
    await vi.waitFor(() => {
      expect(wrapper.text()).toContain('screen.png');
      expect(wrapper.text()).not.toContain('读取中');
    }, { timeout: 3000 });
    expect(wrapper.text()).not.toContain('松开鼠标');
    expect(mockApi.mock.calls.some(([,opts])=>opts?.method === 'POST')).toBe(false);
    await wrapper.get('form').trigger('submit');await flushPromises();
    const body=JSON.parse(mockApi.mock.calls.find(([url])=>url.endsWith('/messages'))![1]!.body as string);
    expect(body.attachments[0]).toMatchObject({name:'screen.png',mime_type:'image/png',data_base64:btoa('image bytes')});
    expect(mockApi.mock.calls.some(([url])=>url==='/api/attachments/extract')).toBe(false);
  });
  it('applies picker limits to drops and rejects folders', async () => {
    const {wrapper}=await setup();const zone=wrapper.get('.file-drop-region');
    await zone.trigger('drop',{dataTransfer:{types:['Files'],files:Array.from({length:11},(_,i)=>new File(['x'],`${i}.txt`))}});
    expect(wrapper.get('[role=alert]').text()).toContain('最多 10');
    await zone.trigger('drop',{dataTransfer:{types:['Files'],files:[],items:[{webkitGetAsEntry:()=>({isDirectory:true})}]}});
    expect(wrapper.get('[role=alert]').text()).toContain('不支持文件夹');
  });
});

it('renders upstream deltas before completion and removes transient bubbles after canonical reload',async()=>{
 const {wrapper}=await setup();let finish!:(value:unknown)=>void;let emit!:(text:string)=>void;
 mockApi.mockImplementation(async(path,opts,onDelta)=>{
  if(path.endsWith('/messages')){emit=onDelta!;return new Promise(resolve=>{finish=resolve;});}
  if(opts?.method==='POST')return {conversation:{id:'c1',title:'stream'}};
  if(path.endsWith('/c1'))return {messages:[{id:'saved-user',role:'user',content:'你好'},{id:'saved-assistant',role:'assistant',content:'第一段第二段'}]};
  return {conversations:[]};
 });
 await wrapper.get('textarea').setValue('你好');await wrapper.get('form').trigger('submit');await flushPromises();
 emit('第一段');await vi.waitFor(()=>expect(wrapper.text()).toContain('第一段'));
 expect(wrapper.text()).toContain('停止');expect(wrapper.findAll('article')).toHaveLength(2);
 emit('第二段');await vi.waitFor(()=>expect(wrapper.text()).toContain('第一段第二段'));
 finish({messages:[]});await flushPromises();expect(wrapper.findAll('article')).toHaveLength(2);expect(wrapper.text()).not.toContain('未完成');
});
it('keeps visible partial text and the draft after a failed stream, with the same retry identity',async()=>{
 const {wrapper}=await setup();let attempts=0;
 mockApi.mockImplementation(async(path,opts,onDelta)=>{
  if(path.endsWith('/messages')){attempts++;onDelta?.('部分回复');throw new Error('连接中断');}
  if(opts?.method==='POST')return {conversation:{id:'c1',title:'stream'}};
  return {conversations:[],messages:[]};
 });
 await wrapper.get('textarea').setValue('问题');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(wrapper.text()).toContain('部分回复');expect(wrapper.text()).toContain('未完成');
 expect((wrapper.get('textarea').element as HTMLTextAreaElement).value).toBe('问题');
 await wrapper.get('form').trigger('submit');await flushPromises();expect(attempts).toBe(2);expect(wrapper.findAll('article')).toHaveLength(2);
});
it.each(['stop', 'account'])('cancels streaming on %s and ignores obsolete updates', async change => {
 const {wrapper,auth}=await setup();let emit!:(text:string)=>void;let signal!:AbortSignal;
 mockApi.mockImplementation(async(path,opts,onDelta)=>{
  if(path.endsWith('/messages')){emit=onDelta!;signal=opts!.signal!;return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true}));}
  if(opts?.method==='POST')return {conversation:{id:'c1',title:'stream'}};
  return {conversations:[],messages:[]};
 });
 await wrapper.get('textarea').setValue('问题');await wrapper.get('form').trigger('submit');await flushPromises();
 emit('收到');await vi.waitFor(()=>expect(wrapper.text()).toContain('收到'));
 if(change==='stop')await wrapper.findAll('button').find(b=>b.text()==='停止')!.trigger('click');
 else auth.user={...user,id:'u2'};
 await flushPromises();expect(signal.aborted).toBe(true);
 if(change==='account'){emit('旧账号秘密');await flushPromises();expect(wrapper.text()).not.toContain('旧账号秘密');expect(wrapper.text()).not.toContain('收到');}
 else {expect(wrapper.text()).toContain('未完成');expect(wrapper.text()).toContain('已停止');expect(wrapper.get('textarea').attributes('disabled')).toBeUndefined();}
});
it('keeps a committed answer when subsequent history refresh fails',async()=>{
 const {wrapper}=await setup();
 mockApi.mockImplementation(async(path,opts,onDelta)=>{
  if(path.endsWith('/messages')){onDelta?.('完整回复');return {messages:[{id:'u',role:'user',content:'问题'},{id:'a',role:'assistant',content:'完整回复'}]};}
  if(opts?.method==='POST')return {conversation:{id:'c1',title:'stream'}};
  if(path.endsWith('/c1'))throw new Error('刷新失败');
  return {conversations:[]};
 });
 await wrapper.get('textarea').setValue('问题');await wrapper.get('form').trigger('submit');await flushPromises();
 expect(wrapper.text()).toContain('完整回复');expect(wrapper.text()).not.toContain('未完成');expect(wrapper.findAll('article')).toHaveLength(2);
});
