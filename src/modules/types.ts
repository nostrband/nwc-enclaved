export const INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE";
export const PAYMENT_FAILED = "PAYMENT_FAILED";
export const RATE_LIMITED = "RATE_LIMITED";

export type ErrorCode =
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

export type TxType = "incoming" | "outgoing";

// NOTE: do not rename, part of NWC
export interface Nip47Req {
  clientPubkey: string;
  id: string;
  method: string;
  params: any;
}

// NOTE: do not rename, part of NWC
export interface Nip47Rep {
  result_type: string;
  error: null | {
    code: ErrorCode;
    message: string;
  };
  result: null | any;
}

// NOTE: do not rename, part of NWC
export interface ListTransactionsReq {
  clientPubkey: string;
  from?: number;
  until?: number;
  limit?: number;
  offset?: number;
  unpaid?: boolean;
  type?: TxType;
}

// NOTE: do not rename, part of NWC
export interface Transaction {
  type: TxType;
  description?: string;
  description_hash?: string;
  preimage?: string;
  payment_hash: string;
  amount: number;
  fees_paid: number;
  created_at: number;
  expires_at?: number;
  settled_at?: number;
}

// NOTE: do not rename, part of NWC
export interface MakeInvoiceReq {
  clientPubkey: string;
  amount: number;
  description?: string;
  description_hash?: string;
  expiry?: number;
}

// NOTE: do not rename, part of NWC
export interface Invoice {
  type: "incoming";
  invoice: string;
  description?: string;
  description_hash?: string;
  payment_hash: string;
  amount: number;
  created_at: number;
  expires_at: number;
}

// NOTE: do not rename, part of NWC
export interface PayInvoiceReq {
  clientPubkey: string;
  invoice: string;
  amount?: number; // msat
}

// NOTE: do not rename, part of NWC
export interface PaymentResult {
  preimage: string;
  fees_paid?: number;
}

export interface WalletState {
  balance: number;
  channelSize: number;
  feeCredit: number;
}

export interface OnIncomingPaymentEvent {
  paymentHash: string;
  settledAt: number;
  externalId?: string;
}

export interface RouteHop {
  baseFee: number;
  ppmFee: number;
}