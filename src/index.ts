import { WebSocket } from "ws";
import { startWalletd } from "./walletd";
import { MAX_BALANCE } from "./modules/consts";

// @ts-ignore
global.WebSocket ??= WebSocket;

console.log("args", process.argv);
const phoenixPassword = process.argv[2];
const relayUrl = process.argv?.[3] || "wss://relay.zap.land";
const maxBalance = Number(process.env["MAX_BALANCE"]) || MAX_BALANCE;
startWalletd({ relayUrl, phoenixPassword, maxBalance });
