import { useState } from 'react';
import Room from './Room';
import Drops from './Drops';
import OfflineTransfer from '../components/OfflineTransfer';
import { useApp } from '../lib/ctx';
import { useControls } from '../utils/siteControls';

function Paused({ what }: { what: string }) {
  return (
    <div className="panel">
      <div className="ph">
        <h2>{what}</h2>
        <span className="badge warn">Paused</span>
      </div>
      <p className="muted">The site admin has turned this off for now.</p>
    </div>
  );
}

export default function Transfer() {
  const { user, settings, notify } = useApp();
  const c = useControls();
  // Wide screens show all three side by side; on phones the offline panel starts collapsed (it stays mounted, so a live pairing survives).
  const [open, setOpen] = useState(() => window.matchMedia('(min-width: 900px)').matches);

  return (
    <div className="cols three">
      {c.roomsEnabled ? <Room /> : <Paused what="Room" />}
      {c.dropsEnabled ? <Drops /> : <Paused what="Drops" />}
      {c.offlineEnabled ? (
        <div className="panel">
          <div className="ph">
            <h2>Offline transfer</h2>
            <div className="row">
              <span className="badge">No internet</span>
              <button className="btn ghost sm" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                {open ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>
          <div hidden={!open}>
            <OfflineTransfer blocked={settings.blockedExtensions} notify={notify} uid={user.uid} />
          </div>
          {!open && <p className="muted small">Pair two devices on the same Wi-Fi or hotspot with a QR code. Works with no internet once installed.</p>}
        </div>
      ) : (
        <Paused what="Offline transfer" />
      )}
    </div>
  );
}
