import { useRef, useState } from 'react';
import Icon from './Icon';
import { isJunk, zipFolder } from '../utils/zipFolder';
import type { FolderItem } from '../utils/zipFolder';
import { getControls } from '../utils/siteControls';

interface Props {
  disabled?: boolean;
  hint?: string;
  onFiles: (files: File[]) => void;
  notify: (msg: string, kind?: 'ok' | 'err') => void;
}
interface Zipping {
  name: string;
  phase: 'scan' | 'zip';
  total: number;
  done: number;
}

function readAll(dir: FileSystemDirectoryEntry): Promise<FileSystemEntry[]> {
  const reader = dir.createReader();
  const all: FileSystemEntry[] = [];
  return new Promise((res, rej) => {
    const next = () =>
      reader.readEntries((batch) => {
        if (batch.length) {
          all.push(...batch); // readEntries returns at most ~100 per call, so loop until empty
          next();
        } else res(all);
      }, rej);
    next();
  });
}
async function walk(entry: FileSystemEntry, base: string, out: FolderItem[]) {
  if (entry.isFile) {
    const file = await new Promise<File>((res, rej) => (entry as FileSystemFileEntry).file(res, rej));
    if (!isJunk(entry.name)) out.push({ path: base + entry.name, file });
  } else if (entry.isDirectory) {
    for (const c of await readAll(entry as FileSystemDirectoryEntry)) await walk(c, base + entry.name + '/', out);
  }
}

export default function Dropzone({ disabled, hint, onFiles, notify }: Props) {
  const [over, setOver] = useState(false);
  const [zip, setZip] = useState<Zipping | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const canFolder = typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;

  /** Applies the admin's per-file size limit before anything is queued. */
  function deliver(files: File[]) {
    const c = getControls();
    const max = c.maxRoomFileMiB * 1024 * 1024;
    const ok = files.filter((f) => f.size <= max);
    if (ok.length < files.length) notify(files.length - ok.length + ' file(s) over the ' + c.maxRoomFileMiB + ' MiB limit were skipped.', 'err');
    if (ok.length) onFiles(ok);
  }
  function zipAllowed(): boolean {
    if (getControls().autoZipFolders) return true;
    notify('Folder transfer is turned off by the site admin. Choose individual files.', 'err');
    return false;
  }

  async function bundle(name: string, items: FolderItem[]): Promise<File | null> {
    if (!items.length) {
      notify('"' + name + '" has no files.', 'err');
      return null;
    }
    setZip({ name, phase: 'zip', total: items.length, done: 0 });
    return zipFolder(name, items, (done, total) => setZip({ name, phase: 'zip', total, done }));
  }

  async function ingest(entries: FileSystemEntry[], loose: File[]) {
    const out: File[] = [...loose];
    try {
      for (const en of entries) {
        if (en.isFile) {
          out.push(await new Promise<File>((res, rej) => (en as FileSystemFileEntry).file(res, rej)));
        } else if (en.isDirectory) {
          if (!zipAllowed()) continue;
          setZip({ name: en.name, phase: 'scan', total: 0, done: 0 });
          const list: FolderItem[] = [];
          await walk(en, '', list);
          const z = await bundle(en.name, list);
          if (z) out.push(z);
        }
      }
    } catch (e: any) {
      notify('Could not read the folder: ' + (e?.message || 'unknown error'), 'err');
    } finally {
      setZip(null);
    }
    if (out.length) deliver(out);
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    if (disabled || zip) return;
    // Entries must be grabbed synchronously: the DataTransfer is emptied after the handler returns.
    const entries: FileSystemEntry[] = [];
    const loose: File[] = [];
    for (const item of Array.from(e.dataTransfer.items || [])) {
      if (item.kind !== 'file') continue;
      const en = item.webkitGetAsEntry?.();
      if (en) entries.push(en);
      else {
        const f = item.getAsFile();
        if (f) loose.push(f);
      }
    }
    if (!entries.length && !loose.length) loose.push(...Array.from(e.dataTransfer.files));
    void ingest(entries, loose);
  }

  /** Picker path: files from <input webkitdirectory> carry webkitRelativePath, so group them by top folder. */
  async function onPicked(list: FileList | null) {
    const files = Array.from(list || []);
    if (!files.length) return;
    const folders = new Map<string, FolderItem[]>();
    const out: File[] = [];
    for (const f of files) {
      const rel = (f as any).webkitRelativePath as string;
      if (rel && rel.includes('/')) {
        const top = rel.split('/')[0];
        if (!folders.has(top)) folders.set(top, []);
        folders.get(top)!.push({ path: rel, file: f });
      } else out.push(f);
    }
    try {
      if (folders.size && zipAllowed()) {
        for (const [name, items] of folders) {
          const z = await bundle(name, items);
          if (z) out.push(z);
        }
      }
    } catch (e: any) {
      notify('Zipping failed: ' + (e?.message || 'unknown error'), 'err');
    } finally {
      setZip(null);
    }
    if (out.length) deliver(out);
  }

  const busy = !!zip;
  return (
    <div
      className={'dz' + (over ? ' over' : '') + (disabled ? ' off' : '')}
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={onDrop}
    >
      {zip ? (
        <div className="zipbar" role="status" aria-live="polite">
          <b>{zip.phase === 'scan' ? 'Reading folder “' + zip.name + '”…' : 'Compressing folder: ' + zip.total + ' files…'}</b>
          {zip.phase === 'zip' && (
            <>
              <progress max={zip.total} value={zip.done} />
              <span className="pct">
                {zip.done} / {zip.total} · {zip.name}.zip
              </span>
            </>
          )}
        </div>
      ) : (
        <>
          <Icon name="file" size={22} />
          <p>{disabled ? hint || 'Connect to a peer to send files.' : canFolder ? 'Drop files or whole folders here. Folders are zipped for you.' : 'Choose files to send. Select several to queue them.'}</p>
          <div className="dz-actions">
            <button className="btn" disabled={disabled || busy} onClick={() => fileRef.current?.click()}>
              Choose files
            </button>
            {canFolder && (
              <button className="btn" disabled={disabled || busy} onClick={() => dirRef.current?.click()}>
                Choose folder
              </button>
            )}
          </div>
        </>
      )}
      <input ref={fileRef} type="file" multiple hidden onChange={(e) => { void onPicked(e.target.files); e.target.value = ''; }} />
      <input ref={dirRef} type="file" hidden multiple {...({ webkitdirectory: '', directory: '' } as any)} onChange={(e) => { void onPicked(e.target.files); e.target.value = ''; }} />
    </div>
  );
}
