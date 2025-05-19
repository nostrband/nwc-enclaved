import { Event } from "nostr-tools";
import { WSClient } from "./ws-client";

export interface EnclavedCertificate {
  root: Event;
  certs: Event[];
}

export class EnclavedClient extends WSClient {
  constructor() {
    const url = process.env["ENCLAVED_ENDPOINT"];
    if (!url) throw new Error("No enclaved endpoint");

    super(url, {
      token: process.env["ENCLAVED_TOKEN"] || "",
    });
  }

  public createCertificate(pubkey: string) {
    return this.call<EnclavedCertificate>("create_certificate", { pubkey });
  }

  public setInfo(info: { pubkey: string }) {
    return this.call<{ ok: boolean }>("set_info", { info });
  }
}
