// ABOUTME: Browser-side entry point for the ALF demo. All OAuth logic is
// handled here using BrowserOAuthClient. API calls go directly to ALF.

import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import type { OAuthSession } from '@atproto/oauth-client-browser';
import { parseRecurrenceRule, formatRecurrenceRule } from '@newpublic/recurrence';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let alfUrl = '';
let oauthClient: BrowserOAuthClient | null = null;
let session: OAuthSession | null = null;
let postsInterval: ReturnType<typeof setInterval> | null = null;
let lastPosts: unknown[] = [];
let lastSchedules: unknown[] = [];
let editingUri: string | null = null;
let userLabel = '';
let activeTab: 'timed' | 'webhook' | 'recurring' = 'timed';
let outerTab: 'create' | 'drafts' | 'delivered' = 'create';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function atUriToBskyUrl(uri: string): string | null {
  const m = uri.match(/^at:\/\/(did:[^/]+)\/app\.bsky\.feed\.post\/([^/]+)$/);
  if (!m) return null;
  return `https://bsky.app/profile/${m[1]}/post/${m[2]}`;
}

function isoToDatetimeLocal(isoString: string): string {
  const d = new Date(isoString);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function hideAllViews(): void {
  ['view-login', 'view-not-authorized', 'view-authorized'].forEach(id => {
    document.getElementById(id)!.classList.add('hidden');
  });
}

function showView(id: string): void {
  document.getElementById(id)!.classList.remove('hidden');
}

async function resolveUserLabel(did: string): Promise<string> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(did)}`,
    );
    if (res.ok) {
      const data = await res.json() as { displayName?: string; handle?: string };
      if (data.displayName && data.handle) return `${data.displayName} (@${data.handle})`;
      if (data.handle) return `@${data.handle}`;
    }
  } catch (_) { /* fall through */ }
  return did;
}

// ---------------------------------------------------------------------------
// ALF fetch helper — makes DPoP-bound authenticated requests via the session
// ---------------------------------------------------------------------------

async function alfFetch(path: string, init?: RequestInit): Promise<Response> {
  if (!session) throw new Error('Not authenticated');
  return session.fetchHandler(`${alfUrl}${path}`, init as any);
}

// ---------------------------------------------------------------------------
// Render — determines which view to show based on current state
// ---------------------------------------------------------------------------

async function render(): Promise<void> {
  document.getElementById('loading')!.classList.add('hidden');
  hideAllViews();

  if (!session) {
    showView('view-login');
    return;
  }

  const did = session.sub;
  userLabel = await resolveUserLabel(did);

  let alfAuthorized = false;
  let recurringDisabled = false;
  try {
    const response = await alfFetch('/oauth/status');
    if (response.ok) {
      const data = await response.json() as { authorized?: boolean; disableRecurring?: boolean };
      alfAuthorized = data.authorized === true;
      recurringDisabled = data.disableRecurring === true;
    }
  } catch (_) {
    // ALF unreachable or not authorized
  }

  if (!alfAuthorized) {
    document.getElementById('did-label-2')!.textContent = userLabel;
    const redirectBack = encodeURIComponent(`${window.location.origin}/?authorized=true`);
    const link = document.getElementById('authorize-alf-link') as HTMLAnchorElement;
    link.href = `${alfUrl}/oauth/authorize?handle=${encodeURIComponent(did)}&redirect_uri=${redirectBack}`;
    showView('view-not-authorized');
    return;
  }

  document.getElementById('did-label-3')!.textContent = userLabel;
  showView('view-authorized');
  applyRecurringDisabled(recurringDisabled);
  await loadPosts();
  await loadSchedules();
  if (postsInterval) clearInterval(postsInterval);
  postsInterval = setInterval(async () => {
    await loadPosts();
    await loadSchedules();
  }, 5000);
}

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

function wireLoginButton(): void {
  const btn = document.getElementById('login-btn') as HTMLButtonElement;
  const handleInput = document.getElementById('handle-input') as HTMLInputElement;
  const errEl = document.getElementById('login-error') as HTMLElement;
  const doLogin = async () => {
    const handle = handleInput.value.trim();
    errEl.classList.add('hidden');

    if (!handle) {
      errEl.textContent = 'Please enter your handle.';
      errEl.classList.remove('hidden');
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Redirecting...';

    try {
      await oauthClient!.signInRedirect(handle);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errEl.textContent = message || 'Login failed.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Sign in with Bluesky';
    }
  };

  btn.addEventListener('click', doLogin);
  handleInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doLogin();
  });
}

// ---------------------------------------------------------------------------
// Scheduling presets
// ---------------------------------------------------------------------------

function wireTimePresets(): void {
  const input = document.getElementById('scheduled-at') as HTMLInputElement;
  const presets = document.querySelectorAll<HTMLButtonElement>('.btn-preset');

  function setPreset(date: Date | null, activeId: string | null): void {
    input.value = date ? isoToDatetimeLocal(date.toISOString()) : '';
    presets.forEach(btn => btn.classList.toggle('active', btn.id === activeId));
  }

  document.getElementById('preset-90s')!.addEventListener('click', () => {
    setPreset(new Date(Date.now() + 90 * 1000), 'preset-90s');
  });

  document.getElementById('preset-1hr')!.addEventListener('click', () => {
    setPreset(new Date(Date.now() + 60 * 60 * 1000), 'preset-1hr');
  });

  document.getElementById('preset-tomorrow')!.addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    d.setHours(9, 0, 0, 0);
    setPreset(d, 'preset-tomorrow');
  });

  document.getElementById('preset-next-week')!.addEventListener('click', () => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    d.setHours(9, 0, 0, 0);
    setPreset(d, 'preset-next-week');
  });

  document.getElementById('preset-draft')!.addEventListener('click', () => {
    setPreset(null, 'preset-draft');
  });

  input.addEventListener('input', () => {
    presets.forEach(btn => btn.classList.remove('active'));
  });
}

// ---------------------------------------------------------------------------
// Image picker
// ---------------------------------------------------------------------------

function wireImagePicker(): void {
  const input = document.getElementById('image-input') as HTMLInputElement;
  const previewWrap = document.getElementById('image-preview-wrap') as HTMLElement;
  const previewImg = document.getElementById('image-preview') as HTMLImageElement;
  const clearBtn = document.getElementById('image-clear-btn') as HTMLButtonElement;

  input.addEventListener('change', () => {
    const file = input.files?.[0];
    if (!file) return;
    const url = URL.createObjectURL(file);
    previewImg.src = url;
    previewWrap.classList.remove('hidden');
  });

  clearBtn.addEventListener('click', () => {
    input.value = '';
    previewImg.src = '';
    previewWrap.classList.add('hidden');
  });
}

// ---------------------------------------------------------------------------
// Edit mode — re-uses the main form
// ---------------------------------------------------------------------------

function startEdit(encodedUri: string): void {
  const uri = decodeURIComponent(encodedUri);
  const post = lastPosts.find((p: any) => (p.uri || p.id) === uri) as Record<string, any> | undefined;

  editingUri = encodedUri;

  const textArea = document.getElementById('post-text') as HTMLTextAreaElement;
  const timeInput = document.getElementById('scheduled-at') as HTMLInputElement;
  const formTitle = document.getElementById('form-title')!;
  const scheduleBtn = document.getElementById('schedule-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-edit-btn') as HTMLButtonElement;

  if (post) {
    textArea.value = post.record?.text || post.text || '';
    const scheduledAt = post.scheduledAt || '';
    timeInput.value = scheduledAt ? isoToDatetimeLocal(scheduledAt) : '';
  }

  switchOuterTab('create');
  switchTab('timed');
  formTitle.textContent = '✎ Editing post';
  formTitle.classList.remove('hidden');
  scheduleBtn.textContent = 'Save changes';
  cancelBtn.classList.remove('hidden');

  document.querySelectorAll<HTMLButtonElement>('.btn-preset').forEach(b => b.classList.remove('active'));
  formTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });
  renderPosts();
}

function cancelEdit(): void {
  editingUri = null;
  (document.getElementById('post-text') as HTMLTextAreaElement).value = '';
  (document.getElementById('scheduled-at') as HTMLInputElement).value = '';
  (document.getElementById('form-title') as HTMLElement).classList.add('hidden');
  document.getElementById('cancel-edit-btn')!.classList.add('hidden');
  document.querySelectorAll<HTMLButtonElement>('.btn-preset').forEach(b => b.classList.remove('active'));
  switchTab(activeTab);
  renderPosts();
}

// ---------------------------------------------------------------------------
// Facet detection — URLs, @mentions (resolved to DIDs), #hashtags
// ATProto facets use UTF-8 byte offsets, not character offsets.
// ---------------------------------------------------------------------------

interface Facet {
  index: { byteStart: number; byteEnd: number };
  features: Array<{ $type: string; [key: string]: unknown }>;
}

async function detectFacets(text: string): Promise<Facet[]> {
  const encoder = new TextEncoder();
  const facets: Facet[] = [];

  function byteOffset(charIdx: number): number {
    return encoder.encode(text.slice(0, charIdx)).length;
  }

  // URLs
  const urlRegex = /https?:\/\/[^\s\]>)'"<]+/g;
  let m: RegExpExecArray | null;
  while ((m = urlRegex.exec(text)) !== null) {
    const url = m[0].replace(/[.,;:!?'")\]]+$/, '');
    const byteStart = byteOffset(m.index);
    const byteEnd = byteStart + encoder.encode(url).length;
    facets.push({ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#link', uri: url }] });
  }

  // @mentions — resolve handles to DIDs in parallel
  const mentionRegex = /(?<![^\s])@([a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)/g;
  const pending: Array<{ index: { byteStart: number; byteEnd: number }; handle: string }> = [];
  while ((m = mentionRegex.exec(text)) !== null) {
    const byteStart = byteOffset(m.index);
    const byteEnd = byteStart + encoder.encode(m[0]).length;
    pending.push({ index: { byteStart, byteEnd }, handle: m[1] });
  }
  await Promise.all(pending.map(async ({ index, handle }) => {
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`);
      if (res.ok) {
        const data = await res.json() as { did?: string };
        if (data.did) facets.push({ index, features: [{ $type: 'app.bsky.richtext.facet#mention', did: data.did }] });
      }
    } catch (_) { /* skip unresolvable handles */ }
  }));

  // #hashtags
  const tagRegex = /(?<![^\s])#([a-zA-Z][a-zA-Z0-9_]*)/g;
  while ((m = tagRegex.exec(text)) !== null) {
    const byteStart = byteOffset(m.index);
    const byteEnd = byteStart + encoder.encode(m[0]).length;
    facets.push({ index: { byteStart, byteEnd }, features: [{ $type: 'app.bsky.richtext.facet#tag', tag: m[1] }] });
  }

  return facets;
}

