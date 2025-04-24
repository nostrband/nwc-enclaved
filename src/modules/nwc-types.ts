// NOTE: clientPubkey field is added to many NWC types to simplify
// passing the client's identity

export const NWC_INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE";
export const NWC_PAYMENT_FAILED = "PAYMENT_FAILED";
export const NWC_RATE_LIMITED = "RATE_LIMITED";

export type NWCErrorCode =
  | "INSUFFICIENT_BALANCE"
  | "RATE_LIMITED"
  | "NOT_IMPLEMENTED"
  | "QUOTA_EXCEEDED"
  | "RESTRICTED"
  | "UNAUTHORIZED"
  | "INTERNAL"
  | "OTHER"
  | "PAYMENT_FAILED"
  | "NOT_FOUND";

export type NWCTxType = "incoming" | "outgoing";

export interface NWCRequest {
  clientPubkey: string;
  id: string;
  method: string;
  params: any;
}

export interface NWCReply {
  result_type: string;
  error: null | {
    code: NWCErrorCode;
    message: string;
  };
  result: null | any;
}

export interface NWCListTransactionsReq {
  clientPubkey: string;
  from?: number;
  until?: number;
  limit?: number;
  offset?: number;
  unpaid?: boolean;
  type?: NWCTxType;
}

export interface NWCTransaction {
  type: NWCTxType;
  description?: string;
  description_hash?: string;
  preimage?: string;
  payment_hash: string;
  amount: number;
  fees_paid: number;
  created_at: number;
  expires_at?: number;
  settled_at?: number;
  metadata: any;
}

export interface MakeInvoiceReq {
  clientPubkey: string;
  amount: number;
  description?: string;
  description_hash?: string;
  expiry?: number;
}

export interface NWCMakeInvoiceForReq {
  clientPubkey: string;
  pubkey: string;
  amount: number;
  description?: string;
  description_hash?: string;
  expiry?: number;
  zap_request?: string;
}

export interface NWCInvoice {
  type: "incoming";
  invoice: string;
  description?: string;
  description_hash?: string;
  payment_hash: string;
  amount: number;
  created_at: number;
  expires_at: number;
}

export interface NWCPayInvoiceReq {
  clientPubkey: string;
  invoice: string;
  amount?: number; // msat
}

export interface NWCPaymentResult {
  preimage: string;
  fees_paid?: number;
}
