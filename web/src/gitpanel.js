// web/src/gitpanel.js
// Sidebar git panel: stage/commit/push/pull, shown whenever the workspace is
// a git repo (same gate as the diff-view toggle in status.js). In a PR
// review session (S.meta.pr set), Push/Pull target the PR's actual head
// branch instead of the checkout's own remote -- see pr.go's Push/Pull.
import { $, esc, S, api, apiPostJson } from './state.js';
import { showToast, copyToClipboard, flashActionSuccess } from './ui.js';
import { reindexWorkspace } from './panels.js';
import { refreshPRMeta } from './pr.js';
import { openSettings } from './settings.js';
import { layout, render } from './renderer.js';
import { openCommitFile } from './tabs.js';
import { COMMIT_STATUS_NAMES } from './diff.js';
import { on } from './bus.js';

const panel = () => $('#git-panel');

export function initGitPanel() {
  if (!panel()) return;

  $('#git-panel-collapse')?.addEventListener('click', () => {
    panel()?.classList.toggle('collapsed');
    layout(); render();
  });

  const rz = $('#git-panel-resizer');
  if (rz && panel()) {
    let dragging = false;
    rz.addEventListener('mousedown', e => {
      dragging = true;
      rz.classList.add('drag');
      panel().classList.remove('collapsed');
      e.preventDefault();
    });
    addEventListener('mousemove', e => {
      if (!dragging) return;
      const bottom = panel().getBoundingClientRect().bottom;
      const h = Math.max(60, Math.min(window.innerHeight * 0.8, bottom - e.clientY));
      panel().style.height = h + 'px';
      layout(); render();
    });
    addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;
      rz.classList.remove('drag');
      layout(); render();
    });
  }

  $('#git-stage-all')?.addEventListener('click', doStageAll);
  $('#git-commit')?.addEventListener('click', doCommit);
  $('#git-commit-msg')?.addEventListener('input', () => $('#git-commit-msg')?.classList.remove('warn-border'));
  $('#git-push')?.addEventListener('click', doPush);
  $('#git-pull')?.addEventListener('click', doPull);
  $('#git-generate-msg')?.addEventListener('click', doCommitWithAI);
  $('#git-token-nudge')?.addEventListener('click', () => {
    showToast('!', 'No GitHub token found: set GITHUB_TOKEN, set GH_TOKEN, or run `gh auth login` -- or add one below.', 5000);
    openSettings('ui', 'GitHub', 'github.token');
  });
  $('#git-write-msg-link')?.addEventListener('click', e => {
    e.preventDefault();
    toggleCommitMsgBox();
  });
  $('#git-generate-link')?.addEventListener('click', e => {
    e.preventDefault();
    doGenerateMessage();
  });
  $('#git-instructions-link')?.addEventListener('click', e => {
    e.preventDefault();
    openSettings('ui', 'Git & Diff', 'git.commitMessageInstruction');
  });
  $('#git-see-all-commits')?.addEventListener('click', handleSeeAllCommits);
  initCommitList();

  updateGitPanelVisibility();
  if (S.meta?.git) {
    fetchRecentCommits();
  }
}

function updateGitPanelVisibility() {
  const p = panel();
  if (!p) return;
  p.hidden = !S.meta?.git;
  const nudge = $('#git-token-nudge');
  if (nudge) {
    // The PR bar already carries its own "no GitHub token" note, so skip
    // this one in PR review mode to avoid nudging twice.
    nudge.hidden = !S.meta?.git || S.meta?.githubToken !== false || !!S.meta?.pr;
  }
}