// ---------------------------------------------------------------------------
// Tab switching
// ---------------------------------------------------------------------------

function switchOuterTab(tab: 'create' | 'drafts' | 'delivered'): void {
  outerTab = tab;
  document.querySelectorAll('[data-outer-tab]').forEach(t => t.classList.remove('active'));
  document.querySelector(`[data-outer-tab="${tab}"]`)?.classList.add('active');
  (document.getElementById('outer-pane-create') as HTMLElement).classList.toggle('hidden', tab !== 'create');
  (document.getElementById('outer-pane-drafts') as HTMLElement).classList.toggle('hidden', tab !== 'drafts');
  (document.getElementById('outer-pane-delivered') as HTMLElement).classList.toggle('hidden', tab !== 'delivered');
  if (tab === 'drafts' || tab === 'delivered') void loadPosts();
}

function switchTab(tab: 'timed' | 'webhook' | 'recurring'): void {
  activeTab = tab;

  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  document.querySelector(`.tab[data-tab="${tab}"]`)?.classList.add('active');

  const isPost = tab === 'timed' || tab === 'webhook';
  (document.getElementById('post-form-fields') as HTMLElement).classList.toggle('hidden', !isPost);
  (document.getElementById('timed-schedule-section') as HTMLElement).classList.toggle('hidden', tab !== 'timed');
  (document.getElementById('webhook-note') as HTMLElement).classList.toggle('hidden', tab !== 'webhook');
  (document.getElementById('recurring-section') as HTMLElement).classList.toggle('hidden', tab !== 'recurring');

  const btn = document.getElementById('schedule-btn') as HTMLButtonElement;
  if (btn && !editingUri) {
    btn.textContent = tab === 'webhook' ? 'Create Webhook Draft' : 'Schedule Post';
  }
}

