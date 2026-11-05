import { mount } from '@vue/test-utils';
import { afterEach, expect, it, vi } from 'vitest';
import StreamingText from './StreamingText.vue';
afterEach(() => vi.unstubAllGlobals());
it('smooths a burst but catches up within 120ms and flushes on completion', async () => {
  let callback!: FrameRequestCallback;
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { callback = fn; return 1; });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const wrapper = mount(StreamingText, { props: { text: '', active: true } });
  await wrapper.setProps({ text: 'abcdefghij😀klmnopqrst' });
  callback(10); await wrapper.vm.$nextTick();
  expect(wrapper.text().length).toBeGreaterThan(0); expect(wrapper.text().length).toBeLessThan(22);
  callback(130); await wrapper.vm.$nextTick(); expect(wrapper.text()).toBe('abcdefghij😀klmnopqrst');
  await wrapper.setProps({ text: 'abcdefghij😀klmnopqrstuvw', active: false });
  expect(wrapper.text()).toBe('abcdefghij😀klmnopqrstuvw'); wrapper.unmount();
});
it('respects reduced motion and escapes plain output', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const wrapper = mount(StreamingText, { props: { text: '', active: true } });
  await wrapper.setProps({ text: '<script>alert(1)</script>' });
  expect(wrapper.text()).toBe('<script>alert(1)</script>'); expect(wrapper.find('script').exists()).toBe(false); wrapper.unmount();
});
