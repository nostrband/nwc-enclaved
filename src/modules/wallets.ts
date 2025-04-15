import { CHAIN } from "./consts";
import { DB } from "./db";
import { Phoenixd } from "./phoenixd";
import { INSUFFICIENT_BALANCE, Invoice, ListTransactionsReq, MakeInvoiceReq, PayInvoiceReq, PaymentResult, Transaction } from "./types";
import { Wallet } from "./wallet";

export class Wallets {
  private phoenixd: Phoenixd;
  private db: DB;
  private wallets = new Map<string, Wallet>();
  private adminPubkey?: string;

  constructor(phoenixd: Phoenixd, db: DB) {
    this.phoenixd = phoenixd;
    this.db = db;
  }

  public setAdminPubkey(adminPubkey: string) {
    this.adminPubkey = adminPubkey;
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
      network: CHAIN,
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
    const id = this.db.createInvoice(req.clientPubkey);
    const invoice = await this.phoenixd.makeInvoice(id, req);
    this.db.completeInvoice(id, invoice);
    return invoice;
  }

  public payInvoice(req: PayInvoiceReq): Promise<PaymentResult> {
    const w = this.wallets.get(req.clientPubkey);
    if (!w) throw new Error(INSUFFICIENT_BALANCE);
    return w.payInvoice(req);
  }
}
