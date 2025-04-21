import {
  MakeInvoiceBackendReq,
  OnIncomingPaymentEvent,
  WalletContext,
} from "./abstract";
import { DEFAULT_EXPIRY } from "./consts";
import {
  NWC_INSUFFICIENT_BALANCE,
  NWCInvoice,
  NWCListTransactionsReq,
  NWCMakeInvoiceForReq,
  MakeInvoiceReq,
  NWCPayInvoiceReq,
  NWCPaymentResult,
  NWCTransaction,
} from "./nwc-types";
import { Wallet } from "./wallet";

export type OnZapReceipt = (zapRequest: string, bolt11: string, preimage: string) => void;

export class Wallets {
  private context: WalletContext;
  private wallets = new Map<string, Wallet>();
  private adminPubkey?: string;
  private onZapReceipt?: OnZapReceipt;

  constructor(context: WalletContext) {
    this.context = context;
  }

  public start(adminPubkey: string, onZapReceipt: OnZapReceipt) {
    this.adminPubkey = adminPubkey;
    this.onZapReceipt = onZapReceipt;

    const wallets = this.context.db.listWallets();
    for (const w of wallets) {
      this.wallets.set(w.pubkey, new Wallet(w.pubkey, this.context, w.state));
      console.log("wallet state", w.pubkey, JSON.stringify(w.state));
    }
  }

  public onIncomingPayment(payment: OnIncomingPaymentEvent) {
    if (!payment.externalId) {
      console.log(new Date(), "unknown incoming payment", payment);
      return;
    }
    const { clientPubkey, invoice, zapRequest } =
      this.context.db.getInvoiceById(payment.externalId!) || {};
    if (!clientPubkey || !invoice) {
      console.log("skip unknown invoice", payment.externalId);
      return;
    }

    let w = this.wallets.get(clientPubkey);
    if (!w) {
      w = new Wallet(clientPubkey, this.context);
      this.wallets.set(clientPubkey, w);
    }

    const ok = w.settleInvoice(invoice, payment);
    if (ok && zapRequest) this.onZapReceipt!(zapRequest, invoice.invoice, payment.preimage);
  }

  public getInfo(clientPubkey: string): Promise<{
    alias: string;
    color: string;
    pubkey: string;
    network: string;
    block_height: number;
    block_hash: string;
    methods: string[];
    notifications: string[];
  }> {
    if (!this.adminPubkey) throw new Error("No admin pubkey");
    return Promise.resolve({
      alias: this.adminPubkey,
      color: "000000",
      pubkey:
        "000000000000000000000000000000000000000000000000000000000000000000",
      // FIXME ask phoenix itself!
      network: "mainnet",
      block_height: 1,
      block_hash:
        "000000000000000000000000000000000000000000000000000000000000000000",
      methods: [
        "pay_invoice",
        "get_balance",
        "make_invoice",
        "list_transactions",
        "get_info",
      ],
      notifications: [], // "payment_received", "payment_sent"
    });
  }

  public getBalance(clientPubkey: string): Promise<{
    balance: number;
  }> {
    const w = this.wallets.get(clientPubkey);
    return w
      ? w.getBalance()
      : Promise.resolve({
          balance: 0,
        });
  }

  public listTransactions(req: NWCListTransactionsReq): Promise<{
    transactions: NWCTransaction[];
  }> {
    const w = this.wallets.get(req.clientPubkey);
    if (!w) return Promise.resolve({ transactions: [] });
    return w.listTransactions(req);
  }

  public async makeInvoice(req: MakeInvoiceReq): Promise<NWCInvoice> {
    return this.makeInvoiceExt(req, req.clientPubkey);
  }

  public async makeInvoiceFor(req: NWCMakeInvoiceForReq): Promise<NWCInvoice> {
    return this.makeInvoiceExt(req, req.clientPubkey, req.zap_request);
  }

  private async makeInvoiceExt(
    req: MakeInvoiceReq,
    pubkey: string,
    zapRequest?: string
  ): Promise<NWCInvoice> {
    if (req.amount < 1000 || (req.amount % 1000) > 0) throw new Error("Only sat payments are supported");

    const id = this.context.db.createInvoice(pubkey);
    try {
      const w = this.wallets.get(pubkey);

      // make sure empty wallets only create short-lived
      // invoices to avoid db explosion
      if (!w) req.expiry = DEFAULT_EXPIRY;

      const backendReq: MakeInvoiceBackendReq = {
        amount: req.amount,
        description: req.description,
        descriptionHash: req.description_hash,
        expiry: req.expiry,
        zapRequest,
      };

      const invoice = await this.context.backend.makeInvoice(id, backendReq);
      this.context.db.completeInvoice(id, invoice, zapRequest);
      return invoice;
    } catch (e) {
      // cleanup on error
      this.context.db.deleteInvoice(id);

      // forward it
      throw e;
    }
  }

  public payInvoice(req: NWCPayInvoiceReq): Promise<NWCPaymentResult> {
    const w = this.wallets.get(req.clientPubkey);
    if (!w) throw new Error(NWC_INSUFFICIENT_BALANCE);
    return w.payInvoice(req);
  }
}