// Called from gitstream.js's handleGitStatus with each SSE/refresh payload,
// so the branch name and staged/changed counts stay live without a manual
// reload.
export function updateGitPanel(payload) {
  updateGitPanelVisibility();
  const branchEl = $('#git-branch');
  if (branchEl) {
    const branch = S.meta?.pr ? S.meta.pr.head + ' (PR review)' : (payload?.branch || '');
    branchEl.textContent = branch;
    branchEl.title = branch;
  }
  const staged = payload?.staged ? Object.keys(payload.staged).length : 0;
  const changed = payload?.gitChanges || 0;
  const countsEl = $('#git-counts');
  if (countsEl) {
    countsEl.textContent = changed ? staged + ' / ' + changed + ' staged' : '';
  }

  // Lifecycle state management:
  // Show commit section when there are uncommitted changes or staged files.
  // When clean, hide commit section and show clean state message.
  const hasChanges = changed > 0 || staged > 0;
  const commitSection = $('#git-commit-section');
  if (commitSection) {
    commitSection.hidden = !hasChanges;
  }
  const cleanState = $('#git-clean-state');
  if (cleanState) {
    cleanState.hidden = hasChanges;
  }

  // Commit button is only enabled when something is staged
  const commitBtn = $('#git-commit');
  if (commitBtn) {
    commitBtn.disabled = staged === 0;
    commitBtn.title = staged === 0 ? 'Stage changes to commit' : 'Commit staged changes';
  }

  // Push button is enabled only when there are unpushed commits (ahead > 0)
  const pushBtn = $('#git-push');
  if (pushBtn) {
    const ahead = payload?.ahead ?? 0;
    pushBtn.disabled = ahead === 0;
    if (ahead > 0) {
      pushBtn.textContent = `Push (${ahead})`;
      pushBtn.title = `Push ${ahead} unpushed commit${ahead > 1 ? 's' : ''} to remote`;
    } else {
      pushBtn.textContent = 'Push';
      pushBtn.title = 'No unpushed commits to push';
    }
  }

  // Pull button: show incoming badge if behind > 0
  const pullBtn = $('#git-pull');
  if (pullBtn) {
    const behind = payload?.behind ?? 0;
    if (behind > 0) {
      pullBtn.textContent = `Pull (${behind})`;
      pullBtn.title = `Pull ${behind} incoming commit${behind > 1 ? 's' : ''} from remote`;
    } else {
      pullBtn.textContent = 'Pull';
      pullBtn.title = 'Pull changes from remote';
    }
  }

  // Render recent commits if provided in payload
  if (payload?.recentCommits) {
    renderRecentCommits(payload.recentCommits);
  }
  updateSeeAllCommits(payload?.commitsUrl, payload?.recentCommits ? payload.recentCommits.length : undefined);
}

export async function stagePath(path) {
  try {
    await apiPostJson('/api/git/stage', { path });
  } catch (e) {
    showToast('!', e.message || 'Could not stage');
  }
}

async function doStageAll() {
  const btn = $('#git-stage-all');
  const prevText = btn?.textContent || 'Stage All';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Staging...';
  }
  try {
    await apiPostJson('/api/git/stage', { path: '.' });
    if (btn) {
      btn.textContent = prevText;
      flashActionSuccess(btn, 'Staged');
    }
  } catch (e) {
    if (btn) btn.textContent = prevText;
    showToast('!', e.message || 'Could not stage');
  } finally {
    if (btn) btn.disabled = false;
  }
}

export async function unstagePath(path) {
  try {
    await apiPostJson('/api/git/unstage', { path });
  } catch (e) {
    showToast('!', e.message || 'Could not unstage');
  }
}

// The message box stays collapsed behind a text link since most commits use
// "Stage all + Commit with AI"; open it on demand to write a message by hand.
function toggleCommitMsgBox(open) {
  const ta = $('#git-commit-msg');
  const link = $('#git-write-msg-link');
  if (!ta) return;
  ta.hidden = open === undefined ? !ta.hidden : !open;
  if (link) link.textContent = ta.hidden ? 'write message' : 'hide message';
  const gen = $('#git-generate-link');
  if (gen) {
    gen.hidden = ta.hidden;
    if (gen.previousElementSibling) gen.previousElementSibling.hidden = ta.hidden;
  }
  if (!ta.hidden) ta.focus();
}

async function doCommit() {
  const ta = $('#git-commit-msg');
  if (ta?.hidden) {
    toggleCommitMsgBox(true);
    return;
  }
  const message = ta ? ta.value.trim() : '';
  if (!message) {
    if (ta) {
      ta.classList.remove('shake');
      void ta.offsetWidth;
      ta.classList.add('shake', 'warn-border');
      setTimeout(() => ta.classList.remove('shake'), 350);
      ta.focus();
    }
    showToast('!', 'Write a commit message first');
    return;
  }
  const btn = $('#git-commit');
  const prevText = btn?.textContent || 'Commit';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Committing...';
  }
  try {
    await apiPostJson('/api/git/commit', { message });
    if (ta) {
      ta.value = '';
      ta.classList.remove('warn-border');
    }
    toggleCommitMsgBox(false);
    showToast('✓', 'Committed');
    if (btn) {
      btn.textContent = prevText;
      flashActionSuccess(btn, 'Committed');
    }
    await fetchRecentCommits();
  } catch (e) {
    if (btn) btn.textContent = prevText;
    showToast('!', e.message || 'Commit failed');
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function doPush() {
  const btn = $('#git-push');
  const prevText = btn?.textContent || 'Push';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Pushing...';
  }
  try {
    await apiPostJson('/api/git/push', {});
    showToast('✓', 'Pushed');
    if (btn) {
      btn.textContent = 'Push';
      flashActionSuccess(btn, 'Pushed');
      btn.title = 'No unpushed commits to push';
      btn.disabled = true;
    }
  } catch (e) {
    if (btn) btn.textContent = prevText;
    showToast('!', e.message || 'Push failed');
    if (btn) btn.disabled = false;
  }
}

