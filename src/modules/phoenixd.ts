import { DEFAULT_EXPIRY, PHOENIX_PORT } from "./consts";
import { Invoice, MakeInvoiceReq, PAYMENT_FAILED, PayInvoiceReq, PaymentResult } from "./types";
import { now } from "./utils";

interface PayInvoiceRequest {
  invoice: string;
  amountSat?: string;
}

interface PayInvoiceReply {
  recipientAmountSat: number;
  routingFeeSat: number;
  paymentId: string;
  paymentHash: string;
  paymentPreimage: string;
}

interface MakeInvoiceRequest {
  amountSat: string;
  externalId: string;
  expirySeconds: string;
  description?: string;
  descriptionHash?: string;
}

interface MakeInvoiceReply {
  amountSat: number;
  paymentHash: string;
  serialized: string;
}

export class Phoenixd {
  private password: string;

  constructor() {
    // FIXME read http-password= from HOME_PATH/.phoenix/phoenix.conf
    this.password = "123";
  }

  public async makeInvoice(
    id: string,
    req: MakeInvoiceReq
  ): Promise<Invoice> {
    const expiry = req.expiry || DEFAULT_EXPIRY;
    const params: MakeInvoiceRequest = {
      amountSat: "" + Math.ceil(req.amount / 1000),
      externalId: id,
      expirySeconds: "" + expiry,
    };
    if (req.description) params.description = req.description;
    if (req.description_hash) params.descriptionHash = req.description_hash;

    const rep = await fetch(`http://127.0.0.1:${PHOENIX_PORT}/createinvoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params as any),
    });
    console.log("makeInvoiceFor reply", params, rep);
    if (rep.status !== 200) throw new Error("Failed to make invoice");

    const r = (await rep.json()) as MakeInvoiceReply;
    const created_at = now();
    return {
      type: "incoming",
      amount: r.amountSat * 1000,
      created_at,
      expires_at: created_at + expiry,
      invoice: r.serialized,
      payment_hash: r.paymentHash,
      description: req.description,
      description_hash: req.description_hash,
    };
  }

  public async payInvoice(req: PayInvoiceReq): Promise<PaymentResult> {
    const params: PayInvoiceRequest = {
      invoice: req.invoice,
    };
    if (req.amount) params.amountSat = "" + Math.ceil(req.amount / 1000);

    const rep = await fetch(`http://127.0.0.1:${PHOENIX_PORT}/payinvoice`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams(params as any),
    });
    console.log("payInvoice reply", params, rep);
    if (rep.status !== 200) throw new Error(PAYMENT_FAILED);

    const r = (await rep.json()) as PayInvoiceReply;
    return {
      preimage: r.paymentPreimage,
      fees_paid: r.routingFeeSat,
    };
  }
}
