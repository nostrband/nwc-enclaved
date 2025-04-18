import { WalletContext } from "./abstract";
import { DEFAULT_EXPIRY } from "./consts";
import {
  INSUFFICIENT_BALANCE,
  Invoice,
  ListTransactionsReq,
  MakeInvoiceReq,
  OnIncomingPaymentEvent,
  PayInvoiceReq,
  PaymentResult,
  Transaction,
} from "./types";
import { Wallet } from "./wallet";

export class Wallets {
  private context: WalletContext;
  private wallets = new Map<string, Wallet>();
  private adminPubkey?: string;

  constructor(context: WalletContext) {
    this.context = context;
  }

  public start(adminPubkey: string) {
    this.adminPubkey = adminPubkey;

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
    const { clientPubkey, invoice } = this.context.db.getInvoiceById(payment.externalId!) || {};
    if (!clientPubkey || !invoice) {
      console.log("skip unknown invoice", payment.externalId);
      return;
    }

    let w = this.wallets.get(clientPubkey);
    if (!w) {
      w = new Wallet(clientPubkey, this.context);
      this.wallets.set(clientPubkey, w);
    }
    w.settleInvoice(invoice, payment);
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

  public listTransactions(req: ListTransactionsReq): Promise<{
    transactions: Transaction[];
  }> {
    const w = this.wallets.get(req.clientPubkey);
    if (!w) return Promise.resolve({ transactions: [] });
    return w.listTransactions(req);
  }

  public async makeInvoice(req: MakeInvoiceReq): Promise<Invoice> {
    const id = this.context.db.createInvoice(req.clientPubkey);
    try {
      const w = this.wallets.get(req.clientPubkey);

      // make sure empty wallets only create short-lived
      // invoices to avoid db explosion
      if (!w) req.expiry = DEFAULT_EXPIRY;

      const invoice = await this.context.phoenix.makeInvoice(id, req);
      this.context.db.completeInvoice(id, invoice);
      return invoice;
    } catch (e) {
      // cleanup on error
      this.context.db.deleteInvoice(id);

      // forward it
      throw e;
    }
  }

  public payInvoice(req: PayInvoiceReq): Promise<PaymentResult> {
    const w = this.wallets.get(req.clientPubkey);
    if (!w) throw new Error(INSUFFICIENT_BALANCE);
    return w.payInvoice(req);
  }
}