async function doPull() {
  const btn = $('#git-pull');
  const prevText = btn?.textContent || 'Pull';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Pulling...';
  }
  try {
    const j = await apiPostJson('/api/git/pull', {});
    showToast('✓', j.message || 'Pulled');
    if (btn) {
      btn.textContent = 'Pull';
      flashActionSuccess(btn, 'Pulled');
    }
    await reindexWorkspace();
    if (S.meta?.pr) await refreshPRMeta();
    await fetchRecentCommits();
  } catch (e) {
    if (btn) btn.textContent = prevText;
    showToast('!', e.message || 'Pull failed');
  } finally {
    if (btn) btn.disabled = false;
  }
}

// Dispatches Stage + Commit with AI:
// 1. Stages all changes
// 2. Dispatches the selected coding harness to write a commit message
//    (honoring git.commitMessageInstruction setting)
// 3. Automatically commits with the generated message
async function doCommitWithAI() {
  const btn = $('#git-generate-msg');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Staging...';
  }

  // Stage all changes
  try {
    await apiPostJson('/api/git/stage', { path: '.' });
  } catch (e) {
    resetGenerateBtn(btn);
    showToast('!', e.message || 'Could not stage changes');
    return;
  }

  if (btn) {
    btn.textContent = 'Writing message...';
  }
  let job;
  try {
    job = await apiPostJson('/api/git/commit-message', {});
  } catch (e) {
    resetGenerateBtn(btn);
    showToast('!', e.message || 'Could not start generation');
    return;
  }
  pollCommitMessage(job.id, {
    progress: t => { if (btn) btn.textContent = t; },
    reset: () => resetGenerateBtn(btn),
    done: async text => {
      const ta = $('#git-commit-msg');
      if (ta) ta.value = text;
      await commitWithMessage(text, btn);
    },
  });
}

function resetGenerateBtn(btn) {
  if (!btn) return;
  btn.disabled = false;
  btn.textContent = 'Stage all + Commit with AI';
}

// Polls the commit-message job. `ui` abstracts the trigger element:
// progress(text) shows status, reset() restores it, done(text) receives the
// cleaned message (the AI button commits it; the link only fills the textarea).
function pollCommitMessage(id, ui) {
  const poll = async () => {
    let j;
    try {
      j = await api('/api/agent/job?id=' + id);
    } catch (e) {
      ui.reset();
      showToast('!', e.message || 'Generation failed');
      return;
    }
    if (j.running) {
      const sec = Math.round((j.ms || 0) / 1000);
      ui.progress('Writing message... (' + sec + 's)');
      setTimeout(poll, 600);
      return;
    }
    if (j.error) {
      ui.reset();
      showToast('!', (j.harness || 'agent') + ': ' + j.error);
      return;
    }
    const text = cleanCommitMessage(j.stdout || j.log || '');
    if (!text) {
      ui.reset();
      showToast('!', 'Harness returned an empty message');
      return;
    }
    await ui.done(text);
  };
  setTimeout(poll, 400);
}

// Generates a message for already-staged changes and fills the textarea
// without committing, so it can be reviewed or edited first.
async function doGenerateMessage() {
  const link = $('#git-generate-link');
  const ta = $('#git-commit-msg');
  if (!link || link.dataset.busy) return;
  const label = link.textContent;
  link.dataset.busy = '1';
  const reset = () => {
    delete link.dataset.busy;
    link.textContent = label;
  };
  link.textContent = 'Writing message...';
  let job;
  try {
    job = await apiPostJson('/api/git/commit-message', {});
  } catch (e) {
    reset();
    showToast('!', e.message || 'Could not start generation');
    return;
  }
  pollCommitMessage(job.id, {
    progress: t => { link.textContent = t; },
    reset,
    done: text => {
      reset();
      if (ta) ta.value = text;
      toggleCommitMsgBox(true);
    },
  });
}

