import { DatabaseSync } from "node:sqlite";
import { DB_PATH, PAYMENT_FEE, WALLET_FEE, WALLET_FEE_PERIOD } from "./consts";
import {
  NWCInvoice,
  NWCListTransactionsReq,
  NWCTransaction,
} from "./nwc-types";
import { now } from "./utils";
import {
  IDB,
  InvoiceInfo,
  OnIncomingPaymentEvent,
  WalletState,
} from "./abstract";

export class DB implements IDB {
  private db: DatabaseSync;
  private isTx: boolean = false;
  private enclavedInternalWallet: boolean;

  constructor(enclavedInternalWallet: boolean) {
    this.enclavedInternalWallet = enclavedInternalWallet;
    this.db = new DatabaseSync(DB_PATH);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey TEXT,
        is_outgoing INTEGER DEFAULT 0,
        is_paid INTEGER DEFAULT 0,
        payment_hash TEXT DEFAULT '',
        description TEXT DEFAULT '',
        description_hash TEXT DEFAULT '',
        preimage TEXT DEFAULT '',
        amount INTEGER,
        fees_paid INTEGER DEFAULT 0,
        created_at INTEGER,
        expires_at INTEGER DEFAULT 0,
        settled_at INTEGER DEFAULT 0,
        zap_request TEXT DEFAULT '',
        invoice TEXT DEFAULT '',
        anon INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS wallets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        pubkey TEXT,
        balance INTEGER DEFAULT 0,
        channel_size INTEGER DEFAULT 0,
        fee_credit INTEGER DEFAULT 0,
        created_at INTEGER,
        next_wallet_fee_at INTEGER
      )
    `);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS fees (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        mining_fee_paid INTEGER DEFAULT 0,
        mining_fee_received INTEGER DEFAULT 0,
        wallet_fee_received INTEGER DEFAULT 0,
        payment_fee_received INTEGER DEFAULT 0
      )
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_pubkey_index 
      ON records (pubkey)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_created_at_index 
      ON records (created_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_tx_index 
      ON records (pubkey, created_at, is_paid, is_outgoing)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_payment_index 
      ON records (pubkey, payment_hash)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_settled_at_index 
      ON records (settled_at)
    `);
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS wallets_pubkey_index 
      ON wallets (pubkey)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS wallets_next_wallet_fee_at_index
      ON wallets (next_wallet_fee_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS records_type_index
      ON records (is_paid, is_outgoing)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS wallets_created_at_index
      ON wallets (created_at)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS wallets_balance_index
      ON wallets (balance)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS wallets_fee_credit_index
      ON wallets (fee_credit)
    `);
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS wallets_next_fee_index
      ON wallets (balance, next_wallet_fee_at)
    `);
  }

  public dispose() {
    this.db.close();
  }

  public startTx() {
    if (this.isTx) throw new Error("Tx already started");
    this.isTx = true;
    this.db.exec("BEGIN TRANSACTION");
    console.log("start transaction");
  }

  public commitTx() {
    if (!this.isTx) throw new Error("Tx is not started");
    this.isTx = false;
    this.db.exec("COMMIT TRANSACTION");
    console.log("commit transaction");
  }

  public rollbackTx() {
    if (!this.isTx) throw new Error("Tx is not started");
    this.isTx = false;
    this.db.exec("ROLLBACK TRANSACTION");
    console.log("rollback transaction");
  }

  public addMiningFeePaid(fee: number) {
    const fees = this.db.prepare(`
      INSERT INTO fees (id, mining_fee_paid)
      VALUES (1, ?)
      ON CONFLICT(id) DO UPDATE 
      SET
        mining_fee_paid = mining_fee_paid + ?
    `);
    const f = fees.run(fee, fee);
    if (!f.changes) throw new Error("Failed to update mining_fee_paid");
  }

  public getFees(): { miningFeeReceived: number; miningFeePaid: number } {
    const select = this.db.prepare(`
      SELECT * FROM fees WHERE id = 1
    `);
    const rec = select.get();
    return {
      miningFeePaid: (rec?.mining_fee_paid as number) || 0,
      miningFeeReceived: (rec?.mining_fee_received as number) || 0,
    };
  }

  public getNextWalletFeePubkey(servicePubkey: string): string | undefined {
    const select = this.db.prepare(`
      SELECT pubkey FROM wallets
      WHERE
        balance > fee_credit
      AND
        next_wallet_fee_at < ?
      AND
        pubkey != ?
      ORDER BY next_wallet_fee_at ASC
      LIMIT 1
    `);
    const rec = select.get(now(), servicePubkey);
    return rec?.pubkey as string;
  }

  public chargeWalletFee(pubkey: string) {
    console.log(new Date(), "db charging wallet fee on", pubkey);
    const tm = now();
    if (!this.isTx) this.db.exec("BEGIN TRANSACTION");
    try {
      const payment = this.db.prepare(`
        INSERT INTO records (
          pubkey,
          is_outgoing,
          is_paid,
          description,
          amount,
          created_at,
          settled_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      const pr = payment.run(pubkey, 1, 1, "wallet fee", WALLET_FEE, tm, tm);
      if (!pr.changes) throw new Error("Failed to charge wallet fee");

      const wallet = this.db.prepare(`
        UPDATE wallets
        SET
          balance = balance - ?,
          next_wallet_fee_at = next_wallet_fee_at + ?
        WHERE
          pubkey = ?
      `);
      const wr = wallet.run(WALLET_FEE, WALLET_FEE_PERIOD, pubkey);
      if (!wr.changes) throw new Error("Failed to update wallet fee balance");

      const fee = this.db.prepare(`
        UPDATE fees
        SET wallet_fee_received = wallet_fee_received + ?
        WHERE id = 1
      `);
      const fr = fee.run(WALLET_FEE);
      if (!fr.changes) throw new Error("Failed to add wallet fee");
    } catch (e) {
      if (!this.isTx) this.db.exec("ROLLBACK TRANSACTION");
      throw e;
    }
    if (!this.isTx) this.db.exec("COMMIT TRANSACTION");
  }

  public clearExpiredInvoices() {
    const del = this.db.prepare(`
      DELETE FROM records
      WHERE
        is_outgoing = 0
      AND
        is_paid = 0
      AND
        expires_at < ?
    `);
    const r = del.run(now());
    console.log(new Date(), "db clear expired invoices deleted", r.changes);
  }

  public clearOldTxs(until: number) {
    const del = this.db.prepare(`
      DELETE FROM records
      WHERE created_at < ?
    `);
    const r = del.run(until);
    console.log(
      new Date(),
      "db clear old txs until",
      until,
      "deleted",
      r.changes
    );
  }

  public listWallets(): {
    pubkey: string;
    state: WalletState;
  }[] {
    const select = this.db.prepare(`
      SELECT * FROM wallets
    `);
    const recs = select.all();
    return recs.map((r) => ({
      pubkey: r.pubkey as string,
      state: {
        balance: r.balance as number,
        channelSize: r.channel_size as number,
        feeCredit: r.fee_credit as number,
      },
    }));
  }

  public countUnpaidInvoices(): { anons: number; wallets: number } {
    const count = (anon: boolean) => {
      const select = this.db.prepare(`
        SELECT COUNT(id) as cnt
        FROM records
        WHERE
          is_outgoing = 0
        AND
          is_paid = 0
        AND
          anon = ?
      `);
      const r = select.get(anon ? 1 : 0);
      return r!.cnt as number;
    };
    return {
      anons: count(true),
      wallets: count(false),
    };
  }

  public createInvoice(clientPubkey: string) {
    const insert = this.db.prepare(`
      INSERT INTO records (
        pubkey,
        created_at
      ) VALUES (?, ?);
    `);
    const r = insert.run(clientPubkey, now());
    return "" + r.lastInsertRowid;
  }

  public deleteInvoice(id: string) {
    const del = this.db.prepare(`
      DELETE FROM records 
      WHERE 
        id = ?
      AND
        is_outgoing = 0 
    `);
    del.run(id);
  }

  public completeInvoice(
    id: string,
    invoice: NWCInvoice,
    zapRequest?: string,
    anon?: boolean
  ) {
    const update = this.db.prepare(`
      UPDATE records
      SET
        payment_hash = ?,
        description = ?,
        description_hash = ?,
        amount = ?,
        created_at = ?,
        expires_at = ?,
        zap_request = ?,
        invoice = ?,
        anon = ?
      WHERE id = ?
    `);
    const r = update.run(
      invoice.payment_hash,
      invoice.description || "",
      invoice.description_hash || "",
      invoice.amount,
      invoice.created_at,
      invoice.expires_at,
      zapRequest || "",
      invoice.invoice,
      anon ? 1 : 0,
      id
    );
    if (r.changes !== 1) throw new Error("Invoice not found by id " + id);
  }

  public lookupInvoice(opt: {
    paymentHash?: string;
    invoice?: string;
  }): NWCTransaction | undefined {
    if (!opt.paymentHash && !opt.invoice) throw new Error("Invalid params");
    const sql = opt.invoice
      ? `
      SELECT * FROM records
      WHERE
        invoice = ?
      AND
        is_outgoing = 0
      `
      : `
      SELECT * FROM records
      WHERE
        payment_hash = ?
      AND
        is_outgoing = 0
    `;
    const select = this.db.prepare(sql);
    const r = select.get(opt.invoice ? opt.invoice : opt.paymentHash!);
    if (!r) return undefined;
    const tx = this.recToTx(r);
    if (tx.type === "outgoing") throw new Error("Invalid type");
    return tx;
  }

  private getInvoiceRecById(id: string) {
    const sql = `
      SELECT * FROM records
      WHERE
        id = ?
      AND
        is_outgoing = 0
    `;
    return this.db.prepare(sql).get(id);
  }

  private getInvoiceRecByPaymentHash(paymentHash: string) {
    const sql = `
      SELECT * FROM records
      WHERE
        payment_hash = ?
      AND
        is_outgoing = 0
    `;
    return this.db.prepare(sql).get(paymentHash);
  }

  private getInvoiceRecByInvoiceString(invoice: string) {
    const sql = `
      SELECT * FROM records
      WHERE
        invoice = ?
      AND
        is_outgoing = 0
    `;
    return this.db.prepare(sql).get(invoice);
  }

  public getInvoiceInfo({
    id,
    paymentHash,
    invoice: invoiceString,
  }: {
    id?: string;
    paymentHash?: string;
    invoice?: string;
  }): InvoiceInfo | undefined {
    if (!id && !paymentHash && !invoiceString)
      throw new Error("Specify id or payment hash or invoice");
    const r = id
      ? this.getInvoiceRecById(id)
      : paymentHash
      ? this.getInvoiceRecByPaymentHash(paymentHash)
      : this.getInvoiceRecByInvoiceString(invoiceString!);

    if (!r) return undefined;
    const tx = this.recToTx(r);
    if (tx.type === "outgoing") throw new Error("Invalid type");
    const invoice: NWCInvoice = {
      ...tx,
      expires_at: tx.expires_at!,
      type: "incoming",
      invoice: tx.invoice!,
    };
    return {
      invoice,
      id: r.id as string,
      isPaid: !!r.is_paid,
      clientPubkey: r.pubkey as string,
      preimage: tx.preimage!,
      zapRequest: (r.zap_request as string) || "",
    };
  }

  public settleInvoice(
    clientPubkey: string,
    payment: OnIncomingPaymentEvent,
    walletState: WalletState,
    miningFee: number
  ) {
    // tx to settle the invoice and update the wallet balance
    if (!this.isTx) this.db.exec("BEGIN TRANSACTION");

    try {
      const {
        id,
        isPaid,
        clientPubkey: expectedPubkey,
      } = this.getInvoiceInfo({ paymentHash: payment.paymentHash }) || {};
      if (expectedPubkey !== clientPubkey)
        throw new Error("Invalid clientPubkey for settleInvoice");
      if (isPaid) throw new Error("Invoice already settled");

      // update invoice state
      const update = this.db.prepare(`
        UPDATE records
        SET
          is_paid = 1,
          settled_at = ?,
          preimage = ?
        WHERE 
          id = ?
        AND
          is_paid = 0
      `);
      const r = update.run(payment.settledAt, payment.preimage, id!);
      if (r.changes === 0) {
        console.log(new Date(), "invoice already settled", id!);
        if (!this.isTx) this.db.exec("ROLLBACK TRANSACTION");
        return false;
      }

      const fees = this.db.prepare(`
        INSERT INTO fees (id, mining_fee_received)
        VALUES (1, ?)
        ON CONFLICT(id) DO UPDATE 
        SET
          mining_fee_received = mining_fee_received + ?
      `);
      const f = fees.run(miningFee, miningFee);
      if (!f.changes) throw new Error("Failed to update mining_fee_received");

      // update wallet
      this.updateWalletState(clientPubkey, walletState);
    } catch (e) {
      console.error(new Date(), "tx failed", e);

      // rollback tx
      if (!this.isTx) this.db.exec("ROLLBACK TRANSACTION");
      throw e;
    }

    // commit if all ok
    if (!this.isTx) this.db.exec("COMMIT TRANSACTION");
    return true;
  }

  public createPayment(clientPubkey: string, invoice: NWCInvoice) {
    const insert = this.db.prepare(`
      INSERT INTO records (
        is_outgoing,
        pubkey,
        payment_hash,
        description,
        description_hash,
        amount,
        created_at
      ) VALUES (1, ?, ?, ?, ?, ?, ?);
    `);
    const r = insert.run(
      clientPubkey,
      invoice.payment_hash,
      invoice.description || "",
      invoice.description_hash || "",
      invoice.amount,
      now()
    );
    return "" + r.lastInsertRowid;
  }

  public deletePayment(clientPubkey: string, paymentHash: string) {
    const del = this.db.prepare(`
      DELETE FROM records 
      WHERE 
        pubkey = ? 
      AND 
        payment_hash = ?
    `);
    del.run(clientPubkey, paymentHash);
  }

  private updateWalletState(clientPubkey: string, walletState: WalletState) {
    // update wallet
    const wallet = this.db.prepare(`
      INSERT INTO wallets (pubkey, balance, channel_size, fee_credit, created_at, next_wallet_fee_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(pubkey) DO UPDATE 
      SET
        balance = ?,
        channel_size = ?,
        fee_credit = ?
    `);
    const tm = now();
    const wr = wallet.run(
      clientPubkey,
      walletState.balance,
      walletState.channelSize,
      walletState.feeCredit,
      tm,
      tm + WALLET_FEE_PERIOD,
      walletState.balance,
      walletState.channelSize,
      walletState.feeCredit
    );
    if (wr.changes !== 1) throw new Error("Wallet not found by clientPubkey");
  }

  public settlePayment(
    clientPubkey: string,
    paymentHash: string,
    preimage: string,
    feesPaid: number,
    walletState: WalletState
  ) {
    // tx to settle the payment and update the wallet balance
    if (!this.isTx) this.db.exec("BEGIN TRANSACTION");
    try {
      // settle payment
      const update = this.db.prepare(`
        UPDATE records
        SET
          is_paid = 1,
          fees_paid = ?,
          settled_at = ?,
          preimage = ?
        WHERE
          pubkey = ?
        AND
          payment_hash = ?
        AND
          is_paid = 0
      `);
      const r = update.run(
        feesPaid,
        now(),
        preimage,
        clientPubkey,
        paymentHash
      );
      if (r.changes !== 1) throw new Error("Payment not found by paymentHash");

      // update wallet
      this.updateWalletState(clientPubkey, walletState);

      if (!this.enclavedInternalWallet) {
        const fee = this.db.prepare(`
          UPDATE fees
          SET payment_fee_received = payment_fee_received + ?
          WHERE id = 1
        `);
        const fr = fee.run(PAYMENT_FEE);
        if (!fr.changes) throw new Error("Failed to add payment fee");
      }
    } catch (e) {
      console.error(new Date(), "tx failed", e);

      // rollback tx
      if (!this.isTx) this.db.exec("ROLLBACK TRANSACTION");
      throw e;
    }

    // commit if all ok
    if (!this.isTx) this.db.exec("COMMIT TRANSACTION");
  }

  private recToTx(r: Record<string, any>): NWCTransaction {
    const tx: NWCTransaction = {
      type: r.is_outgoing ? "outgoing" : "incoming",
      state: r.settled_at
        ? "settled"
        : r.expires_at < now()
        ? "failed"
        : "pending",
      payment_hash: r.payment_hash as string,
      amount: (r.amount as number) || 0,
      fees_paid: (r.fees_paid as number) || 0,
      created_at: (r.created_at as number) || 0,
      metadata: {},
    };

    if (r.invoice) tx.invoice = r.invoice as string;
    if (r.description) tx.description = r.description as string;
    if (r.description_hash) tx.description_hash = r.description_hash as string;
    if (r.preimage) tx.preimage = r.preimage as string;
    if (r.expires_at) tx.expires_at = r.expires_at as number;
    if (r.settled_at) tx.settled_at = r.settled_at as number;

    return tx;
  }

  public getTransaction(id: string): NWCTransaction | undefined {
    const select = this.db.prepare(`
      SELECT * FROM records
      WHERE id = ?
    `);
    const rec = select.get(id);
    if (!rec) return undefined;
    return this.recToTx(rec);
  }

  public listTransactions(req: NWCListTransactionsReq): {
    total_count: number;
    transactions: NWCTransaction[];
  } {
    let sql = `
      SELECT * FROM records
      WHERE
        pubkey = ?
        AND created_at >= ?
        AND created_at <= ?
    `;
    if (req.unpaid !== true) {
      sql += `AND is_paid = ? `;
    }
    if (req.type !== undefined) {
      sql += `AND is_outgoing = ? `;
    }
    sql += `
      ORDER BY created_at DESC
      LIMIT ?
      OFFSET ?
    `;

    const select = this.db.prepare(sql);
    const args = [req.clientPubkey, req.from || 0, req.until || now()];
    if (req.unpaid !== true) {
      args.push(1); // is_paid = 1 only
    }
    if (req.type !== undefined) {
      args.push(req.type === "outgoing" ? 1 : 0); // is_outgoing
    }
    args.push(req.limit || 10);
    args.push(req.offset || 0);

    // console.log("listTransaction args", args);
    const recs = select.all(...args);
    const r = {
      total_count: 0,
      transactions: recs.map((r) => this.recToTx(r)),
    };

    // const count = this.db.prepare(`SELECT COUNT(id) as cnt FROM records WHERE pubkey = ?`);
    // const { cnt } = count.get(req.clientPubkey);

    console.log("listTransactions", r);
    return r;
  }

  public getLastInvoiceSettledAt() {
    const select = this.db.prepare(
      `SELECT settled_at FROM records ORDER BY settled_at DESC LIMIT 1`
    );
    const r = select.get();
    return (r?.settled_at as number) || 0;
  }

  public getStats(servicePubkey: string) {
    const stats = {
      payments: 0,
      paymentsHour: 0,
      wallets: 0,
      walletsHour: 0,
      totalBalance: 0,
      totalFeeCredit: 0,
      serviceBalance: 0,
    };

    const payments = this.db.prepare(
      `SELECT COUNT(id) as cnt FROM records WHERE is_outgoing = 1 AND is_paid = 1`
    );
    stats.payments = payments.get()?.cnt as number;

    const paymentsHour = this.db.prepare(
      `SELECT COUNT(id) as cnt FROM records WHERE is_outgoing = 1 AND is_paid = 1 AND settled_at > ?`
    );
    stats.paymentsHour = paymentsHour.get(now() - 3600)?.cnt as number;

    const wallets = this.db.prepare(`SELECT COUNT(id) as cnt FROM wallets`);
    stats.wallets = wallets.get()?.cnt as number;

    const walletsHour = this.db.prepare(
      `SELECT COUNT(id) as cnt FROM wallets WHERE created_at > ?`
    );
    stats.walletsHour = walletsHour.get(now() - 3600)?.cnt as number;

    const balance = this.db.prepare(
      `SELECT SUM(balance) as cnt FROM wallets WHERE pubkey != ?`
    );
    stats.totalBalance = (balance.get(servicePubkey)?.cnt as number) || 0;

    const fee = this.db.prepare(
      `SELECT SUM(fee_credit) as cnt FROM wallets WHERE pubkey != ?`
    );
    stats.totalFeeCredit = (fee.get(servicePubkey)?.cnt as number) || 0;

    const serviceBalance = this.db.prepare(
      `SELECT balance FROM wallets WHERE pubkey = ?`
    );
    stats.serviceBalance =
      (serviceBalance.get(servicePubkey)?.balance as number) || 0;

    return stats;
  }
}
