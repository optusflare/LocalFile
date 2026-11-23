import { useApp } from '../lib/ctx';
import InstallPwa from './InstallPwa';
import { useOnline, usePwa } from '../utils/pwa';

export default function OfflineCard({ onOpenTransfer }: { onOpenTransfer?: () => void }) {
  const { notify } = useApp();
  const p = usePwa();
  const online = useOnline();
  return (
    <div className="panel">
      <div className="ph">
        <h2>Offline transfer</h2>
        <span className={'badge ' + (online ? 'ok' : 'warn')}>{online ? 'Online' : 'Offline'}</span>
      </div>
      <div className="stack">
        <p className="muted">
          Big files stream straight to your device's disk and are checked with SHA-256, so a dropped connection pauses the transfer instead of wrecking it, and it resumes where it stopped. Install AyDrop as an app and you can pair two devices over the same Wi-Fi or a phone hotspot with no internet at all.
        </p>
        <dl className="kvs">
          <dt>Installed as an app</dt>
          <dd>{p.installed ? 'Yes' : 'No'}</dd>
          <dt>Files cached for offline use</dt>
          <dd>{p.offlineReady ? 'Yes' : p.swActive ? 'Caching…' : 'Not yet'}</dd>
        </dl>
        <InstallPwa label="Download / Install PWA" notify={notify} />
        <ol className="steps">
          <li>Install once while you have internet, and open the app one time.</li>
          <li>Put both devices on the same Wi-Fi or one phone's hotspot.</li>
          <li>On Transfer, open Offline transfer: one device shows a QR, the other scans it and shows a reply QR, then you scan that back.</li>
        </ol>
        <p className="muted small">If devices can't connect, the Wi-Fi may block device-to-device traffic (guest networks do this). A phone hotspot usually works.</p>
        {onOpenTransfer && (
          <button className="btn" onClick={onOpenTransfer}>
            Open Offline transfer
          </button>
        )}
      </div>
    </div>
  );
}
