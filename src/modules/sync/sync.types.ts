export interface LandingSyncPayload {
  idempotencyKey: string;
  slug: string;
  version: number;
  checksum: string;
  downloadUrl: string;
  formSnapshot?: unknown;
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
  };
}

export interface FormSubmissionSyncPayload {
  idempotencyKey: string;
  submissionId: string;
  formKey: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
