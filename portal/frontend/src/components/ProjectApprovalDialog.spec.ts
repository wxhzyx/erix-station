import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount, flushPromises } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { api } from '../api';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import ProjectApprovalDialog from './ProjectApprovalDialog.vue';
vi.mock('../api',()=>({api:vi.fn()}));
const request=vi.mocked(api);let wrapper:ReturnType<typeof mount>;
beforeEach(()=>{setLocale('zh-CN');request.mockReset();request.mockResolvedValue({items:[]});const pinia=createPinia();setActivePinia(pinia);useAuthStore().user={id:'u1',login:'a',display_name:null,role:'fde',fde_name:'a',auth_source:'local'};});
afterEach(()=>wrapper?.unmount());
function setup(){wrapper=mount(ProjectApprovalDialog,{props:{cwd:'~/projects/demo'},global:{plugins:[i18n],stubs:{ModalShell:{template:'<div><slot /></div>'}}}});}
describe('Project approval request',()=>{
 it('requires explicit different branches and preserves failed input',async()=>{setup();await wrapper.get('[name=source_ref]').setValue('main');await wrapper.get('[name=target_ref]').setValue('main');await wrapper.get('form').trigger('submit');expect(request).not.toHaveBeenCalled();expect(wrapper.get('[role=alert]').text()).toContain('不能相同');await wrapper.get('[name=source_ref]').setValue('feature');request.mockRejectedValueOnce(new Error('remote unavailable'));await wrapper.get('form').trigger('submit');await flushPromises();expect(request.mock.calls[0]![1]?.body).toBe(JSON.stringify({cwd:'~/projects/demo',source_ref:'feature',target_ref:'main'}));expect((wrapper.get('[name=source_ref]').element as HTMLInputElement).value).toBe('feature');});
 it('guards repeated submit and shows requester history after completion',async()=>{setup();await wrapper.get('[name=source_ref]').setValue('feature');await wrapper.get('[name=target_ref]').setValue('main');let resolve:(value:unknown)=>void=()=>{};request.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await wrapper.get('form').trigger('submit');await wrapper.get('form').trigger('submit');expect(request).toHaveBeenCalledTimes(1);resolve({id:'a1'});await flushPromises();expect(wrapper.text()).toContain('审批已提交');expect(wrapper.find('form').exists()).toBe(false);});
 it('closes on account change and never shows a late successful response',async()=>{setup();await wrapper.get('[name=source_ref]').setValue('feature');await wrapper.get('[name=target_ref]').setValue('main');let resolve:(value:unknown)=>void=()=>{};request.mockImplementationOnce(()=>new Promise(r=>{resolve=r;}));await wrapper.get('form').trigger('submit');useAuthStore().user=null;await flushPromises();expect(wrapper.emitted('close')).toHaveLength(1);resolve({id:'a1'});await flushPromises();expect(wrapper.text()).not.toContain('审批已提交');});
});
