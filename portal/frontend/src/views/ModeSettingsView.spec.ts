import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import ModeSettingsView from './ModeSettingsView.vue';
vi.mock('../api', () => ({ api: vi.fn() }));
const mockApi = vi.mocked(api);
const provider = {id:'p1',name:'API One',models:[{id:'m1',model_name:'chat-model',type:'text',tool_calling:false},{id:'m2',model_name:'work-model',type:'text',tool_calling:true}]};
let wrapper: ReturnType<typeof mount>;
beforeEach(() => { setLocale('zh-CN'); mockApi.mockReset(); mockApi.mockResolvedValue({providers:[provider],chat:{provider_id:'p1',main:{model_id:'m1'}},work:{provider_id:'p1',main:{model_id:'m2'}}}); });
afterEach(() => wrapper?.unmount());
async function setup() { const pinia = createPinia(); setActivePinia(pinia); const auth = useAuthStore(); auth.user = {id:'u1',login:'a',display_name:null,role:'fde',fde_name:'a',auth_source:'local'}; wrapper = mount(ModeSettingsView,{global:{plugins:[pinia,i18n],stubs:{RouterLink:{template:'<a><slot /></a>'}}}}); await flushPromises(); return auth; }
describe('per-user mode settings', () => {
  it('loads separate selections and saves only selected mode, without keys', async () => {
    await setup(); const selects = wrapper.findAll('select');
    expect((selects[2]!.element as HTMLSelectElement).value).toBe('m1');
    await selects[0]!.setValue('work'); expect((selects[2]!.element as HTMLSelectElement).value).toBe('m2');
    expect(selects[2]!.text()).not.toContain('chat-model');
    mockApi.mockResolvedValueOnce({provider_id:'p1',main:{model_id:'m2'}});
    await wrapper.get('form').trigger('submit'); await flushPromises();
    const [path, opts] = mockApi.mock.calls.at(-1)!; expect(path).toBe('/api/me/mode-settings/work');
    expect(JSON.parse(opts!.body as string)).toEqual({provider_id:'p1',main_model_id:'m2',embedding_model_id:null,vision_model_id:null});
    expect(wrapper.text()).toContain('已保存'); expect(wrapper.find('input[type=password]').exists()).toBe(false);
  });
  it('clears previous user config while loading another account', async () => {
    const auth = await setup(); let resolve: (value: unknown) => void = () => {};
    mockApi.mockImplementationOnce(() => new Promise(r => {resolve = r;})); auth.user = {...auth.user!,id:'u2'}; await flushPromises();
    expect(wrapper.text()).not.toContain('API One');
    resolve({providers:[],chat:null,work:null}); await flushPromises(); expect(wrapper.text()).not.toContain('API One');
  });
});
