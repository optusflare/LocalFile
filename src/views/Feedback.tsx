import { useState } from 'react';
import { addDoc, collection, serverTimestamp } from 'firebase/firestore';
import { db } from '../lib/firebase';
import { useApp } from '../lib/ctx';
import { useTurnstile } from '../components/Turnstile';

const CATS = [
  { id: 'bug', label: 'Something is broken' },
  { id: 'idea', label: 'Idea' },
  { id: 'abuse', label: 'Report abuse' },
  { id: 'other', label: 'Other' },
];

export default function Feedback() {
  const { user, settings, notify } = useApp();
  const human = useTurnstile(settings);
  const [category, setCategory] = useState('bug');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const len = message.trim().length;

  async function submit() {
    if (len < 5 || len > 2000 || busy) return;
    setBusy(true);
    try {
      if (!(await human.verify())) return notify('Finish the human check first.', 'err');
      await addDoc(collection(db, 'feedback'), { uid: user.uid, category, message: message.trim(), createdAt: serverTimestamp() });
      setMessage('');
      notify('Feedback sent.');
    } catch (e: any) {
      notify('Could not send feedback: ' + (e?.code || e?.message), 'err');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="panel narrow">
      <div className="ph">
        <h2>Feedback</h2>
      </div>
      <div className="stack">
        <select aria-label="Category" value={category} onChange={(e) => setCategory(e.target.value)}>
          {CATS.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label}
            </option>
          ))}
        </select>
        <textarea rows={7} maxLength={2000} placeholder="What happened, and on which device or browser?" value={message} onChange={(e) => setMessage(e.target.value)} />
        <div className={'small ' + (len > 0 && len < 5 ? 'err' : 'muted')}>{len} / 2000 (minimum 5)</div>
        {human.widget}
        <button className="btn primary" disabled={busy || len < 5 || !human.ready} onClick={submit}>
          Send feedback
        </button>
      </div>
    </div>
  );
}
