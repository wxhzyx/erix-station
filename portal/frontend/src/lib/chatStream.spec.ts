import { describe, expect, it } from 'vitest';
import { readChatStream } from './chatStream';

describe('chat stream transport', () => {
  it('delivers split UTF-8 events before the committed result', async () => {
    let source!: ReadableStreamDefaultController<Uint8Array>;
    const body = new ReadableStream<Uint8Array>({ start(controller) { source = controller; } });
    const received: string[] = [];
    let finished = false;
    const result = readChatStream(new Response(body), text => received.push(text)).then(value => { finished = true; return value; });
    for (const byte of new TextEncoder().encode(': ping\r\n\r\nevent: delta\r\ndata: {"text":"你好😀"}\r\n\r\n')) source.enqueue(Uint8Array.of(byte));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(received).toEqual(['你好😀']); expect(finished).toBe(false);
    source.enqueue(new TextEncoder().encode('event: done\ndata: {"messages":[]}\n\n'));
    expect(await result).toEqual({ messages: [] });
  });
  it.each(['', 'event: error\ndata: {"error":{"message":"失败","code":"chat_failed","status":502}}\n\n'])('rejects incomplete/error streams without losing emitted text', async ending => {
    const received: string[] = [];
    const body = 'event: delta\ndata: {"text":"部分"}\n\n' + ending;
    await expect(readChatStream(new Response(body), text => received.push(text))).rejects.toThrow(ending ? '失败' : '中断');
    expect(received).toEqual(['部分']);
  });
  it('cancels a stalled reader immediately', async () => {
    let cancelled = false;
    const controller = new AbortController();
    const result = readChatStream(new Response(new ReadableStream({ cancel() { cancelled = true; } })), () => {}, controller.signal);
    controller.abort();
    await expect(result).rejects.toMatchObject({ name: 'AbortError' });
    expect(cancelled).toBe(true);
  });
});
