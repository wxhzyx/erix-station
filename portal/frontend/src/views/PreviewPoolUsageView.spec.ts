import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import PreviewPoolUsageView from './PreviewPoolUsageView.vue';
import { api } from '../api';
import { i18n, setLocale } from '../i18n';
vi.mock('../api', () => ({ api:vi.fn() }));
const mockApi=vi.mocked(api);
let wrapper:ReturnType<typeof mount>;
const at='2026-11-03T05:00:00Z';
const fixture={sampled_at:at,freshness_seconds:45,total:2,limit:500,items:[
 {id:'a',login:'JXu14',display_name:'Xu, Jim(IT)',project:'machine-dashboard',port:22020,branch:'dev/JXu14',routed:true,observed_at:at},
 {id:'b',login:'employee',display_name:'Employee',project:null,port:5173,branch:null,routed:false,observed_at:at},
]};
beforeEach(()=>{setLocale('zh-CN');mockApi.mockReset();mockApi.mockResolvedValue(fixture);vi.useFakeTimers({toFake:['setInterval','clearInterval','performance']});});
afterEach(()=>{wrapper?.unmount();vi.useRealTimers();});
async function setup(){wrapper=mount(PreviewPoolUsageView,{global:{plugins:[i18n]}});await flushPromises();}
it('shows SSO identity, observed project and actual port without pool blocks or direct preview links',async()=>{
 await setup();expect(mockApi).toHaveBeenCalledWith('/api/admin/preview-ports/runtime');
 for(const text of ['JXu14','Xu, Jim(IT)','machine-dashboard','22020','监听中','未识别项目','未分配']) expect(wrapper.text()).toContain(text);
 expect(wrapper.find('a').exists()).toBe(false);expect(wrapper.text()).not.toContain('空闲的段');
 await wrapper.get('input').setValue('machine');expect(wrapper.text()).toContain('machine-dashboard');expect(wrapper.text()).not.toContain('employee');
});
it('expires cached observations even when refresh fails and stops polling after unmount',async()=>{
 await setup();mockApi.mockRejectedValue(new Error('网络失败'));
 await vi.advanceTimersByTimeAsync(46000);await flushPromises();
 expect(wrapper.text()).toContain('网络失败');expect(wrapper.text()).not.toContain('JXu14');expect(wrapper.text()).toContain('暂无新鲜');
 wrapper.unmount();const calls=mockApi.mock.calls.length;await vi.advanceTimersByTimeAsync(30000);expect(mockApi.mock.calls.length).toBe(calls);
});
it('shows a bounded-result notice and surfaces first-load errors',async()=>{
 mockApi.mockResolvedValueOnce({...fixture,total:600});await setup();expect(wrapper.text()).toContain('500 / 600');
 wrapper.unmount();mockApi.mockRejectedValue(new Error('服务不可用'));await setup();expect(wrapper.text()).toContain('服务不可用');
});
it('does not promote old or future observations to current listeners',async()=>{
 mockApi.mockResolvedValueOnce({...fixture,items:fixture.items.map((row,i)=>({...row,observed_at:i?'2026-11-03T06:00:00Z':'2026-11-03T04:59:00Z'}))});
 await setup();expect(wrapper.text()).not.toContain('JXu14');expect(wrapper.text()).not.toContain('employee');
});
