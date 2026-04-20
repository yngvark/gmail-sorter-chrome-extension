// Thin promise wrapper around chrome.identity.getAuthToken.
// Chrome caches tokens in memory and refreshes them on expiry automatically,
// so we don't cache anything ourselves.

export function getToken({ interactive = true } = {}) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive }, (token) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "auth failed"));
        return;
      }
      if (!token) {
        reject(new Error("no token returned"));
        return;
      }
      resolve(typeof token === "string" ? token : token.token);
    });
  });
}

export function removeCachedToken(token) {
  return new Promise((resolve) => {
    chrome.identity.removeCachedAuthToken({ token }, () => resolve());
  });
}

// Sign-out: remove the cached token AND revoke it server-side so the next
// interactive auth prompts for account selection again.
export async function signOut() {
  try {
    const token = await getToken({ interactive: false });
    await removeCachedToken(token);
    // Revoke server-side. Best-effort — ignore errors.
    try {
      await fetch("https://oauth2.googleapis.com/revoke", {
        method: "POST",
        headers: { "Content-type": "application/x-www-form-urlencoded" },
        body: `token=${encodeURIComponent(token)}`,
      });
    } catch { /* ignore */ }
  } catch {
    // No token cached — nothing to do.
  }
  if (chrome.identity.clearAllCachedAuthTokens) {
    await new Promise((resolve) => chrome.identity.clearAllCachedAuthTokens(() => resolve()));
  }
}

export function maskToken(token) {
  if (!token || token.length < 10) return "***";
  return `${token.slice(0, 6)}…${token.slice(-4)}`;
}