async function commitWithMessage(message, btn) {
  if (btn) btn.textContent = 'Committing...';
  try {
    await apiPostJson('/api/git/commit', { message });
    const ta = $('#git-commit-msg');
    if (ta) {
      ta.value = '';
      ta.classList.remove('warn-border');
    }
    showToast('✓', 'Committed with AI');
    await fetchRecentCommits();
    if (btn) {
      btn.textContent = 'Stage all + Commit with AI';
      flashActionSuccess(btn, 'Committed');
    }
  } catch (e) {
    toggleCommitMsgBox(true); // surface the generated message so it isn't lost
    showToast('!', e.message || 'Commit failed');
  } finally {
    if (!btn?._flashTimer) resetGenerateBtn(btn);
    else btn.disabled = false;
  }
}

// Harnesses sometimes wrap output in a markdown code fence despite being
// asked not to; strip that and surrounding whitespace before using it.
function cleanCommitMessage(text) {
  let t = text.trim();
  const fence = t.match(/^```[a-z]*\n([\s\S]*?)\n```$/);
  if (fence) t = fence[1].trim();
  return t;
}

export async function fetchRecentCommits() {
  if (!S.meta?.git) return;
  try {
    const res = await api('/api/git/log?limit=5');
    if (res?.commits) {
      renderRecentCommits(res.commits);
      updateSeeAllCommits(res.commitsUrl, res.commits.length);
    }
  } catch {
    // Silently ignore if git log not available
  }
}

let currentCommitsUrl = '';

function updateSeeAllCommits(commitsUrl, commitCount) {
  if (commitsUrl) currentCommitsUrl = commitsUrl;
  if (S.meta?.pr) {
    currentCommitsUrl = `https://github.com/${S.meta.pr.owner}/${S.meta.pr.repo}/pull/${S.meta.pr.number}/commits`;
  }
  const link = $('#git-see-all-commits');
  if (!link) return;
  if (commitCount === 0) {
    link.hidden = true;
    return;
  }
  link.hidden = false;
  if (currentCommitsUrl) {
    link.href = currentCommitsUrl;
    link.target = '_blank';
    link.rel = 'noopener';
    link.title = 'View all repository commits in browser';
  } else {
    link.href = '#';
    link.removeAttribute('target');
    link.title = 'View commits';
  }
}

async function handleSeeAllCommits(e) {
  if (currentCommitsUrl) return; // Follow standard hyperlink
  e.preventDefault();
  try {
    const res = await api('/api/git/log?limit=50');
    if (res?.commits) {
      renderRecentCommits(res.commits, 0);
      const link = $('#git-see-all-commits');
      if (link) link.hidden = true;
    }
  } catch (err) {
    showToast('!', err.message || 'Could not load commits');
  }
}

/* ---------- recent commits: expandable rows ----------
   The git status stream re-sends the commits on every tick, so the list is
   rebuilt only when they change, and expanded rows are restored from cache. */

const commitDetails = new Map(); // hash -> CommitDetail, or a pending Promise
const expandedCommits = new Set();
let renderedCommitsKey = '';

function renderRecentCommits(commits, max = 5) {
  const list = $('#git-commits-list');
  if (!list) return;
  if (!commits || commits.length === 0) {
    renderedCommitsKey = '';
    list.innerHTML = '<div class="git-commits-empty">No commits yet</div>';
    return;
  }
  const slice = max ? commits.slice(0, max) : commits;
  const key = slice.map(c => c.hash + '\x1f' + c.subject + '\x1f' + c.date).join('\x1e');
  if (key === renderedCommitsKey) return;
  renderedCommitsKey = key;
  const focusedHash = list.contains(document.activeElement) ? document.activeElement.closest('.git-commit')?.dataset.hash : null;
  list.innerHTML = slice.map(c => `
    <div class="git-commit" data-hash="${esc(c.hash)}">
      <div class="git-commit-row" tabindex="0" role="button" aria-expanded="false" title="${esc(c.subject || '')} (${esc(c.author || '')}, ${esc(c.date || '')})&#10;Click to show changed files">
        <svg class="git-commit-caret" viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3.5 2L6.5 5L3.5 8"/></svg>
        <svg class="git-commit-icon" viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><circle cx="8" cy="8" r="2.8"/><line x1="8" y1="1" x2="8" y2="5.2"/><line x1="8" y1="10.8" x2="8" y2="15"/></svg>
        <span class="git-commit-msg-text">${esc(c.subject || '(no message)')}</span>
        <button type="button" class="git-commit-sha" tabindex="-1" title="Copy SHA">${esc(c.hash)}</button>
      </div>
      <div class="git-commit-files" hidden></div>
    </div>
  `).join('');
  for (const hash of [...expandedCommits]) {
    const el = commitEl(hash);
    if (el) setCommitExpanded(el, true);
    else expandedCommits.delete(hash);
  }
  if (focusedHash) commitEl(focusedHash)?.querySelector('.git-commit-row')?.focus();
  markActiveCommitFile();
}

