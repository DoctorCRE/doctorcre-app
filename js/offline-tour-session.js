const key = 'doctorcre-tour-day-session-v1';
export const TOUR_DRAFT_KEYS = {
  route: 'doctorcre-tour-pending-v1',
  other: 'doctorcre-tour-other-writes-v1',
};
const tourRecoveryKeys = [key, ...Object.values(TOUR_DRAFT_KEYS)];

function retireDayBinding(window) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key));
    if (saved?.epoch != null) window.sessionStorage.setItem(key, JSON.stringify({ ...saved, epoch: null }));
  } catch { /* Storage failure already prevents offline restore. */ }
}
export function hasTourDrafts(window) {
  try { return tourRecoveryKeys.some(name => window.sessionStorage.getItem(name) !== null); }
  catch { return false; }
}
export function legacyTourDraftScope(window, actor) {
  try {
    const saved = JSON.parse(window.sessionStorage.getItem(key));
    return actor && saved?.userRef === actor && /^[a-f0-9]{64}$/.test(saved.scope) ? saved.scope : null;
  } catch { return null; }
}
export const SESSION_EPOCH_KEY = 'doctorcre-session-epoch-v1';
// Old cached pages treat the original epoch as an instruction to erase drafts.
export const TOUR_SIGN_IN_EPOCH_KEY = 'doctorcre-tour-sign-in-epoch-v1';
export function sessionEpoch(window) {
  try {
    const epoch = window.localStorage.getItem(SESSION_EPOCH_KEY) || 'initial';
    const tourSignIn = window.localStorage.getItem(TOUR_SIGN_IN_EPOCH_KEY);
    return tourSignIn ? `${epoch}:${tourSignIn}` : epoch;
  } catch { return null; }
}
export async function clearPrivateStorage(window, { shared = true } = {}) {
  retireDayBinding(window);
  for (const name of shared ? ['localStorage','sessionStorage'] : ['sessionStorage']) {
    try {
      const storage = window[name];
      // eslint-disable-next-line no-restricted-syntax -- Revocation visits each storage key once in descending order; deletion cannot extend the finite scan.
      for (let i = storage.length - 1; i >= 0; i--) {
        const k = storage.key(i);
        if (/^doctorcre[.:-]/.test(k) && k !== SESSION_EPOCH_KEY && k !== TOUR_SIGN_IN_EPOCH_KEY && k !== 'doctorcre.visual-preferences' &&
          !(name === 'sessionStorage' && tourRecoveryKeys.includes(k))) storage.removeItem(k);
      }
    } catch { /* Revocation remains fail-closed when browser storage is denied. */ }
  }
  if (!shared) return;
  const tasks = [];
  if (window.caches) tasks.push(window.caches.keys().then(names => Promise.all(names.map(name => window.caches.delete(name)))));
  if (window.indexedDB) tasks.push(new Promise(resolve => {
    const request = window.indexedDB.open('doctorcre-tour-day-drafts-v1',1);
    request.onupgradeneeded = () => { request.result.createObjectStore('notes',{keyPath:['scope','id']}); request.result.createObjectStore('tours',{keyPath:['scope','id']}); };
    request.onerror = request.onblocked = () => resolve();
    request.onsuccess = () => {
      const db = request.result, tx = db.transaction('tours','readwrite');
      tx.objectStore('tours').clear();
      tx.oncomplete = tx.onerror = tx.onabort = () => { db.close(); resolve(); };
    };
  }));
  window.navigator?.serviceWorker?.controller?.postMessage({type:'doctorcre-session-revoked'});
  await Promise.allSettled(tasks);
}
export function offlineTourSession(window) {
  return {
    retireBinding: () => retireDayBinding(window),
    save(binding) {
      const epoch = sessionEpoch(window);
      if (epoch === null) return;
      window.sessionStorage.setItem(key,JSON.stringify({...binding,epoch}));
    },
    read(tourId) {
      try {
        const saved = JSON.parse(window.sessionStorage.getItem(key));
        return sessionEpoch(window) !== null && saved?.epoch === sessionEpoch(window) && saved?.tourId === tourId && typeof saved.scope === 'string' && saved.scope && typeof saved.userRef === 'string' ? saved : null;
      } catch { return null; }
    },
    async revoke({ expectedEpoch } = {}) {
      const shared = expectedEpoch === undefined || expectedEpoch === sessionEpoch(window);
      if (shared) {
        try { window.localStorage.setItem(TOUR_SIGN_IN_EPOCH_KEY, window.crypto.randomUUID()); } catch { /* Offline restore requires storage. */ }
      }
      window.dispatchEvent(new window.Event('doctorcre-offline-session-revoked'));
      await clearPrivateStorage(window, { shared });
    },
  };
}
