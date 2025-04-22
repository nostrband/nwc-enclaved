# `nwc-enclaved` - custodial NWC wallet for TEE

Native digital payments enable lots of new possibilities on the internet. Lightning Network
is the best tool right now in terms of maturity, privacy, sovereignty, costs and performance, but the UX
of it is still not perfect:

- self-custodial wallets are generally complex, expensive and unreliable for receiving
- custodial wallets are subject to privacy, rug-pull and shotgun-KYC risks

Nostr apps are at the forefront of LN usage with zaps, but app developers still don't have
a clear path for onboarding new users to LN.

- Primal has deep integration with custodial Strike, which provides great UX at the expense
  of aforementioned custodial risks, and requires permission from Strike to perform the integration
- Yakihonne offers users it's own custodial wallet subject to the same custodial risks and
  additional legal burdens
- Amethyst, Damus and others offer LN integration with [NWC](https://nwc.dev), but users have
  to figure out their wallet setup on their own, which is a big obstacle

Another huge potential for LN usage are (AI) agents, that could use the internet-native
currency to pay for services and get paid by users and other agents. These agents can't
realistically use custodial services due to KYC requirements, and the usage of self-custodial
LN wallets is a serious technical challenge.

Lots of efforts are put into improvement of self-custodial LN wallets by projects like Breez, LDK
or Greenlight, but their current state still makes it uneconomical for onboarding new Nostr users
that would only keep a few hundred sats on the balance and make many small payments.

This project attempts to improve the custodial wallet setup using a Trusted Execution Environment ([AWS Nitro Enclaves](https://aws.amazon.com/es/ec2/nitro/nitro-enclaves/)). By running an open-source fully-autonomous public custodial wallet with robust abuse
protection inside TEE we might get significant improvements:

- privacy is preserved by an isolated environment such that even the service operator can't
  access users' data
- rug-pull risks are reduced because of isolated wallet keys and code transparency (reproducible builds and [attestation](https://docs.aws.amazon.com/enclaves/latest/user/set-up-attestation.html) by TEE)
- shotgun-KYC risks are harder to tackle, and we will share our approach in this area later
  when the relevant research is complete

The legal risks for service operators are out of the scope, more research is needed to
figure out if TEE adds anything new to the topic of custodian responsibilities.

Our hope is that this project results in a lot of custodial wallet services ran by different
operators, all sharing a common open API, discoverable on Nostr. This would enable a new
lightweight path for app and agent developers to integrate LN, uncover new use cases and
help Bitcoin and LN get adoption as a currency.

## Purpose

- allow app/agent developers to provide zappable LN wallets for their users/agents without signup or kyc

## Requirements

- provides zappable address and wallet access to any npub without signup, KYC or upfront payments
- economical for small balances and lots of payments
- robust protection from abuse
- self-sustainable: generate revenue to pay for itself
- private and secure: no way for LN node keys or customer data to leak to the operator or third parties (TEE)
- service instances discoverable for customers to choose among builds/operators
- safe service termination strategy without rug-pulling
- reproducible builds to deploy on TEE

## Functional requirements

- [x] NWC for all wallet operations
- [x] proper liquidity fee charging to allow for efficient **payment** wallets (small amounts, balanced flow)
- [x] new NWC method `make_invoice_for` to enable zaps
- [x] zaps: support for NIP57 zap receipts
- [x] automatic liquidity management
- [x] service instance announcement published as Nostr event
- [x] custom LNURL server to provide zappable addresses to any npub
- [x] abuse protection: zero overhead for empty unused wallets
- [x] abuse protection: limits on number of wallets, unpaid invoices, balance and payment amounts
- [x] abuse protection: tx history size
- [x] abuse protection: fees for holding to protect against dormant small-balance wallets
- [x] abuse protection: fees for payments to earn revenue on non-holding wallets
- [ ] privacy and security: open-source, reproducible, deployable in TEE
- [ ] custom relay with proper DDoS protections and settings
- [ ] safe service termination: auto-withdrawal as cashu tokens over NIP-04 DM
- [ ] telemetry for transparency
- [ ] internal payments without LN routing fees (LATER)
- [ ] abuse protection: small fee for internal payments

## Non-goals

- cheapest payments or wallet maintenance
- providing revenue for wallet service operator
- on-chain withdrawals or topups
- LNRUL pay, withdraw or auth
- keysend payments

## Priorities

- robust, autonomous, 100% uptime, reliable against abuse
- self-sustainable, full-reserves, pays for itself
- secure and private, reproducible builds

## LN Node

The LN node used as the basis is [phoenixd](https://phoenix.acinq.co/), which provides fully-automatic
liquidity management. It's not a perfect solution due to significant liqudity and payment fees,
so when other projects develop similar robust auto-pilot we would consider adding them as alternative
backends.

## Wallet creation

NWC spec specifies that wallets should generate a client key and return it to apps in the form of NWC
connection string - this is a prescribed wallet creation step, usually executed manually by users by scanning
a QR-code. `nwc-enclaved` allows clients to generate NWC keys themselves and accepts NWC queries from any key.
In other words, any NWC method can be called by any `npub` without any additional connection/signup step.
Actual wallet state is created only when an invoice is paid and `npub` gets a non-zero balance. This basically
means that if you generated a nostr pubkey and discovered an `nwc-enclaved` instance - you have a wallet.

## LUD-16 address and Zaps

NWC doesn't define a method for third-parties to create invoices (`make_invoice` can only be called by wallet owner),
we are introducing a new method `make_invoice_for` that acts like `make_invoice` but a) **can be called by any
pubkey** (i.e. throwaway pubkey), and b) has two additional parameters:

- `pubkey` - required, target pubkey whose wallet will be receiving the sats
- `zap_request` - optional, stringified NIP57 zap-request (`kind:9734`) event for zaps

To provide users with LUD-16 lightning address, the address provider must figure out how to translate `<username>@<domain>`
to `service pubkey` and `user pubkey`. Specifics are up to providers, one approach that we're
using with our `zap.land` LUD-16 provider (see `lnaddr.ts`) is to use `<user-npub>@<service-npub>.zap.land` as address.
An app can choose an `nwc-enclaved` service instance, get it's pubkey (`service pubkey`) and put
`<user-npub>@<service-npub>.zap.land` as user's LN-address (`lud16` field in Nostr profiles). After this
the user is ready to accept LN payments and zaps.

## Service announcement event

`nwc-enclaved` will publish a NIP-65 `kind:10002` event listing the relays it's using for NWC, and an announcement
event of `kind:13195` to enable discovery and to inform clients about fees and other metadata:

```
{
  ...
  "kind": 13195,
  "pubkey": <wallet pubkey>,
  "tags": [
      ["minSendable", 1000],
      ["maxSendable", 100000000],
      ["maxBalance", 100000000],
      // TBD
  ]
}
```

## Fees

To protect against abuse and to make sure the service earns revenue from usage, two kinds of fees are introduced:

- `wallet fee`: 1 sat charged on non-empty wallets every 24 hours
- `payment fee`: 1 sat charged on every payment (in addition to other fees)

Additional payment fees are charged by phoenix at the rate of 4 sats + 0.4% per payment (percentage fee not charged if it's
less than 1 sat).

Liquidity fees are paid by the service on LN channel extension at the rate of 1% of channel amount + mining fees. We are relaying
these fees on customer wallets according to this logic:

- each wallet gets a single _virtual channel_ which is extended whenever wallet balance exceeds channel size
- each wallet channel extension results in `fee_credit` of 1% + `share_of_mining_fee` accumulating on the wallet state
- when wallet makes a payment, a share of wallet's `fee_credit` is charged as an additional payment fee

This way liquidity fees are only charged on customers extending their balance and are spread over outgoing payments
so customers don't have to pre-pay for liquidity.

Mining fees are tricky to account for because phoenix charges liquidity fees upfront from incoming payments and only when
those charges accumulate enough to extend the channel will the mining fee amount be known. We track the total of
mining fees paid to phoenix and adjust the `share_of_mining_fee` value that we charge our customers so that total
fees charged approach total fees paid.

## Examples

TBD:

- Getting an invoice for your wallet.
- Getting LUD16 address for nostr profile.
- Sending a zap.
- Managing your wallet.
