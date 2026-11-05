import { ApiError } from '../api';

export async function readChatStream<T>(response: Response, onDelta: (text: string) => void, signal?: AbortSignal | null): Promise<T> {
  if (!response.body) throw new Error('回复流不可用');
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '', bytes = 0;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  try {
    while (true) {
      signal?.throwIfAborted();
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) throw new Error('回复连接中断，请重试');
      bytes += item.value.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('回复过大');
      buffer += decoder.decode(item.value, { stream: true });
      let boundary;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const frame = buffer.slice(0, boundary.index); buffer = buffer.slice(boundary.index + boundary[0].length);
        const lines = frame.split(/\r?\n/), type = lines.find(line => line.startsWith('event:'))?.slice(6).trim();
        const raw = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!raw) continue;
        const data = JSON.parse(raw);
        if (type === 'delta' && typeof data.text === 'string') onDelta(data.text);
        else if (type === 'done' && Array.isArray(data.messages)) return data as T;
        else if (type === 'error') throw new ApiError(data.error?.message || '回复未完成', data.error?.status || 502, data.error?.code);
      }
    }
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
