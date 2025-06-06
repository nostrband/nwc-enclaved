import fs from "node:fs";
import { bytesToHex } from "@noble/hashes/utils";
import { generateSecretKey } from "nostr-tools";
import { HOME_PATH } from "./consts";

export function getSecretKey() {
  const FILE = HOME_PATH+"/.service.sk";
  if (fs.existsSync(FILE)) {
    const hex = fs.readFileSync(FILE).toString("utf8");
    const privkey = Buffer.from(hex, "hex");
    if (privkey.length !== 32) throw new Error("Invalid privkey");
    return privkey;
  }

  const privkey = generateSecretKey();
  fs.writeFileSync(FILE, bytesToHex(privkey));
  return privkey;
}
