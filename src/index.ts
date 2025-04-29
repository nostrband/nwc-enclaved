import { WebSocket } from "ws";
import { startWalletd } from "./walletd";

// @ts-ignore
global.WebSocket ??= WebSocket;

// console.log("args", process.argv);
const phoenixPassword = process.argv[2];
const relayUrl = process.argv?.[3] || "wss://relay.primal.net";
startWalletd({ relayUrl, phoenixPassword });
