export interface LandingSyncPayload {
  idempotencyKey: string;
  slug: string;
  version: number;
  checksum: string;
  downloadUrl: string;
  /** اگه downloadUrl از IP داخلی Master نرسید */
  downloadUrlFallback?: string;
  formSnapshot?: unknown;
  /** فقط روی همون نود پوش بشه (اختیاری) */
  targetQueue?: string;
}

export type FormSyncAction = 'upsert' | 'delete';

export interface FormSyncPayload {
  idempotencyKey: string;
  action: FormSyncAction;
  key: string;
  form?: {
    id: string;
    title: string;
    key: string;
    slug: string;
    body: unknown;
    webhookUrl?: string | null;
    googleSheetUrl?: string | null;
    googleSheetMeta?: unknown;
    otpEnabled?: boolean | null;
    otpField?: string | null;
    otpTemplate?: string | null;
  };
}

export interface FormSubmissionSyncPayload {
  idempotencyKey: string;
  submissionId: string;
  formKey: string;
  edgeNodeId?: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
