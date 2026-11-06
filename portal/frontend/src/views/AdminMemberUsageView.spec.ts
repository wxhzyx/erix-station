import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { api } from '../api';
import { i18n, setLocale } from '../i18n';
import AdminMemberUsageView from './AdminMemberUsageView.vue';

vi.mock('../api', () => ({ api: vi.fn() }));
const request = vi.mocked(api);
const members = [
  { id: 'u1', login: 'alice', display_name: 'Alice Tester' },
  { id: 'u2', login: 'bob', display_name: 'Bob Example' },
];
const quota = { day: '2026-11-06', used: 123456, reserved: 1000, daily_limit: 2000000, remaining: 1875544 };
let wrapper: ReturnType<typeof mount>;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
  vi.setSystemTime(new Date('2026-11-05T17:00:00Z'));
  setLocale('zh-CN');
  request.mockReset();
  request.mockImplementation(async path => path === '/api/admin/users' ? { items: members } : quota);
});
afterEach(() => { wrapper?.unmount(); vi.useRealTimers(); });
async function setup() {
  wrapper = mount(AdminMemberUsageView, { global: { plugins: [i18n] } });
  await flushPromises();
}
const tableRows = () => wrapper.findAll('.el-table__body tr');

it('uses Beijing calendar date and shows exact gateway counters without adding reserved to usage', async () => {
  await setup();
  expect(wrapper.text()).toContain('2026-11-06 · 北京时间');
  expect(tableRows()).toHaveLength(2);
  expect(tableRows()[0].text()).toContain('alice');
  expect(tableRows()[0].text()).toContain('Alice Tester');
  for (const value of ['123,456', '1,000', '2,000,000', '1,875,544']) expect(tableRows()[0].text()).toContain(value);
  expect(tableRows()[0].text()).not.toContain('124,456');
  expect(request.mock.calls.every(([, options]) => !options?.method || options.method === 'GET')).toBe(true);
});

it('sorts by used tokens, searches names and accounts, and preserves genuine zero use/zero quota', async () => {
  request.mockImplementation(async path => path === '/api/admin/users' ? { items: members } : path.includes('u1') ? { ...quota, used: 0, daily_limit: 0, reserved: 0, remaining: 0 } : quota);
  await setup();
  expect(tableRows()[0].text()).toContain('bob');
  expect(tableRows()[1].text()).not.toContain('读取失败');
  expect(tableRows()[1].findAll('td')[1].text()).toBe('0');
  await wrapper.get('input').setValue('tester');
  expect(tableRows()).toHaveLength(1);
  expect(tableRows()[0].text()).toContain('alice');
  await wrapper.get('input').setValue('bob');
  expect(tableRows()[0].text()).toContain('bob');
});

it('isolates failed members and retries on refresh without displaying a failed request as zero', async () => {
  let offline = true;
  request.mockImplementation(async path => {
    if (path === '/api/admin/users') return { items: members };
    if (path.includes('u1') && offline) throw new Error('offline');
    return quota;
  });
  await setup();
  const failed = tableRows().find(row => row.text().includes('alice'))!;
  expect(failed.text()).toContain('读取失败');
  expect(failed.findAll('td')[2].text()).toBe('—');
  expect(wrapper.text()).toContain('123,456');
  offline = false;
  await wrapper.get('button').trigger('click');
  await flushPromises();
  expect(wrapper.text()).not.toContain('读取失败');
});

it.each([
  { ...quota, day: '2026-11-05' },
  { ...quota, used: undefined },
  { ...quota, used: -1 },
  { ...quota, remaining: '42' },
])('rejects stale or malformed usage: %j', async invalid => {
  request.mockImplementation(async path => path === '/api/admin/users' ? { items: [members[0]] } : invalid);
  await setup();
  expect(tableRows()[0].text()).toContain('读取失败');
  expect(tableRows()[0].text()).not.toContain('123,456');
});

it('surfaces list failure and does not leave an unhandled rejection', async () => {
  request.mockRejectedValue(new Error('成员列表不可用'));
  await setup();
  expect(wrapper.get('[role="alert"]').text()).toContain('成员列表不可用');
  expect(tableRows()).toHaveLength(0);
});

it('bounds concurrent reads and aborts in-flight work on unmount', async () => {
  let signal: AbortSignal | undefined;
  request.mockImplementation(async (path, options) => {
    if (path === '/api/admin/users') return { items: Array.from({ length: 10 }, (_, id) => ({ ...members[0], id: String(id) })) };
    signal = options?.signal as AbortSignal;
    return new Promise(() => {});
  });
  await setup();
  expect(request).toHaveBeenCalledTimes(5);
  expect(signal?.aborted).toBe(false);
  wrapper.unmount();
  expect(signal?.aborted).toBe(true);
});

it('refreshes the new Beijing day without retaining yesterday counters', async () => {
  await setup();
  vi.setSystemTime(new Date('2026-11-06T16:00:01Z'));
  request.mockImplementation(async path => path === '/api/admin/users' ? { items: members } : { ...quota, day: '2026-11-07', used: 0 });
  await vi.advanceTimersByTimeAsync(60000);
  await flushPromises();
  expect(wrapper.text()).toContain('2026-11-07');
  expect(wrapper.text()).not.toContain('123,456');
});
