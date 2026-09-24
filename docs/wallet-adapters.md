# Wallet adapters

Core never imports a wallet SDK directly. Everything goes through `SwarmApp/src/lib/wallet`, which resolves one **adapter** at load time. WalletConnect (Reown AppKit) is the built-in one; a mod can supply another.

## Using the wallet in app code

```ts
import { useWalletAccount, useWallet, ConnectWalletButton } from "@/lib/wallet";
```

- `useWalletAccount()` → `{ address } | undefined`
- `useWallet()` → `{ address, chainId, status }`
- `useWalletSignMessage()`, `useDisconnectWallet()`, `<ConnectWalletButton label="Connect" />`

## Writing an adapter

Implement `WalletAdapter` from `src/lib/wallet/types.ts` (provider, `useWallet`, `useSignMessage`, `useDisconnect`, `ConnectButton`, `storagePrefixes`), then register it in `src/lib/wallet/adapters/index.ts` and set `NEXT_PUBLIC_WALLET_PROVIDER=<your id>`.

Login is provider-agnostic: any adapter that can `personal_sign` a SIWE message works with `/api/auth/payload` + `/api/auth/verify` (see `src/lib/auth/siwe.ts`). Smart-contract wallets are verified via ERC-1271.

## WalletConnect setup

1. Create a project at <https://cloud.reown.com> and add your domains to the allowlist.
2. Set `NEXT_PUBLIC_REOWN_PROJECT_ID` in `SwarmApp/.env.local`.
