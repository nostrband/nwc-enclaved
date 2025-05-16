import { WebSocket } from "ws";
import { startWalletd } from "./walletd";
import { MAX_BALANCE } from "./modules/consts";

// @ts-ignore
global.WebSocket ??= WebSocket;

console.log("args", process.argv);
console.log("env", process.env);
const phoenixPassword = process.argv[2];
const relayUrls = process.argv?.[3] || process.env["NWC_RELAYS"] || "wss://relay.zap.land";
const maxBalance = Number(process.env["MAX_BALANCE"]) || MAX_BALANCE;
const enclavedInternalWallet = process.env["ENCLAVED_INTERNAL_WALLET"] === 'true';
startWalletd({ relayUrls, phoenixPassword, maxBalance, enclavedInternalWallet });
