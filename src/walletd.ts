import { Event, getPublicKey } from "nostr-tools";
import { NWCServer } from "./modules/nwc";
import { Relay } from "./modules/relay";
import { RequestListener } from "./modules/listeners";
import { Nip47Rep, Nip47Req, PAYMENT_FAILED } from "./modules/types";
import { PrivateKeySigner } from "./modules/signer";
import { Wallets } from "./modules/wallets";
import { DB } from "./modules/db";
import { Phoenixd } from "./modules/phoenixd";
import { PHOENIX_PASSWORD } from "./modules/consts";
import { Signer } from "./modules/abstract";
import { PhoenixFeePolicy } from "./modules/fees";
import { getSecretKey } from "./modules/key";

const db = new DB();
const phoenix = new Phoenixd();
const fees = new PhoenixFeePolicy();
const wallets = new Wallets({ phoenix, db, fees });

// forward NWC calls to wallets
class Server extends NWCServer {
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

export async function startWalletd({ relayUrl }: { relayUrl: string }) {
  // new admin key on every restart
  const adminPrivkey = getSecretKey();
  const adminSigner = new PrivateKeySigner(adminPrivkey);
  const adminPubkey = getPublicKey(adminPrivkey);
  console.log("adminPubkey", adminPubkey);

  // fetch global mining fee state
  const feeState = db.getFees();
  fees.addMiningFeePaid(feeState.miningFeePaid);
  fees.addMiningFeeReceived(feeState.miningFeeReceived);

  // load all wallets
  wallets.start(adminPubkey);

  // start phoenix client and sync incoming payments
  phoenix.start({
    password: PHOENIX_PASSWORD,
    onIncomingPayment: async (p) => wallets.onIncomingPayment(p),
    onOpen: () => phoenix.syncPaymentsSince(db.getLastInvoiceSettledAt()),
    onMiningFeeEstimate: (miningFee: number) =>
      fees.setMiningFeeEstimate(miningFee),
    onLiquidityFee: async (fee: number) => {
      fees.addMiningFeePaid(fee);
    }
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
