// 管理台通过统一头像菜单退出，仍须调用 auth.logout 清理用户会话和预览凭证。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import AdminLayout from './AdminLayout.vue';
import { useAuthStore } from '../stores/auth';
import { i18n, setLocale } from '../i18n';
import { setUserScopeResetListener } from '../lib/userScope';

const ADMIN_WITH_SEAT = {
  id: 'u0', login: 'root', display_name: 'Root', role: 'admin', fde_name: 'root', auth_source: 'local',
};

/** 不带应用守卫的裸路由：本组件只用 useRoute/useRouter，守卫的 /api/me 与本单无关。 */
function makeRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/', component: AdminLayout },
      { path: '/login', component: { template: '<div>login</div>' } },
      // 提供管理页面路由桩；菜单点击由浏览器回归验证。
      ...['admin-delivery', 'admin-approvals', 'admin-users', 'admin-llm', 'admin-repos', 'admin-preview-pool']
        .map((name) => ({ path: `/${name}`, name, component: { template: '<div />' } })),
    ],
  });
}

beforeEach(() => {
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
});

afterEach(() => {
  setUserScopeResetListener(null);
  vi.unstubAllGlobals();
});

describe('AdminLayout 头像菜单退出', () => {
  it('点「登出」：打 /api/auth/logout、跳 /login，并触发用户 scope 复位', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      calls.push(url);
      return new Response(null, { status: 204 });
    }));
    let notified = 0;
    setUserScopeResetListener(() => { notified += 1; }); // 工作台侧注册的就是这个（此处用 spy 代替）

    const auth = useAuthStore();
    auth.user = ADMIN_WITH_SEAT as never;
    auth.ready = true;
    const router = makeRouter();
    router.push('/');
    await router.isReady();
    const wrapper = mount(AdminLayout, { global: { plugins: [router, i18n] } });

    expect(wrapper.find('header button').exists()).toBe(false);
    expect(wrapper.find('[aria-label="账号菜单"]').exists()).toBe(true);
    wrapper.findComponent({name:'ElDropdown'}).vm.$emit('command','logout');
    await flushPromises();

    expect(calls.filter((u) => u.startsWith('/api/auth/logout'))).toHaveLength(1);
    expect(router.currentRoute.value.path).toBe('/login');
    wrapper.unmount();
    expect(notified, '这颗按钮必须汇到 auth.logout()——否则从管理台登出时上一账号的 SSE 没人关').toBe(1);
  });
});
