import { ElSelect, ElRadioGroup } from 'element-plus';
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
const settings = {providers:[provider],chat:{provider_id:'p1',main:{model_id:'m1'}},work:{provider_id:'p1',main:{model_id:'m2'}}};
const members = {items:[{id:'u1',login:'admin',status:'active',fde_name:'admin'},{id:'u2',login:'member',status:'active',fde_name:'member'}]};
let wrapper: ReturnType<typeof mount>;
beforeEach(() => { setLocale('zh-CN'); mockApi.mockReset(); mockApi.mockImplementation(async path => path === '/api/admin/users' ? members : settings); });
afterEach(() => wrapper?.unmount());
async function setup(role='admin') { const pinia=createPinia(); setActivePinia(pinia); const auth=useAuthStore(); auth.user={id:'u1',login:'a',display_name:null,role,fde_name:'a',auth_source:'local'}; wrapper=mount(ModeSettingsView,{global:{plugins:[pinia,i18n],stubs:{RouterLink:{template:'<a><slot /></a>'}}}}); await flushPromises(); return auth; }
describe('administrator model assignments', () => {
  it('selects a member and saves only their development model without keys', async () => {
    await setup(); wrapper.findAllComponents(ElSelect)[0]!.vm.$emit('update:modelValue','u2'); await flushPromises(); wrapper.findAllComponents(ElSelect)[0]!.vm.$emit('change','u2'); await flushPromises();
    wrapper.getComponent(ElRadioGroup).vm.$emit('update:modelValue','work'); await flushPromises();
    const selects=wrapper.findAllComponents(ElSelect); expect(selects[2]!.props('modelValue')).toBe('m2'); expect(selects[2]!.text()).not.toContain('chat-model');
    mockApi.mockResolvedValueOnce({provider_id:'p1',main:{model_id:'m2'}});
    await wrapper.get('form').trigger('submit'); await flushPromises();
    const [path,opts]=mockApi.mock.calls.at(-1)!; expect(path).toBe('/api/admin/users/u2/mode-settings/work');
    expect(JSON.parse(opts!.body as string)).toEqual({provider_id:'p1',main_model_id:'m2',embedding_model_id:null,vision_model_id:null});
    expect(wrapper.text()).toContain('已保存'); expect(wrapper.find('input[type=password]').exists()).toBe(false);
  });
  it('never requests configuration or exposes the form to a regular member',async()=>{
    await setup('fde'); expect(mockApi).not.toHaveBeenCalled(); expect(wrapper.find('form').exists()).toBe(false);
  });
  it('clears previous account and ignores obsolete responses after privilege changes',async()=>{
    const auth=await setup(); let resolve:(value:unknown)=>void=()=>{};
    mockApi.mockImplementationOnce(()=>new Promise(r=>{resolve=r;})); wrapper.findAllComponents(ElSelect)[0]!.vm.$emit('update:modelValue','u2'); await flushPromises(); wrapper.findAllComponents(ElSelect)[0]!.vm.$emit('change','u2'); await flushPromises(); expect(wrapper.text()).not.toContain('API One');
    auth.user={...auth.user!,id:'u3',role:'fde'}; await flushPromises(); resolve(settings); await flushPromises(); expect(wrapper.find('form').exists()).toBe(false); expect(wrapper.text()).not.toContain('API One');
  });
  it('disables saving when loading fails',async()=>{
    mockApi.mockImplementation(async path=>{if(path==='/api/admin/users')return members;throw new Error('目录暂不可用');});
    await setup(); expect(wrapper.get('[role=alert]').text()).toContain('目录暂不可用'); expect(wrapper.findAll('button').at(-1)!.attributes('disabled')).toBeDefined();
  });
});
