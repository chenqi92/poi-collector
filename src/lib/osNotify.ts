/* Thin wrapper over the browser Notification API (available inside the Tauri
   webview without an extra plugin).  Reads the same `notifyOnComplete` pref the
   Settings page writes to localStorage. */

interface Prefs { notifyOnComplete?: boolean; soundOnComplete?: boolean }

function readPrefs(): Prefs {
    try { return JSON.parse(localStorage.getItem('poi-prefs') ?? '{}') } catch { return {} }
}

let permissionRequested = false

export function osNotify(title: string, body?: string) {
    if (typeof window === 'undefined' || typeof Notification === 'undefined') return
    const prefs = readPrefs()
    if (prefs.notifyOnComplete === false) return

    const fire = () => {
        try {
            const n = new Notification(title, { body, silent: !prefs.soundOnComplete })
            n.onclick = () => { try { window.focus() } catch { /* ignore */ } }
        } catch { /* ignore */ }
    }

    if (Notification.permission === 'granted') {
        fire()
        return
    }
    if (Notification.permission === 'denied') return
    if (permissionRequested) return
    permissionRequested = true
    Notification.requestPermission().then(p => { if (p === 'granted') fire() }).catch(() => { /* ignore */ })
}
