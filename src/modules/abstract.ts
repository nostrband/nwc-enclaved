import { Event, UnsignedEvent } from "nostr-tools";
import {
  Invoice,
  ListTransactionsReq,
  MakeInvoiceReq,
  OnIncomingPaymentEvent,
  PayInvoiceReq,
  PaymentResult,
  RouteHop,
  Transaction,
  WalletState,
} from "./types";

export interface IFeePolicy {
  // liquidity fees:

  // 0.01 by Phoenix
  getLiquidityServiceFeeRate(): number;

  // how much we'll charge to cover our mining fees paid
  calcMiningFeeMsat(channelExtensionAmount: number): number;

  // when we take our fee on outgoing payment
  addMiningFeeReceived(amount: number): void;

  // when we're charged on new liquidity by Phoenix
  addMiningFeePaid(amount: number): void;

  // estimate before making a payment
  estimatePaymentFeeMsat(wallet: WalletState, amount: number, route: RouteHop[]): number;

  // calc actual payment fee, normally should coincide with the estimate
  calcPaymentFeeMsat(wallet: WalletState, amount: number, fees_paid: number): number;

}

export interface IPhoenixd {
  makeInvoice(id: string, req: MakeInvoiceReq): Promise<Invoice>;
  payInvoice(req: PayInvoiceReq): Promise<PaymentResult>;
  syncPaymentsSince(fromSec: number): Promise<void>;
}

export interface IDB {
  getFees(): { miningFeeReceived: number; miningFeePaid: number };

  listWallets(): {
    pubkey: string;
    state: WalletState;
  }[];

  createInvoice(clientPubkey: string): string;
  deleteInvoice(id: string): void;
  completeInvoice(id: string, invoice: Invoice): void;
  getInvoiceById(
    id: string
  ): { invoice: Invoice; clientPubkey: string } | undefined;
  settleInvoice(
    clientPubkey: string,
    id: string,
    settledAt: number,
    walletState: WalletState,
    miningFee: number
  ): boolean;

  createPayment(clientPubkey: string, invoice: Invoice): void;
  deletePayment(clientPubkey: string, paymentHash: string): void;
  settlePayment(
    clientPubkey: string,
    paymentHash: string,
    feesPaid: number,
    walletState: WalletState
  ): void;
  listTransactions(req: ListTransactionsReq): {
    transactions: Transaction[];
  };
  getLastInvoiceSettledAt(): number;
}

export interface WalletContext {
  phoenix: IPhoenixd;
  db: IDB;
  fees: IFeePolicy;
}

export type OnIncomingPayment = (p: OnIncomingPaymentEvent) => Promise<void>;
export type OnMiningFeeEstimate = (miningFee: number, serviceFee: number) => void;
export type OnLiquidityFee = (fee: number) => Promise<void>;

export interface Signer {
  getPublicKey(): string;

  signEvent(event: UnsignedEvent): Promise<Event>;

  nip04Encrypt(pubkey: string, data: string): Promise<string>;

  nip04Decrypt(pubkey: string, data: string): Promise<string>;
}
