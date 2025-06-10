import { Signer } from "./abstract";
import { Nip04 } from "./nip04";
import { UnsignedEvent, finalizeEvent, getPublicKey } from "nostr-tools";
import { Nip44 } from "./nip44";

export class PrivateKeySigner implements Signer {
  private privkey: Uint8Array;
  private nip04 = new Nip04();
  private nip44 = new Nip44();

  constructor(privkey: Uint8Array) {
    this.privkey = privkey;
  }

  public getPublicKey() {
    return getPublicKey(this.privkey);
  }

  public signEvent(event: UnsignedEvent) {
    return Promise.resolve(finalizeEvent(event, this.privkey));
  }

  public nip04Encrypt(pubkey: string, data: string) {
    return this.nip04.encrypt(this.privkey, pubkey, data);
  }

  public nip04Decrypt(pubkey: string, data: string) {
    return this.nip04.decrypt(this.privkey, pubkey, data);
  }

  public nip44Encrypt(pubkey: string, data: string) {
    return Promise.resolve(this.nip44.encrypt(this.privkey, pubkey, data));
  }

  public nip44Decrypt(pubkey: string, data: string) {
    return Promise.resolve(this.nip44.decrypt(this.privkey, pubkey, data));
  }
}
