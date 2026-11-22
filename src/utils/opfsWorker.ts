/* Dedicated worker that owns OPFS sync access handles.
   createSyncAccessHandle() is the one OPFS write path that works in Safari, Firefox and Chromium. */
const ctx = self as any;
const handles = new Map<string, any>();
const root = (): Promise<any> => ctx.navigator.storage.getDirectory();

ctx.onmessage = async (e: MessageEvent) => {
  const m = e.data;
  try {
    switch (m.op) {
      case 'write': // fire-and-forget; errors come back without an id and are attached to the file name
        handles.get(m.name).write(new Uint8Array(m.buf, m.off, m.len), { at: m.at });
        return;
      case 'probe': {
        const r = await root();
        const fh = await r.getFileHandle('.probe', { create: true });
        const h = await fh.createSyncAccessHandle();
        h.close();
        await r.removeEntry('.probe');
        break;
      }
      case 'open': {
        const r = await root();
        if (m.reset) await r.removeEntry(m.name).catch(() => {});
        const fh = await r.getFileHandle(m.name, { create: true });
        const h = await fh.createSyncAccessHandle();
        // Pre-sizing doubles as a quota check: it throws QuotaExceededError if the disk is full.
        h.truncate(Math.max(h.getSize(), m.size));
        handles.set(m.name, h);
        break;
      }
      case 'flush':
        handles.get(m.name)?.flush();
        break;
      case 'close': {
        const h = handles.get(m.name);
        if (h) {
          h.flush();
          h.close();
          handles.delete(m.name);
        }
        break;
      }
      case 'remove': {
        const h = handles.get(m.name);
        if (h) {
          try { h.close(); } catch { /* already closed */ }
          handles.delete(m.name);
        }
        await (await root()).removeEntry(m.name).catch(() => {});
        break;
      }
      case 'list': {
        const names: string[] = [];
        for await (const [n] of (await root()).entries()) names.push(n);
        ctx.postMessage({ id: m.id, names });
        return;
      }
    }
    ctx.postMessage({ id: m.id });
  } catch (err: any) {
    ctx.postMessage({ id: m.id, name: m.name, err: String(err?.message || err), errName: err?.name });
  }
};

export {};
