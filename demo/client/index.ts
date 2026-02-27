// ABOUTME: Browser-side entry point for the ALF demo. All OAuth logic is
// handled here using BrowserOAuthClient. API calls go directly to ALF.

import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import type { OAuthSession } from '@atproto/oauth-client-browser';

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let alfUrl = '';
let oauthClient: BrowserOAuthClient | null = null;
let session: OAuthSession | null = null;
let postsInterval: ReturnType<typeof setInterval> | null = null;
let lastPosts: unknown[] = [];
let editingUri: string | null = null;
let userLabel = '';

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

  // Check whether ALF has an active session for this user
  let alfAuthorized = false;
  try {
    const response = await alfFetch('/oauth/status');
    if (response.ok) {
      const data = await response.json() as { authorized?: boolean };
      alfAuthorized = data.authorized === true;
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
  await loadPosts();
  if (postsInterval) clearInterval(postsInterval);
  postsInterval = setInterval(loadPosts, 5000);
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
      // signInRedirect navigates away, so nothing below this runs
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

  // Clear active state when user manually edits the time input
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

  formTitle.textContent = 'Edit Post';
  scheduleBtn.textContent = 'Save changes';
  cancelBtn.classList.remove('hidden');

  // Clear preset active state — the loaded time doesn't match a preset
  document.querySelectorAll<HTMLButtonElement>('.btn-preset').forEach(b => b.classList.remove('active'));

  // Scroll the form into view
  formTitle.scrollIntoView({ behavior: 'smooth', block: 'start' });

  renderPosts();
}

function cancelEdit(): void {
  editingUri = null;
  (document.getElementById('post-text') as HTMLTextAreaElement).value = '';
  (document.getElementById('scheduled-at') as HTMLInputElement).value = '';
  document.getElementById('form-title')!.textContent = 'Schedule a Post';
  (document.getElementById('schedule-btn') as HTMLButtonElement).textContent = 'Schedule Post';
  document.getElementById('cancel-edit-btn')!.classList.add('hidden');
  document.querySelectorAll<HTMLButtonElement>('.btn-preset').forEach(b => b.classList.remove('active'));
  renderPosts();
}

// ---------------------------------------------------------------------------
// Schedule / update post
// ---------------------------------------------------------------------------

function wireScheduleButton(): void {
  const btn = document.getElementById('schedule-btn') as HTMLButtonElement;
  const cancelBtn = document.getElementById('cancel-edit-btn') as HTMLButtonElement;

  cancelBtn.addEventListener('click', () => cancelEdit());

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

    btn.textContent = 'Scheduling...';
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (scheduledAtValue) {
      headers['x-scheduled-at'] = new Date(scheduledAtValue).toISOString();
    }

    const record: Record<string, unknown> = {
      $type: 'app.bsky.feed.post',
      text,
      createdAt: new Date().toISOString(),
    };
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

    const data = await response.json() as { uri?: string; error?: string; message?: string };

    if (!response.ok) {
      errEl.textContent = data.error || data.message || 'Failed to schedule post.';
      errEl.classList.remove('hidden');
    } else {
      successEl.textContent = `Post scheduled! URI: ${data.uri || JSON.stringify(data)}`;
      successEl.classList.remove('hidden');
      (document.getElementById('post-text') as HTMLTextAreaElement).value = '';
      (document.getElementById('scheduled-at') as HTMLInputElement).value = '';
      document.querySelectorAll<HTMLButtonElement>('.btn-preset').forEach(b => b.classList.remove('active'));
      imageInput.value = '';
      (document.getElementById('image-preview-wrap') as HTMLElement).classList.add('hidden');
      await loadPosts();
    }
  } catch (err) {
    const errEl2 = document.getElementById('schedule-error') as HTMLElement;
    errEl2.textContent = 'Network error.';
    errEl2.classList.remove('hidden');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Schedule Post';
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
    const updateBody: Record<string, unknown> = {
      uri,
      record: { $type: 'app.bsky.feed.post', text, createdAt: new Date().toISOString() },
    };
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
  } catch (_) {
    listEl.innerHTML = '<div class="empty-state">Error loading posts.</div>';
  }
}

function renderPosts(): void {
  const listEl = document.getElementById('posts-list')!;
  if (!Array.isArray(lastPosts) || lastPosts.length === 0) {
    listEl.innerHTML = '<div class="empty-state">No scheduled posts yet.</div>';
    return;
  }

  listEl.innerHTML = lastPosts.map(post => renderPostCard(post as Record<string, any>)).join('');

  listEl.querySelectorAll('[data-action="publish"]').forEach(btn => {
    btn.addEventListener('click', () => publishPost((btn as HTMLElement).dataset.uri!));
  });
  listEl.querySelectorAll('[data-action="cancel"]').forEach(btn => {
    btn.addEventListener('click', () => cancelPost((btn as HTMLElement).dataset.uri!));
  });
  listEl.querySelectorAll('[data-action="edit"]').forEach(btn => {
    btn.addEventListener('click', () => startEdit((btn as HTMLElement).dataset.uri!));
  });
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

  return `
    <div class="post-item${isEditing ? ' post-item-editing' : ''}">
      <div class="post-item-header">
        <span class="badge ${badgeCls}">${status}</span>
        ${isEditing ? '<span style="font-size:0.72rem;color:var(--indigo);font-weight:600;margin-left:auto;">editing ↑</span>' : ''}
      </div>
      <div class="post-text">${escHtml(preview) || '<em style="color:var(--text-faint)">(no text)</em>'}</div>
      <div class="post-meta">${scheduledTime}</div>
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
  // 1. Fetch ALF URL from /api/config
  try {
    const cfg = await fetch('/api/config').then(r => r.json()) as { alfUrl?: string };
    alfUrl = cfg.alfUrl || '';
  } catch (_) {
    alfUrl = '';
  }

  // 2. Create BrowserOAuthClient.
  // On localhost use the RFC 8252 loopback pattern (no metadata document needed).
  // On a real domain use a hosted client metadata document so the PDS can
  // redirect back to the actual origin instead of 127.0.0.1.
  const isLocalhost = ['localhost', '127.0.0.1'].includes(window.location.hostname);
  let oauthClientMetadata: Parameters<typeof BrowserOAuthClient>[0]['clientMetadata'];
  let allowHttp: boolean;
  if (isLocalhost) {
    const port = window.location.port;
    const redirectUri = `http://127.0.0.1${port ? `:${port}` : ''}/`;
    const clientId = `http://localhost?scope=${encodeURIComponent('atproto transition:generic')}&redirect_uri=${encodeURIComponent(redirectUri)}`;
    oauthClientMetadata = {
      client_id: clientId,
      client_name: 'ALF Demo',
      redirect_uris: [redirectUri],
      scope: 'atproto transition:generic',
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
      scope: 'atproto transition:generic',
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
  wireDeleteAccount();

  // 4. Call client.init() — detects OAuth callback params or restores existing session
  let initResult: { session: OAuthSession; state?: string } | undefined;
  try {
    initResult = await oauthClient.init();
  } catch (_) {
    initResult = undefined;
  }

  if (initResult) {
    session = initResult.session;

    // 5. If session came from an OAuth callback ('state' in result), clean the URL
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

  // 6. Render appropriate view
  await render();
});
