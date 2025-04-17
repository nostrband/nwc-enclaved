import { WebSocket } from "ws";
import { Nip47Client } from "./modules/nip47-client";
import { generateSecretKey, nip19 } from "nostr-tools";
import readline from "node:readline";
import fs from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";

// @ts-ignore
global.WebSocket ??= WebSocket;

async function readLine() {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: false,
  });
  return await new Promise<string>((ok) => {
    rl.on("line", (line) => {
      ok(line);
    });
  });
}

async function getSecretKey() {
  const FILE = "./.cli.sk";
  if (fs.existsSync(FILE)) {
    const privkeyHex = fs.readFileSync(FILE).toString("utf8");
    console.log("privkey from file: ", privkeyHex);
    const privkey = Buffer.from(privkeyHex, "hex");
    if (privkey.length !== 32) throw new Error("Invalid privkey");
    return privkey;
  }

  console.log("Enter nsec:");
  let line = await readLine();
  line = line.trim();
  if (line.startsWith("nsec1")) {
    const { type, data } = nip19.decode(line);
    if (type !== "nsec") throw new Error("Invalid nsec");
    line = bytesToHex(data);
  }
  const privkeyHex = line;
  console.log("privkey", privkeyHex);

  const privkey = Buffer.from(privkeyHex, "hex");
  if (privkey.length !== 32) throw new Error("Invalid privkey");

  console.log(`Save key to ${FILE} ? y/N`);
  let yn = (await readLine()).trim();
  if (yn === "y") {
    fs.writeFileSync(FILE, privkeyHex);
    console.log("Saved to", FILE);
  }

  return privkey;
}

async function client(opts: {
  relayUrl: string;
  walletPubkey: string;
  method: string;
  paramsJson: string;
}) {
  const params = JSON.parse(paramsJson) || {};
  const client = (privkey: Uint8Array) => {
    const c = new Nip47Client({ relayUrl, walletPubkey, privkey });
    c.start();
    return c;
  };

  const start = Date.now();
  let r: any = undefined;
  switch (method) {
    case "get_info":
      r = await client(generateSecretKey()).getInfo();
      break;
    case "make_invoice_for":
      r = await client(generateSecretKey()).makeInvoiceFor(params);
      break;
    case "make_invoice":
      r = await client(await getSecretKey()).makeInvoice(params);
      break;
    case "pay_invoice":
      r = await client(await getSecretKey()).payInvoice(params);
      break;
    case "get_balance":
      r = await client(await getSecretKey()).getBalance();
      break;
  }

  console.log("result", r);
  console.log("latency", Date.now() - start);
}

console.log("args", process.argv);
const relayUrl = process.argv[2];
const walletPubkey = process.argv[3];
const method = process.argv[4];
const paramsJson = process.argv[5];
client({ relayUrl, walletPubkey, method, paramsJson });
