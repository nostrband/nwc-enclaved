import { Event, getPublicKey } from "nostr-tools";
import { NWCServer } from "./modules/nwc";
import { Relay } from "./modules/relay";
import { RequestListener } from "./modules/listeners";
import { NWCReply, NWCRequest, NWC_PAYMENT_FAILED } from "./modules/nwc-types";
import { PrivateKeySigner } from "./modules/signer";
import { Wallets } from "./modules/wallets";
import { DB } from "./modules/db";
import { Phoenix } from "./modules/phoenix";
import {
  MAX_TX_AGE,
  PAYMENT_FEE,
  PHOENIX_LIQUIDITY_FEE,
  PHOENIX_PAYMENT_FEE_BASE,
  PHOENIX_PAYMENT_FEE_PCT,
  WALLET_FEE,
  WALLET_FEE_PERIOD,
} from "./modules/consts";
import { Signer } from "./modules/abstract";
import { PhoenixFeePolicy } from "./modules/fees";
import { getSecretKey } from "./modules/key";
import {
  fetchCerts,
  isValidZapRequest,
  publishNip65Relays,
  publishServiceInfo,
  publishZapReceipt,
} from "./modules/nostr";
import { now } from "./modules/utils";

// read from file or generate
const servicePrivkey = getSecretKey();
const servicePubkey = getPublicKey(servicePrivkey);
const db = new DB();
const phoenix = new Phoenix();
const fees = new PhoenixFeePolicy();
const wallets = new Wallets({ backend: phoenix, db, fees, servicePubkey });

// forward NWC calls to wallets
class Server extends NWCServer {
  constructor(signer: Signer) {
    super(signer);
  }

  protected async addPubkey(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = wallets.addPubkey({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async getBalance(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await wallets.getBalance(req.clientPubkey);
  }

  protected async getInfo(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await wallets.getInfo(req.clientPubkey);
  }

  protected async listTransactions(
    req: NWCRequest,
    res: NWCReply
  ): Promise<void> {
    res.result = await wallets.listTransactions({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async lookupInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await wallets.lookupInvoice({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async makeInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    res.result = await wallets.makeInvoice({
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

    res.result = await wallets.makeInvoiceFor({
      ...req.params,
      clientPubkey: req.clientPubkey,
    });
  }

  protected async payInvoice(req: NWCRequest, res: NWCReply): Promise<void> {
    try {
      res.result = await wallets.payInvoice({
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

async function startBackgroundJobs() {
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
  relayUrl,
  phoenixPassword,
  maxBalance,
  enclavedInternalWallet,
}: {
  relayUrl: string;
  phoenixPassword: string;
  maxBalance: number;
  enclavedInternalWallet?: boolean;
}) {
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

  // load all wallets
  wallets.start({
    maxBalance,
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
  const server = new Server(serviceSigner);

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
  requestListener.addPubkey(servicePubkey, [relayUrl]);

  // advertise our relays
  await publishNip65Relays(serviceSigner);
  // update our announcement once per minute
  const announce = async () => {
    await publishServiceInfo(
      {
        maxBalance: maxBalance,
        minSendable: 1000,
        maxSendable: maxBalance,
        liquidityFeeRate: PHOENIX_LIQUIDITY_FEE,
        paymentFeeRate: PHOENIX_PAYMENT_FEE_PCT,
        paymentFeeBase: PHOENIX_PAYMENT_FEE_BASE + PAYMENT_FEE,
        walletFeeBase: WALLET_FEE,
        walletFeePeriod: WALLET_FEE_PERIOD,
        open: (await phoenix.getInfo()).channels.length > 0,
        stats: db.getStats(servicePubkey),
      },
      serviceSigner,
      [relayUrl]
    ).catch((e) =>
      console.error(new Date(), "failed to publish service info", e)
    );
  };
  await announce();
  setInterval(announce, 600000);

  // clear old txs, empty wallets, unpaid expired invoices etc
  startBackgroundJobs();
}
