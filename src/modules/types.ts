import { Event, UnsignedEvent } from "nostr-tools";

export interface Signer {
  getPublicKey(): string;

  signEvent(event: UnsignedEvent): Promise<Event>;

  nip04Encrypt(pubkey: string, data: string): Promise<string>;

  nip04Decrypt(pubkey: string, data: string): Promise<string>;

  // nip44Encrypt(pubkey: string, data: string): Promise<string>;

  // nip44Decrypt(pubkey: string, data: string): Promise<string>;
}

export interface Nip47Req {
  clientPubkey: string;
  id: string;
  method: string;
  params: any;
}

export const INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE";
export const PAYMENT_FAILED = "PAYMENT_FAILED";

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

export interface Nip47Rep {
  result_type: string;
  error: null | {
    code: ErrorCode;
    message: string;
  };
  result: null | any;
}

export interface ListTransactionsReq {
  clientPubkey: string;
  from?: number;
  until?: number;
  limit?: number;
  offset?: number;
  unpaid?: boolean;
  type?: "incoming" | "outgoing";
}

export interface Transaction {
  type: "incoming" | "outgoing";
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

export interface MakeInvoiceReq {
  clientPubkey: string;
  amount: number;
  description?: string;
  description_hash?: string;
  expiry?: number;
}

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

export interface PayInvoiceReq {
  clientPubkey: string;
  invoice: string;
  amount?: number; // msat
}

export interface PaymentResult {
  preimage: string;
  fees_paid?: number;
}