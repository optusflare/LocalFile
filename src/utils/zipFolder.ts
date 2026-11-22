import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

export interface FolderItem {
  path: string;
  file: File;
}

// Already-compressed formats are stored as-is: faster, and deflate would only burn CPU.
const STORE = new Set(['zip', 'gz', '7z', 'rar', 'xz', 'bz2', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'heic', 'mp3', 'aac', 'm4a', 'ogg', 'mp4', 'mov', 'mkv', 'webm', 'pdf']);
const STEP = 1024 * 1024;
const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const IGNORE = new Set(['.ds_store', 'thumbs.db', 'desktop.ini']);

export const isJunk = (path: string) => IGNORE.has(path.slice(path.lastIndexOf('/') + 1).toLowerCase());

/** Streams a folder into <name>.zip with fflate, yielding to the UI between slices. */
export async function zipFolder(name: string, items: FolderItem[], onProgress?: (done: number, total: number) => void): Promise<File> {
  const list = items.filter((i) => !isJunk(i.path));
  let acc = new Blob([]);
  let buf: Uint8Array[] = [];
  let buffered = 0;
  const spill = () => {
    // Folding chunks into a Blob lets the browser page them out of RAM.
    if (buf.length) acc = new Blob([acc, ...(buf as BlobPart[])]);
    buf = [];
    buffered = 0;
  };
  let zip!: Zip;
  const finished = new Promise<void>((res, rej) => {
    zip = new Zip((err, chunk, final) => {
      if (err) return rej(err);
      buf.push(chunk);
      buffered += chunk.length;
      if (buffered > 32 * 1024 * 1024) spill();
      if (final) res();
    });
  });

  let done = 0;
  for (const { path, file } of list) {
    const clean = path.replace(/^\/+/, '');
    const ext = clean.slice(clean.lastIndexOf('.') + 1).toLowerCase();
    const entry = STORE.has(ext) ? new ZipPassThrough(clean) : new ZipDeflate(clean, { level: 6 });
    zip.add(entry);
    if (file.size === 0) entry.push(new Uint8Array(0), true);
    else {
      for (let o = 0; o < file.size; o += STEP) {
        const end = Math.min(file.size, o + STEP);
        entry.push(new Uint8Array(await file.slice(o, end).arrayBuffer()), end >= file.size);
        await tick();
      }
    }
    onProgress?.(++done, list.length);
  }
  zip.end();
  await finished;
  spill();
  const safe = name.replace(/[\\/:*?"<>|]+/g, '_').trim() || 'folder';
  return new File([acc], safe + '.zip', { type: 'application/zip' });
}
