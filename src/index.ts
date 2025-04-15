
import { WebSocket } from "ws";

// @ts-ignore
global.WebSocket ??= WebSocket;

// FIXME need our own relay
const relayUrl = process.argv?.[4] || "wss://relay.primal.net";
startWalletd({ relayUrl });