function commitEl(hash) {
  return $('#git-commits-list')?.querySelector(`.git-commit[data-hash="${CSS.escape(hash)}"]`);
}

async function loadCommit(hash) {
  const have = commitDetails.get(hash);
  if (have) return have;
  const req = api('/api/git/show', { rev: hash });
  commitDetails.set(hash, req);
  try {
    const c = await req;
    commitDetails.set(hash, c);
    return c;
  } catch (e) {
    commitDetails.delete(hash);
    throw e;
  }
}

async function setCommitExpanded(el, open) {
  const hash = el.dataset.hash;
  const row = el.querySelector('.git-commit-row');
  const body = el.querySelector('.git-commit-files');
  el.classList.toggle('expanded', open);
  row.setAttribute('aria-expanded', String(open));
  body.hidden = !open;
  if (!open) {
    expandedCommits.delete(hash);
    body.replaceChildren(); // hiding would keep every row in memory
    return;
  }
  expandedCommits.add(hash);
  const cached = commitDetails.get(hash);
  if (cached && !(cached instanceof Promise)) { drawCommitFiles(body, cached); return; }
  body.innerHTML = '<div class="git-commit-note">Loading…</div>';
  try {
    const c = await loadCommit(hash);
    if (el.isConnected && expandedCommits.has(hash)) drawCommitFiles(body, c);
  } catch (e) {
    if (el.isConnected) body.innerHTML = `<div class="git-commit-note">${esc(e.message || 'Could not load commit')}</div>`;
  }
}

// File rows are built a page at a time, only while the commit is expanded.
const COMMIT_FILES_PAGE = 100;

function drawCommitFiles(body, c) {
  const meta = `<div class="git-commit-meta">${esc(c.author)} · <span title="${esc(c.date)}">${esc(relTime(c.date))}</span>` +
    (c.merge ? ' · <span title="Changes are shown against the first parent">merge</span>' : '') + '</div>';
  if (!c.files || !c.files.length) {
    body.innerHTML = meta + '<div class="git-commit-note">No file changes</div>';
    return;
  }
  body.innerHTML = meta;
  appendCommitFiles(body, c);
}

function appendCommitFiles(body, c) {
  const from = body.querySelectorAll('.git-commit-file').length;
  const to = Math.min(c.files.length, from + COMMIT_FILES_PAGE);
  body.querySelector('.git-commit-more')?.remove();
  body.insertAdjacentHTML('beforeend', c.files.slice(from, to).map((f, k) => commitFileRow(f, from + k)).join(''));
  const left = c.files.length - to;
  if (left > 0) {
    body.insertAdjacentHTML('beforeend', `<div class="git-commit-more" tabindex="0" role="button">` +
      `Show ${Math.min(left, COMMIT_FILES_PAGE)} more · ${left.toLocaleString()} remaining</div>`);
  }
  markActiveCommitFile();
  return from;
}

function commitFileRow(f, i) {
  const slash = f.path.lastIndexOf('/');
  const name = f.path.slice(slash + 1);
  const dir = slash > 0 ? f.path.slice(0, slash) : '';
  const title = (f.oldPath ? f.oldPath + ' → ' : '') + f.path + ' (' + (COMMIT_STATUS_NAMES[f.status] || f.status) + ')';
  const stat = f.binary
    ? '<span class="gcf-bin">bin</span>'
    : (f.add ? `<span class="gcf-add">+${f.add}</span>` : '') + (f.del ? `<span class="gcf-del">−${f.del}</span>` : '');
  return `<div class="git-commit-file" data-i="${i}" tabindex="0" role="button" title="${esc(title)}">` +
    `<span class="gcf-st gcf-st-${esc(f.status)}">${esc(f.status)}</span>` +
    `<span class="gcf-name">${esc(name)}</span>` +
    `<span class="gcf-dir">${esc(dir)}</span>` +
    `<span class="gcf-stat">${stat}</span></div>`;
}

// Returns the index of the first row added, or -1 if the commit isn't loaded.
function showMoreCommitFiles(el) {
  const c = commitDetails.get(el.dataset.hash);
  if (!c || c instanceof Promise) return -1;
  return appendCommitFiles(el.querySelector('.git-commit-files'), c);
}

