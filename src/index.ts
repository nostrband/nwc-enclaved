import { WebSocket } from "ws";
import { startWalletd } from "./walletd";

// @ts-ignore
global.WebSocket ??= WebSocket;

const phoenixPassword = process.argv[4];
const relayUrl = process.argv?.[5] || "wss://relay.primal.net";
startWalletd({ relayUrl, phoenixPassword });
