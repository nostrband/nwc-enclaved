import { Event, generateSecretKey, getPublicKey } from "nostr-tools";
import { Relay } from "./modules/relay";
import { RequestListener } from "./modules/listeners";
import { PrivateKeySigner } from "./modules/signer";
import { Wallets } from "./modules/wallets";
import { DB } from "./modules/db";
import { Phoenix } from "./modules/phoenix";
import { KIND_SERVICE_INFO, MAX_TX_AGE } from "./modules/consts";
import { WalletContext as GlobalContext } from "./modules/abstract";
import { PhoenixFeePolicy } from "./modules/fees";
import { getSecretKey } from "./modules/key";
import {
  fetchReplaceableEvent,
  publish,
  publishZapReceipt,
} from "./modules/nostr";
import { normalizeRelay, now } from "./modules/utils";
import { startAnnouncing } from "./modules/announce";
import { NWCServer } from "./modules/nwc-server";
import { EnclavedClient } from "./modules/enclaved-client";
import { NWCClient } from "./modules/nwc-client";

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

async function watchContainerInfo(
  enclaved: EnclavedClient,
  wallets: Wallets,
  fees: PhoenixFeePolicy
) {
  while (true) {
    try {
      const info = await enclaved.getContainerInfo();
      console.log("container info", info);

      // need to pay?
      if (info.balance < info.price) {
        const state = wallets.getWalletState(servicePubkey);
        console.log(new Date(), "need payment for container, service wallet state", state);
        if (state) {
          const fee = fees.estimatePaymentFeeMsat(state, info.price, []);
          console.log("container payment fee estimate", fee);
          if (state.balance >= info.price + fee) {
            const walletInfo = await fetchReplaceableEvent(
              info.walletPubkey,
              KIND_SERVICE_INFO
            );
            console.log(
              new Date(),
              "wallet info",
              info.walletPubkey,
              walletInfo
            );
            if (walletInfo) {
              const relay = walletInfo.tags.find(
                (t) => t.length > 1 && t[0] === "relay"
              )?.[1];
              if (relay) {
                const client = new NWCClient({
                  walletPubkey: info.walletPubkey,
                  privkey: generateSecretKey(),
                  relayUrl: relay,
                });
                try {
                  client.start();
                  const invoice = await client.makeInvoiceFor({
                    amount: info.price,
                    pubkey: info.pubkey,
                  });
                  console.log("container invoice", invoice);
                  const payment = await wallets.payInvoice({
                    clientPubkey: servicePubkey,
                    invoice: invoice.invoice,
                  });
                  console.log("payment", payment);
                } finally {
                  client.dispose();
                }
              }
            }
          }
        }
      }
    } catch (e) {
      console.log("Failed to get container info", e);
    }

    await new Promise((ok) => setTimeout(ok, 10000));
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

  // enclaved?
  const enclaved = process.env["ENCLAVED"] ? new EnclavedClient() : undefined;

  // set set our info
  if (enclaved) await enclaved.setInfo({ pubkey: servicePubkey });

  // get admin pubkey in enclaved internal wallet mode
  let adminPubkey: string | undefined;
  if (
    enclaved &&
    process.env["NWC_DEBUG"] !== "true" &&
    enclavedInternalWallet
  ) {
    // get admin pubkey
    adminPubkey = (await enclaved.createCertificate(servicePubkey))?.root
      .pubkey;
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
    onPaymentReceived: (clientPubkey, tx) => {
      server.notify(clientPubkey, "payment_received", tx);
    },
    onPaymentSent: (clientPubkey, tx) => {
      server.notify(clientPubkey, "payment_sent", tx);
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

  // are we a public wallet in enclaved?
  if (enclaved && !enclavedInternalWallet) {
    // start watching to be able to pay for ourselves
    watchContainerInfo(enclaved, wallets, fees);
  }

  // NWC server
  const server = new NWCServer({
    signer: serviceSigner,
    wallets,
    onNotify: async (e: Event) => {
      publish(e, relays);
    },
  });

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
