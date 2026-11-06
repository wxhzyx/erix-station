// DirSelect 单测（issue #84 P5.4）：目录下拉数据源（store.dirs）、●N 运行态徽标
//（N=running+queued，0 不显）、末项「＋ 新建目录」、切换 selectDir。
// store 状态直填、fetch 桩掉（不碰真实后端）。事件消费侧（new-dir/refresh）在 SidebarPanel.spec 覆盖。
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { ElSelect, ElOption } from 'element-plus';
import { createPinia, setActivePinia } from 'pinia';
import DirSelect from './DirSelect.vue';
import { useWorkbenchStore } from '../stores/workbench';
import { i18n, setLocale } from '../i18n';

// selectDir 会触发 loadSessions：桩掉 fetch（不碰真实后端）。
beforeEach(() => {
  // issue #101 P2：装配真实 i18n 单例，每例重置为 zh-CN。
  localStorage.clear();
  setLocale('zh-CN');
  setActivePinia(createPinia());
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{"items":[]}', { status: 200 })));
});

function setup(dirs: { name: string; cwd: string; running_count: number; queued_count: number }[]) {
  const store = useWorkbenchStore();
  store.canCreateProject = true;
  store.dirs = dirs;
  store.dirCwd = dirs[0]?.cwd ?? null;
  const wrapper = mount(DirSelect, { props: {}, global: { plugins: [i18n] } });
  return { store, wrapper };
}

describe('DirSelect（目录下拉）', () => {
  it('管理员下发模式隐藏用户新建目录入口', async () => {
    const { store, wrapper } = setup([]);
    store.canCreateProject = false;
    await wrapper.vm.$nextTick();
    expect(wrapper.findAllComponents(ElOption).some(o => o.props('value') === '__new__')).toBe(false);
  });
  it('选项 = 目录名 + ●N 徽标（N=running+queued；0 不显示徽标）+ 末项「＋ 新建目录」', () => {
    const { wrapper } = setup([
      { name: 'llm-smoke', cwd: '~/projects/llm-smoke', running_count: 1, queued_count: 1 },
      { name: 'idle', cwd: '~/projects/idle', running_count: 0, queued_count: 0 },
    ]);
    const options = wrapper.findAllComponents(ElOption);
    expect(options.map((o) => o.props('label'))).toEqual(['llm-smoke ●2', 'idle', '＋ 新建目录']);
    expect(options[0].props('value')).toBe('~/projects/llm-smoke');
  });

  it('切换选项 → store.selectDir（cwd 切换，会话列表按新 cwd 重载）', async () => {
    const { store, wrapper } = setup([
      { name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 },
      { name: 'b', cwd: '~/projects/b', running_count: 0, queued_count: 0 },
    ]);
    wrapper.getComponent(ElSelect).vm.$emit('change', '~/projects/b');
    await wrapper.vm.$nextTick();
    expect(store.dirCwd).toBe('~/projects/b');
    const called = vi.mocked(fetch).mock.calls.some(([u]) => String(u).startsWith('/api/sessions?cwd='));
    expect(called).toBe(true);
  });

  it('选中「＋ 新建目录」→ 下拉弹回当前选中，不产生 cwd 切换', async () => {
    const { store, wrapper } = setup([
      { name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 },
    ]);
    const select = wrapper.getComponent(ElSelect);
    select.vm.$emit('change', '__new__');
    await wrapper.vm.$nextTick();
    expect(store.dirCwd).toBe('~/projects/a'); // 未切目录（表单流程由 SidebarPanel 承接）
    expect(select.props('modelValue')).toBe('~/projects/a'); // 弹回
  });

  it('无目录：显示「（无目录）」占位选项，且「＋ 新建目录」仍可选', async () => {
    const { wrapper } = setup([]);
    await wrapper.vm.$nextTick();
    expect(wrapper.getComponent(ElSelect).props('placeholder')).toBe('（无目录）');
    // issue #332：这里原先还钉「平台管理员 ⇒ 该选项 disabled」。入口拦截后没有工位的平台管理员
    // 进不到工作台，`store.newDirDisabled` 已拆除 ⇒ 这里改钉「选项恒可用」，防它被顺手加回来。
    const opt = wrapper.findAllComponents(ElOption).find((o) => o.props('label') === '＋ 新建目录');
    expect(opt?.attributes('disabled')).toBeUndefined();
  });

  // issue #112：控件收敛——32px 高 / 7px 圆角 / 12px 字号（label 11px）。
  it('控件规格（issue #112）：select 与 ↻ 均 32px 高 / 7px 圆角 / 12px 字号，label 11px', () => {
    const { wrapper } = setup([{ name: 'a', cwd: '~/projects/a', running_count: 0, queued_count: 0 }]);
    const select = wrapper.getComponent(ElSelect);
    expect(select.classes()).toContain('el-select');
    const refresh = wrapper.get('button[title="刷新目录列表与目录树"]');
    expect(refresh.classes()).toContain('el-button');
    expect(wrapper.get('label[for="dirSel"]').text()).toBeTruthy();
  });
});

describe('Project context menu', () => {
  it('right click and keyboard open actions for selected project; escape dismisses', async () => {
    const { wrapper } = setup([{name:'demo',cwd:'~/projects/demo',running_count:0,queued_count:0}]);
    await wrapper.get('.project-selector__controls').trigger('contextmenu');
    expect(wrapper.get('[role=menu]').text()).toContain('发起审批');
    expect(wrapper.get('[role=menu]').text()).toContain('合并版本');
    await wrapper.get('[role=menu]').trigger('keydown',{key:'Escape'}); expect(wrapper.find('[role=menu]').exists()).toBe(false);
    await wrapper.get('.project-selector__controls').trigger('keydown',{key:'F10',shiftKey:true}); expect(wrapper.find('[role=menu]').exists()).toBe(true); wrapper.unmount();
  });
  it('visible actions fallback disables without a project and closes on project change',async()=>{
    const {wrapper,store}=setup([]);expect(wrapper.get('button[aria-label="项目操作"]').attributes('disabled')).toBeDefined();store.dirCwd='~/projects/a';await wrapper.vm.$nextTick();await wrapper.get('button[aria-label="项目操作"]').trigger('click');expect(wrapper.find('[role=menu]').exists()).toBe(true);store.dirCwd='~/projects/b';await wrapper.vm.$nextTick();expect(wrapper.find('[role=menu]').exists()).toBe(false);wrapper.unmount();
  });
});
