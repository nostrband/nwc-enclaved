import { Event, getPublicKey } from "nostr-tools";
import { Relay } from "./modules/relay";
import { RequestListener } from "./modules/listeners";
import { PrivateKeySigner } from "./modules/signer";
import { Wallets } from "./modules/wallets";
import { DB } from "./modules/db";
import { Phoenix } from "./modules/phoenix";
import { MAX_TX_AGE } from "./modules/consts";
import { WalletContext as GlobalContext } from "./modules/abstract";
import { PhoenixFeePolicy } from "./modules/fees";
import { getSecretKey } from "./modules/key";
import { fetchCerts, publishZapReceipt } from "./modules/nostr";
import { normalizeRelay, now } from "./modules/utils";
import { startAnnouncing } from "./modules/announce";
import { NWCServer } from "./modules/nwc-server";

// read from file or generate
const servicePrivkey = getSecretKey();
const servicePubkey = getPublicKey(servicePrivkey);

async function startBackgroundJobs(context: GlobalContext, wallets: Wallets) {
  // GC
  setInterval(() => {
    if (!context.enclavedInternalWallet)
      context.db.clearOldTxs(now() - MAX_TX_AGE);
    context.db.clearExpiredInvoices();
  }, 60000);

  // wallet fee charging
  if (!context.enclavedInternalWallet) {
    setInterval(() => {
      const pubkey = context.db.getNextWalletFeePubkey(servicePubkey);
      if (pubkey) wallets.chargeWalletFee(pubkey);
    }, 1000);
  }
}

export async function startWalletd({
  relayUrls,
  phoenixPassword,
  maxBalance,
  enclavedInternalWallet = false,
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

  // main modules
  const db = new DB(enclavedInternalWallet);
  const phoenix = new Phoenix();
  const fees = new PhoenixFeePolicy(enclavedInternalWallet);

  // global context
  const context: GlobalContext = {
    backend: phoenix,
    db,
    fees,
    serviceSigner,
    enclavedInternalWallet,
    relays,
    maxBalance,
  };

  // fetch global mining fee state
  const feeState = db.getFees();
  console.log("feeState", feeState);
  fees.addMiningFeePaid(feeState.miningFeePaid);
  fees.addMiningFeeReceived(feeState.miningFeeReceived);

  // get admin pubkey in enclaved mode
  let adminPubkey: string | undefined;
  if (process.env['NWC_DEBUG'] !== 'true' && enclavedInternalWallet) {
    adminPubkey = (await fetchCerts(servicePubkey))?.root.pubkey;
    if (!adminPubkey) throw new Error("Failed to get enclaved admin pubkey");
    console.log("enclaved parent pubkey", adminPubkey);
  }

  // load all wallets
  const wallets = new Wallets(context, {
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
  const server = new NWCServer(serviceSigner, wallets);

  // request handler
  const handle = async (e: Event, relay: Relay) => {
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
      await handle(e, relay);
    },
  });

  // listen to requests targeting our pubkey
  requestListener.addPubkey(servicePubkey, relays);

  // announce
  startAnnouncing(context);

  // clear old txs, empty wallets, unpaid expired invoices etc
  startBackgroundJobs(context, wallets);
}
