import { Event, generateSecretKey, getPublicKey } from "nostr-tools";
import { Nip47Server } from "./modules/nip47";
import { Relay } from "./modules/relay";
import { RequestListener } from "./modules/listeners";
import { Nip47Rep, Nip47Req, PAYMENT_FAILED, Signer } from "./modules/types";
import { SignerImpl } from "./modules/signer";
import { Wallets } from "./modules/wallets";
import { DB } from "./modules/db";
import { Phoenixd } from "./modules/phoenixd";
import fs from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";
import { PHOENIX_PASSWORD } from "./modules/consts";

const db = new DB();
const phoenix = new Phoenixd();
const wallets = new Wallets({ phoenix, db });

class Server extends Nip47Server {
  constructor(signer: Signer) {
    super(signer);
  }

  protected async getBalance(req: Nip47Req, res: Nip47Rep): Promise<void> {
    res.result = await wallets.getBalance(req.clientPubkey);
  }

  protected async getInfo(req: Nip47Req, res: Nip47Rep): Promise<void> {
    res.result = await wallets.getInfo(req.clientPubkey);
  }

  protected async listTransactions(
    req: Nip47Req,
    res: Nip47Rep
  ): Promise<void> {
    res.result = await wallets.listTransactions({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async makeInvoice(req: Nip47Req, res: Nip47Rep): Promise<void> {
    res.result = await wallets.makeInvoice({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async payInvoice(req: Nip47Req, res: Nip47Rep): Promise<void> {
    try {
      res.result = await wallets.payInvoice({
        ...req.params,
        clientPubkey: req.clientPubkey,
      });
    } catch (e) {
      if (e === PAYMENT_FAILED) {
        res.error = {
          code: PAYMENT_FAILED,
          message: "Payment failed",
        };
      } else {
        throw e;
      }
    }
  }
}

function getSecretKey() {
  const FILE = "./.admin.sk";
  if (fs.existsSync(FILE)) {
    const hex = fs.readFileSync(FILE).toString("utf8");
    const privkey = Buffer.from(hex, "hex");
    if (privkey.length !== 32) throw new Error("Invalid privkey");
    return privkey;
  }

  const privkey = generateSecretKey();
  fs.writeFileSync(FILE, bytesToHex(privkey));
  return privkey;
}

export async function startWalletd({ relayUrl }: { relayUrl: string }) {
  // new admin key on every restart
  const adminPrivkey = getSecretKey();
  const adminSigner = new SignerImpl(adminPrivkey);
  const adminPubkey = getPublicKey(adminPrivkey);
  console.log("adminPubkey", adminPubkey);

  // load all wallets 
  wallets.start(adminPubkey);

  // start phoenix client and sync incoming payments
  phoenix.start({
    password: PHOENIX_PASSWORD,
    onIncomingPayment: async (p) => wallets.onIncomingPayment(p),
    onOpen: () => phoenix.syncPaymentsSince(db.getLastInvoiceSettledAt()),
  });

  // list of nip47 handlers: admin + all user keys
  const server = new Server(adminSigner);

  // request handler
  const process = async (e: Event, relay: Relay) => {
    const reply = await server.process(e);
    if (!reply) return; // ignored
    try {
      await relay.publish(reply);
    } catch (err) {
      console.log("failed to publish reply");
      relay.reconnect();
    }
  };

  let reqsTotal = 0;
  const requestListener = new RequestListener({
    onRequest: async (relay: Relay, pubkey: string, e: Event) => {
      reqsTotal++;
      await process(e, relay);
    },
  });

  // single admin on a single relay for now
  requestListener.addPubkey(adminPubkey, [relayUrl]);
}