// ---------------------------------------------------------------------------
// Schedule / update post
// ---------------------------------------------------------------------------

function wireScheduleButton(): void {
  const btn = document.getElementById('schedule-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-edit-btn') as HTMLButtonElement;

  cancelBtn.addEventListener('click', () => cancelEdit());

  document.querySelectorAll('[data-outer-tab]').forEach(tabEl => {
    tabEl.addEventListener('click', () => {
      switchOuterTab((tabEl as HTMLElement).dataset.outerTab as 'create' | 'drafts' | 'delivered');
    });
  });

  document.querySelectorAll('[data-tab]').forEach(tabEl => {
    tabEl.addEventListener('click', () => {
      switchTab((tabEl as HTMLElement).dataset.tab as 'timed' | 'webhook' | 'recurring');
    });
  });

  btn.addEventListener('click', async () => {
    if (editingUri) {
      await performSaveEdit();
    } else {
      await performCreatePost();
    }
  });
}

async function performCreatePost(): Promise<void> {
  const btn = document.getElementById('schedule-btn') as HTMLButtonElement;
  const text = (document.getElementById('post-text') as HTMLTextAreaElement).value.trim();
  const scheduledAtValue = (document.getElementById('scheduled-at') as HTMLInputElement).value;
  const isTriggerMode = activeTab === 'webhook';
  const imageInput = document.getElementById('image-input') as HTMLInputElement;
  const imageFile = imageInput.files?.[0] ?? null;
  const successEl = document.getElementById('schedule-success') as HTMLElement;
  const errEl = document.getElementById('schedule-error') as HTMLElement;
  successEl.classList.add('hidden');
  errEl.classList.add('hidden');

  if (!text && !imageFile) {
    errEl.textContent = 'Post text or an image is required.';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;

  try {
    // Upload image blob first if one is selected
    let embed: Record<string, unknown> | undefined;
    if (imageFile) {
      btn.textContent = 'Uploading image...';
      const arrayBuffer = await imageFile.arrayBuffer();
      const blobResponse = await alfFetch('/blob', {
        method: 'POST',
        headers: { 'Content-Type': imageFile.type || 'application/octet-stream' },
        body: arrayBuffer,
      });
      const blobData = await blobResponse.json() as { cid?: string; mimeType?: string; size?: number; error?: string; message?: string };
      if (!blobResponse.ok) {
        errEl.textContent = blobData.error || blobData.message || 'Image upload failed.';
        errEl.classList.remove('hidden');
        return;
      }
      const altText = (document.getElementById('image-alt') as HTMLInputElement).value.trim();
      embed = {
        $type: 'app.bsky.embed.images',
        images: [{
          image: { $type: 'blob', ref: { $link: blobData.cid }, mimeType: blobData.mimeType, size: blobData.size },
          alt: altText,
        }],
      };
    }

    btn.textContent = isTriggerMode ? 'Creating...' : 'Scheduling...';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (isTriggerMode) {
      headers['x-trigger'] = 'webhook';
    } else if (scheduledAtValue) {
      headers['x-scheduled-at'] = new Date(scheduledAtValue).toISOString();
    }

    const facets = await detectFacets(text);
    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
    };
    if (facets.length > 0) record.facets = facets;
    if (embed) record.embed = embed;

    const response = await alfFetch('/xrpc/com.atproto.repo.createRecord', {
      method: 'POST',
      headers,
      body: JSON.stringify({
        repo: session!.sub,
        collection: 'app.bsky.feed.post',
        record,
      }),
    });

    const data = await response.json() as { uri?: string; triggerUrl?: string; error?: string; message?: string };

    if (!response.ok) {
      errEl.textContent = data.error || data.message || 'Failed to schedule post.';
      errEl.classList.remove('hidden');
    } else {
      if (data.triggerUrl) {
        const safeUrl = escHtml(data.triggerUrl);
        successEl.innerHTML = `Draft created! Call this URL (POST) to publish on demand:<br><code style="display:block;word-break:break-all;font-size:0.78rem;margin-top:0.3rem;padding:0.3rem 0;">${safeUrl}</code>`;
      } else {
        successEl.textContent = `Post scheduled! URI: ${data.uri ?? ''}`;
      }
      successEl.classList.remove('hidden');
      (document.getElementById('post-text') as HTMLTextAreaElement).value = '';
      (document.getElementById('scheduled-at') as HTMLInputElement).value = '';
      document.querySelectorAll<HTMLButtonElement>('.btn-preset').forEach(b => b.classList.remove('active'));
      imageInput.value = '';
      (document.getElementById('image-preview-wrap') as HTMLElement).classList.add('hidden');
      await loadPosts();
    }
  } catch (_) {
    errEl.textContent = 'Network error.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = activeTab === 'webhook' ? 'Create Webhook Draft' : 'Schedule Post';
  }
}

