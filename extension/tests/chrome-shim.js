// Minimal chrome.storage + chrome.identity + chrome.runtime shim for unit
// tests. Deliberately tiny — just enough surface area for the modules we
// exercise. Tests install it on globalThis.chrome before importing code
// under test.

export function installChromeShim({ token = "fake-token" } = {}) {
  const storage = {
    local:   new Map(),
    session: new Map(),
    sync:    new Map(),
  };
  const listeners = [];

  function areaApi(name) {
    return {
      async get(keys) {
        const out = {};
        const m = storage[name];
        if (keys == null) {
          for (const [k, v] of m) out[k] = v;
        } else if (typeof keys === "string") {
          if (m.has(keys)) out[keys] = m.get(keys);
        } else if (Array.isArray(keys)) {
          for (const k of keys) if (m.has(k)) out[k] = m.get(k);
        }
        return out;
      },
      async set(obj) {
        const changes = {};
        for (const [k, v] of Object.entries(obj)) {
          const oldValue = storage[name].get(k);
          storage[name].set(k, v);
          changes[k] = { newValue: v, oldValue };
        }
        for (const fn of listeners) fn(changes, name);
      },
      async remove(keys) {
        const arr = Array.isArray(keys) ? keys : [keys];
        const changes = {};
        for (const k of arr) {
          if (storage[name].has(k)) {
            changes[k] = { oldValue: storage[name].get(k), newValue: undefined };
            storage[name].delete(k);
          }
        }
        for (const fn of listeners) fn(changes, name);
      },
    };
  }

  globalThis.chrome = {
    storage: {
      local:   areaApi("local"),
      session: areaApi("session"),
      sync:    areaApi("sync"),
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    identity: {
      getAuthToken: (_opts, cb) => cb(token),
      removeCachedAuthToken: (_opts, cb) => cb(),
      clearAllCachedAuthTokens: (cb) => cb(),
    },
    runtime: {
      id: "test-extension-id",
      lastError: null,
    },
  };

  return { storage, listeners };
}

export function uninstallChromeShim() {
  delete globalThis.chrome;
}
