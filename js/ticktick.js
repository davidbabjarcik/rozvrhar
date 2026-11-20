// TickTick Open API. The OAuth code exchange needs a client secret, so it goes
// through a tiny Cloudflare Worker (see /worker). The worker also adds CORS.
import { CONFIG } from './config.js';
import { toOffsetString, TZ } from './dates.js';

const TOKEN_KEY = 'rozvrhar:ttToken';

export function proxyUrl() {
  return (CONFIG.ticktickProxy || localStorage.getItem('rozvrhar:ttProxy') || '').replace(/\/+$/, '');
}

export function ticktickConnected() {
  return Boolean(localStorage.getItem(TOKEN_KEY));
}

export function connectTickTick() {
  const p = proxyUrl();
  if (!p) throw new Error('Chýba adresa TickTick proxy – nastav ju v Nastaveniach.');
  const back = location.origin + location.pathname;
  location.href = `${p}/auth?redirect=${encodeURIComponent(back)}`;
}

/** Called on startup: picks up '#tt_token=…' after the OAuth redirect. */
export function captureTokenFromHash() {
  const m = location.hash.match(/tt_token=([^&]+)/);
  const err = location.hash.match(/tt_error=([^&]+)/);
  if (m || err) history.replaceState(null, '', location.pathname + location.search);
  if (m) {
    localStorage.setItem(TOKEN_KEY, decodeURIComponent(m[1]));
    return { ok: true };
  }
  if (err) return { ok: false, error: decodeURIComponent(err[1]) };
  return null;
}

export function disconnectTickTick() {
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, opts = {}) {
  const t = localStorage.getItem(TOKEN_KEY);
  if (!t) throw new Error('TickTick nie je pripojený');
  const res = await fetch(`${proxyUrl()}/api${path}`, {
    ...opts,
    headers: { Authorization: `Bearer ${t}`, 'Content-Type': 'application/json', ...opts.headers },
  });
  if (res.status === 401) {
    disconnectTickTick();
    throw new Error('TickTick prihlásenie vypršalo – pripoj ho znova.');
  }
  const text = await res.text();
  if (!res.ok) {
    const e = new Error(`TickTick ${res.status}: ${text.slice(0, 160)}`);
    e.status = res.status;
    throw e;
  }
  return text ? JSON.parse(text) : null;
}

async function ensureProject(name) {
  const projects = await api('/project');
  const found = projects.find((p) => p.name === name);
  if (found) return found.id;
  const created = await api('/project', { method: 'POST', body: JSON.stringify({ name, kind: 'TASK', viewMode: 'list' }) });
  return created.id;
}

function toTask(t, projectId) {
  const body = {
    title: t.title,
    content: t.content || '',
    projectId,
    priority: t.priority || 0,
    timeZone: TZ,
    isAllDay: !t.time,
    dueDate: toOffsetString(t.date, t.time || '00:00'),
    startDate: toOffsetString(t.date, t.time || '00:00'),
  };
  // All-day: 9:00 that day. Timed: 30 min before. Tests/exams also a day before.
  body.reminders = t.time ? ['TRIGGER:-PT30M'] : ['TRIGGER:P0DT9H0M0S'];
  if (t.priority >= 5) body.reminders.push(t.time ? 'TRIGGER:-P1D' : 'TRIGGER:-P0DT15H0M0S');
  return body;
}

/**
 * Sync tasks into a TickTick list. `map` remembers key → task id from the
 * previous export so re-exporting updates instead of duplicating, and tasks
 * that disappeared from the plan are removed.
 */
export async function exportToTickTick(tasks, { listName, map = {}, onProgress } = {}) {
  const projectId = await ensureProject(listName);
  const newMap = {};
  const failures = [];
  let done = 0;
  for (const t of tasks) {
    const prev = map[t.key];
    try {
      if (prev && prev.projectId === projectId) {
        try {
          await api(`/task/${prev.id}`, { method: 'POST', body: JSON.stringify({ ...toTask(t, projectId), id: prev.id }) });
          newMap[t.key] = prev;
        } catch (e) {
          if (e.status !== 404 && e.status !== 400) throw e;
          const c = await api('/task', { method: 'POST', body: JSON.stringify(toTask(t, projectId)) });
          newMap[t.key] = { id: c.id, projectId };
        }
      } else {
        const c = await api('/task', { method: 'POST', body: JSON.stringify(toTask(t, projectId)) });
        newMap[t.key] = { id: c.id, projectId };
      }
    } catch (e) {
      failures.push(`${t.title}: ${e.message}`);
      if (prev) newMap[t.key] = prev;
    }
    onProgress?.(++done, tasks.length);
  }
  for (const [key, v] of Object.entries(map)) {
    if (newMap[key]) continue;
    try {
      await api(`/project/${v.projectId}/task/${v.id}`, { method: 'DELETE' });
    } catch (e) { /* already gone */ }
  }
  return { map: newMap, failures };
}