async function performSaveEdit(): Promise<void> {
  const btn = document.getElementById('schedule-btn') as HTMLButtonElement;
  const errEl = document.getElementById('schedule-error') as HTMLElement;
  const text = (document.getElementById('post-text') as HTMLTextAreaElement).value.trim();
  const scheduledAtValue = (document.getElementById('scheduled-at') as HTMLInputElement).value;

  errEl.classList.add('hidden');

  if (!text) {
    errEl.textContent = 'Post text cannot be empty.';
    errEl.classList.remove('hidden');
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Saving...';

  try {
    const uri = decodeURIComponent(editingUri!);
    const facets = await detectFacets(text);
    const record: Record<string, unknown> = { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString() };
    if (facets.length > 0) record.facets = facets;
    const updateBody: Record<string, unknown> = { uri, record };
    if (scheduledAtValue) {
      updateBody.scheduledAt = new Date(scheduledAtValue).toISOString();
    }

    const response = await alfFetch('/xrpc/town.roundabout.scheduledPosts.updatePost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateBody),
    });
    const data = await response.json() as { error?: string; message?: string };
    if (!response.ok) {
      errEl.textContent = data.error || data.message || 'Failed to update post.';
      errEl.classList.remove('hidden');
      btn.disabled = false;
      btn.textContent = 'Save changes';
    } else {
      cancelEdit();
      await loadPosts();
    }
  } catch (_) {
    errEl.textContent = 'Network error.';
    errEl.classList.remove('hidden');
    btn.disabled = false;
    btn.textContent = 'Save changes';
  }
}

// ---------------------------------------------------------------------------
// Posts list
// ---------------------------------------------------------------------------

async function loadPosts(): Promise<void> {
  const listEl = document.getElementById('posts-list')!;
  try {
    const response = await alfFetch(
      `/xrpc/town.roundabout.scheduledPosts.listPosts?repo=${encodeURIComponent(session!.sub)}`,
    );
    if (!response.ok) {
      listEl.innerHTML = '<div class="empty-state">Could not load posts.</div>';
      return;
    }
    const data = await response.json() as { posts?: unknown[]; drafts?: unknown[] } | unknown[];
    if (Array.isArray(data)) {
      lastPosts = data;
    } else {
      lastPosts = (data as any).posts || (data as any).drafts || [];
    }
    renderPosts();
    renderDelivered();
  } catch (_) {
    listEl.innerHTML = '<div class="empty-state">Error loading posts.</div>';
  }
}

function wireCopyTrigger(container: Element): void {
  container.querySelectorAll('[data-action="copy-trigger"]').forEach(btn => {
    btn.addEventListener('click', () => {
      const url = (btn as HTMLElement).dataset.url!;
      void navigator.clipboard.writeText(url).then(() => {
        (btn as HTMLElement).textContent = 'Copied!';
        setTimeout(() => { (btn as HTMLElement).textContent = 'Copy'; }, 2000);
      });
    });
  });
}

function renderPosts(): void {
  const listEl = document.getElementById('posts-list')!;
  const active = Array.isArray(lastPosts)
    ? lastPosts.filter((p: any) => p.status !== 'published')
    : [];
  if (active.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No scheduled posts yet.</div>';
    return;
  }

  listEl.innerHTML = active.map(post => renderPostCard(post as Record<string, any>)).join('');

  listEl.querySelectorAll('[data-action="publish"]').forEach(btn => {
    btn.addEventListener('click', () => publishPost((btn as HTMLElement).dataset.uri!));
  });
  listEl.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', () => cancelPost((btn as HTMLElement).dataset.uri!));
  });
  listEl.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => startEdit((btn as HTMLElement).dataset.uri!));
  });
  wireCopyTrigger(listEl);
}

function renderDelivered(): void {
  const listEl = document.getElementById('delivered-list')!;
  const delivered = Array.isArray(lastPosts)
    ? lastPosts.filter((p: any) => p.status === 'published')
    : [];
  if (delivered.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No delivered posts yet.</div>';
    return;
  }
  listEl.innerHTML = delivered.map(post => renderPostCard(post as Record<string, any>)).join('');
  wireCopyTrigger(listEl);
}

function renderPostCard(post: Record<string, any>): string {
  const status = post.status || 'pending';
  const badgeClass: Record<string, string> = {
    scheduled: 'badge-scheduled',
    published: 'badge-published',
    draft: 'badge-draft',
    failed: 'badge-failed',
  };
  const badgeCls = badgeClass[status] || 'badge-pending';

  const text: string = post.record?.text || post.text || '';
  const uri: string = post.uri || post.id || '';
  const encodedUri = encodeURIComponent(uri);
  const canEdit = status === 'draft' || status === 'scheduled';
  const isEditing = editingUri === encodedUri;

  const preview = text.length > 140 ? text.slice(0, 140) + '…' : text;
  const scheduledTime = post.scheduledAt
    ? new Date(post.scheduledAt).toLocaleString()
    : status === 'draft' ? 'Unscheduled' : 'Immediate';

  const bskyUrl = status === 'published' ? atUriToBskyUrl(uri) : null;

  const scheduleIdBadge = post.scheduleId
    ? `<span class="badge badge-recurring" title="Part of recurring schedule">recurring</span>`
    : '';

  const triggerUrlHtml = post.triggerUrl
    ? `<div class="trigger-url-box">
        <span class="trigger-url-label">Trigger URL:</span>
        <code class="trigger-url-value">${escHtml(post.triggerUrl as string)}</code>
        <button class="btn btn-outline" data-action="copy-trigger" data-url="${escHtml(post.triggerUrl as string)}" style="padding:0.2rem 0.5rem;font-size:0.72rem;flex-shrink:0;">Copy</button>
      </div>`
    : '';

  return `
    <div class="post-item${isEditing ? ' post-item-editing' : ''}">
      <div class="post-item-header">
        <span class="badge ${badgeCls}">${status}</span>
        ${scheduleIdBadge}
        ${isEditing ? '<span style="font-size:0.72rem;color:var(--indigo);font-weight:600;margin-left:auto;">editing ↑</span>' : ''}
      </div>
      <div class="post-text">${escHtml(preview) || '<em style="color:var(--text-faint)">(no text)</em>'}</div>
      <div class="post-meta">${scheduledTime}</div>
      ${triggerUrlHtml}
      <div class="post-actions">
        ${bskyUrl ? `<a href="${bskyUrl}" target="_blank" rel="noopener" class="post-bsky-link">View on Bluesky →</a>` : ''}
        ${canEdit && !isEditing ? `
          <button class="btn btn-outline" data-action="edit" data-uri="${encodedUri}">Edit</button>
          <button class="btn btn-outline" data-action="publish" data-uri="${encodedUri}">Publish now</button>
          <button class="btn btn-danger" data-action="cancel" data-uri="${encodedUri}">Delete</button>
        ` : ''}
      </div>
    </div>`;
}

