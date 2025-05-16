import { IFeePolicy, RouteHop, WalletState } from "./abstract";
import {
  PAYMENT_FEE,
  PHOENIX_AUTO_LIQUIDITY_AMOUNT,
  PHOENIX_LIQUIDITY_FEE,
  PHOENIX_PAYMENT_FEE_BASE,
  PHOENIX_PAYMENT_FEE_PCT,
} from "./consts";

export class PhoenixFeePolicy implements IFeePolicy {
  private miningFeeEstimate: number = 0;
  private miningFeePaid: number = 0;
  private miningFeeReceived: number = 0;
  private enclavedInternalWallet: boolean;

  constructor(enclavedInternalWallet: boolean) {
    this.enclavedInternalWallet = enclavedInternalWallet;
  }

  setMiningFeeEstimate(amount: number) {
    this.miningFeeEstimate = amount;
  }

  addMiningFeeReceived(amount: number): void {
    this.miningFeeReceived += amount;
  }

  addMiningFeePaid(amount: number): void {
    this.miningFeePaid += amount;
  }

  getMiningFeePaid() {
    return this.miningFeePaid;
  }

  calcMiningFeeMsat(channelExtensionAmount: number): number {
    // how much more we received than we paid
    const miningFeeBalance = this.miningFeeReceived - this.miningFeePaid;

    // target fee that we need to charge to get closer to estimate
    const targetFee = this.miningFeeEstimate - miningFeeBalance;

    console.log("calcMiningFeeMsat", {
      channelExtensionAmount,
      miningFeeBalance,
      targetFee,
      estimate: this.miningFeeEstimate,
      received: this.miningFeeReceived,
      paid: this.miningFeePaid,
    });

    // already overcharged?
    if (targetFee <= 0) return 0;

    // NOTE: actually phoenix provides 2m + currentPayment,
    // but since that's hard to account for we will
    // just spread the fees over the base 2m and thus
    // charge faster than needed, but that seems fine

    // that's how much we will charge for this specific extension
    return Math.ceil(
      (targetFee * channelExtensionAmount) / PHOENIX_AUTO_LIQUIDITY_AMOUNT
    );
  }

  getLiquidityServiceFeeRate() {
    return PHOENIX_LIQUIDITY_FEE;
  }

  private calcOurPaymentFee(wallet: WalletState, amount: number) {
    // we charge from fee credit this wallet has accumulated,
    // spread over wallet's **available** balance (balance - feeCredit)
    return (
      (this.enclavedInternalWallet ? 0 : PAYMENT_FEE) +
      Math.ceil(
        (amount * wallet.feeCredit) / (wallet.balance - wallet.feeCredit)
      )
    );
  }

  calcPaymentFeeMsat(wallet: WalletState, amount: number, fees_paid: number) {
    // our fee plus actually paid to Phoenix
    return fees_paid + this.calcOurPaymentFee(wallet, amount);
  }

  estimatePaymentFeeMsat(
    wallet: WalletState,
    amount: number,
    route: RouteHop[]
  ) {
    // NOTE: looks like Phoenix always charges floor(0.4%) + 4 sats no matter
    // what actual routing fees are, that's great and simple
    const phoenixFee =
      Math.floor(amount * PHOENIX_PAYMENT_FEE_PCT) + PHOENIX_PAYMENT_FEE_BASE;

    // // assume 3 hops * (1 sat base + 1 sat PPM)
    // const dumbRoutingFee = 3 * (1000 + Math.ceil((1000 * amount) / 1000000000));

    // // dumb estimate + Phoenix fees
    // let fee = dumbRoutingFee + Math.floor(amount * PHOENIX_PAYMENT_FEE_PCT) + PHOENIX_PAYMENT_FEE_BASE;

    // // add fees for prescribed route
    // if (route.length) {
    //   for (const r of route) {
    //     fee += r.baseFee + Math.ceil((r.ppmFee * amount) / 1000000000);
    //   }
    // }

    // total phoenix + our fee
    return phoenixFee + this.calcOurPaymentFee(wallet, amount);
  }
}
