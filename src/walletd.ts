import { Event, getPublicKey } from "nostr-tools";
import { NWCServer } from "./modules/nwc";
import { Relay } from "./modules/relay";
import { RequestListener } from "./modules/listeners";
import { NWCReply, NWCRequest, NWC_PAYMENT_FAILED } from "./modules/nwc-types";
import { PrivateKeySigner } from "./modules/signer";
import { Wallets } from "./modules/wallets";
import { DB } from "./modules/db";
import { Phoenix } from "./modules/phoenix";
import { MAX_TX_AGE } from "./modules/consts";
import { Signer, WalletContext } from "./modules/abstract";
import { PhoenixFeePolicy } from "./modules/fees";
import { getSecretKey } from "./modules/key";
import {
  fetchCerts,
  isValidZapRequest,
  publishZapReceipt,
} from "./modules/nostr";
import { normalizeRelay, now } from "./modules/utils";
import { startAnnouncing } from "./modules/announce";

// read from file or generate
const servicePrivkey = getSecretKey();
const servicePubkey = getPublicKey(servicePrivkey);
const db = new DB();
const phoenix = new Phoenix();
const fees = new PhoenixFeePolicy();

// forward NWC calls to wallets
class Server extends NWCServer {
  private wallets: Wallets;

  constructor(signer: Signer, wallets: Wallets) {
    super(signer);
    this.wallets = wallets;
  }

  protected async addPubkey(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = this.wallets.addPubkey({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async getBalance(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await this.wallets.getBalance(req.clientPubkey);
  }

  protected async getInfo(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await this.wallets.getInfo(req.clientPubkey);
  }

  protected async listTransactions(
    req: NWCRequest,
    res: NWCReply
  ): Promise<void> {
    res.result = await this.wallets.listTransactions({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async lookupInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await this.wallets.lookupInvoice({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async makeInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await this.wallets.makeInvoice({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async makeInvoiceFor(
    req: NWCRequest,
    res: NWCReply
  ): Promise<void> {
    if (!req.params.pubkey) throw new Error("Pubkey not specified");
    if (
      req.params.zap_request &&
      !isValidZapRequest(
        req.params.zap_request,
        req.params.amount,
        servicePubkey
      )
    )
      throw new Error("Invalid zap request");
    if (req.params.zap_request)
      console.log("valid zap request", req.params.zap_request);

    res.result = await this.wallets.makeInvoiceFor({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async payInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    try {
      res.result = await this.wallets.payInvoice({
        ...req.params,
        clientPubkey: req.clientPubkey,
      });
    } catch (e) {
      if (e === NWC_PAYMENT_FAILED) {
        res.error = {
          code: NWC_PAYMENT_FAILED,
          message: "Payment failed",
        };
      } else {
        throw e;
      }
    }
  }
}

async function startBackgroundJobs(wallets: Wallets) {
  // GC
  setInterval(() => {
    db.clearOldTxs(now() - MAX_TX_AGE);
    db.clearExpiredInvoices();
  }, 60000);

  // wallet fee charging
  setInterval(() => {
    const pubkey = db.getNextWalletFeePubkey(servicePubkey);
    if (pubkey) wallets.chargeWalletFee(pubkey);
  }, 1000);
}

export async function startWalletd({
  relayUrls,
  phoenixPassword,
  maxBalance,
  enclavedInternalWallet,
}: {
  relayUrls: string;
  phoenixPassword: string;
  maxBalance: number;
  enclavedInternalWallet?: boolean;
}) {
  const relays = relayUrls
    .split(",")
    .map((s) => normalizeRelay(s.trim()))
    .filter((s) => !!s)
    .map((s) => s as string);
  if (!relays.length) throw new Error("No relays");

  // read or create our key
  const serviceSigner = new PrivateKeySigner(servicePrivkey);
  console.log("servicePubkey", servicePubkey);
  console.log("maxBalance", maxBalance);

  // fetch global mining fee state
  const feeState = db.getFees();
  console.log("feeState", feeState);
  fees.addMiningFeePaid(feeState.miningFeePaid);
  fees.addMiningFeeReceived(feeState.miningFeeReceived);

  let adminPubkey: string | undefined;
  if (enclavedInternalWallet) {
    adminPubkey = (await fetchCerts(servicePubkey))?.root.pubkey;
    if (!adminPubkey) throw new Error("Failed to get enclaved admin pubkey");
    console.log("enclaved parent pubkey", adminPubkey);
  }

  // global settings etc
  const context: WalletContext = {
    backend: phoenix,
    db,
    fees,
    serviceSigner,
    enclavedInternalWallet,
    relays,
    maxBalance,
  };

  // load all wallets
  const wallets = new Wallets(context);
  wallets.start({
    adminPubkey,
    onZapReceipt: (zapRequest: string, bolt11: string, preimage: string) => {
      publishZapReceipt(zapRequest, bolt11, preimage, serviceSigner).catch(
        (e) => {
          const o = { e, zapRequest, bolt11, preimage };
          console.error(new Date(), "failed to publish zap receipt", o);
        }
      );
    },
  });

  // start phoenix client and sync incoming payments
  phoenix.start({
    password: phoenixPassword,
    onIncomingPayment: async (p) => wallets.onIncomingPayment(p),
    onOpen: () => phoenix.syncPaymentsSince(db.getLastInvoiceSettledAt()),
    onMiningFeeEstimate: (miningFee: number) =>
      fees.setMiningFeeEstimate(miningFee),
    onLiquidityFee: async (fee: number) => {
      const oldFees = fees.getMiningFeePaid();
      fees.addMiningFeePaid(fee);
      db.addMiningFeePaid(fee);
      return !oldFees; // true if haven't paid fees before
    },
  });

  // NWC server
  const server = new Server(serviceSigner, wallets);

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

  // listen to requests targeting our pubkey
  requestListener.addPubkey(servicePubkey, relays);

  // announce
  startAnnouncing(context);

  // clear old txs, empty wallets, unpaid expired invoices etc
  startBackgroundJobs(wallets);
}
