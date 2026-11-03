import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import QuotaIndicator from './QuotaIndicator.vue';
vi.mock('../api',()=>({api:vi.fn()}));
const request=vi.mocked(api),quota={daily_limit:2000000,used:500000,reserved:1000,remaining:1499000};
let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{setLocale('zh-CN');request.mockReset();request.mockResolvedValue(quota);});
afterEach(()=>wrapper?.unmount());
async function setup(){
 const pinia=createPinia(),auth=useAuthStore(pinia);auth.user={id:'a',login:'a',display_name:'A',role:'fde',fde_name:'a',auth_source:'oidc'};
 const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{template:'<div />'}},{path:'/settings',component:{template:'<div />'}}]});await router.push('/');
 wrapper=mount(QuotaIndicator,{global:{plugins:[pinia,router,i18n],stubs:{ElPopover:{template:'<div><slot name="reference"/><slot/></div>'}}}});await flushPromises();return{auth,router};
}
it('shows used percentage with authoritative details, and opens quota settings on click',async()=>{
 const {router}=await setup();expect(wrapper.get('button').text()).toBe('25%');
 expect(wrapper.text()).toContain('500,000');expect(wrapper.text()).toContain('2,000,000');expect(wrapper.text()).toContain('1,499,000');
 await wrapper.get('button').trigger('click');await flushPromises();expect(router.currentRoute.value.fullPath).toBe('/settings?tab=usage');
});
it('does not show a failed or zero-limit quota as unused 0%',async()=>{
 request.mockRejectedValueOnce(new Error('offline'));await setup();expect(wrapper.get('button').text()).toBe('—');expect(wrapper.text()).toContain('暂不可用');
 request.mockResolvedValue({...quota,daily_limit:0});window.dispatchEvent(new Event('focus'));await flushPromises();expect(wrapper.get('button').text()).toBe('—');
});
it('discards a previous account response and clears data immediately on logout',async()=>{
 const {auth}=await setup();let resolve!:(value:unknown)=>void;request.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));
 auth.user={...auth.user!,id:'b'};await flushPromises();expect(wrapper.text()).not.toContain('500,000');
 auth.user=null;resolve(quota);await flushPromises();expect(wrapper.text()).not.toContain('500,000');expect(wrapper.get('button').text()).toBe('—');
});
