import { WebSocket, MessageEvent } from "ws";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";

export class WSClient {
  private url: string;
  private headers: any;
  private ws?: WebSocket;
  private openPromise?: Promise<void>;
  private pending = new Map<
    string,
    {
      ok: (result: string) => void;
      err: (e: any) => void;
    }
  >();

  constructor(url: string, headers: any = {}) {
    this.url = url;
    this.headers = headers;
    this.connect();
  }

  private connect() {
    this.ws = new WebSocket(this.url, {
      headers: this.headers,
    });
    this.openPromise = new Promise<void>((ok) => {
      this.ws!.onopen = () => {
        console.log(new Date(), "connected to", this.url);
        ok();
      };
    });
    this.ws.onclose = () => {
      console.log(new Date(), "disconnected from", this.url);
      setTimeout(() => this.connect(), 1000);
    };
    this.ws.onmessage = this.onReplyEvent.bind(this);
  }

  protected onEvent(event: { type: string }) {
    // noop
  }

  private onReplyEvent(e: MessageEvent) {
    const p = JSON.parse(e.data.toString("utf8"));
    if (p.event) {
      this.onEvent(p.event);
    } else {
      const { id, result, error } = p;
      console.log("reply", { id, result: JSON.stringify(result), error });

      const cbs = this.pending.get(id);
      if (!cbs) return;
      this.pending.delete(id);

      if (error) cbs.err(error);
      else cbs.ok(result);
    }
  }

  private async send(method: string, params: any, timeout = 10000) {
    // wait until connected
    await this.openPromise!;

    // send request
    const req = {
      id: bytesToHex(randomBytes(6)),
      method,
      params,
    };
    this.ws!.send(JSON.stringify(req));

    // wait reply with timeout
    return new Promise<string>((ok, err) => {
      this.pending.set(req.id, { ok, err });
      setTimeout(() => {
        const cbs = this.pending.get(req.id);
        if (cbs) {
          this.pending.delete(req.id);
          cbs.err("Request timeout");
        }
      }, timeout);
    });
  }

  public async call<T>(method: string, params: any, timeout = 10000) {
    const r = await this.send(method, params, timeout);
    return r as T;
  }
}
