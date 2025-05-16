import {
  InvoiceInfo,
  MakeInvoiceBackendReq,
  OnIncomingPaymentEvent,
  WalletContext,
} from "./abstract";
import {
  MAX_ANON_INVOICES,
  MAX_ANON_INVOICE_EXPIRY,
  MAX_INVOICES,
  MAX_INVOICE_EXPIRY,
  MAX_WALLETS,
  PHOENIX_AUTO_LIQUIDITY_AMOUNT,
} from "./consts";
import {
  NWC_INSUFFICIENT_BALANCE,
  NWCInvoice,
  NWCListTransactionsReq,
  NWCMakeInvoiceForReq,
  MakeInvoiceReq,
  NWCPayInvoiceReq,
  NWCPaymentResult,
  NWCTransaction,
  NWC_RATE_LIMITED,
  NWCLookupInvoiceReq,
  NWC_NOT_FOUND,
} from "./nwc-types";
import { now } from "./utils";
import { Wallet } from "./wallet";

export type OnZapReceipt = (
  zapRequest: string,
  bolt11: string,
  preimage: string
) => void;

export class Wallets {
  private context: WalletContext;
  private wallets = new Map<string, Wallet>();
  private onZapReceipt?: OnZapReceipt;
  private adminPubkey?: string;
  private allowedPubkeys = new Set<string>();

  constructor(
    context: WalletContext,
    opts: { onZapReceipt: OnZapReceipt; adminPubkey?: string }
  ) {
    this.context = context;
    this.onZapReceipt = opts.onZapReceipt;
    this.adminPubkey = opts.adminPubkey;

    const wallets = this.context.db.listWallets();
    for (const w of wallets) {
      this.wallets.set(w.pubkey, new Wallet(w.pubkey, this.context, w.state));
      console.log("wallet state", w.pubkey, JSON.stringify(w.state));
    }
  }

  public addPubkey(req: { clientPubkey: string; targetPubkey: string }) {
    if (!this.adminPubkey) throw new Error("Not supported");
    if (this.adminPubkey !== req.clientPubkey) throw new Error("Disallowed");
    this.allowedPubkeys.add(req.clientPubkey);
  }

  // NOTE: must be sync to avoid races
  public onIncomingPayment(payment: OnIncomingPaymentEvent) {
    if (!payment.externalId) {
      console.log(new Date(), "unknown incoming payment", payment);
      return;
    }
    const { clientPubkey, invoice, isPaid, zapRequest } =
      this.context.db.getInvoiceInfo({ id: payment.externalId! }) || {};
    if (!clientPubkey || !invoice) {
      console.log("skip unknown invoice", payment.externalId);
      return;
    }

    if (isPaid) {
      console.log("skip settled invoice", payment.externalId);
      return;
    }

    let w = this.wallets.get(clientPubkey);
    if (!w) {
      w = new Wallet(clientPubkey, this.context);
      this.wallets.set(clientPubkey, w);
    }

    const ok = w.settleInvoice(invoice, payment);
    if (ok && zapRequest)
      this.onZapReceipt!(zapRequest, invoice.invoice, payment.preimage);
  }

