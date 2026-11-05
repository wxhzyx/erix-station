import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AdminDeliveryView from './AdminDeliveryView.vue';

afterEach(() => vi.unstubAllGlobals());

it('requires the project name and explains retained repositories before deletion',async()=>{
  const requests:{url:string;options?:RequestInit}[]=[];
  vi.stubGlobal('fetch',vi.fn(async(url:string,options?:RequestInit)=>{
    requests.push({url,options});
    const data=url.endsWith('/users')?{items:[]}:url.endsWith('delivery-packages')?{packages:[]}:
      url.endsWith('assigned-projects')?{projects:[{id:'project-one',name:'alpha',login:'JXu14',status:'ready',package_name:'Kit',repo_url:'https://git.invalid/alpha'}]}:{ok:true};
    return new Response(JSON.stringify(data),{status:200});
  }));
  const wrapper=mount(AdminDeliveryView);await flushPromises();
  await vi.waitFor(()=>expect(wrapper.get('[data-test="delete-project"]').attributes('disabled')).toBeUndefined());
  await wrapper.get('[data-test="delete-project"]').trigger('click');
  expect(wrapper.get('[role="dialog"]').text()).toContain('保留 Gitea 仓库');
  const button=wrapper.get('[data-test="confirm-project-delete"]');expect(button.attributes('disabled')).toBeDefined();
  await wrapper.get('[data-test="project-delete-confirmation"]').setValue('alpha');
  await wrapper.get('form.delivery').trigger('submit');await flushPromises();
  await vi.waitFor(()=>expect(requests.find(r=>r.options?.method==='DELETE')).toEqual({url:'/api/admin/assigned-projects/project-one',options:expect.objectContaining({method:'DELETE',body:JSON.stringify({confirmation:'alpha'})})}));
  wrapper.unmount();
});

it('uses the real admin users items envelope and offers only active workstations', async () => {
  vi.stubGlobal('fetch', vi.fn(async (input: string) => {
    const data = input === '/api/admin/users' ? {items:[
      {id:'active',login:'employee',display_name:'员工',fde_name:'seat',status:'active'},
      {id:'disabled',login:'disabled-person',fde_name:'old-seat',status:'disabled'},
    ]} : input.endsWith('delivery-packages') ? {packages:[]} : input.endsWith('assigned-projects') ? {projects:[]} : {requests:[]};
    return new Response(JSON.stringify(data), {status:200});
  }));
  const wrapper = mount(AdminDeliveryView);
  await flushPromises();
  expect(wrapper.findAllComponents({name:'ElOption'}).map(option=>option.props('label'))).toContain('员工 · employee');
  expect(wrapper.text()).not.toContain('disabled-person');
  expect(wrapper.find('[role="alert"]').exists()).toBe(false);
  wrapper.unmount();
});

it('surfaces failed initial loading without an unhandled rejection', async () => {
  vi.stubGlobal('fetch',vi.fn(async () => new Response(JSON.stringify({error:{message:'服务暂不可用'}}),{status:503})));
  const wrapper=mount(AdminDeliveryView);
  await flushPromises();
  expect(wrapper.get('[role="alert"]').text()).toContain('服务暂不可用');
  wrapper.unmount();
});
