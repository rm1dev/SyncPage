export interface LandingSyncPayload {
  idempotencyKey: string;
  slug: string;
  version: number;
  checksum: string;
  downloadUrl: string;
  /** اگه downloadUrl از IP داخلی Master نرسید */
  downloadUrlFallback?: string;
  /** شناسه عملیات برای نمایش روند استقرار در پنل Master */
  operationId?: string;
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
    category?: string | null;
    key: string;
    slug: string;
    body: unknown;
    webhookUrl?: string | null;
    googleSheetUrl?: string | null;
    googleSheetMeta?: unknown;
    otpEnabled?: boolean | null;
    otpField?: string | null;
    otpTemplate?: string | null;
    otpLength?: number | null;
    sendUtmToWebhook?: boolean | null;
    sendUtmToSheet?: boolean | null;
    paymentEnabled?: boolean | null;
    productIds?: string[] | null;
  };
}

export interface FormSubmissionSyncPayload {
  idempotencyKey: string;
  submissionId: string;
  formKey: string;
  edgeNodeId?: string;
  payload: Record<string, unknown>;
  otpStatus: 'NOT_REQUIRED' | 'UNVERIFIED' | 'VERIFIED';
  syncVersion: number;
  createdAt: string;
  verifiedAt?: string | null;
  payment?: {
    id: string;
    productId: string;
    amount: number;
    status: 'PENDING' | 'COMPLETED' | 'FAILED' | 'REVERSED';
    payCode?: string | null;
    refId?: string | null;
    clientRefId?: string | null;
    cardNumber?: string | null;
    cardHashPan?: string | null;
    errorMessage?: string | null;
    verifiedAt?: string | null;
  } | null;
}
