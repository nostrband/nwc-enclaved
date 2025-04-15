import { DatabaseSync } from "node:sqlite";
import { DB_PATH } from "./consts";
import { Invoice } from "./types";
import { now } from "./utils";

export class DB {
  private db: DatabaseSync;

  constructor() {
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
        expires_at INTEGER DEFAULT 0
      )
    `);
  }

  public dispose() {
    this.db.close();
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

  public completeInvoice(id: string, invoice: Invoice) {
    const update = this.db.prepare(`
      UPDATE records
      SET
        payment_hash = ?,
        description = ?,
        description_hash = ?,
        amount = ?,
        created_at = ?,
        expires_at = ?
      WHERE id = ?
    `);
    const r = update.run(
      id,
      invoice.payment_hash,
      invoice.description || "",
      invoice.description_hash || "",
      invoice.amount,
      invoice.created_at,
      invoice.expires_at
    );
    if (r.changes !== 1) throw new Error("Invoice not found by paymentHash");
  }

  public createPayment(clientPubkey: string, invoice: Invoice) {
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
    insert.run(
      clientPubkey,
      invoice.payment_hash,
      invoice.description || "",
      invoice.description_hash || "",
      invoice.amount,
      now()
    );
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

  public completePayment(
    clientPubkey: string,
    paymentHash: string,
    feesPaid: number
  ) {
    const update = this.db.prepare(`
      UPDATE records
      SET
        is_paid = 1,
        fees_paid = ?,
      WHERE
        pubkey = ?
      AND
        payment_hash = ?
    `);
    const r = update.run(feesPaid, clientPubkey, paymentHash);
    if (r.changes !== 1) throw new Error("Payment not found by paymentHash");
  }
}
