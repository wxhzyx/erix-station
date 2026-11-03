import { afterEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import AdminDeliveryView from './AdminDeliveryView.vue';

afterEach(() => vi.unstubAllGlobals());

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
  expect(wrapper.text()).toContain('员工 · employee');
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
