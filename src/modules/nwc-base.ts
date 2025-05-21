import { NWCReply, NWCRequest } from "./nwc-types";
import { Event } from "nostr-tools";
import { now } from "./utils";
import {
  KIND_NWC_NOTIFICATION,
  KIND_NWC_REPLY,
  KIND_NWC_REQUEST,
  NWC_SUPPORTED_METHODS,
} from "./consts";
import { Signer } from "./abstract";

export class NWCServerBase {
  private signer: Signer;
  private onNotify: (event: Event) => Promise<void>;
  private done = new Set<string>();

  constructor(signer: Signer, onNotify: (event: Event) => Promise<void>) {
    this.signer = signer;
    this.onNotify = onNotify;
  }

  public getSigner() {
    return this.signer;
  }

  protected async addPubkey(req: NWCRequest, res: NWCReply) {
    throw new Error("Method not implemented");
  }

  protected async payInvoice(req: NWCRequest, res: NWCReply) {
    throw new Error("Method not implemented");
  }

  protected async makeInvoice(req: NWCRequest, res: NWCReply) {
    throw new Error("Method not implemented");
  }

  protected async makeInvoiceFor(req: NWCRequest, res: NWCReply) {
    throw new Error("Method not implemented");
  }

  protected async listTransactions(req: NWCRequest, res: NWCReply) {
    throw new Error("Method not implemented");
  }

  protected async lookupInvoice(req: NWCRequest, res: NWCReply) {
    throw new Error("Method not implemented");
  }

  protected async getBalance(req: NWCRequest, res: NWCReply) {
    throw new Error("Method not implemented");
  }

  protected async getInfo(req: NWCRequest, res: NWCReply) {
    throw new Error("Method not implemented");
  }

  private async handle(req: NWCRequest, res: NWCReply) {
    switch (req.method) {
      case "add_pubkey":
        return this.addPubkey(req, res);
      case "pay_invoice":
        return this.payInvoice(req, res);
      case "make_invoice":
        return this.makeInvoice(req, res);
      case "make_invoice_for":
        return this.makeInvoiceFor(req, res);
      case "lookup_invoice":
        return this.lookupInvoice(req, res);
      case "list_transactions":
        return this.listTransactions(req, res);
      case "get_balance":
        return this.getBalance(req, res);
      case "get_info":
        return this.getInfo(req, res);
      default:
        throw new Error("Invalid method");
    }
  }

  private isValidReq(req: NWCRequest, res: NWCReply) {
    let valid = false;
    if (!NWC_SUPPORTED_METHODS.includes(req.method)) {
      res.error = {
        code: "NOT_IMPLEMENTED",
        message: "Unsupported method",
      };
      return false;
    }

    switch (req.method) {
      case "get_balance":
        valid = true;
        break;
      case "add_pubkey":
        valid =
          !!req.params.pubkey &&
          typeof req.params.pubkey === "string" &&
          req.params.pubkey.length === 64;
        break;
      case "pay_invoice":
        valid = !!req.params.invoice && typeof req.params.invoice === "string";
        break;
      case "make_invoice":
        valid = !!req.params.amount && typeof req.params.amount === "number";
        break;
      case "make_invoice_for":
        valid =
          !!req.params.amount &&
          typeof req.params.amount === "number" &&
          !!req.params.pubkey &&
          typeof req.params.pubkey === "string" &&
          req.params.pubkey.length === 64;
        break;
      case "lookup_invoice":
        valid =
          (!!req.params.payment_hash &&
            typeof req.params.payment_hash === "string") ||
          (!!req.params.invoice && typeof req.params.invoice === "string");
        break;
      case "list_transactions":
        valid = true;
        break;
      case "get_balance":
        valid = true;
        break;
      case "get_info":
        valid = true;
        break;
      default:
        // dev error
        throw new Error("Supported method not implemented");
    }

    if (!valid) {
      res.error = {
        code: "OTHER",
        message: "Invalid request",
      };
    }

    return valid;
  }

  // process event tagging pubkey
  public async process(e: Event): Promise<Event | undefined> {
    if (e.kind !== KIND_NWC_REQUEST) return; // ignore irrelevant kinds
    if (this.done.has(e.id)) return;
    this.done.add(e.id);

    try {
      const expiration = Number(
        e.tags.find((t) => t.length > 1 && t[0] === "expiration")?.[1] || 0
      );
      if (expiration > 0 && expiration < now()) {
        // ignore
        return;
      }
    } catch {}

    const res: NWCReply = {
      result_type: "",
      error: null,
      result: null,
    };

    try {
      const data = await this.signer.nip04Decrypt(e.pubkey, e.content);
      const { method, params } = JSON.parse(data);
      if (!method || !params) throw new Error("Bad request");

      // req
      const req: NWCRequest = {
        clientPubkey: e.pubkey,
        id: e.id,
        method,
        params,
      };
      console.log(new Date(), "nwc request", req);

      // res
      res.result_type = method;

      if (this.isValidReq(req, res)) {
        await this.handle(req, res);
      }
      console.log(new Date(), "processed", req, res);
    } catch (err: any) {
      console.log("Bad event ", err, e);
      res.error = {
        code: "INTERNAL",
        message: err.message || err.toString(),
      };
    }

    console.log(new Date(), "nwc reply", res);
    return this.signer.signEvent({
      pubkey: this.signer.getPublicKey(),
      kind: KIND_NWC_REPLY,
      created_at: now(),
      tags: [
        ["p", e.pubkey],
        ["e", e.id],
      ],
      content: await this.signer.nip04Encrypt(e.pubkey, JSON.stringify(res)),
    });
  }

  public async notify(
    clientPubkey: string,
    notification_type: string,
    notification: any
  ) {
    const data = {
      notification_type,
      notification,
    };
    const event = await this.signer.signEvent({
      pubkey: this.signer.getPublicKey(),
      kind: KIND_NWC_NOTIFICATION,
      created_at: now(),
      tags: [["p", clientPubkey]],
      content: await this.signer.nip04Encrypt(
        clientPubkey,
        JSON.stringify(data)
      ),
    });
    this.onNotify(event);
  }
}