async function publishPost(encodedUri: string): Promise<void> {
  if (!confirm('Publish this post now?')) return;
  try {
    const uri = decodeURIComponent(encodedUri);
    const response = await alfFetch('/xrpc/town.roundabout.scheduledPosts.publishPost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) alert(data.error || 'Failed to publish.');
    await loadPosts();
  } catch (_) {
    alert('Network error.');
  }
}

async function cancelPost(encodedUri: string): Promise<void> {
  if (!confirm('Cancel this post?')) return;
  try {
    const uri = decodeURIComponent(encodedUri);
    const response = await alfFetch('/xrpc/town.roundabout.scheduledPosts.deletePost', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uri }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) alert(data.error || 'Failed to cancel.');
    await loadPosts();
  } catch (_) {
    alert('Network error.');
  }
}

// ---------------------------------------------------------------------------
// Recurring Schedules
// ---------------------------------------------------------------------------

async function loadSchedules(): Promise<void> {
  const listEl = document.getElementById('schedules-list');
  if (!listEl) return;
  try {
    const response = await alfFetch(
      `/xrpc/town.roundabout.scheduledPosts.listSchedules?repo=${encodeURIComponent(session!.sub)}`,
    );
    if (!response.ok) {
      listEl.innerHTML = '<div class="empty-state">Could not load schedules.</div>';
      return;
    }
    const data = await response.json() as { schedules?: unknown[] };
    lastSchedules = data.schedules ?? [];
    renderSchedules();
  } catch (_) {
    listEl.innerHTML = '<div class="empty-state">Error loading schedules.</div>';
  }
}

function renderSchedules(): void {
  const listEl = document.getElementById('schedules-list');
  if (!listEl) return;
  if (!Array.isArray(lastSchedules) || lastSchedules.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No recurring schedules yet.</div>';
    return;
  }

  listEl.innerHTML = lastSchedules.map(s => renderScheduleCard(s as Record<string, any>)).join('');

  listEl.querySelectorAll('[data-action="pause-schedule"]').forEach(btn => {
    btn.addEventListener('click', () => pauseSchedule((btn as HTMLElement).dataset.id!));
  });
  listEl.querySelectorAll('[data-action="resume-schedule"]').forEach(btn => {
    btn.addEventListener('click', () => resumeSchedule((btn as HTMLElement).dataset.id!));
  });
  listEl.querySelectorAll('[data-action="delete-schedule"]').forEach(btn => {
    btn.addEventListener('click', () => deleteScheduleItem((btn as HTMLElement).dataset.id!));
  });
}


function renderScheduleCard(schedule: Record<string, any>): string {
  const status: string = schedule.status || 'active';
  const statusBadge: Record<string, string> = {
    active: 'badge-published',
    paused: 'badge-draft',
    cancelled: 'badge-pending',
    completed: 'badge-scheduled',
    error: 'badge-failed',
  };
  const badgeCls = statusBadge[status] || 'badge-pending';

  const ruleDesc = schedule.recurrenceRule
    ? formatRecurrenceRule(schedule.recurrenceRule as any)
    : (schedule.timezone as string) || 'unknown schedule';

  const fireCount: number = schedule.fireCount ?? 0;
  const lastFired = schedule.lastFiredAt
    ? new Date(schedule.lastFiredAt as string).toLocaleString()
    : null;

  const id: string = schedule.id || '';
  const staticText: string = (schedule.record as Record<string, any> | undefined)?.text ?? '';
  const preview = staticText ? (staticText.length > 80 ? staticText.slice(0, 80) + '…' : staticText) : '';

  return `
    <div class="schedule-item">
      <div class="post-item-header">
        <span class="badge ${badgeCls}">${escHtml(status)}</span>
        <span style="font-size:0.82rem;color:var(--text);font-weight:500;">${escHtml(ruleDesc)}</span>
      </div>
      ${preview ? `<div class="post-text" style="font-size:0.82rem;">${escHtml(preview)}</div>` : ''}
      ${schedule.contentUrl ? `<div class="post-meta">Dynamic content: <code>${escHtml(schedule.contentUrl as string)}</code></div>` : ''}
      <div class="post-meta">
        Fired ${fireCount} time${fireCount === 1 ? '' : 's'}${lastFired ? ` · Last: ${lastFired}` : ''}
      </div>
      <div class="post-actions">
        ${status === 'active' ? `<button class="btn btn-outline" data-action="pause-schedule" data-id="${escHtml(id)}">Pause</button>` : ''}
        ${status === 'paused' ? `<button class="btn btn-outline" data-action="resume-schedule" data-id="${escHtml(id)}">Resume</button>` : ''}
        ${status !== 'cancelled' && status !== 'completed' ? `<button class="btn btn-danger" data-action="delete-schedule" data-id="${escHtml(id)}">Delete</button>` : ''}
      </div>
    </div>`;
}

