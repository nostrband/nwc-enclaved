import { DB } from "./db";
import { Phoenixd } from "./phoenixd";
import bolt11 from "bolt11";
import {
  Invoice,
  ListTransactionsReq,
  PAYMENT_FAILED,
  PayInvoiceReq,
  PaymentResult,
  Transaction,
} from "./types";

export class Wallet {
  private phoenix: Phoenixd;
  private db: DB;
  private pubkey: string;
  private balance: number = 0;
  private pendingPayments = new Map<string, number>();

  constructor(pubkey: string, phoenix: Phoenixd, db: DB) {
    this.phoenix = phoenix;
    this.db = db;
    this.pubkey = pubkey;
  }

  public clientPubkey() {
    return this.pubkey;
  }

  public getBalance(): Promise<{
    balance: number;
  }> {
    return Promise.resolve({
      balance: this.balance,
    });
  }

  public listTransactions(
    req: ListTransactionsReq
  ): Promise<{ transactions: Transaction[] }> {
    if (req.clientPubkey !== this.pubkey) throw new Error("Bad client pubkey");
    // FIXME select txs from db
    return {};
  }

  private calcFees(invoice: Invoice, payment: PaymentResult) {
    // FIXME calc properly
    return payment.fees_paid!;
  }

  public async payInvoice(req: PayInvoiceReq): Promise<PaymentResult> {
    if (req.clientPubkey !== this.pubkey) throw new Error("Bad client pubkey");

    // parse invoice to get amount and paymentHash
    const decoded = bolt11.decode(req.invoice);
    const invoice: Invoice = {
      type: "incoming",
      invoice: "",
      amount: req.amount || Number(decoded.millisatoshis),
      payment_hash: decoded.tagsObject.payment_hash!,
      description: decoded.tagsObject.description,
      description_hash: decoded.tagsObject.purpose_commit_hash,
      created_at: decoded.timestamp!,
      expires_at: decoded.timestamp! + decoded.timeExpireDate!,
    };

    const preimage = decoded.tagsObject.payment_secret;
    if (!invoice.payment_hash) throw new Error("Invalid invoice");
    if (!invoice.amount) throw new Error("Empty amount");
    if (invoice.amount % 1000 > 0)
      throw new Error("Msat payments not supported");

    // check if client has enough balance
    // FIXME
    const lockedAmount = invoice.amount;

    // protect against double-entry in our db
    if (this.pendingPayments.has(invoice.payment_hash))
      throw new Error(PAYMENT_FAILED);
    this.pendingPayments.set(invoice.payment_hash, lockedAmount);

    // create payment template
    this.db.createPayment(req.clientPubkey, invoice);

    try {
      // pay
      const r = await this.phoenix.payInvoice(req);
      if (r.preimage !== preimage) throw new Error("Wrong preimage");

      // done
      this.pendingPayments.delete(invoice.payment_hash);

      // determine fees for this payment
      const fees = this.calcFees(invoice, r);

      // set payment template status to paid and record fee
      this.db.completePayment(req.clientPubkey, invoice.payment_hash, fees);

      // update balance
      this.balance -= invoice.amount;
      this.balance -= fees;

      // result
      return r;
    } catch (e) {
      // cleanup on error
      this.pendingPayments.delete(invoice.payment_hash);
      this.db.deletePayment(req.clientPubkey, invoice.payment_hash);

      // forward it
      throw e;
    }
  }
}
