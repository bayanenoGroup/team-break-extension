// Talks to the Cloudflare Worker and keeps the last known state in
// chrome.storage.local, together with the offset between this computer's
// clock and the server clock (all schedule times are server times).

import { DEFAULT_SERVER_URL } from '../config.js';

export async function getSettings() {
  const s = await chrome.storage.local.get(['serverUrl', 'token', 'userId']);
  return {
    serverUrl: (s.serverUrl || DEFAULT_SERVER_URL || '').replace(/\/+$/, ''),
    token: s.token || null,
    userId: s.userId || null,
  };
}

export async function setServerUrl(url) {
  await chrome.storage.local.set({ serverUrl: String(url || '').trim().replace(/\/+$/, '') });
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

async function request(method, path, body) {
  const { serverUrl, token } = await getSettings();
  if (!serverUrl) throw new ApiError('آدرس سرور تنظیم نشده است.', 0);
  const sentAt = Date.now();
  let res;
  try {
    res = await fetch(`${serverUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: method === 'POST' ? JSON.stringify(body || {}) : undefined,
    });
  } catch {
    throw new ApiError('اتصال به سرور برقرار نشد.', 0);
  }
  const receivedAt = Date.now();
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token) {
    // Token no longer known to the server: start over as a new user.
    await chrome.storage.local.remove(['token', 'userId', 'state']);
  }
  if (!res.ok) throw new ApiError(data.error || 'خطای ناشناخته', res.status);
  if (data.serverTime) {
    // Assume the server answered halfway through the round trip.
    const offset = data.serverTime - (sentAt + receivedAt) / 2;
    await chrome.storage.local.set({ state: data, offset, stateAt: receivedAt });
  }
  return data;
}

export async function register(name) {
  const data = await request('POST', '/api/register', { name });
  await chrome.storage.local.set({ token: data.token, userId: data.userId });
  return data;
}

export const api = {
  state: () => request('GET', '/api/state'),
  rename: (name) => request('POST', '/api/me/name', { name }),
  createGroup: (name) => request('POST', '/api/groups/create', { name }),
  joinGroup: (code) => request('POST', '/api/groups/join', { code }),
  leaveGroup: () => request('POST', '/api/groups/leave'),
  deleteGroup: () => request('POST', '/api/groups/delete'),
  kick: (userId) => request('POST', '/api/groups/kick', { userId }),
  regenerateCode: () => request('POST', '/api/groups/regenerate-code'),
  selectModel: (modelId, cycles) => request('POST', '/api/groups/select-model', { modelId, cycles }),
  start: () => request('POST', '/api/groups/start'),
  pause: () => request('POST', '/api/groups/pause'),
  resume: () => request('POST', '/api/groups/resume'),
  stop: () => request('POST', '/api/groups/stop'),
};

// Last state + offset from storage, without a network call.
export async function cachedState() {
  const { state, offset } = await chrome.storage.local.get(['state', 'offset']);
  return { state: state || null, offset: offset || 0 };
}

export function serverNow(offset) {
  return Date.now() + (offset || 0);
}
