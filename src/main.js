import { auth, db, signInWithGoogle, signOutUser, onAuthStateChanged } from './firebase.js';

const root = document.getElementById('app');

root.innerHTML = `
  <main style="font-family: system-ui, sans-serif; max-width: 640px; margin: 48px auto; padding: 16px;">
    <h1>DropNeighbor</h1>
    <p id="status">Checking sign-in status...</p>
    <button id="login-btn" type="button">Sign in with Google</button>
    <button id="logout-btn" type="button" style="display:none;">Sign out</button>
    <pre id="user-info" style="background:#f4f4f5; padding:12px; border-radius:8px; overflow:auto;"></pre>
  </main>
`;

const statusEl = document.getElementById('status');
const loginBtn = document.getElementById('login-btn');
const logoutBtn = document.getElementById('logout-btn');
const userInfoEl = document.getElementById('user-info');

loginBtn.addEventListener('click', async () => {
  try {
    await signInWithGoogle();
  } catch (err) {
    statusEl.textContent = `Sign-in error: ${err.message}`;
  }
});

logoutBtn.addEventListener('click', async () => {
  await signOutUser();
});

onAuthStateChanged(auth, (user) => {
  if (user) {
    statusEl.textContent = 'Signed in';
    loginBtn.style.display = 'none';
    logoutBtn.style.display = 'inline-block';
    userInfoEl.textContent = JSON.stringify({
      uid: user.uid,
      displayName: user.displayName,
      email: user.email,
      firestoreReady: Boolean(db)
    }, null, 2);
  } else {
    statusEl.textContent = 'Signed out';
    loginBtn.style.display = 'inline-block';
    logoutBtn.style.display = 'none';
    userInfoEl.textContent = '';
  }
});
