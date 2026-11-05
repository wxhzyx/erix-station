// Ownership and input checks happen before start(). A committed result is the only done event.
export async function streamChatResponse(res, send) {
  const controller = new AbortController();
  let ping;
  const closed = () => controller.abort();
  res.once('close', closed);
  function start() {
    controller.signal.throwIfAborted();
    if (res.headersSent) return;
    res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no' });
    res.flushHeaders?.();
    ping = setInterval(() => {
      if (!res.destroyed && res.writableLength < 65536) res.write(': ping\n\n');
    }, 15000);
  }
  async function event(type, data) {
    start();
    if (res.writableLength > 1024 * 1024) throw new Error('Client too slow');
    await new Promise((resolve, reject) => res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`, err => err ? reject(err) : resolve()));
  }
  try {
    const result = await send({ signal: controller.signal, onStart: start, onDelta: text => event('delta', { text }) });
    await event('done', result);
    res.end();
  } catch (error) {
    if (res.destroyed || controller.signal.aborted) return;
    if (!res.headersSent) throw error;
    try {
      await event('error', { error: { code: error.code ?? 'chat_failed', message: '回复未完成，请重试。', status: error.httpStatus ?? 502 } });
      res.end();
    } catch {
      // Headers already went out; a closed/slow socket cannot accept a JSON fallback.
      res.destroy();
    }
  } finally {
    clearInterval(ping);
    res.removeListener('close', closed);
    controller.abort();
  }
}
