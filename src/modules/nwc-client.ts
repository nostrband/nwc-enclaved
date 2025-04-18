import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import { Event, finalizeEvent, getPublicKey } from "nostr-tools";
import { Relay } from "./relay";
import { Nip04 } from "./nip04";
import { now } from "./utils";
import { Invoice, PaymentResult, Transaction } from "./types";
import { KIND_NWC_REPLY, KIND_NWC_REQUEST } from "./consts";

const nip04 = new Nip04();

interface WalletInfo {
  alias: string;
  color: string;
  pubkey: string;
  network: "mainnet" | "testnet" | "signet" | "regtest";
  block_height: number;
  block_hash: string;
  methods: string[];
  notifications: string[];
}

interface NWCWallet {
  getInfo(): Promise<WalletInfo>;

  getBalance(): Promise<{ balance: number }>;

  payInvoice(params: {
    invoice: string;
    amount?: number;
  }): Promise<PaymentResult>;

  makeInvoice(params: {
    amount: number;
    description?: string;
    description_hash?: string;
    expiry?: number;
  }): Promise<Invoice>;

  makeInvoiceFor(params: {
    pubkey: string;
    amount: number;
    description?: string;
    description_hash?: string;
    expiry?: number;
  }): Promise<Invoice>;

  listTransactions(params: {
    from?: number;
    until?: number;
    limit?: number;
    offset?: number;
    unpaid?: boolean;
    type?: "incoming" | "outgoing";
  }): Promise<{
    transactions: Transaction;
  }>;
}

export class Nip47Client implements NWCWallet {
  private relay: Relay;
  private walletPubkey?: string;

  private privkey?: Uint8Array;
  private pending = new Map<
    string,
    {
      ok: (result: any) => void;
      err: (e: any) => void;
    }
  >();

  constructor({
    relayUrl,
    walletPubkey,
    privkey,
  }: {
    relayUrl: string;
    walletPubkey?: string;
    privkey?: Uint8Array;
  }) {
    this.relay = new Relay(relayUrl);
    this.walletPubkey = walletPubkey;
    this.privkey = privkey;
  }

  public getRelay() {
    return this.relay;
  }

  public async send<Type>({
    method,
    params,
    timeout = 30000,
  }: {
    method: string;
    params: any;
    timeout?: number;
  }): Promise<Type> {
    if (!this.privkey || !this.walletPubkey) throw new Error("Not started");

    const req = {
      method,
      params,
    };

    const event = finalizeEvent(
      {
        created_at: Math.floor(Date.now() / 1000),
        kind: KIND_NWC_REQUEST,
        content: await nip04.encrypt(
          this.privkey,
          this.walletPubkey,
          JSON.stringify(req)
        ),
        tags: [["p", this.walletPubkey]],
      },
      this.privkey
    );
    console.log("sending", event);
    await this.relay.publish(event);

    return new Promise<Type>((ok, err) => {
      this.pending.set(event.id, { ok, err });
      setTimeout(() => {
        const cbs = this.pending.get(event.id);
        if (cbs) {
          this.pending.delete(event.id);
          cbs.err("Request timeout");
        }
      }, timeout);
    });
  }

  private async onReplyEvent(e: Event) {
    if (e.kind !== KIND_NWC_REPLY) return;
    const { result_type, error, result } = JSON.parse(
      await nip04.decrypt(this.privkey!, this.walletPubkey!, e.content)
    );
    const id = e.tags.find((t) => t.length > 1 && t[0] === "e")?.[1];
    console.log("reply", { id, result_type, result, error });
    if (!id) return;

    const cbs = this.pending.get(id);
    if (!cbs) return;
    this.pending.delete(id);

    if (error) cbs.err(error);
    else cbs.ok(result);
  }

  private subscribe() {
    this.relay.req({
      fetch: false,
      id: bytesToHex(randomBytes(6)),
      filter: {
        kinds: [KIND_NWC_REPLY],
        authors: [this.walletPubkey!],
        "#p": [getPublicKey(this.privkey!)],
        since: now() - 10,
      },
      onEvent: this.onReplyEvent.bind(this),
    });
  }

  public start() {
    this.subscribe();
  }

  getBalance(): Promise<{ balance: number }> {
    return this.send<{ balance: number }>({
      method: "get_balance",
      params: {},
    });
  }

  getInfo(): Promise<WalletInfo> {
    return this.send<WalletInfo>({
      method: "get_info",
      params: {},
    });
  }

  listTransactions(params: {
    from?: number | undefined;
    until?: number | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    unpaid?: boolean | undefined;
    type?: "incoming" | "outgoing" | undefined;
  }): Promise<{ transactions: Transaction }> {
    return this.send<{ transactions: Transaction }>({
      method: "list_transactions",
      params,
    });
  }

  makeInvoice(params: {
    amount: number;
    description?: string | undefined;
    description_hash?: string | undefined;
    expiry?: number | undefined;
  }): Promise<Invoice> {
    return this.send<Invoice>({
      method: "make_invoice",
      params,
    });
  }

  makeInvoiceFor(params: {
    pubkey: string;
    amount: number;
    description?: string | undefined;
    description_hash?: string | undefined;
    expiry?: number | undefined;
  }): Promise<Invoice> {
    return this.send<Invoice>({
      method: "make_invoice_for",
      params,
    });
  }

  payInvoice(params: {
    invoice: string;
    amount?: number | undefined;
  }): Promise<PaymentResult> {
    return this.send<PaymentResult>({
      method: "pay_invoice",
      params,
    });
  }
}
