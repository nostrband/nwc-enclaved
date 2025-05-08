import { Event, UnsignedEvent, validateEvent, verifyEvent } from "nostr-tools";
import { normalizeRelay, now } from "./utils";
import { Signer } from "./abstract";
import { Relay, Req } from "./relay";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import {
  KIND_NWC_INFO,
  KIND_RELAYS,
  KIND_SERVICE_INFO,
  NWC_SUPPORTED_METHODS,
} from "./consts";

const OUTBOX_RELAYS = [
  "wss://relay.primal.net",
  "wss://purplepag.es",
  "wss://user.kindpag.es/",
  "wss://relay.nos.social/",
];

async function publish(event: Event, relays: string[]) {
  const promises = relays.map((r) => {
    const relay = new Relay(r);
    return relay.publish(event).finally(() => relay.dispose());
  });
  await Promise.allSettled(promises);
}

export async function publishNip65Relays(relays: string[], signer: Signer) {
  const tmpl: UnsignedEvent = {
    pubkey: signer.getPublicKey(),
    kind: KIND_RELAYS,
    created_at: now(),
    content: "",
    tags: relays.map((r) => ["r", r]),
  };

  const event = await signer.signEvent(tmpl);
  await publish(event, OUTBOX_RELAYS);
  console.log("published outbox relays", event, OUTBOX_RELAYS);
}

export async function publishServiceInfo(
  info: {
    minSendable: number;
    maxSendable: number;
    maxBalance: number;
  },
  signer: Signer,
  nwcRelays: string[]
) {
  const tmpl: UnsignedEvent = {
    pubkey: signer.getPublicKey(),
    kind: KIND_SERVICE_INFO,
    created_at: now(),
    content: "",
    tags: [
      ["minSendable", "" + info.minSendable],
      ["maxSendable", "" + info.maxSendable],
      ["maxBalance", "" + info.maxBalance],
    ],
  };

  const event = await signer.signEvent(tmpl);
  await publish(event, OUTBOX_RELAYS);
  console.log("published service info", event, OUTBOX_RELAYS);

  const nwcInfo: UnsignedEvent = {
    pubkey: signer.getPublicKey(),
    kind: KIND_NWC_INFO,
    created_at: now(),
    content: NWC_SUPPORTED_METHODS.join(","),
    tags: [],
  };

  const nwcInfoEvent = await signer.signEvent(nwcInfo);
  await publish(nwcInfoEvent, nwcRelays);
  console.log("published outbox relays", event, nwcRelays);
}

export async function fetchReplaceableEvent(pubkey: string, kind: number) {
  let event: Event | undefined;
  const makeReq = (ok: () => void): Req => {
    return {
      id: bytesToHex(randomBytes(6)),
      fetch: true,
      filter: {
        kinds: [kind],
        authors: [pubkey],
        limit: 1,
      },
      onEOSE(events) {
        for (const e of events) {
          if (!event || event.created_at < e.created_at) event = e;
        }
        ok();
      },
    };
  };

  const promises = OUTBOX_RELAYS.map((url) => {
    const r = new Relay(url);
    return new Promise<void>((ok) => r.req(makeReq(ok))).finally(() =>
      r.dispose()
    );
  });
  await Promise.race([
    new Promise((ok) => setTimeout(ok, 5000)),
    Promise.allSettled(promises),
  ]);

  return event;
}

export async function fetchPubkeyRelays(pubkey: string) {
  const event = await fetchReplaceableEvent(pubkey, KIND_RELAYS);
  if (!event) throw new Error("Relays not found for pubkey");

  return event.tags
    .filter((r) => r.length > 1 && r[0] === "r")
    .map((t) => normalizeRelay(t[1]) as string)
    .filter((r) => !!r);
}

// https://github.com/nostr-protocol/nips/blob/master/57.md#appendix-d-lnurl-server-zap-request-validation
export async function isValidZapRequest(
  zapRequest: string,
  amount: number,
  servicePubkey: string
) {
  try {
    const req: Event = JSON.parse(zapRequest);

    // It MUST have a valid nostr signature
    if (!validateEvent(req) || !verifyEvent(req)) return false;
    if (req.kind !== 9734) return false;

    // It MUST have only one p tag
    const ps = req.tags.filter(
      (t) => t.length > 1 && t[0] === "p" && t[1].length === 64
    );
    if (ps.length !== 1) return false;

    // It MUST have 0 or 1 e tags
    const es = req.tags.filter(
      (t) => t.length > 1 && t[0] === "e" && t[1].length === 64
    );
    if (es.length > 1) return false;

    // There should be a relays tag with the relays to send the zap receipt to.
    const relays = req.tags
      .find((t) => t.length > 1 && t[0] === "relays")
      ?.slice(1)
      .map((r) => normalizeRelay(r))
      .filter((r) => !!r);
    if (!relays?.length) return false;

    // If there is an amount tag, it MUST be equal to the amount query parameter.
    const amountTag = req.tags.find(
      (t) => t.length > 1 && t[0] === "amount"
    )?.[1];
    if (amountTag && amountTag !== "" + amount) return false;

    // If there is an a tag, it MUST be a valid event coordinate
    const a = req.tags.find((t) => t.length > 1 && t[0] === "a")?.[1];
    if (a) {
      const parts = a.split(":");
      if (
        parts.length < 3 ||
        !isNaN(parts[0] as unknown as number) ||
        parts[1].length !== 64
      )
        return false;
    }

    // There MUST be 0 or 1 P tags. If there is one, it MUST be equal to the zap receipt's pubkey.
    const Ps = req.tags
      .filter((t) => t.length > 1 && t[0] === "P" && t[1].length === 64)
      .map((t) => t[1]);
    if (Ps.length > 1 || (Ps.length === 1 && Ps[0] !== servicePubkey))
      return false;

    return true;
  } catch (e) {
    console.log("Failed to validate zap request", e, zapRequest);
    return false;
  }
}

export async function publishZapReceipt(
  zapRequest: string,
  bolt11: string,
  preimage: string,
  signer: Signer
) {
  const req: Event = JSON.parse(zapRequest);
  const relays: string[] = req.tags
    .find((t) => t.length > 1 && t[0] === "relays")!
    .slice(1)
    .map((r) => normalizeRelay(r) as string)
    .filter((r) => !!r);
  const p = req.tags.find((t) => t.length > 1 && t[0] === "p")![1];
  const e = req.tags.find((t) => t.length > 1 && t[0] === "e")?.[1];
  const a = req.tags.find((t) => t.length > 1 && t[0] === "a")?.[1];
  const zapReceiptTmpl: UnsignedEvent = {
    content: "",
    pubkey: signer.getPublicKey(),
    kind: 9735,
    created_at: now(),
    tags: [
      ["p", p],
      ["P", req.pubkey],
      ["bolt11", bolt11],
      ["description", zapRequest],
      ["preimage", preimage],
    ],
  };
  if (e) zapReceiptTmpl.tags.push(["e", e]);
  if (a) zapReceiptTmpl.tags.push(["a", a]);

  const zapReceipt = await signer.signEvent(zapReceiptTmpl);
  await publish(zapReceipt, relays);
  console.log(new Date(), "published zap receipt", zapReceipt, relays);
}
