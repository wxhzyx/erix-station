// Bounded OpenAI-compatible SSE consumption. Transport chunks need not align with UTF-8 or events.
export async function readCompletionStream(body, { onDelta, signal } = {}) {
  if (!body?.getReader) throw new Error('Missing response stream');
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', text = '', bytes = 0, done = false;
  const abort = () => { void reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', abort, { once: true });
  async function frame(frameText) {
    const data = frameText.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
    if (!data) return;
    if (data === '[DONE]') { done = true; return; }
    const chunk = JSON.parse(data);
    if (chunk.error) throw new Error('Upstream streaming error');
    const delta = chunk.choices?.[0]?.delta?.content;
    if (typeof delta === 'string' && delta) {
      text += delta;
      if (text.length > 1000000) throw new Error('Response text too large');
      signal?.throwIfAborted();
      await onDelta?.(delta);
    }
  }
  try {
    while (!done) {
      signal?.throwIfAborted();
      const item = await reader.read();
      signal?.throwIfAborted();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error('Response stream too large');
      buffer += decoder.decode(item.value, { stream: true });
      let boundary;
      while (!done && (boundary = /\r?\n\r?\n/.exec(buffer))) {
        const part = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        await frame(part);
      }
    }
    if (!done) throw new Error('Incomplete response stream');
    return text;
  } finally {
    signal?.removeEventListener('abort', abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Hold only a possible secret prefix so a key split across tokens cannot leak.
export function createSecretFilter(secret, emit) {
  let pending = '';
  return {
    async push(delta) {
      pending += delta;
      if (secret) pending = pending.split(secret).join('[redacted]');
      let hold = 0;
      for (let n = Math.min((secret?.length ?? 0) - 1, pending.length); n > 0; n--) {
        if (pending.endsWith(secret.slice(0, n))) { hold = n; break; }
      }
      const safe = pending.slice(0, pending.length - hold);
      pending = pending.slice(pending.length - hold);
      if (safe) await emit?.(safe);
    },
    async finish() { if (pending) await emit?.(pending); pending = ''; },
  };
}