async function pauseSchedule(id: string): Promise<void> {
  try {
    const response = await alfFetch('/xrpc/town.roundabout.scheduledPosts.updateSchedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'paused' }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) alert(data.error || 'Failed to pause schedule.');
    await loadSchedules();
  } catch (_) {
    alert('Network error.');
  }
}

async function resumeSchedule(id: string): Promise<void> {
  try {
    const response = await alfFetch('/xrpc/town.roundabout.scheduledPosts.updateSchedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, status: 'active' }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) alert(data.error || 'Failed to resume schedule.');
    await loadSchedules();
    await loadPosts();
  } catch (_) {
    alert('Network error.');
  }
}

async function deleteScheduleItem(id: string): Promise<void> {
  if (!confirm('Delete this recurring schedule and cancel its pending draft?')) return;
  try {
    const response = await alfFetch('/xrpc/town.roundabout.scheduledPosts.deleteSchedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) alert(data.error || 'Failed to delete schedule.');
    await loadSchedules();
    await loadPosts();
  } catch (_) {
    alert('Network error.');
  }
}

const INTERVAL_UNITS: Record<string, string> = {
  daily: 'days',
  weekly: 'weeks',
  monthly: 'months',
  quarterly: 'quarters',
  yearly: 'years',
};

function updateScheduleFormVisibility(): void {
  const type = (document.getElementById('sched-type') as HTMLSelectElement).value;
  const monthlyPattern = (document.getElementById('sched-monthly-pattern') as HTMLSelectElement).value;
  const yearlyPattern = (document.getElementById('sched-yearly-pattern') as HTMLSelectElement).value;

  const show = (id: string, visible: boolean) =>
    document.getElementById(id)?.classList.toggle('hidden', !visible);

  // Interval unit label
  const unitEl = document.getElementById('sched-interval-unit');
  if (unitEl) unitEl.textContent = INTERVAL_UNITS[type] ?? '';

  // Hide the nth-col (ordinal) for quarterly — it only has "last"
  const nthCol = document.getElementById('sched-nth-col');
  if (nthCol) nthCol.classList.toggle('hidden', type === 'quarterly');

  show('sched-weekly-opts', type === 'weekly');
  show('sched-monthly-opts', type === 'monthly');
  show('sched-yearly-opts', type === 'yearly');

  // Month selector: yearly only
  show('sched-month-row', type === 'yearly');

  // Day of month: monthly on_day OR yearly on_month_day
  const showDom = (type === 'monthly' && monthlyPattern === 'on_day') ||
                  (type === 'yearly' && yearlyPattern === 'on_month_day');
  show('sched-dom-row', showDom);

  // Nth + weekday: monthly nth_weekday, quarterly (all), yearly nth_weekday
  const showNthWeekday = (type === 'monthly' && monthlyPattern === 'nth_weekday') ||
                         type === 'quarterly' ||
                         (type === 'yearly' && yearlyPattern === 'nth_weekday');
  show('sched-nth-weekday-row', showNthWeekday);
}

function applyRecurringDisabled(disabled: boolean): void {
  const notice = document.getElementById('sched-disabled-notice') as HTMLElement;
  const btn = document.getElementById('create-schedule-btn') as HTMLButtonElement;
  const nlpBtn = document.getElementById('sched-nlp-btn') as HTMLButtonElement;
  const nlpInput = document.getElementById('sched-nlp') as HTMLInputElement;
  if (disabled) {
    notice.classList.remove('hidden');
    btn.disabled = true;
    nlpBtn.disabled = true;
    nlpInput.disabled = true;
  } else {
    notice.classList.add('hidden');
    btn.disabled = false;
    nlpBtn.disabled = false;
    nlpInput.disabled = false;
  }
}

function wireCreateScheduleForm(): void {
  const typeSelect = document.getElementById('sched-type') as HTMLSelectElement;
  const monthlyPatternSelect = document.getElementById('sched-monthly-pattern') as HTMLSelectElement;
  const yearlyPatternSelect = document.getElementById('sched-yearly-pattern') as HTMLSelectElement;

  typeSelect.addEventListener('change', updateScheduleFormVisibility);
  monthlyPatternSelect.addEventListener('change', updateScheduleFormVisibility);
  yearlyPatternSelect.addEventListener('change', updateScheduleFormVisibility);

  // Set initial state
  updateScheduleFormVisibility();

  document.getElementById('create-schedule-btn')!.addEventListener('click', performCreateSchedule);
}

function currentTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch (_) {
    return 'UTC';
  }
}

function wireNlpInput(): void {
  const input = document.getElementById('sched-nlp') as HTMLInputElement;
  const btn = document.getElementById('sched-nlp-btn') as HTMLButtonElement;
  const feedback = document.getElementById('sched-nlp-feedback') as HTMLElement;

  function applyParsed(): void {
    const text = input.value.trim();
    if (!text) return;

    const result = parseRecurrenceRule(text, currentTimezone());

    if (!result) {
      feedback.textContent = "Couldn't parse — try: 'every Monday at 9am ET'";
      feedback.style.color = '#ef4444';
      feedback.classList.remove('hidden');
      return;
    }

    const c = result.rule;

    // Map parsed rule type to form select value
    const typeSelect = document.getElementById('sched-type') as HTMLSelectElement;
    const intervalInput = document.getElementById('sched-interval') as HTMLInputElement;
    const hourInput = document.getElementById('sched-hour') as HTMLInputElement;
    const minuteInput = document.getElementById('sched-minute') as HTMLInputElement;
    const tzSelect = document.getElementById('sched-tz') as HTMLSelectElement;
    const monthlyPatternSelect = document.getElementById('sched-monthly-pattern') as HTMLSelectElement;
    const yearlyPatternSelect = document.getElementById('sched-yearly-pattern') as HTMLSelectElement;
    const nthSelect = document.getElementById('sched-nth') as HTMLSelectElement;
    const weekdaySelect = document.getElementById('sched-weekday') as HTMLSelectElement;
    const monthSelect = document.getElementById('sched-month') as HTMLSelectElement;
    const domInput = document.getElementById('sched-dom') as HTMLInputElement;

    // Resolve time spec (all rules except 'once' have a time field)
    const time = (c as any).time;

    // Set hour/minute/timezone
    if (time) {
      hourInput.value = String(time.hour ?? 9);
      minuteInput.value = String(time.minute ?? 0);
      // Try to set timezone — find matching option value
      const tz = time.timezone ?? 'UTC';
      const tzOption = Array.from(tzSelect.options).find(o => o.value === tz);
      if (tzOption) {
        tzSelect.value = tz;
      }
    }

    // Set frequency type and sub-options
    if (c.type === 'daily') {
      typeSelect.value = 'daily';
      intervalInput.value = String((c as any).interval ?? 1);
    } else if (c.type === 'weekly') {
      typeSelect.value = 'weekly';
      intervalInput.value = String((c as any).interval ?? 1);
      // Check/uncheck weekday checkboxes
      const daysOfWeek: number[] = (c as any).daysOfWeek ?? [];
      document.querySelectorAll<HTMLInputElement>('input[name="sched-day"]').forEach(cb => {
        cb.checked = daysOfWeek.includes(parseInt(cb.value, 10));
      });
    } else if (c.type === 'monthly_on_day') {
      typeSelect.value = 'monthly';
      monthlyPatternSelect.value = 'on_day';
      intervalInput.value = String((c as any).interval ?? 1);
      domInput.value = String((c as any).dayOfMonth ?? 1);
    } else if (c.type === 'monthly_nth_weekday') {
      typeSelect.value = 'monthly';
      monthlyPatternSelect.value = 'nth_weekday';
      intervalInput.value = String((c as any).interval ?? 1);
      nthSelect.value = String((c as any).nth ?? 1);
      weekdaySelect.value = String((c as any).weekday ?? 1);
    } else if (c.type === 'monthly_last_business_day') {
      typeSelect.value = 'monthly';
      monthlyPatternSelect.value = 'last_business_day';
      intervalInput.value = String((c as any).interval ?? 1);
    } else if (c.type === 'quarterly_last_weekday') {
      typeSelect.value = 'quarterly';
      weekdaySelect.value = String((c as any).weekday ?? 5);
    } else if (c.type === 'yearly_on_month_day') {
      typeSelect.value = 'yearly';
      yearlyPatternSelect.value = 'on_month_day';
      monthSelect.value = String((c as any).month ?? 1);
      domInput.value = String((c as any).dayOfMonth ?? 1);
    } else if (c.type === 'yearly_nth_weekday') {
      typeSelect.value = 'yearly';
      yearlyPatternSelect.value = 'nth_weekday';
      monthSelect.value = String((c as any).month ?? 1);
      nthSelect.value = String((c as any).nth ?? 1);
      weekdaySelect.value = String((c as any).weekday ?? 1);
    }

    // Refresh visibility of sub-options
    updateScheduleFormVisibility();

    // Build human-readable summary for the feedback line
    feedback.textContent = `Parsed: ${formatRecurrenceRule(result)}`;
    feedback.style.color = '#166534';
    feedback.classList.remove('hidden');
  }

  btn.addEventListener('click', applyParsed);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') applyParsed();
  });
}

