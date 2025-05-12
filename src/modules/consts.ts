export const KIND_PROFILE = 0;
export const KIND_NOTE = 1;

export const KIND_RELAYS = 10002;
export const KIND_NWC_INFO = 13194;
export const KIND_SERVICE_INFO = 13196;
export const KIND_NWC_REQUEST = 23194;
export const KIND_NWC_REPLY = 23195;
export const KIND_NWC_NOTIFICATION = 23196;

export const PHOENIX_PORT = 9740;

export const HOME_PATH = "./data/";
export const DB_PATH = `${HOME_PATH}nwc-enclaved.db`;

export const PHOENIX_LIQUIDITY_FEE = 0.01;
export const PHOENIX_PAYMENT_FEE_PCT = 0.004;
export const PHOENIX_PAYMENT_FEE_BASE = 4000;
export const PHOENIX_AUTO_LIQUIDITY_AMOUNT = 2000000000; // 2m sats

export const WALLET_FEE_PERIOD = 24 * 3600; // 1 day
export const WALLET_FEE = 1000; // 1 sat
export const PAYMENT_FEE = 1000; // 1 sat

export const MAX_CONCURRENT_PAYMENTS_PER_WALLET = 10;
export const MAX_ANON_INVOICE_EXPIRY = 120;
export const MAX_INVOICE_EXPIRY = 600;

export const MAX_BALANCE = 100000000; // 100k sats
export const MAX_WALLETS = 10000;
export const MAX_ANON_INVOICES = 1000;
export const MAX_INVOICES = 1000;
export const MAX_TX_AGE = 30 * 24 * 3600; // 1 month

export const NWC_SUPPORTED_METHODS = [
  "pay_invoice",
  "make_invoice",
  "make_invoice_for",
  "list_transactions",
  "get_balance",
  "get_info",
];
