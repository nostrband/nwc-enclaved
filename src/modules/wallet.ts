import { DB } from "./db";
import { OnIncomingPaymentEvent, Phoenixd } from "./phoenixd";
import bolt11 from "bolt11";
import {
  Invoice,
  ListTransactionsReq,
  PAYMENT_FAILED,
  PayInvoiceReq,
  PaymentResult,
  Transaction,
  WalletState,
} from "./types";

export interface FeePolicy {
  getLiquidityFee(): number;
  calcPaymentFee(amount: number, fees_paid: number): number;
  estimateRoutingFee(amount: number, routes: any[]): number;
}

export interface WalletContext {
  phoenix: Phoenixd;
  db: DB;
  fees: FeePolicy;
}

export class Wallet {
  private context: WalletContext;
  private pubkey: string;
  private state: WalletState;
  private pendingPayments = new Map<string, number>();

  constructor(pubkey: string, context: WalletContext, state?: WalletState) {
    this.context = context;
    this.pubkey = pubkey;
    this.state = state || {
      balance: 0,
      channelSize: 0,
      feeCredit: 0,
    };
  }

  public clientPubkey() {
    return this.pubkey;
  }

  private prepareStateSettleInvoice(p: OnIncomingPaymentEvent) {
    const newState = { ...this.state };
    newState.balance = this.state.balance + p.amount;

    if (p.amount > this.state.channelSize) {
      // extend virtual channel by a round number of sats
      const channelExtensionSize = Math.ceil((newState.balance - this.state.channelSize) / 1000) * 1000;
      
      // set new size
      newState.channelSize += channelExtensionSize;

      // set fee credit for channel extension
      newState.feeCredit += channelExtensionSize * this.context.fees.getLiquidityFee();

      // we will spread the payout of feeCredit over this many payment sats
      newState.feeCreditBase += channelExtensionSize;
    }

    return newState;
  }

  private prepareStateSettlePayment(invoice: Invoice, fees: number) {
    return {
      ...this.state,
      balance: this.state.balance - invoice.amount - fees,
    };
  }

  public settleInvoice(p: OnIncomingPaymentEvent) {
    const newState = this.prepareStateSettleInvoice(p);
    const ok = this.context.db.settleInvoice(
      this.pubkey,
      p.externalId!,
      p.settledAt,
      newState
    );
    if (!ok) return;

    this.state = newState;
    console.log(
      new Date(),
      `incoming payment to ${this.pubkey} amount ${
        p.amount
      } sat => state ${JSON.stringify(this.state)}`
    );
  }

  public getBalance(): Promise<{
    balance: number;
  }> {
    return Promise.resolve({
      balance: this.state.balance,
    });
  }

  public listTransactions(
    req: ListTransactionsReq
  ): Promise<{ transactions: Transaction[] }> {
    if (req.clientPubkey !== this.pubkey) throw new Error("Bad client pubkey");
    return Promise.resolve(this.context.db.listTransactions(req));
  }

  public async payInvoice(req: PayInvoiceReq): Promise<PaymentResult> {
    if (req.clientPubkey !== this.pubkey) throw new Error("Bad client pubkey");

    // parse invoice to get amount and paymentHash
    const decoded = bolt11.decode(req.invoice);
    console.log("decoded invoice", decoded);
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
    const feeEstimate = this.context.fees.estimateRoutingFee(invoice.amount, routes);
    // FIXME
    const lockedAmount = invoice.amount;

    // protect against double-entry in our db
    if (this.pendingPayments.has(invoice.payment_hash))
      throw new Error(PAYMENT_FAILED);
    this.pendingPayments.set(invoice.payment_hash, lockedAmount);

    // create payment template
    this.context.db.createPayment(req.clientPubkey, invoice);

    try {
      // pay
      const r = await this.context.phoenix.payInvoice(req);
      if (r.preimage !== preimage) throw new Error("Wrong preimage");

      // done
      this.pendingPayments.delete(invoice.payment_hash);

      // determine fees for this payment
      const fees = this.context.fees.calcPaymentFee(invoice.amount, r.fees_paid || 0);
      const newState = this.prepareStateSettlePayment(invoice, fees);

      // set payment template status to paid and record fee
      this.context.db.settlePayment(
        req.clientPubkey,
        invoice.payment_hash,
        fees,
        newState
      );

      // update state
      this.state = newState;
      console.log(
        new Date(),
        `outgoing payment amount ${
          invoice.amount
        } msat => state ${JSON.stringify(this.state)}`
      );

      // result
      return r;
    } catch (e) {
      // cleanup on error
      this.pendingPayments.delete(invoice.payment_hash);
      this.context.db.deletePayment(req.clientPubkey, invoice.payment_hash);

      // forward it
      throw e;
    }
  }
}
