import { Event } from "nostr-tools";
import { Signer } from "./abstract";
import { isValidZapRequest } from "./nostr";
import { NWCServerBase } from "./nwc-base";
import { NWCReply, NWCRequest, NWC_PAYMENT_FAILED } from "./nwc-types";
import { Wallets } from "./wallets";

// forward NWC calls to wallets
export class NWCServer extends NWCServerBase {
  private wallets: Wallets;

  constructor(opts: {
    signer: Signer;
    wallets: Wallets;
    onNotify: (event: Event) => Promise<void>;
  }) {
    super(opts.signer, opts.onNotify);
    this.wallets = opts.wallets;
  }

  protected async addPubkey(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = this.wallets.addPubkey({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async getBalance(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await this.wallets.getBalance(req.clientPubkey);
  }

  protected async getInfo(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await this.wallets.getInfo(req.clientPubkey);
  }

  protected async listTransactions(
    req: NWCRequest,
    res: NWCReply
  ): Promise<void> {
    res.result = await this.wallets.listTransactions({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async lookupInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await this.wallets.lookupInvoice({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async makeInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await this.wallets.makeInvoice({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async makeInvoiceFor(
    req: NWCRequest,
    res: NWCReply
  ): Promise<void> {
    if (!req.params.pubkey) throw new Error("Pubkey not specified");
    if (
      req.params.zap_request &&
      !isValidZapRequest(
        req.params.zap_request,
        req.params.amount,
        this.getSigner().getPublicKey()
      )
    )
      throw new Error("Invalid zap request");
    if (req.params.zap_request)
      console.log("valid zap request", req.params.zap_request);

    res.result = await this.wallets.makeInvoiceFor({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async payInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    try {
      res.result = await this.wallets.payInvoice({
        ...req.params,
        clientPubkey: req.clientPubkey,
      });
    } catch (e) {
      if (e === NWC_PAYMENT_FAILED) {
        res.error = {
          code: NWC_PAYMENT_FAILED,
          message: "Payment failed",
        };
      } else {
        throw e;
      }
    }
  }
}
