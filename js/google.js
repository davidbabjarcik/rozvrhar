// Google sign-in (Google Identity Services token model), Drive appData sync
// and Calendar export. No backend: the access token lives only in memory.
import { CONFIG } from './config.js';
import { TZ, addDays } from './dates.js';
import { recurrenceLines } from './ics.js';

const SCOPES = [
  'openid', 'email', 'profile',
  'https://www.googleapis.com/auth/drive.appdata',
  'https://www.googleapis.com/auth/calendar.app.created',
].join(' ');

let token = null;
let tokenExpiry = 0;
let tokenClient = null;
let gisLoading = null;

export function googleConfigured() {
  return Boolean(clientId());
}

function clientId() {
  return CONFIG.googleClientId || localStorage.getItem('rozvrhar:gcid') || '';
}

function loadGIS() {
  if (window.google?.accounts?.oauth2) return Promise.resolve();
  if (gisLoading) return gisLoading;
  gisLoading = new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Nepodarilo sa načítať Google prihlásenie (si online?)'));
    document.head.appendChild(s);
  });
  return gisLoading;
}

/** Ask for an access token (opens Google popup the first time). */
export async function signIn({ silent = false } = {}) {
  if (!clientId()) throw new Error('Chýba Google Client ID – nastav ho v Nastaveniach.');
  await loadGIS();
  return new Promise((resolve, reject) => {
    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId(),
      scope: SCOPES,
      callback: (resp) => {
        if (resp.error) { reject(new Error(resp.error_description || resp.error)); return; }
        token = resp.access_token;
        tokenExpiry = Date.now() + (Number(resp.expires_in) - 60) * 1000;
        resolve(token);
      },
      error_callback: (err) => reject(new Error(err?.message || 'Prihlásenie zrušené')),
    });
    const hint = localStorage.getItem('rozvrhar:email') || undefined;
    tokenClient.requestAccessToken({ prompt: silent ? '' : (hint ? '' : 'consent'), login_hint: hint });
  });
}

export function signOut() {
  if (token && window.google?.accounts?.oauth2) window.google.accounts.oauth2.revoke(token, () => {});
  token = null;
  tokenExpiry = 0;
  localStorage.removeItem('rozvrhar:email');
}

export function isSignedIn() {
  return Boolean(token) && Date.now() < tokenExpiry;
}

async function ensureToken() {
  if (!isSignedIn()) await signIn({ silent: true });
  return token;
}

async function api(url, opts = {}) {
  const t = await ensureToken();
  const res = await fetch(url, {
    ...opts,
    headers: { Authorization: `Bearer ${t}`, ...(opts.body && !(opts.body instanceof FormData) ? { 'Content-Type': 'application/json' } : {}), ...opts.headers },
  });
  if (res.status === 204) return null;
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const err = new Error(data?.error?.message || `Google API ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

export async function userInfo() {
  const u = await api('https://www.googleapis.com/oauth2/v3/userinfo');
  if (u?.email) localStorage.setItem('rozvrhar:email', u.email);
  return u;
}

/* ---------------------------- Drive appData sync ---------------------------- */

const FILE_NAME = 'rozvrhar-data.json';

async function findFile() {
  const q = encodeURIComponent(`name='${FILE_NAME}'`);
  const r = await api(`https://www.googleapis.com/drive/v3/files?spaces=appDataFolder&q=${q}&fields=files(id,modifiedTime)`);
  return r.files?.[0] || null;
}

export async function loadFromDrive() {
  const f = await findFile();
  if (!f) return null;
  const data = await api(`https://www.googleapis.com/drive/v3/files/${f.id}?alt=media`);
  return { data, modified: f.modifiedTime };
}

export async function saveToDrive(obj) {
  const f = await findFile();
  const body = JSON.stringify(obj);
  if (f) {
    return api(`https://www.googleapis.com/upload/drive/v3/files/${f.id}?uploadType=media`, { method: 'PATCH', body });
  }
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: FILE_NAME, parents: ['appDataFolder'] })], { type: 'application/json' }));
  form.append('file', new Blob([body], { type: 'application/json' }));
  return api('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart', { method: 'POST', body: form });
}

/* ------------------------------ Calendar export ----------------------------- */

const CAL = 'https://www.googleapis.com/calendar/v3';

function toGoogleEvent(ev) {
  const body = {
    summary: ev.title,
    description: ev.description || undefined,
    location: ev.location || undefined,
    colorId: ev.colorId,
    reminders: { useDefault: false, overrides: (ev.reminders || []).slice(0, 5).map((m) => ({ method: 'popup', minutes: m })) },
    extendedProperties: { private: { rozvrharKey: ev.key } },
  };
  if (ev.allDay) {
    body.start = { date: ev.date };
    body.end = { date: addDays(ev.endDate || ev.date, 1) };
  } else {
    body.start = { dateTime: `${ev.date}T${ev.start}:00`, timeZone: TZ };
    body.end = { dateTime: `${ev.date}T${ev.end}:00`, timeZone: TZ };
    if (ev.recurrence) body.recurrence = recurrenceLines(ev);
  }
  return body;
}

/**
 * Re-creates the app's own calendar ("Škola – …") and fills it. Only touches
 * calendars this app created (calendar.app.created scope).
 */
export async function exportToCalendar(events, { name, previousId, onProgress } = {}) {
  if (previousId) {
    try {
      await api(`${CAL}/calendars/${encodeURIComponent(previousId)}`, { method: 'DELETE' });
    } catch (e) {
      if (e.status !== 404 && e.status !== 410) throw e;
    }
  }
  const cal = await api(`${CAL}/calendars`, { method: 'POST', body: JSON.stringify({ summary: name, timeZone: TZ }) });
  let done = 0;
  const queue = events.slice();
  const failures = [];
  const worker = async () => {
    while (queue.length) {
      const ev = queue.shift();
      try {
        await api(`${CAL}/calendars/${encodeURIComponent(cal.id)}/events`, { method: 'POST', body: JSON.stringify(toGoogleEvent(ev)) });
      } catch (e) {
        failures.push(`${ev.title}: ${e.message}`);
      }
      done++;
      onProgress?.(done, events.length);
    }
  };
  await Promise.all([worker(), worker(), worker()]);
  return { calendarId: cal.id, failures };
}
