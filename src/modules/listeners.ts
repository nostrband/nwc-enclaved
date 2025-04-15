import { Event } from "nostr-tools";
import { Relay } from "./relay";
import { PubkeyBatcher, now } from "./utils";
import { KIND_NWC_REQUEST } from "./consts";

const BATCH_SIZE = 100;

// watch for nip47 requests tagging our service pubkey on our relays
export class RequestListener {
  private relays = new Map<string, Relay>();
  private onRequest: (relay: Relay, pubkey: string, event: Event) => void;
  private pubkeys = new PubkeyBatcher(BATCH_SIZE);

  constructor(
    {
      onRequest,
    }: { onRequest: (relay: Relay, pubkey: string, event: Event) => void }
  ) {
    this.onRequest = onRequest;
  }

  private onEvent(relay: Relay, event: Event) {
    switch (event.kind) {
      case KIND_NWC_REQUEST:
        const p = event.tags.find((t) => t.length > 1 && t[0] === "p")?.[1];
        if (!p || !this.pubkeys.has(p)) {
          console.log("Unknown pubkey", event);
          return;
        }
        this.onRequest(relay, p, event);
        break;
      default:
        throw new Error("Invalid kind");
    }
  }

  private req(relay: Relay, id: string, pubkeys: string[]) {
    relay.req({
      id,
      fetch: false,
      filter: {
        "#p": pubkeys,
        kinds: [KIND_NWC_REQUEST],
        // NOTE: actually NWC nip proposes to use 'expiration' which
        // means we should process 'everything that hasn't expired',
        // but that seems unrealistic and useless, hence 'since'
        since: now() - 100,
      },
      onClosed: () => relay.close(id),
      onEvent: (e: Event) => this.onEvent(relay, e),
    });
  }

  public addPubkey(pubkey: string, relays: string[]) {
    for (const url of relays) {
      const [id, pubkeys] = this.pubkeys.add(pubkey, url);
      if (!id) continue;

      // forward-looking subscription watching
      // for new requests, id will be the same to a previous
      // id of a batch so a new REQ will override the old REQ on relay
      const relay = this.relays.get(url) || new Relay(url);
      this.req(relay, id, pubkeys);
    }
  }

  public removePubkey(pubkey: string) {
    for (const url of this.pubkeys.relays(pubkey)) {
      const [id, pubkeys] = this.pubkeys.remove(pubkey, url);
      if (!id) continue;

      const relay = this.relays.get(url);
      if (!relay) continue; // wtf?

      if (pubkeys.length) {
        this.req(relay, id, pubkeys);
      } else {
        relay.close(id);
      }
    }
  }

  public pubkeyRelays(pubkey: string) {
    return this.pubkeys.relays(pubkey);
  }
}