  public async getInfo(clientPubkey: string): Promise<{
    alias: string;
    color: string;
    pubkey: string;
    network: string;
    block_height: number;
    // block_hash: string;
    methods: string[];
    notifications: string[];
  }> {
    const info = await this.context.backend.getInfo();
    return {
      alias: this.context.serviceSigner.getPublicKey(),
      color: "000000",
      pubkey: info.nodeId,
      network: info.chain,
      block_height: info.blockHeight,
      // block_hash:
      //   "000000000000000000000000000000000000000000000000000000000000000000",
      methods: [
        "pay_invoice",
        "get_balance",
        "make_invoice",
        "list_transactions",
        "get_info",
      ],
      notifications: [], // "payment_received", "payment_sent"
    };
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

  public lookupInvoice(req: NWCLookupInvoiceReq): Promise<NWCTransaction> {
    const tx = this.context.db.lookupInvoice(req);
    if (!tx) throw new Error(NWC_NOT_FOUND);
    return Promise.resolve(tx);
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
    return this.makeInvoiceExt(req, req.pubkey, req.zap_request);
  }

  private async makeInvoiceExt(
    req: MakeInvoiceReq,
    pubkey: string,
    zapRequest?: string
  ): Promise<NWCInvoice> {
    // only make invoices for allowed pubkeys
    if (this.adminPubkey && !this.allowedPubkeys.has(pubkey))
      throw new Error("Disallowed");

    // only rounded sats payments
    if (req.amount < 1000 || req.amount % 1000 > 0)
      throw new Error("Only sat payments are supported");

    const isService = pubkey === this.context.serviceSigner.getPublicKey();
    // limit invoice size
    if (!isService) {
      if (req.amount > this.context.maxBalance)
        throw new Error("Max invoice size exceeded");
    }

    // make sure there is at least one channel first,
    // service operator should topup the backend
    if (!isService) {
      const info = await this.context.backend.getInfo();
      if (!info.channels.length)
        throw new Error("Service not available, no liquidity");
    }

    // get target wallet
    const w = this.wallets.get(pubkey);

    // limit the number of wallets
    if (!w && this.wallets.size >= MAX_WALLETS)
      throw new Error("No new wallets allowed");

    // limit total balance
    if (!isService) {
      if (w && w.getState().balance + req.amount > this.context.maxBalance)
        throw new Error("Wallet balance would exceed max balance");
    }

    // internal wallet?
    if (this.context.enclavedInternalWallet) {
      // only 2m sats allowed for internal wallet,
      // otherwise we need to enable liquidity fees
      const totalBalance = [...this.wallets.values()]
        .map((w) => w.getState().balance)
        .reduce((a, c) => a + c, 0);
      if (totalBalance + req.amount > PHOENIX_AUTO_LIQUIDITY_AMOUNT)
        throw new Error("Max node balance exceeded");
    }

    // max unpaid invoices
    const counts = this.context.db.countUnpaidInvoices();
    if (counts.anons >= (w ? MAX_INVOICES : MAX_ANON_INVOICES))
      throw new Error(NWC_RATE_LIMITED);

    const id = this.context.db.createInvoice(pubkey);
    try {
      // make sure empty wallets only create short-lived
      // invoices to avoid db explosion
      req.expiry = Math.min(
        req.expiry || MAX_ANON_INVOICE_EXPIRY, // default
        w ? MAX_INVOICE_EXPIRY : MAX_ANON_INVOICE_EXPIRY // max
      );

      // backend req
      const backendReq: MakeInvoiceBackendReq = {
        amount: req.amount,
        description: req.description,
        descriptionHash: req.description_hash,
        expiry: req.expiry,
        zapRequest,
      };

      // create invoice on the backend
      const invoice = await this.context.backend.makeInvoice(id, backendReq);

      // commit to db
      const anon = !w;
      this.context.db.completeInvoice(id, invoice, zapRequest, anon);
      return invoice;
    } catch (e) {
      // cleanup on error
      this.context.db.deleteInvoice(id);

      // forward it
      throw e;
    }
  }

  private async payInternal(
    req: NWCPayInvoiceReq,
    info: InvoiceInfo
  ): Promise<NWCPaymentResult> {
    if (req.clientPubkey === info.clientPubkey)
      throw new Error("Self-payment not supported");

    const from = this.wallets.get(req.clientPubkey);
    if (!from) throw new Error("No payment wallet");

    this.context.db.startTx();
    try {
      const r = await from.payInvoice(req, async (req: NWCPayInvoiceReq) => {
        console.log("internal payment of", req.invoice);
        this.onIncomingPayment({
          firstLiquidityPayment: false,
          paymentHash: info.invoice.payment_hash,
          externalId: info.id,
          settledAt: now(),
          preimage: "",
        });

        return {
          preimage: "-", // make some validators happier
          fees_paid: 0,
        };
      });
      this.context.db.commitTx();
      return r;
    } catch (e) {
      this.context.db.rollbackTx();
      console.log("internal payment failed", e);
      throw e;
    }
  }

  public payInvoice(req: NWCPayInvoiceReq): Promise<NWCPaymentResult> {
    if (req.clientPubkey === this.context.serviceSigner.getPublicKey())
      throw new Error("Service pubkey can't send payments");
    const w = this.wallets.get(req.clientPubkey);
    if (!w) throw new Error(NWC_INSUFFICIENT_BALANCE);

    // NOTE: we're not handling internal _public_ payments yet bcs
    // phoenixd doesn't let us destroy an unpaid invoice,
    // which means we could accept internal payment and
    // external payment on the same invoice and there's
    // no way to prevent that from happening. Leave it
    // for later.
    const info = this.context.db.getInvoiceInfo({ invoice: req.invoice });
    if (this.context.enclavedInternalWallet && info) {
      // internal payment
      return this.payInternal(req, info);
    } else {
      // external payment
      return w.payInvoice(req);
    }
  }

  public chargeWalletFee(pubkey: string) {
    const w = this.wallets.get(pubkey);
    if (!w) throw new Error("Failed to find wallet for payment fee");
    w.chargeWalletFee();
  }
}
