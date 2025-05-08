import http from "node:http";
import { Event, generateSecretKey, nip19 } from "nostr-tools";
import { fetchPubkeyRelays, fetchReplaceableEvent } from "./modules/nostr";
import { NWCClient } from "./modules/nwc-client";
import { KIND_SERVICE_INFO } from "./modules/consts";
import { sha256 } from "@noble/hashes/sha2"; // ESM & Common.js
import { bytesToHex } from "@noble/hashes/utils";
import { now } from "./modules/utils";

const CACHE_TTL = 3600;
const cache = new Map<
  string,
  {
    timestamp: number;
    relays: string[];
    info: Event;
  }
>();

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*" /* @dev First, read about security */,
  "Access-Control-Allow-Methods": "OPTIONS, GET",
  "Access-Control-Max-Age": 2592000, // 30 days
  "Content-Type": "application/json",
};

function parseNpub(npub: string) {
  const { type, data } = nip19.decode(npub);
  if (type !== "npub") throw new Error("Bad npub");
  return data;
}

async function getWalletInfo(walletPubkey: string, res: http.ServerResponse) {
  const cached = cache.get(walletPubkey);
  if (!cached || now() - cached.timestamp > CACHE_TTL) {
    // wallet relays
    // const relays = await fetchPubkeyRelays(walletPubkey);
    // console.log("wallet relays", relays);
    // if (!relays.length) {
    //   res.writeHead(504, CORS_HEADERS);
    //   res.end("Wallet relays not found");
    //   return;
    // }

    // wallet info
    const info = await fetchReplaceableEvent(walletPubkey, KIND_SERVICE_INFO);
    if (!info) {
      res.writeHead(504, CORS_HEADERS);
      res.end("Wallet info not found");
      return;
    }

    const relays = info.tags.filter(t => t.length > 1 && t[0] === 'relay').map(t => t[1]);

    cache.set(walletPubkey, {
      timestamp: now(),
      relays,
      info,
    });
  }

  return cache.get(walletPubkey)!;
}

async function lnaddrServer(opts: { port: number }) {
  const server = http.createServer({}, async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }

    // <npubWallet>.domain.com/.well-known/lnurlp/<npubUser>[/callback]

    const path = req.url?.split("?")[0] || "";

    let userNpub = "";
    let userPubkey = "";
    let walletPubkey = "";
    try {
      if (!path.startsWith("/.well-known/lnurlp/"))
        throw new Error("Not found");
      userNpub = req.url!.split("/.well-known/lnurlp/")[1].split("/")[0];
      userPubkey = parseNpub(userNpub);

      if (!req.headers.host?.startsWith("npub"))
        throw new Error("Unknown wallet npub");
      walletPubkey = parseNpub(req.headers.host.split(".")[0]);
    } catch (e: any) {
      res.writeHead(400, CORS_HEADERS);
      res.end(e.message || e.toString());
      return;
    }
    console.log(new Date(), "user", userPubkey, "wallet", walletPubkey);

    // wallet info
    const walletInfo = await getWalletInfo(walletPubkey, res);
    if (!walletInfo) return; // not found, error is sent to res
    const { relays, info } = walletInfo;

    // invoice desc
    const description = `sats for ${userNpub}`;

    let reply: any | undefined;

    if (path.endsWith("/callback")) {
      const query = req.url!.split("?")?.[1];
      if (!query) {
        res.writeHead(400, CORS_HEADERS);
        res.end("No query string");
        return;
      }
      const params = new URLSearchParams(query);
      if (!params.has("amount")) {
        res.writeHead(400, CORS_HEADERS);
        res.end("No amount");
        return;
      }

      const amount = parseInt(params.get("amount")!);
      const nostr = params.get("nostr");
      console.log("amount", amount, "nostr", nostr);

      // create invoice
      const client = new NWCClient({
        relayUrl: relays[0],
        walletPubkey,
        privkey: generateSecretKey(),
      });
      client.start();

      const invoice = await client.makeInvoiceFor({
        pubkey: userPubkey,
        amount,
        description_hash: nostr ? undefined : bytesToHex(sha256(description)),
        zap_request: nostr ? nostr : undefined,
      });

      client.dispose();

      reply = {
        pr: invoice.invoice,
        routes: [],
      };
    } else {
      // lud06 callback reply

      // lud-06 reply
      reply = {
        status: "OK",
        allowsNostr: true,
        nostrPubkey: walletPubkey,
        commentAllowed: 200,
        callback: `https://${req.headers.host}/.well-known/lnurlp/${userNpub}/callback`,
        maxSendable: parseInt(
          info.tags.find((t) => t.length > 1 && t[0] === "maxSendable")?.[1] ||
            "0"
        ),
        minSendable: parseInt(
          info.tags.find((t) => t.length > 1 && t[0] === "minSendable")?.[1] ||
            "0"
        ),
        metadata: JSON.stringify([
          ["text/plain", description],
          ["text/identifier", `${userNpub}@${req.headers.host!}`],
        ]),
        tag: "payRequest",
      };
    }

    res.writeHead(200, CORS_HEADERS);
    res.end(JSON.stringify(reply));
  });
  server.on("clientError", (err: { code: string }, socket) => {
    if (err.code === "ECONNRESET" || !socket.writable) {
      return;
    }
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });
  server.listen(port);
}

console.log("args", process.argv);
const port = parseInt(process.argv[2]);
lnaddrServer({ port });