async function performCreateSchedule(): Promise<void> {
  const btn = document.getElementById('create-schedule-btn') as HTMLButtonElement;
  const successEl = document.getElementById('sched-success') as HTMLElement;
  const errEl = document.getElementById('sched-error') as HTMLElement;

  successEl.classList.add('hidden');
  errEl.classList.add('hidden');

  const text = (document.getElementById('sched-text') as HTMLTextAreaElement).value.trim();
  const type = (document.getElementById('sched-type') as HTMLSelectElement).value;
  const interval = parseInt((document.getElementById('sched-interval') as HTMLInputElement).value, 10) || 1;
  const monthlyPattern = (document.getElementById('sched-monthly-pattern') as HTMLSelectElement).value;
  const yearlyPattern = (document.getElementById('sched-yearly-pattern') as HTMLSelectElement).value;
  const hour = parseInt((document.getElementById('sched-hour') as HTMLInputElement).value, 10);
  const minute = parseInt((document.getElementById('sched-minute') as HTMLInputElement).value, 10);
  const timezone = (document.getElementById('sched-tz') as HTMLSelectElement).value;

  if (!text) {
    errEl.textContent = 'Post text is required.';
    errEl.classList.remove('hidden');
    return;
  }

  const timeSpec = { type: 'wall_time', hour, minute, timezone };
  const intervalOpt = interval > 1 ? { interval } : {};
  let ruleCore: Record<string, unknown>;

  if (type === 'daily') {
    ruleCore = { type: 'daily', ...intervalOpt, time: timeSpec };

  } else if (type === 'weekly') {
    const checkedDays = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[name="sched-day"]:checked'),
    ).map(cb => parseInt(cb.value, 10));
    if (checkedDays.length === 0) {
      errEl.textContent = 'Select at least one day of the week.';
      errEl.classList.remove('hidden');
      return;
    }
    ruleCore = { type: 'weekly', ...intervalOpt, daysOfWeek: checkedDays, time: timeSpec };

  } else if (type === 'monthly') {
    if (monthlyPattern === 'on_day') {
      const dom = parseInt((document.getElementById('sched-dom') as HTMLInputElement).value, 10);
      ruleCore = { type: 'monthly_on_day', ...intervalOpt, dayOfMonth: dom, time: timeSpec };
    } else if (monthlyPattern === 'nth_weekday') {
      const nth = parseInt((document.getElementById('sched-nth') as HTMLSelectElement).value, 10);
      const weekday = parseInt((document.getElementById('sched-weekday') as HTMLSelectElement).value, 10);
      ruleCore = { type: 'monthly_nth_weekday', ...intervalOpt, nth, weekday, time: timeSpec };
    } else {
      // last_business_day
      ruleCore = { type: 'monthly_last_business_day', ...intervalOpt, time: timeSpec };
    }

  } else if (type === 'quarterly') {
    const weekday = parseInt((document.getElementById('sched-weekday') as HTMLSelectElement).value, 10);
    ruleCore = { type: 'quarterly_last_weekday', ...intervalOpt, weekday, time: timeSpec };

  } else if (type === 'yearly') {
    const month = parseInt((document.getElementById('sched-month') as HTMLSelectElement).value, 10);
    if (yearlyPattern === 'on_month_day') {
      const dom = parseInt((document.getElementById('sched-dom') as HTMLInputElement).value, 10);
      ruleCore = { type: 'yearly_on_month_day', ...intervalOpt, month, dayOfMonth: dom, time: timeSpec };
    } else {
      const nth = parseInt((document.getElementById('sched-nth') as HTMLSelectElement).value, 10);
      const weekday = parseInt((document.getElementById('sched-weekday') as HTMLSelectElement).value, 10);
      ruleCore = { type: 'yearly_nth_weekday', ...intervalOpt, month, nth, weekday, time: timeSpec };
    }

  } else {
    ruleCore = { type, time: timeSpec };
  }

  const recurrenceRule = { rule: ruleCore };
  const facets = await detectFacets(text);
  const record: Record<string, unknown> = {
    $type: 'app.bsky.feed.post',
    text,
    createdAt: new Date().toISOString(),
  };
  if (facets.length > 0) record.facets = facets;

  btn.disabled = true;
  btn.textContent = 'Creating...';

  try {
    const response = await alfFetch('/xrpc/town.roundabout.scheduledPosts.createSchedule', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ collection: 'app.bsky.feed.post', recurrenceRule, timezone, record }),
    });

    const data = await response.json() as { schedule?: Record<string, any>; error?: string; message?: string };

    if (!response.ok) {
      errEl.textContent = data.error || data.message || 'Failed to create schedule.';
      errEl.classList.remove('hidden');
    } else {
      successEl.textContent = 'Schedule created! First draft queued.';
      successEl.classList.remove('hidden');
      (document.getElementById('sched-text') as HTMLTextAreaElement).value = '';
      await loadSchedules();
      await loadPosts();
    }
  } catch (_) {
    errEl.textContent = 'Network error.';
    errEl.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Create Schedule';
  }
}

