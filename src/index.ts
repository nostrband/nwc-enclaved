
import { WebSocket } from "ws";
import { startWalletd } from "./walletd";

// @ts-ignore
global.WebSocket ??= WebSocket;

// FIXME need our own relay
const relayUrl = process.argv?.[4] || "wss://relay.primal.net";
startWalletd({ relayUrl });
