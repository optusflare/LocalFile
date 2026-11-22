import { fmtSize } from '../lib/util';
import type { TItem, TState } from '../utils/transferEngine';

const LABEL: Record<TState, string> = {
  queued: 'Queued',
  preparing: 'Preparing',
  active: 'In progress',
  paused: 'Paused',
  interrupted: 'Waiting to resume',
  verifying: 'Verifying',
  verified: 'Verified',
  sent: 'Sent',
  mismatch: 'Checksum mismatch',
  rejected: 'Stopped',
  failed: 'Failed',
};
const END: TState[] = ['verified', 'sent', 'mismatch', 'rejected', 'failed'];
const tone = (s: TState) => (s === 'verified' || s === 'sent' ? 'ok' : s === 'mismatch' || s === 'rejected' || s === 'failed' ? 'err' : s === 'queued' ? '' : 'warn');

interface Props {
  items: TItem[];
  incomplete: number;
  onPause: (id: string) => void;
  onResume: (id: string) => void;
  onRemove: (id: string) => void;
  onSave: (id: string) => void;
  onClearIncomplete: () => void;
}

export default function TransferQueue({ items, incomplete, onPause, onResume, onRemove, onSave, onClearIncomplete }: Props) {
  const outs = items.filter((i) => i.dir === 'out');
  const outsLive = outs.filter((i) => !END.includes(i.state));
  const bytes = outs.reduce((n, i) => n + i.size, 0);
  const sent = outs.reduce((n, i) => n + (END.includes(i.state) ? i.size : i.state === 'preparing' ? 0 : i.done), 0);
  const finished = items.filter((i) => END.includes(i.state) && !i.file);

  return (
    <div className="tq">
      {outsLive.length > 0 && (
        <div className="tq-head" role="status">
          <span>
            Sending file {Math.min(outs.length - outsLive.length + 1, outs.length)} of {outs.length}
          </span>
          <span className="pct">{Math.round((sent / Math.max(bytes, 1)) * 100)}%</span>
          <progress max={Math.max(bytes, 1)} value={sent} />
        </div>
      )}

      {items.map((it) => {
        const pct = Math.round((it.done / Math.max(it.size, 1)) * 100);
        const live = !END.includes(it.state);
        return (
          <div className="tq-item" key={it.id}>
            <div className="row">
              <div className="grow clip">
                <b>{it.name}</b>
                <div className="muted small">
                  {it.dir === 'in' ? 'Receiving' : 'Sending'} · {fmtSize(it.size)}
                  {live && it.state !== 'queued' && <span className="pct"> · {pct}%</span>}
                  {it.storage && <span className="pct"> · {it.storage === 'memory' ? 'in memory' : 'on disk'}</span>}
                  {it.resumed && it.state === 'active' && <span className="pct"> · resumed</span>}
                </div>
              </div>
              <span className={'badge ' + tone(it.state)}>{LABEL[it.state]}</span>
            </div>
            {live && it.state !== 'queued' && <progress max={Math.max(it.size, 1)} value={it.done} />}
            {it.note && <div className="muted small">{it.note}</div>}
            <div className="tq-actions">
              {(it.state === 'active' || it.state === 'interrupted') && (
                <button className="btn" onClick={() => onPause(it.id)}>
                  Pause
                </button>
              )}
              {it.state === 'paused' && (
                <button className="btn primary" onClick={() => onResume(it.id)}>
                  Resume
                </button>
              )}
              {it.file && (
                <button className="btn primary" onClick={() => onSave(it.id)}>
                  Save
                </button>
              )}
              {(live || END.includes(it.state)) && it.state !== 'preparing' && it.state !== 'verifying' && (
                <button className="btn ghost" onClick={() => onRemove(it.id)}>
                  {live ? 'Cancel' : 'Dismiss'}
                </button>
              )}
            </div>
          </div>
        );
      })}

      {finished.length > 1 && (
        <button className="btn ghost sm" style={{ alignSelf: 'flex-start' }} onClick={() => finished.forEach((i) => onRemove(i.id))}>
          Clear finished
        </button>
      )}

      {incomplete > 0 && (
        <div className="tq-item">
          <div className="muted small">
            {incomplete} incomplete transfer{incomplete === 1 ? '' : 's'} kept on this device. If the sender picks the same file again, it continues where it stopped.
          </div>
          <div className="tq-actions">
            <button className="btn" onClick={onClearIncomplete}>
              Clear incomplete transfers
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