// ---------------------------------------------------------------------------
// Re-authorize ALF (refresh server-side OAuth session without losing drafts)
// ---------------------------------------------------------------------------

function wireReauth(): void {
  const btn = document.getElementById('reauth-btn') as HTMLButtonElement;
  btn.addEventListener('click', () => {
    if (!session) return;
    const did = session.sub;
    const redirectBack = encodeURIComponent(`${window.location.origin}/?authorized=true`);
    window.location.href = `${alfUrl}/oauth/authorize?handle=${encodeURIComponent(did)}&redirect_uri=${redirectBack}`;
  });
}

// ---------------------------------------------------------------------------
// Sign out (revoke OAuth session, preserve drafts)
// ---------------------------------------------------------------------------

function wireSignOut(): void {
  const btn = document.getElementById('signout-btn') as HTMLButtonElement;
  btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Signing out...';
    try {
      await oauthClient!.revoke(session!.sub);
    } catch (_) {
      // best-effort
    }
    session = null;
    if (postsInterval) clearInterval(postsInterval);
    hideAllViews();
    showView('view-login');
    document.getElementById('loading')!.classList.add('hidden');
  });
}

// ---------------------------------------------------------------------------
// Delete account
// ---------------------------------------------------------------------------

function wireDeleteAccount(): void {
  const btn = document.getElementById('delete-account-btn') as HTMLButtonElement;
  btn.addEventListener('click', async () => {
    if (!confirm('This will cancel all your drafts and remove ALF\'s authorization to post on your behalf. Are you sure?')) return;
    btn.disabled = true;
    btn.textContent = 'Deleting...';
    try {
      await alfFetch('/account', { method: 'DELETE' });
    } catch (_) {
      // best-effort — proceed to sign out regardless
    }
    try {
      await oauthClient!.revoke(session!.sub);
    } catch (_) {
      // best-effort — clear UI regardless
    }
    session = null;
    if (postsInterval) clearInterval(postsInterval);
    hideAllViews();
    showView('view-login');
    document.getElementById('loading')!.classList.add('hidden');
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

document.addEventListener('DOMContentLoaded', async () => {
  try {
  // 1. Fetch ALF URL from /api/config
  try {
    const cfg = await fetch('/api/config', { signal: AbortSignal.timeout(5000) }).then(r => r.json()) as { alfUrl?: string };
    alfUrl = cfg.alfUrl || '';
  } catch (_) {
    alfUrl = '';
  }

  // 2. Create BrowserOAuthClient.
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  let oauthClientMetadata: Parameters<typeof BrowserOAuthClient>[0]['clientMetadata'];
  let allowHttp: boolean;
  if (isLocalhost) {
    const port = window.location.port;
    const redirectUri = `http://127.0.0.1${port ? `:${port}` : ''}/`;
    const clientId = `http://localhost?scope=${encodeURIComponent('atproto')}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    oauthClientMetadata = {
      client_id: clientId,
      client_name: 'ALF Demo',
      redirect_uris: [redirectUri],
      scope: 'atproto',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
      application_type: 'native',
    };
    allowHttp = true;
  } else {
    const metadataUrl = `${window.location.origin}/oauth/client-metadata.json`;
    oauthClientMetadata = {
      client_id: metadataUrl,
      client_name: 'ALF Demo',
      redirect_uris: [`${window.location.origin}/`],
      scope: 'atproto',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      dpop_bound_access_tokens: true,
      application_type: 'web',
    };
    allowHttp = false;
  }

  oauthClient = new BrowserOAuthClient({
    handleResolver: 'https://api.bsky.app',
    clientMetadata: oauthClientMetadata,
    allowHttp,
  });

  // Wire up UI buttons
  wireLoginButton();
  wireTimePresets();
  wireImagePicker();
  wireScheduleButton();
  wireCreateScheduleForm();
  wireNlpInput();
  wireReauth();
  wireSignOut();
  wireDeleteAccount();

  // 4. Call client.init() — detects OAuth callback params or restores existing session
  let initResult: { session: OAuthSession; state?: string } | undefined;
  try {
    initResult = await Promise.race([
      oauthClient.init(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('OAuth init timed out')), 8000),
      ),
    ]);
  } catch (_) {
    initResult = undefined;
  }

  if (initResult) {
    session = initResult.session;
    if ('state' in initResult) {
      history.replaceState({}, '', '/?authorized=true');
    }
  }

  // Check for ?authorized=true banner
  const params = new URLSearchParams(window.location.search);
  if (params.get('authorized') === 'true') {
    const banner = document.getElementById('banner-authorized')!;
    banner.classList.remove('hidden');
    history.replaceState({}, '', '/');
    setTimeout(() => banner.classList.add('hidden'), 5000);
  }

  } catch (_) {
    // unexpected boot error — fall through so render() always runs
  }

  // 6. Render appropriate view (always runs, even if boot fails)
  await render();
});
