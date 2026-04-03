/**
 * storage.js — localStorage persistence for user state
 *
 * Stores: preferred network, last wallet address, active room,
 * session game history, and local scoreboard cache.
 *
 * All game stats are authoritative on-chain — this is only
 * for UX continuity across page reloads on Vercel.
 */

const STORAGE_KEY = 'rps-arena';
const MAX_HISTORY = 50;

function getStore() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function setStore(data) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
  } catch {
    // Storage full or blocked — silently ignore
  }
}

// ---- Network ----

export function getSavedNetwork() {
  return getStore().network || 'studionet';
}

export function saveNetwork(network) {
  const store = getStore();
  store.network = network;
  setStore(store);
}

// ---- Wallet ----

export function getSavedWallet() {
  return getStore().wallet || null;
}

export function saveWallet(address) {
  const store = getStore();
  store.wallet = address ? address.toLowerCase() : null;
  setStore(store);
}

export function clearWallet() {
  const store = getStore();
  store.wallet = null;
  setStore(store);
}

// ---- Active Room ----

export function getSavedRoom() {
  return getStore().activeRoom || null;
}

export function saveRoom(roomCode) {
  const store = getStore();
  store.activeRoom = roomCode || null;
  setStore(store);
}

// ---- Game History (local session log) ----

export function getGameHistory() {
  return getStore().history || [];
}

export function addGameRecord(record) {
  const store = getStore();
  if (!store.history) store.history = [];
  store.history.unshift({
    ...record,
    timestamp: Date.now(),
  });
  // Cap history
  if (store.history.length > MAX_HISTORY) {
    store.history = store.history.slice(0, MAX_HISTORY);
  }
  setStore(store);
}

// ---- Cached Stats (for instant display before chain loads) ----

export function getCachedStats(address) {
  const store = getStore();
  const key = `stats_${(address || '').toLowerCase()}`;
  return store[key] || null;
}

export function saveCachedStats(address, stats) {
  const store = getStore();
  const key = `stats_${(address || '').toLowerCase()}`;
  store[key] = stats;
  setStore(store);
}

// ---- Full clear ----

export function clearAll() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Ignore
  }
}
