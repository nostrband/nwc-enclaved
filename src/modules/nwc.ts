import { Nip47Rep, Nip47Req } from "./types";
import { Event } from "nostr-tools";
import { now } from "./utils";
import { KIND_NWC_REPLY, KIND_NWC_REQUEST } from "./consts";
import { Signer } from "./abstract";

export class NWCServer {
  private signer: Signer;

  constructor(signer: Signer) {
    this.signer = signer;
  }

  public getSigner() {
    return this.signer;
  }

  protected async payInvoice(req: Nip47Req, res: Nip47Rep) {
    throw new Error("Method not implemented");
  }

  protected async makeInvoice(req: Nip47Req, res: Nip47Rep) {
    throw new Error("Method not implemented");
  }

  protected async listTransactions(req: Nip47Req, res: Nip47Rep) {
    throw new Error("Method not implemented");
  }

  protected async getBalance(req: Nip47Req, res: Nip47Rep) {
    throw new Error("Method not implemented");
  }

  protected async getInfo(req: Nip47Req, res: Nip47Rep) {
    throw new Error("Method not implemented");
  }

  private async handle(req: Nip47Req, res: Nip47Rep) {
    switch (req.method) {
      case "pay_invoice":
        return this.payInvoice(req, res);
      case "make_invoice":
        return this.makeInvoice(req, res);
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

  private isValidReq(req: Nip47Req, res: Nip47Rep) {
    let valid = false;
    switch (req.method) {
      case "pay_invoice":
        valid = !!req.params.invoice && typeof req.params.invoice === "string";
        break;
      case "make_invoice":
        valid = !!req.params.amount && typeof req.params.amount === "number";
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
        res.error = {
          code: "NOT_IMPLEMENTED",
          message: "Unsupported method",
        };
        return false;
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
    try {
      const expiration = Number(
        e.tags.find((t) => t.length > 1 && t[0] === "expiration")?.[1] || 0
      );
      if (expiration > 0 && expiration < now()) {
        // ignore
        return;
      }
    } catch {}

    const res: Nip47Rep = {
      result_type: "",
      error: null,
      result: null,
    };

    try {
      const data = await this.signer.nip04Decrypt(e.pubkey, e.content);
      const { method, params } = JSON.parse(data);
      if (!method || !params) throw new Error("Bad request");

      // req
      const req: Nip47Req = {
        clientPubkey: e.pubkey,
        id: e.id,
        method,
        params,
      };

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

    return this.signer.signEvent({
      pubkey: await this.signer.getPublicKey(),
      kind: KIND_NWC_REPLY,
      created_at: now(),
      tags: [
        ["p", e.pubkey],
        ["e", e.id],
      ],
      content: await this.signer.nip04Encrypt(e.pubkey, JSON.stringify(res)),
    });
  }
}
