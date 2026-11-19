// Keeps an imported export's built data in this browser (IndexedDB), so a reload shows it again without
// rebuilding. Nothing leaves the device. Storage can be unavailable (a private window, blocked site data), so
// every call fails quietly: the import still works for the visit, it just isn't remembered.
const DB = 'fitness-analyzer';
const STORE = 'imported';
const KEY = 'latest';

function openDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run(mode, fn) {
  const db = await openDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

// record: { summary, intraday, avatar, fileName, importedAt }. Returns whether it was saved.
export async function saveImported(record) {
  try { await run('readwrite', (store) => store.put(record, KEY)); return true; } catch { return false; }
}

export async function loadImported() {
  try { return (await run('readonly', (store) => store.get(KEY))) ?? null; } catch { return null; }
}

export async function clearImported() {
  try { await run('readwrite', (store) => store.delete(KEY)); } catch {}
}