async function openCommitAt(el, index) {
  try {
    const c = await loadCommit(el.dataset.hash);
    const f = c.files?.[index];
    if (f) openCommitFile(c, f);
    else if (!c.files?.length) showToast('!', 'This commit changes no files');
  } catch (e) {
    showToast('!', e.message || 'Could not load commit');
  }
}

function markActiveCommitFile() {
  const list = $('#git-commits-list');
  if (!list) return;
  for (const x of list.querySelectorAll('.git-commit-file.active')) x.classList.remove('active');
  const d = S.tabs[S.active];
  if (!d || !d.rev) return;
  for (const el of list.querySelectorAll('.git-commit')) {
    const c = commitDetails.get(el.dataset.hash);
    if (!c || c.hash !== d.rev) continue;
    const i = c.files.findIndex(f => f.path === d.path);
    el.querySelector(`.git-commit-file[data-i="${i}"]`)?.classList.add('active');
  }
}

function relTime(iso) {
  const t = Date.parse(iso);
  if (isNaN(t)) return iso || '';
  const s = Math.max(0, (Date.now() - t) / 1000);
  const units = [[60, 'second'], [60, 'minute'], [24, 'hour'], [30, 'day'], [12, 'month'], [Infinity, 'year']];
  let n = s;
  for (const [size, unit] of units) {
    if (n < size) {
      const v = Math.floor(n);
      return v <= 0 && unit === 'second' ? 'just now' : `${v} ${unit}${v === 1 ? '' : 's'} ago`;
    }
    n /= size;
  }
  return '';
}

function initCommitList() {
  const list = $('#git-commits-list');
  if (!list) return;
  list.addEventListener('click', e => {
    const sha = e.target.closest('.git-commit-sha');
    if (sha) {
      e.stopPropagation();
      copyToClipboard(sha.textContent, 'Copied ' + sha.textContent, sha);
      return;
    }
    const more = e.target.closest('.git-commit-more');
    if (more) { showMoreCommitFiles(more.closest('.git-commit')); return; }
    const file = e.target.closest('.git-commit-file');
    if (file) { openCommitAt(file.closest('.git-commit'), +file.dataset.i); return; }
    const row = e.target.closest('.git-commit-row');
    // The second click of a double-click opens instead (dblclick below).
    if (row && e.detail < 2) {
      const el = row.closest('.git-commit');
      setCommitExpanded(el, !el.classList.contains('expanded'));
    }
  });
  list.addEventListener('dblclick', e => {
    const row = e.target.closest('.git-commit-row');
    if (!row || e.target.closest('.git-commit-sha')) return;
    const el = row.closest('.git-commit');
    if (!el.classList.contains('expanded')) setCommitExpanded(el, true);
    openCommitAt(el, 0);
  });
  list.addEventListener('keydown', e => {
    const item = e.target.closest('.git-commit-row, .git-commit-file, .git-commit-more');
    if (!item) return;
    const el = item.closest('.git-commit');
    const isRow = item.classList.contains('git-commit-row');
    if (item.classList.contains('git-commit-more') && (e.key === 'Enter' || e.key === ' ')) {
      e.preventDefault();
      const first = showMoreCommitFiles(el);
      el.querySelector(`.git-commit-file[data-i="${first}"]`)?.focus();
      return;
    }
    const items = [...list.querySelectorAll('.git-commit-row, .git-commit.expanded .git-commit-file, .git-commit.expanded .git-commit-more')];
    const at = items.indexOf(item);
    switch (e.key) {
      case 'ArrowDown': items[at + 1]?.focus(); break;
      case 'ArrowUp': items[at - 1]?.focus(); break;
      case 'ArrowRight':
        if (isRow && !el.classList.contains('expanded')) setCommitExpanded(el, true);
        else if (isRow) items[at + 1]?.focus();
        break;
      case 'ArrowLeft':
        if (isRow) setCommitExpanded(el, false);
        else el.querySelector('.git-commit-row').focus();
        break;
      case 'Enter':
        if (isRow) openCommitAt(el, 0);
        else openCommitAt(el, +item.dataset.i);
        break;
      case ' ':
        if (isRow) setCommitExpanded(el, !el.classList.contains('expanded'));
        else openCommitAt(el, +item.dataset.i);
        break;
      default: return;
    }
    e.preventDefault();
  });
  on('tab:activated', markActiveCommitFile);
}
