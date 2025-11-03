# Raven Off‑chain Oracle

This is a tiny REST API (Express) that reads from your on‑chain `RavenAccessWithSubgraphHooks` contract and helps your frontend make the right choices:

- How many credits an inference will cost
- Whether the user can proceed via subscription or credits
- What the user’s current subscription/credits are
- Prepare calldata for the privileged writes (so the oracle/owner wallet signs and sends on-chain)

## Endpoints (how to call from your frontend)

oracle user has to be called.

### GET `/health`
- Purpose: simple liveness check.
- Frontend 
```js
const res = await fetch('/health');
const data = await res.json(); // { status: 'ok' }
```

### POST `/inference/estimate`
- Purpose: calculate the credit cost before sending the request.
- Body params (JSON):
  - `mode` (string): one of `basic | tags | price_accuracy | full`
  - `quantity` (number, optional, default 1)
- Frontend :
```js
const res = await fetch('/inference/estimate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'basic', quantity: 2 })
});
const { cost } = await res.json();
```

### POST `/inference/authorize`
- read-only check to decide if a user can run an inference now, and whether it would bill subscription or credits.
- Body params (JSON):
  - `user` (string, 0x-address)
  - `mode` (string): `basic | tags | price_accuracy | full`
  - `quantity` (number, optional, default 1)
- Returns: `{ allowed, method: 'subscription'|'credits'|'initial_grant'|'deny', reason, cost }`
- Frontend :
```js
const res = await fetch('/inference/authorize', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user, mode: 'full', quantity: 1 })
});
const decision = await res.json();
```

### GET `/users/:address/credits`
- Purpose: read user credit balance.
- Frontend :
```js
const res = await fetch(`/users/${user}/credits`);
const data = await res.json(); // { address, credits }
```

### GET `/users/:address/subscription`
- Purpose: read user subscription info (planId, window usage, plan monthly cap, priceUnits, etc.).
- Frontend :
```js
const res = await fetch(`/users/${user}/subscription`);
const sub = await res.json();
```

### GET `/users/:address/has-active-subscription`
- Purpose: boolean helper for active subscription.
- Frontend :
```js
const res = await fetch(`/users/${user}/has-active-subscription`);
const data = await res.json(); // { address, hasActiveSubscription }
```

### POST `/memory/update`  (Only oracle/owner)
- Purpose: prepare calldata to update the user’s memory pointer on-chain. The server does NOT sign; it returns `{ to, data }` for your oracle/owner wallet to sign and send.
- Body params (JSON):
  - `user` (string, 0x-address)
  - `memoryHash` (string)
- Frontend :
```js
const resp = await fetch('/memory/update', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user, memoryHash })
});
const { to, data } = await resp.json();
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner(); // must be oracle or owner()
const tx = await signer.sendTransaction({ to, data });
await tx.wait();
```

### POST `/credits/initial-grant`  (Only oracle/owner)
- Purpose: prepare calldata for a one-time initial credit grant ( 50 credits) when the user has no credits and no active subscription.
- Body params (JSON):
  - `user` (string, 0x-address)
- Response: `{ to, data }` for the on-chain call.
- Frontend
```js
const resp = await fetch('/credits/initial-grant', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user })
});
const { to, data } = await resp.json();
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner(); // must be oracle or owner()
const tx = await signer.sendTransaction({ to, data });
await tx.wait();
```

## Configuration
Set env vars (Vercel → Project → Settings → Environment Variables):
- `RPC_URL` = Sepolia RPC
- `RAVEN_ACCESS_ADDRESS` = deployed Access contract address

Local `.env` example (for `npm start`):
```
RPC_URL=https://sepolia.infura.io/v3/XXXX
RAVEN_ACCESS_ADDRESS=0xYourAccessAddress
PORT=8080
```

## Local run
```bash
npm install
npm start
# open http://localhost:8080/health
```


## vercel.json
This repo includes a minimal `vercel.json`:
```json
{
  "version": 2,
  "builds": [{ "src": "server.js", "use": "@vercel/node" }],
  "routes": [{ "src": "/(.*)", "dest": "server.js" }]
}
```

## Repo structure
```
server.js         # Express app (exports app for serverless)
ravenOracle.js    # On-chain read helpers & business logic
package.json      # deps & start script
vercel.json       # vercel routing/build config
```


```bash
git subtree split --prefix=offchain-oracle -b offchain-oracle-deploy
# replace with your repo URL
git push https://github.com/pavankv241/agent-asva-temp offchain-oracle-deploy:main
```
