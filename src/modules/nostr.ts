import { Event, UnsignedEvent, validateEvent, verifyEvent } from "nostr-tools";
import { normalizeRelay, now } from "./utils";
import { Signer } from "./abstract";
import { Relay, Req } from "./relay";
import { bytesToHex, randomBytes } from "@noble/hashes/utils";
import {
  KIND_NWC_INFO,
  KIND_PROFILE,
  KIND_RELAYS,
  KIND_SERVICE_INFO,
  NWC_SUPPORTED_METHODS,
} from "./consts";

const DEFAULT_RELAYS = [
  "wss://relay.damus.io",
  "wss://relay.primal.net",
  "wss://nostr.mom",
];

const OUTBOX_RELAYS = [
  "wss://relay.primal.net",
  "wss://relay.nostr.band",
  "wss://purplepag.es",
  "wss://user.kindpag.es",
  "wss://relay.nos.social",
];

async function publish(event: Event, relays: string[]) {
  const promises = relays.map((r) => {
    const relay = new Relay(r);
    return relay.publish(event).finally(() => relay.dispose());
  });
  await Promise.allSettled(promises);
}

export async function publishNip65Relays(signer: Signer) {
  const tmpl: UnsignedEvent = {
    pubkey: signer.getPublicKey(),
    kind: KIND_RELAYS,
    created_at: now(),
    content: "",
    tags: DEFAULT_RELAYS.map((r) => ["r", r]),
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
    liquidityFeeRate: number;
    paymentFeeRate: number;
    paymentFeeBase: number;
    walletFeeBase: number;
    walletFeePeriod: number;
  },
  signer: Signer,
  nwcRelays: string[]
) {
  const serviceInfo: UnsignedEvent = {
    pubkey: signer.getPublicKey(),
    kind: KIND_SERVICE_INFO,
    created_at: now(),
    content: "",
    tags: [
      ...nwcRelays.map((r) => ["relay", r]),
      ["minSendable", "" + info.minSendable],
      ["maxSendable", "" + info.maxSendable],
      ["maxBalance", "" + info.maxBalance],
      ["liquidityFeeRate", "" + info.liquidityFeeRate.toFixed(4)],
      ["paymentFeeRate", "" + info.paymentFeeRate.toFixed(4)],
      ["paymentFeeBase", "" + info.paymentFeeBase],
      ["walletFeeBase", "" + info.walletFeeBase],
      ["walletFeePeriod", "" + info.walletFeePeriod],
    ],
  };

  switch (process.env["ENCLAVE"]) {
    case "dev":
      serviceInfo.tags.push(["t", "dev"]);
      break;
    case "prod":
      serviceInfo.tags.push(["t", "prod"]);
      break;
    default:
      serviceInfo.tags.push(["t", "debug"]);
      break;
  }
  const dev = process.env["ENCLAVE"] === "dev";
  const prod = process.env["ENCLAVE"] === "prod";
  const debug = !dev && !prod;

  const serviceEvent = await signer.signEvent(serviceInfo);
  await publish(serviceEvent, [...DEFAULT_RELAYS, ...OUTBOX_RELAYS]);
  console.log(
    "published service info",
    serviceEvent,
    DEFAULT_RELAYS,
    OUTBOX_RELAYS
  );

  const profile: UnsignedEvent = {
    pubkey: signer.getPublicKey(),
    kind: KIND_PROFILE,
    created_at: now(),
    content: JSON.stringify({
      name: "nwc-enclaved wallet service",
      about: `This is a custodial Lightning Wallet with NWC support.
Learn more at https://github.com/nostrband/nwc-enclaved\n
Max balance: ${info.maxBalance / 1000} sats\n
Liquidity fee: ${
        info.liquidityFeeRate
      } + share of mining fees, paid when sending payments\n
Payment fee: ${info.paymentFeeBase / 1000} sats + ${(
        info.paymentFeeRate * 100
      ).toFixed(2)}%\n
Wallet fee: ${info.walletFeeBase / 1000} sats per ${
        info.walletFeePeriod / 3600
      } hours\n
${
  debug
    ? `DEBUG INSTANCE, not private, may break or get terminated at any time!`
    : ""
}
${dev ? `DEVELOPMENT INSTANCE, may break or get terminated at any time!` : ""}
`,
      picture: "",
    }),
    tags: [
      ["t", "nwc-enclaved"],
      ["r", "https://github.com/nostrband/nwc-enclaved"],
    ],
  };

  const profileEvent = await signer.signEvent(profile);
  await publish(profileEvent, OUTBOX_RELAYS);
  console.log("published profile", profileEvent, OUTBOX_RELAYS);

  const nwcInfo: UnsignedEvent = {
    pubkey: signer.getPublicKey(),
    kind: KIND_NWC_INFO,
    created_at: now(),
    content: NWC_SUPPORTED_METHODS.join(","),
    tags: [],
  };

  const nwcInfoEvent = await signer.signEvent(nwcInfo);
  await publish(nwcInfoEvent, nwcRelays);
  console.log("published nwc info", nwcInfoEvent, nwcRelays);
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

  const promises = [...DEFAULT_RELAYS, ...OUTBOX_RELAYS].map((url) => {
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
