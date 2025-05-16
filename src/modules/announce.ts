import { WalletContext } from "./abstract";
import {
  ANNOUNCEMENT_INTERVAL,
  PAYMENT_FEE,
  PHOENIX_LIQUIDITY_FEE,
  PHOENIX_PAYMENT_FEE_BASE,
  PHOENIX_PAYMENT_FEE_PCT,
  WALLET_FEE,
  WALLET_FEE_PERIOD,
} from "./consts";
import { publishNip65Relays, publishServiceInfo } from "./nostr";

// update our announcement once per minute
async function announce(context: WalletContext) {
  if (!context.enclavedInternalWallet)
    await publishNip65Relays(context.serviceSigner);

  await publishServiceInfo(
    {
      maxBalance: context.maxBalance,
      minSendable: 1000,
      maxSendable: context.maxBalance,
      liquidityFeeRate: PHOENIX_LIQUIDITY_FEE,
      paymentFeeRate: PHOENIX_PAYMENT_FEE_PCT,
      paymentFeeBase: PHOENIX_PAYMENT_FEE_BASE + PAYMENT_FEE,
      walletFeeBase: WALLET_FEE,
      walletFeePeriod: WALLET_FEE_PERIOD,
      open: (await context.backend.getInfo()).channels.length > 0,
      stats: context.db.getStats(context.serviceSigner.getPublicKey()),
    },
    context.serviceSigner,
    context.relays,
    context.enclavedInternalWallet
  ).catch((e) =>
    console.error(new Date(), "failed to publish service info", e)
  );
}

export function startAnnouncing(context: WalletContext) {
  const tryAnnounce = async () => {
    try {
      await announce(context);

      // schedule next announcement
      setTimeout(tryAnnounce, ANNOUNCEMENT_INTERVAL);
    } catch (e) {
      console.log("Failed to announce", e);

      // retry faster than normal
      setTimeout(tryAnnounce, ANNOUNCEMENT_INTERVAL / 10);
    }
  };
  tryAnnounce();
}
