import { MessageEvent, WebSocket } from "ws";
import { DEFAULT_EXPIRY, PHOENIX_PORT } from "./consts";
import {
  Invoice,
  MakeInvoiceReq,
  PAYMENT_FAILED,
  PayInvoiceReq,
  PaymentResult,
} from "./types";
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

export interface OnIncomingPaymentEvent {
  amount: number;
  paymentHash: string;
  settledAt: number;
  externalId?: string;
}

export type OnIncomingPayment = (p: OnIncomingPaymentEvent) => Promise<void>;

export class Phoenixd {
  private password?: string;
  private ws?: WebSocket;
  private onOpen?: () => void;
  private onIncomingPayment?: OnIncomingPayment;

  constructor() {}

  public async start({
    password,
    onIncomingPayment,
    onOpen,
  }: {
    password: string;
    onIncomingPayment: OnIncomingPayment;
    onOpen: () => void;
  }) {
    this.password = password;
    this.onIncomingPayment = onIncomingPayment;
    this.onOpen = onOpen;
    this.subscribe();
  }

  private subscribe() {
    this.ws = new WebSocket(`http://127.0.0.1:${PHOENIX_PORT}/websocket`, {
      headers: {
        Authorization: this.getAuth(),
      },
    });
    this.ws.onopen = () => {
      console.log(new Date(), "phoenixd websocket connected");
      this.onOpen!();
    };
    this.ws.onclose = async () => {
      console.log(new Date(), "phoenixd websocket closed");
      await new Promise((ok) => setTimeout(ok, 1000));
      console.log(new Date(), "phoenixd restarting");
      this.subscribe();
    };
    this.ws.onerror = (e: any) => {
      console.log(new Date(), "phoenixd websocket error", e);
    };
    this.ws.onmessage = (e: MessageEvent) => {
      this.onMessage(e.data as string);
    };
  }

  private terminate() {
    if (this.ws && this.ws.readyState !== WebSocket.CLOSED) {
      console.log(new Date(), "phoenixd closing");
      this.ws.close();
      this.ws = undefined;
    }
  }

  private async onMessage(data: string) {
    try {
      const m = JSON.parse(data);
      if (m.type === "payment_received") {
        const p: OnIncomingPaymentEvent = {
          amount: m.amountSat * 1000,
          paymentHash: m.paymentHash,
          settledAt: m.settledAt,
          externalId: m.externalId,
        };
        p.settledAt = now();
        await this.onIncomingPayment!(p);
      }
    } catch (e) {
      console.log(new Date(), "phoenixd bad message", data, e);
      this.terminate();
    }
  }

  private getAuth() {
    const auth = Buffer.from(":" + this.password).toString("base64");
    return `Basic ${auth}`;
  }

  private async call<Type>(
    httpMethod: "GET" | "POST",
    method: string,
    params: any,
    err?: string
  ) {
    console.log(new Date(), "phoenixd call", method, params);
    let url = `http://127.0.0.1:${PHOENIX_PORT}/${method}`;
    let body = undefined;
    if (httpMethod === "GET")
      url += "?" + new URLSearchParams(params).toString();
    else body = new URLSearchParams(params);

    const rep = await fetch(url, {
      method: httpMethod,
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: this.getAuth(),
      },
      body,
    });
    console.log(new Date(), "phoenixd call reply", method, rep);
    if (rep.status !== 200) throw new Error(err || "Failed to call " + method);
    const res = (await rep.json()) as Type;
    console.log(new Date(), "phoenixd call result", method, res);
    return res;
  }

  public async makeInvoice(id: string, req: MakeInvoiceReq): Promise<Invoice> {
    const expiry = req.expiry || DEFAULT_EXPIRY;
    const params: MakeInvoiceRequest = {
      amountSat: "" + Math.ceil(req.amount / 1000),
      externalId: id,
      expirySeconds: "" + expiry,
    };
    if (req.description) params.description = req.description;
    if (req.description_hash) params.descriptionHash = req.description_hash;

    const r = await this.call<MakeInvoiceReply>(
      "POST",
      "createinvoice",
      params
    );
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

    const r = await this.call<PayInvoiceReply>(
      "POST",
      "payinvoice",
      params,
      PAYMENT_FAILED
    );
    return {
      preimage: r.paymentPreimage,
      fees_paid: r.routingFeeSat * 1000,
    };
  }

  public async syncPaymentsSince(fromSec: number) {
    console.log(new Date(), "phoenixd sync from", fromSec);
    const payments = await this.call<
      {
        externalId?: string;
        completedAt: number;
        receivedSat: number;
        paymentHash: string;
      }[]
    >("GET", "payments/incoming", { from: fromSec * 1000 });
    for (const p of payments) {
      console.log(new Date(), "phoenixd sync incoming payment", p);
      this.onIncomingPayment!({
        amount: p.receivedSat * 1000,
        paymentHash: p.paymentHash,
        settledAt: Math.round(p.completedAt / 1000),
        externalId: p.externalId,
      });
    }
  }
}
