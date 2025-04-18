import bolt11 from "bolt11";
import {
  INSUFFICIENT_BALANCE,
  Invoice,
  ListTransactionsReq,
  OnIncomingPaymentEvent,
  PAYMENT_FAILED,
  PayInvoiceReq,
  PaymentResult,
  RATE_LIMITED,
  RouteHop,
  Transaction,
  WalletState,
} from "./types";
import { WalletContext } from "./abstract";
import { MAX_CONCURRENT_PAYMENTS } from "./consts";

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

  private prepareStateSettleInvoice(amount: number) {
    const newState = { ...this.state };

    // always put the full received amount on the balance
    newState.balance = this.state.balance + amount;

    // we might need to pay some mining fees for auto-liquidity
    let miningFee = 0;

    // need to extend our virtual channel?
    if (newState.balance > this.state.channelSize) {
      // extend virtual channel by a round number of sats
      const channelExtensionAmount =
        Math.ceil((newState.balance - this.state.channelSize) / 1000) * 1000;

      // set new size
      newState.channelSize += channelExtensionAmount;

      // auto-liquidity service fee
      newState.feeCredit += Math.ceil(
        channelExtensionAmount * this.context.fees.getLiquidityServiceFeeRate()
      );

      // calc mining fee separately to return it to caller
      miningFee = Math.ceil(
        channelExtensionAmount *
          this.context.fees.calcMiningFeeMsat(channelExtensionAmount)
      );

      // add mining fee to wallet's fee credit
      newState.feeCredit += miningFee;
    }

    return { newState, miningFee };
  }

  private prepareStateSettlePayment(
    amount: number,
    totalFee: number,
    phoenixFee: number
  ): WalletState {
    const ourFee = totalFee - phoenixFee;
    return {
      channelSize: this.state.channelSize,
      balance: this.state.balance - amount - totalFee,
      feeCredit: this.state.feeCredit - ourFee,
    };
  }

  public settleInvoice(invoice: Invoice, p: OnIncomingPaymentEvent) {
    // prepare new state and calc miningFee
    const { newState, miningFee } = this.prepareStateSettleInvoice(
      invoice.amount
    );

    // settle as an atomic tx in db
    const ok = this.context.db.settleInvoice(
      this.pubkey,
      p.externalId!,
      p.settledAt,
      newState,
      miningFee
    );

    // !ok if invoice was already settled
    if (!ok) return;

    // new wallet state
    this.state = newState;

    // account for mining fee received from this wallet
    this.context.fees.addMiningFeeReceived(miningFee);

    console.log(
      new Date(),
      `incoming payment to ${this.pubkey} amount ${
        invoice.amount
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

  private parseBolt11(bolt11str: string, amount?: number) {
    // parse invoice to get amount and paymentHash
    const decoded = bolt11.decode(bolt11str);
    if (!decoded.complete) throw new Error("Incomplete invoice");

    console.log("decoded invoice", decoded);
    console.log("tagsObject", decoded.tagsObject);
    const invoice: Invoice = {
      type: "incoming",
      invoice: "",
      amount: amount || Number(decoded.millisatoshis),
      payment_hash: decoded.tagsObject.payment_hash!,
      description: decoded.tagsObject.description,
      description_hash: decoded.tagsObject.purpose_commit_hash,
      created_at: decoded.timestamp!,
      expires_at: decoded.timestamp! + decoded.timeExpireDate!,
    };

    const preimage = decoded.tagsObject.payment_secret;

    const route: RouteHop[] =
      decoded.tagsObject.routing_info?.map((r) => ({
        baseFee: r.fee_base_msat,
        ppmFee: r.fee_proportional_millionths,
      })) || [];

    return {
      invoice,
      preimage,
      route,
    };
  }

  // NOTE: this is the only mutating method that can be called in
  // parallel by many threads, we should take great care about
  // avoiding races, especially btw different wallets. Right now
  // there's basically only 1 async call to phoenix - need
  // to keep it this way.
  public async payInvoice(req: PayInvoiceReq): Promise<PaymentResult> {
    if (req.clientPubkey !== this.pubkey) throw new Error("Bad client pubkey");

    if (this.pendingPayments.size > MAX_CONCURRENT_PAYMENTS)
      throw new Error(RATE_LIMITED);

    // parse bolt11 string
    const { invoice, preimage, route } = this.parseBolt11(
      req.invoice,
      req.amount
    );

    if (!invoice.payment_hash) throw new Error("Invalid invoice");
    if (!invoice.amount) throw new Error("Empty amount");
    if (invoice.amount % 1000 > 0)
      throw new Error("Msat payments not supported");

    // already paying this?
    if (this.pendingPayments.has(invoice.payment_hash))
      throw new Error(PAYMENT_FAILED);

    // check if client has enough balance,
    // take the prescribed route into account to make sure
    // we aren't attacked with huge-fee routes that we wouldn't estimate
    // NOTE: this is upper-bound estimate if several payments are going
    // in parallel bcs both will use the same feeCredit value,
    // later when settled one fee will be deduced from feeCredit
    // first and the next payment will have lower actual fee
    const feeEstimate = this.context.fees.estimatePaymentFeeMsat(
      this.state,
      invoice.amount,
      route
    );

    // amount we're locking for this payment
    const lockAmount = invoice.amount + feeEstimate;

    // =======================================
    // NOTE: this section must be **sync**
    // to make sure other concurrent payments can't
    // overspend by racing with this payment
    (() => {
      // already locked by other payments
      const lockedAmount = [...this.pendingPayments.values()].reduce(
        (s, l) => s + l,
        0
      );

      // not enough balance if we include pending payments?
      if (lockAmount + lockedAmount > this.state.balance)
        throw new Error(INSUFFICIENT_BALANCE);
    })();
    // =======================================

    // add this payment to pending
    this.pendingPayments.set(invoice.payment_hash, lockAmount);

    // create payment placeholder
    this.context.db.createPayment(req.clientPubkey, invoice);

    try {
      // pay
      const r = await this.context.phoenix.payInvoice(req);
      if (r.preimage !== preimage) throw new Error("Wrong preimage");

      // done
      this.pendingPayments.delete(invoice.payment_hash);

      // paid to phoenix
      const phoenixFee = r.fees_paid || 0;

      // determine fees for this payment
      const totalFee = this.context.fees.calcPaymentFeeMsat(
        this.state,
        invoice.amount,
        phoenixFee
      );

      // new wallet state accounting for payment and fees
      const newState = this.prepareStateSettlePayment(
        invoice.amount,
        totalFee,
        phoenixFee
      );

      // settle payment - set status to paid and update the wallet state
      this.context.db.settlePayment(
        req.clientPubkey,
        invoice.payment_hash,
        totalFee,
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

      if (this.state.balance < this.state.feeCredit) {
        console.error(
          new Date(),
          "negative wallet balance",
          this.pubkey,
          JSON.stringify(this.state)
        );
      }

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
