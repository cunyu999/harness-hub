import type { TaskSnapshot } from '../../../packages/contracts/src/events';
import type { ArtifactDto, ProfileDto, ReviewBundle, SessionDto, TaskListItem } from '../../../packages/contracts/src/api';
import type { EventEnvelope } from '../../../packages/contracts/src/events';
import type { ExecutionProfile, TaskRecord } from '../../../packages/contracts/src/types';

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: unknown;
  correlationId?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: ApiErrorBody,
  ) {
    super(body.message || `HTTP ${status}`);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    const body = (json ?? { code: 'http_error', message: text }) as ApiErrorBody;
    throw new ApiError(res.status, body);
  }
  return json as T;
}

export type TaskDetail = Omit<TaskSnapshot, 'profiles' | 'artifacts'> & {
  artifacts: ArtifactDto[];
  profiles: ProfileDto[];
  /** 任务工作区绝对路径。 */
  workspace: string;
};

export interface ArchiveEntryDto {
  taskId: string;
  title: string | null;
  objective: string | null;
  archivedAt: string | null;
  fileCount: number;
  totalBytes: number;
  hasManifest: boolean;
}

export interface HealthInfo {
  ok: boolean;
  version: string;
  uptimeSeconds: number;
  liveSessions: number;
  adapters: { id: string; displayName: string; mock: boolean }[];
}

export interface ProbeResponse {
  result: {
    ok: boolean;
    mode: string;
    checkedAt: string;
    executableResolved: string;
    version?: string;
    protocol?: string;
    detail?: string;
    capability?: { capabilities: Record<string, { state: string; evidence?: string }>; notes?: string[] };
    warnings?: string[];
  };
  home?: { dir: string; copied: string[]; warnings: string[]; sourceHome?: string | null };
}

export const api = {
  health: () => request<HealthInfo>('GET', '/api/health'),
  listTasks: () => request<(TaskListItem & { artifactCount?: number })[]>('GET', '/api/tasks'),
  deleteTask: (id: string, keepArtifacts = true) =>
    request<{ ok: boolean; archivedDir: string | null; files: number; removedEvents: number }>(
      'DELETE',
      `/api/tasks/${id}?keepArtifacts=${keepArtifacts ? 1 : 0}`,
    ),
  getTask: (id: string) => request<TaskDetail>('GET', `/api/tasks/${id}`),
  listArchives: () => request<{ entries: ArchiveEntryDto[] }>('GET', '/api/archive'),
  deleteArchive: (taskId: string) =>
    request<{ ok: boolean; removedFiles: number; removedBytes: number }>('DELETE', `/api/archive/${taskId}`),
  createTask: (input: Record<string, unknown>) => request<{ task: TaskRecord; snapshot: TaskSnapshot }>('POST', '/api/tasks', input),
  requestPlan: (id: string, reason: string, supplement?: string) =>
    request<{ status: string }>('POST', `/api/tasks/${id}/plan`, { reason, supplement }),
  planDecision: (id: string, body: Record<string, unknown>) =>
    request<{ decision: string; task: TaskRecord }>('POST', `/api/tasks/${id}/plan-decisions`, body),
  fsList: (path?: string | null) =>
    request<{
      path: string | null;
      parent: string | null;
      entries: { name: string; path: string; isDir: boolean }[];
      roots: { label: string; path: string }[];
      error?: string;
    }>('GET', `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ''}`),
  /** 打开 Windows 自带的文件夹选择框(在宿主机上弹), 取消时 path 为 null。 */
  pickDirectory: (initial?: string | null) =>
    request<{ path: string | null }>('POST', '/api/fs/pick-directory', { initial: initial ?? null }),
  uploadAttachment: (taskId: string, file: { name: string; dataBase64: string; mediaType?: string }) =>
    request<{
      name: string;
      path: string;
      relativePath: string;
      mediaType: string;
      size: number;
      isImage: boolean;
    }>('POST', `/api/tasks/${taskId}/attachments`, file),
  sendMessage: (
    id: string,
    body: {
      text: string;
      intent: string;
      participantId?: string | null;
      attachments?: {
        name: string;
        path: string;
        relativePath: string;
        mediaType: string;
        size: number;
        isImage: boolean;
      }[];
    },
  ) =>
    request<{ messageId: string }>('POST', `/api/tasks/${id}/messages`, body),
  updateParticipant: (
    id: string,
    participantId: string,
    body: { workspaceRoot?: string | null; sandbox?: string | null },
  ) =>
    request<{ ok: boolean; participant: Record<string, unknown> }>(
      'PATCH',
      `/api/tasks/${id}/participants/${participantId}`,
      body,
    ),
  control: (id: string, action: string, sessionId?: string, reason?: string) =>
    request<{ status: string }>('POST', `/api/tasks/${id}/controls`, {
      action,
      targetSessionId: sessionId,
      reason,
    }),
  events: (id: string, after: number) =>
    request<{ events: EventEnvelope[]; highWaterSeq: number }>('GET', `/api/tasks/${id}/events?format=json&after=${after}`),
  reviews: (id: string) => request<ReviewBundle>('GET', `/api/tasks/${id}/reviews`),
  artifacts: (id: string) => request<ArtifactDto[]>('GET', `/api/tasks/${id}/artifacts`),
  session: (id: string) => request<SessionDto>('GET', `/api/sessions/${id}`),
  cancelSession: (id: string) => request<{ status: string }>('POST', `/api/sessions/${id}/cancel`),
  resolveApproval: (id: string, body: Record<string, unknown>) =>
    request<{ status: string }>('POST', `/api/approvals/${id}/resolve`, body),
  listProfiles: () => request<ProfileDto[]>('GET', '/api/profiles'),
  createProfile: (body: Record<string, unknown>) => request<ProfileDto>('POST', '/api/profiles', body),
  patchProfile: (id: string, body: Record<string, unknown>) => request<ProfileDto>('PATCH', `/api/profiles/${id}`, body),
  deleteProfile: (id: string, hard = false) =>
    request<{ ok: boolean; deleted: boolean }>('DELETE', `/api/profiles/${id}${hard ? '?hard=1' : ''}`),
  probeProfile: (id: string, mode: 'inspect' | 'live') =>
    request<ProbeResponse>('POST', `/api/profiles/${id}/probe`, { mode }),
  capabilities: () => request<{ id: string; displayName: string; mock: boolean }[]>('GET', '/api/adapters'),
  /** 页面存活心跳: 服务靠它判断网页还在不在。 */
  heartbeat: () => request<UiRuntimeStatus>('POST', '/api/runtime/heartbeat', {}),
  runtime: () => request<UiRuntimeStatus>('GET', '/api/runtime'),
  /** 页面即将关闭: 让服务在 grace 之后自行停止(刷新页面会被新心跳取消)。 */
  closeIntent: () => request<{ scheduled: boolean; delayMs: number | null; reason?: string }>(
    'POST',
    '/api/runtime/close-intent',
    {},
  ),
};

export interface UiRuntimeStatus {
  exitOnUiClose: boolean;
  lastHeartbeatAgoMs: number | null;
  pendingStopInMs: number | null;
  activeSessions: number;
  stopped: boolean;
  pageSeen: boolean;
}

export type { ExecutionProfile, TaskSnapshot, EventEnvelope, ProfileDto, ArtifactDto, ReviewBundle };
