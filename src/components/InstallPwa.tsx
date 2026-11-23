import { useState } from 'react';
import { promptInstall, usePwa } from '../utils/pwa';

interface Props {
  label?: string;
  notify?: (msg: string, kind?: 'ok' | 'err') => void;
}

export default function InstallPwa({ label = 'Download / Install PWA', notify }: Props) {
  const p = usePwa();
  const [help, setHelp] = useState(false);

  if (p.installed) {
    return (
      <div className="pwa">
        <span className="badge ok">Installed</span>
        <span className="muted small">AyDrop is running as an app on this device. It opens with no internet at all.</span>
      </div>
    );
  }

  async function click() {
    if (p.canPrompt) {
      const r = await promptInstall();
      if (r === 'accepted') notify?.('Installing AyDrop…');
      else if (r === 'dismissed') notify?.('Install cancelled. You can try again any time.');
    } else setHelp((h) => !h);
  }

  return (
    <div className="pwa">
      <button className="btn primary" onClick={click} aria-expanded={!p.canPrompt ? help : undefined}>
        {label}
      </button>
      {!p.canPrompt && (
        <span className="muted small">
          {p.ios ? 'On iPhone and iPad, install from the Share menu.' : "Your browser hasn't offered a one-tap install. Use the steps below."}
        </span>
      )}
      {help && !p.canPrompt && (
        <ol className="steps">
          {p.ios ? (
            <>
              <li>Open aydrop.vercel.app in Safari.</li>
              <li>Tap the Share button, then “Add to Home Screen”.</li>
              <li>Open AyDrop from the home screen once while online so it can cache itself.</li>
            </>
          ) : p.firefoxDesktop ? (
            <>
              <li>Firefox on desktop can't install web apps.</li>
              <li>Open aydrop.vercel.app in Chrome or Edge to install it, or keep this tab open.</li>
            </>
          ) : p.android ? (
            <>
              <li>Open the browser menu (three dots).</li>
              <li>Choose “Install app” or “Add to Home screen”.</li>
            </>
          ) : (
            <>
              <li>Click the install icon at the right end of the address bar,</li>
              <li>or open the browser menu and choose “Install AyDrop” (Chrome / Edge).</li>
            </>
          )}
        </ol>
      )}
    </div>
  );
}
