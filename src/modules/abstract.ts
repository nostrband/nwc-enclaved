import { Event, UnsignedEvent } from "nostr-tools";
import {
  NWCInvoice,
  NWCListTransactionsReq,
  NWCPayInvoiceReq,
  NWCPaymentResult,
  NWCTransaction,
} from "./nwc-types";
import { EnclavedClient } from "./enclaved-client";

export interface WalletState {
  balance: number;
  channelSize: number;
  feeCredit: number;
}

export interface OnIncomingPaymentEvent {
  paymentHash: string;
  preimage: string;
  settledAt: number;
  externalId?: string;
  firstLiquidityPayment: boolean;
}

export interface RouteHop {
  baseFee: number;
  ppmFee: number;
}

export interface IFeePolicy {
  // liquidity fees:

  // 0.01 by Phoenix
  getLiquidityServiceFeeRate(): number;

  // how much we'll charge to cover our mining fees paid
  calcMiningFeeMsat(channelExtensionAmount: number): number;

  // when we reserve mining fee on incoming payments
  addMiningFeeReceived(amount: number): void;

  // when we're charged on new liquidity by Phoenix
  addMiningFeePaid(amount: number): void;

  // getter
  getMiningFeePaid(): number;

  // estimate before making a payment
  estimatePaymentFeeMsat(
    wallet: WalletState,
    amount: number,
    route: RouteHop[]
  ): number;

  // calc actual payment fee, normally should coincide with the estimate
  calcPaymentFeeMsat(
    wallet: WalletState,
    amount: number,
    fees_paid: number
  ): number;
}

export interface MakeInvoiceBackendReq {
  amount: number;
  expiry?: number;
  description?: string;
  descriptionHash?: string;
  zapRequest?: string;
}

export interface BackendInfo {
  nodeId: string;
  chain: string;
  blockHeight: number;
  channels: {
    state: string;
    channelId: string;
    balance: number;
    inboundLiquidity: number;
    capacity: number;
    fundingTxId: string;
  }[];
}

export interface IBackend {
  getInfo(): Promise<BackendInfo>;
  getInfoSync(): BackendInfo | undefined;
  makeInvoice(id: string, req: MakeInvoiceBackendReq): Promise<NWCInvoice>;
  payInvoice(req: NWCPayInvoiceReq): Promise<NWCPaymentResult>;
  syncPaymentsSince(fromSec: number): Promise<void>;
}

export interface InvoiceInfo {
  clientPubkey: string;
  id: string;
  invoice: NWCInvoice;
  preimage: string;
  isPaid: boolean;
  zapRequest?: string;
}

export interface IDB {
  startTx(): void;
  commitTx(): void;
  rollbackTx(): void;
  getFees(): { miningFeeReceived: number; miningFeePaid: number };
  listWallets(): {
    pubkey: string;
    state: WalletState;
  }[];
  clearOldTxs(until: number): void;
  clearExpiredInvoices(): void;
  getNextWalletFeePubkey(servicePubkey: string): string | undefined;
  chargeWalletFee(pubkey: string): void;
  countUnpaidInvoices(): { anons: number; wallets: number };
  createInvoice(clientPubkey: string): string;
  deleteInvoice(id: string): void;
  completeInvoice(
    id: string,
    invoice: NWCInvoice,
    zapRequest?: string,
    anon?: boolean
  ): void;
  lookupInvoice(opt: {
    paymentHash?: string;
    invoice?: string;
  }): NWCTransaction | undefined;
  getInvoiceInfo(opt: {
    id?: string;
    paymentHash?: string;
    invoice?: string;
  }): InvoiceInfo | undefined;
  settleInvoice(
    clientPubkey: string,
    payment: OnIncomingPaymentEvent,
    walletState: WalletState,
    miningFee: number
  ): boolean;
  createPayment(clientPubkey: string, invoice: NWCInvoice): string;
  deletePayment(clientPubkey: string, paymentHash: string): void;
  settlePayment(
    clientPubkey: string,
    paymentHash: string,
    preimage: string,
    feesPaid: number,
    walletState: WalletState
  ): void;
  getTransaction(id: string): NWCTransaction | undefined;
  listTransactions(req: NWCListTransactionsReq): {
    total_count: number;
    transactions: NWCTransaction[];
  };
  getLastInvoiceSettledAt(): number;
  getStats(servicePubkey: string): {
    payments: number;
    paymentsHour: number;
    wallets: number;
    walletsHour: number;
    totalBalance: number;
    totalFeeCredit: number;
  };
}

export interface WalletContext {
  serviceSigner: Signer;
  backend: IBackend;
  db: IDB;
  fees: IFeePolicy;
  enclavedInternalWallet?: boolean;
  relays: string[];
  maxBalance: number;
  enclaved?: EnclavedClient;
}

export type OnIncomingPayment = (p: OnIncomingPaymentEvent) => Promise<void>;
export type OnMiningFeeEstimate = (
  miningFee: number,
  serviceFee: number
) => void;
// returns true if this is the first paid fee
export type OnLiquidityFee = (fee: number) => Promise<boolean>;

export interface Signer {
  getPublicKey(): string;

  signEvent(event: UnsignedEvent): Promise<Event>;

  nip04Encrypt(pubkey: string, data: string): Promise<string>;

  nip04Decrypt(pubkey: string, data: string): Promise<string>;

  nip44Encrypt(pubkey: string, data: string): Promise<string>;

  nip44Decrypt(pubkey: string, data: string): Promise<string>;
}
