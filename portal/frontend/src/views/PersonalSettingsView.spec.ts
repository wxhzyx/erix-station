import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createRouter, createMemoryHistory } from 'vue-router';
import PersonalSettingsView from './PersonalSettingsView.vue';
import { useAuthStore } from '../stores/auth';
import { api } from '../api';
import { i18n, setLocale } from '../i18n';
vi.mock('../api', () => ({ api: vi.fn() }));
const mockApi=vi.mocked(api);
const allowance={daily_limit:2000000,used:500000,reserved:1000,remaining:1499000,requests:[]};
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{setLocale('zh-CN');mockApi.mockReset();mockApi.mockResolvedValue(allowance);});
afterEach(()=>wrapper?.unmount());
async function setup(path='/settings'){
 const pinia=createPinia();setActivePinia(pinia);const auth=useAuthStore();auth.user={id:'u1',login:'member',display_name:'Member',role:'fde',fde_name:'member',auth_source:'oidc'};auth.ready=true;
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/settings',component:PersonalSettingsView},{path:'/chat',component:{template:'<div />'}},{path:'/',component:{template:'<div />'}}]});
 await router.push(path);await router.isReady();wrapper=mount(PersonalSettingsView,{global:{plugins:[pinia,router,i18n]}});await flushPromises();return{auth,router};
}
it('keeps personal preferences separate from admin APIs and persists language',async()=>{
 await setup();expect(wrapper.text()).toContain('INTEVA SSO');expect(mockApi).not.toHaveBeenCalled();expect(wrapper.find('a[href="/admin"]').exists()).toBe(false);
 expect(wrapper.find('select').exists()).toBe(false);await wrapper.get('button[aria-haspopup="menu"]').trigger('click');await wrapper.findAll('[role=menuitem]')[1]!.trigger('click');
 expect(wrapper.text()).toContain('Personal settings');expect(localStorage.getItem('locale')).toBe('en');
});
it('shows authoritative shared quota and submits an upgrade request, then locks duplicate requests',async()=>{
 await setup('/settings?tab=usage');expect(wrapper.text()).toContain('500,000');expect(wrapper.get('[role=progressbar]').attributes('aria-valuenow')).toBe('25.05');
 await wrapper.get('input[type=number]').setValue(4000000);await wrapper.get('textarea').setValue('项目需要');
 mockApi.mockResolvedValueOnce({}).mockResolvedValueOnce({...allowance,requests:[{id:'r1',requested_limit:4000000,status:'pending'}]});
 await wrapper.get('form').trigger('submit');await flushPromises();
 const [,opts]=mockApi.mock.calls.find(([,o])=>o?.method==='POST')!;expect(JSON.parse(opts!.body as string)).toEqual({requested_limit:4000000,reason:'项目需要'});
 expect(wrapper.text()).toContain('等待管理员审批');expect(wrapper.find('form').exists()).toBe(false);
});
it('discards a stale quota response after a user change',async()=>{
 const {auth}=await setup('/settings?tab=usage');let resolve:(v:unknown)=>void=()=>{};mockApi.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 auth.user={...auth.user!,id:'u2'};await flushPromises();expect(wrapper.text()).not.toContain('500,000');
 auth.user=null;await flushPromises();resolve(allowance);await flushPromises();expect(wrapper.text()).not.toContain('500,000');expect(wrapper.find('form').exists()).toBe(false);
});
