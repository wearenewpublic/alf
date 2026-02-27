// ABOUTME: Prometheus metrics for ALF (Atproto Latency Fabric) service monitoring

import { Registry, Gauge, Counter, Histogram, collectDefaultMetrics } from 'prom-client';

// Create a custom registry for this service
export const registry = new Registry();

// Collect default Node.js metrics (memory, CPU, event loop, etc.)
collectDefaultMetrics({
  register: registry,
  prefix: 'alf_',
});

// ============================================================================
// DRAFT OPERATION METRICS
// ============================================================================

export const draftsCreatedTotal = new Counter({
  name: 'alf_drafts_created_total',
  help: 'Total drafts created',
  labelNames: ['collection'] as const,
  registers: [registry],
});

export const draftsUpdatedTotal = new Counter({
  name: 'alf_drafts_updated_total',
  help: 'Total drafts updated',
  registers: [registry],
});

export const draftsCancelledTotal = new Counter({
  name: 'alf_drafts_cancelled_total',
  help: 'Total drafts cancelled',
  registers: [registry],
});

// ============================================================================
// BLOB STORAGE METRICS
// ============================================================================

export const blobsStoredTotal = new Counter({
  name: 'alf_blobs_stored_total',
  help: 'Total blobs stored in the ALF blob store',
  registers: [registry],
});

export const blobSizeBytes = new Histogram({
  name: 'alf_blob_size_bytes',
  help: 'Distribution of stored blob sizes in bytes',
  buckets: [1024, 10240, 102400, 512000, 1048576, 2097152, 5242880],
  registers: [registry],
});

// ============================================================================
// SCHEDULER METRICS
// ============================================================================

export const schedulerWakeupsTotal = new Counter({
  name: 'alf_scheduler_wakeups_total',
  help: 'Total scheduler wakeup polls',
  registers: [registry],
});

export const schedulerPublishesTotal = new Counter({
  name: 'alf_scheduler_publishes_total',
  help: 'Total publish attempts',
  labelNames: ['result'] as const, // 'success', 'retry', 'failed', 'skipped'
  registers: [registry],
});

export const publishDurationSeconds = new Histogram({
  name: 'alf_publish_duration_seconds',
  help: 'Duration of individual draft publish operations in seconds',
  buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60],
  registers: [registry],
});

// ============================================================================
// AUTHENTICATION METRICS
// ============================================================================

export const authVerificationsTotal = new Counter({
  name: 'alf_auth_verifications_total',
  help: 'Total authentication verification attempts',
  labelNames: ['result'] as const, // 'success', 'failure'
  registers: [registry],
});

// ============================================================================
// HTTP SERVER METRICS
// ============================================================================

export const httpRequestsTotal = new Counter({
  name: 'alf_http_requests_total',
  help: 'Total HTTP requests',
  labelNames: ['method', 'endpoint', 'status_code'] as const,
  registers: [registry],
});

export const httpRequestDuration = new Histogram({
  name: 'alf_http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'endpoint'] as const,
  buckets: [0.001, 0.005, 0.01, 0.05, 0.1, 0.5, 1, 2, 5, 10],
  registers: [registry],
});

// ============================================================================
// SYSTEM HEALTH METRICS
// ============================================================================

export const serverState = new Gauge({
  name: 'alf_server_state',
  help: 'Server state (0=down, 1=up)',
  registers: [registry],
});

export const startupTimestamp = new Gauge({
  name: 'alf_startup_timestamp',
  help: 'Unix timestamp of last server startup',
  registers: [registry],
});
