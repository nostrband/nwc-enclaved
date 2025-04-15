import { bytesToHex } from "@noble/hashes/utils";
import { randomBytes } from "crypto";

export function now() {
  return Math.floor(Date.now() / 1000);
}

export class PubkeyBatcher {
  private batchSize: number;
  private pubkeyRelays = new Map<string, Set<string>>();
  private relayReqs = new Map<string, Map<string, string[]>>();

  constructor(batchSize: number) {
    this.batchSize = batchSize;
  }

  public add(pubkey: string, relay: string): [string, string[]] {
    const relays = this.pubkeyRelays.get(pubkey) || new Set();
    if (relays.has(relay)) return ["", []];

    // add relay to pubkey
    relays.add(relay);
    this.pubkeyRelays.set(pubkey, relays);

    const reqs = this.relayReqs.get(relay) || new Map();
    this.relayReqs.set(relay, reqs);

    let id = [...reqs.entries()].find(
      ([_, pubkeys]) => pubkeys.length < this.batchSize
    )?.[0];
    if (!id) {
      id = bytesToHex(randomBytes(6));
      reqs.set(id, []);
    }
    const reqPubkeys = reqs.get(id)!;
    reqPubkeys.push(pubkey);

    return [id, reqPubkeys];
  }

  public relays(pubkey: string) {
    const relays = this.pubkeyRelays.get(pubkey);
    return relays ? [...relays.values()] : [];
  }

  public remove(pubkey: string, relay: string): [string, string[]] {
    const empty = ["", []] as [string, string[]];
    const relays = this.pubkeyRelays.get(pubkey);
    if (!relays) return empty;

    // delete relay from pubkey
    if (!relays.delete(relay)) return empty;
    this.pubkeyRelays.set(pubkey, relays);

    const reqs = this.relayReqs.get(relay);
    if (!reqs) return empty;

    for (const [id, pubkeys] of reqs.entries()) {
      const index = pubkeys.findIndex((p) => p === pubkey);
      if (index >= 0) {
        pubkeys.splice(index, 1);
        if (!pubkeys.length) reqs.delete(id);
        return [id, pubkeys];
      }
    }

    return empty;
  }

  public has(pubkey: string) {
    return this.pubkeyRelays.has(pubkey);
  }
}

export function normalizeRelay(r: string) {
  try {
    const u = new URL(r);
    if (u.protocol !== "wss:" && u.protocol !== "ws:") return undefined;
    if (u.hostname.endsWith(".onion")) return undefined;
    if (u.hostname === "localhost") return undefined;
    if (u.hostname === "127.0.0.1") return undefined;
    return u.href;
  } catch {}
}
