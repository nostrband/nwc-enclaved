import { randomBytes } from "@noble/hashes/utils";
import { secp256k1 } from "@noble/curves/secp256k1";
import { getPublicKey } from "nostr-tools";

// from nostr-tools

export const utf8Decoder = new TextDecoder("utf-8");
export const utf8Encoder = new TextEncoder();

function getNormalizedX(key: Uint8Array): Uint8Array {
  return key.slice(1, 33);
}

export class Nip04 {
  private cache = new Map<string, CryptoKey>();

  public createKey(privkey: Uint8Array, pubkey: string) {
    const key = secp256k1.getSharedSecret(privkey, "02" + pubkey);
    const normalizedKey = getNormalizedX(key);
    return normalizedKey;
  }

  private async getKey(
    privkey: Uint8Array,
    pubkey: string,
    extractable?: boolean
  ) {
    const id = getPublicKey(privkey) + pubkey;
    let cryptoKey = this.cache.get(id);
    if (cryptoKey) return cryptoKey;
    const key = this.createKey(privkey, pubkey);
    cryptoKey = await crypto.subtle.importKey(
      "raw",
      key,
      { name: "AES-CBC" },
      !!extractable,
      ["encrypt", "decrypt"]
    );
    this.cache.set(id, cryptoKey);
    return cryptoKey;
  }

  public async encrypt(
    privkey: Uint8Array,
    pubkey: string,
    text: string
  ): Promise<string> {
    const cryptoKey = await this.getKey(privkey, pubkey);
    let iv = Uint8Array.from(randomBytes(16));
    let plaintext = utf8Encoder.encode(text);
    let ciphertext = await crypto.subtle.encrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      plaintext
    );
    // base64.encode(
    let ctb64 = Buffer.from(ciphertext).toString("base64");
    let ivb64 = Buffer.from(iv.buffer).toString("base64");
    return `${ctb64}?iv=${ivb64}`;
  }

  public async decrypt(
    privkey: Uint8Array,
    pubkey: string,
    data: string
  ): Promise<string> {
    let [ctb64, ivb64] = data.split("?iv=");
    const cryptoKey = await this.getKey(privkey, pubkey);
    let ciphertext = Buffer.from(ctb64, "base64");
    let iv = Buffer.from(ivb64, "base64");
    let plaintext = await crypto.subtle.decrypt(
      { name: "AES-CBC", iv },
      cryptoKey,
      ciphertext
    );
    let text = utf8Decoder.decode(plaintext);
    return text;
  }
}
