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
    expect(wrapper.find('aside').exists()).toBe(false);
    expect(wrapper.text()).toContain('开始一段新对话');
    expect(wrapper.get('input[type=file]').attributes('multiple')).toBeDefined();
    expect(wrapper.get('a[href="/"]').text()).toContain('工作模式');
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
    await input.trigger('change'); await new Promise(r => setTimeout(r, 30)); await flushPromises();
    expect(wrapper.text()).toContain('one.txt'); expect(wrapper.text()).toContain('two.txt');
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
    Object.defineProperty(input.element, 'files', {configurable:true,value:Array.from({length:6}, (_,i) => new File(['x'], `${i}.txt`))});
    await input.trigger('change'); await flushPromises(); expect(wrapper.get('[role=alert]').text()).toContain('最多 5');
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
    await new Promise(r => setTimeout(r, 30)); await flushPromises();
  }
  it('sends extracted Unicode text, not document bytes, and displays warnings', async () => {
    const { wrapper } = await setup();
    const original = mockApi.getMockImplementation()!;
    mockApi.mockImplementation(async (path, opts) => path === '/api/attachments/extract'
      ? { name: 'report.pdf', text: '表格内容\n[已截断]', warnings: ['已截断'] } : original(path, opts));
    await upload(wrapper);
    expect(wrapper.text()).toContain('已截断');
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
    Object.defineProperty(input.element, 'files', { configurable:true, value:[{name:'large.pdf',size:8 * 1024 * 1024 + 1}] });
    await input.trigger('change'); await flushPromises();
    expect(wrapper.get('[role=alert]').text()).toContain('8 MiB');
    expect(mockApi.mock.calls.some(([url]) => url === '/api/attachments/extract')).toBe(false);
  });
});
