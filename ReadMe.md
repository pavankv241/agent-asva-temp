# Raven Off‑chain Oracle (Sepolia)

This Express API:

- Reads on-chain state from `RavenAccessWithSubgraphHooks`
- Tracks off-chain engagement events in Neo4j (likes, referrals, etc.)
- Tracks calculated credits in Neo4j (social_quest, prompt_streak, referral, ai_inference)
- Automatically awards XP (Experience Points) for engagement actions (XP = Credits * 2)
- Manages referral codes and referral relationships in Neo4j
- Exposes endpoints for inference estimation/authorization
- Lets the UI show "pending credits" immediately (from Neo4j) while confirmed credits come from the contract/subgraph
- Automatically batches pending credits (both engagement and calculated) via `awardCreditsBatch` on a schedule (with an optional manual batch endpoint for admins)

## Endpoints (frontend + oracle usage)

Unless noted, endpoints are public read helpers. Oracle-only endpoints return calldata and must be signed by an oracle/owner wallet before broadcasting.

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
  - `reason` (string, optional): descriptive label for the requested combination (e.g. `tags_accuracy`, `scores_reasoning_accuracy`). When provided, it overrides the default mode-based pricing.
- Frontend :
```js
const res = await fetch('/inference/estimate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ mode: 'basic', quantity: 2 })
});
const { cost } = await res.json();
```

### POST `/inference/authorize`
- Read-mostly helper to decide if a user can run an inference now, and whether it would bill subscription or credits. Also updates Neo4j with the decremented remaining quota for the user's plan (shared pool across allowed modes) and off‑chain credit usage.
- Body params (JSON):
  - `user` (string, 0x-address)
  - `mode` (string, optional): `basic | tags | price_accuracy | full` (defaults to `basic` if omitted)
  - `quantity` (number, optional, default 1)
  - `reason` (string, optional): same as in `/inference/estimate`; used to determine the precise credit cost if/when the request falls back to credits.
  - `tags` (boolean, optional): when `true`, forces pricing to include tags even if the free‑text `reason` doesn’t explicitly contain the word “tags`.
- Returns: `{ allowed, method: 'subscription'|'credits'|'initial_grant'|'deny', reason, cost, ... }`
- Frontend :
```js
const res = await fetch('/inference/authorize', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user, reason: 'tags_price_accuracy_basic', tags: true })
});
const decision = await res.json();
```

### GET `/users/:address/credits`
- Purpose: read user credit balance (on-chain).
- Frontend :
```js
const res = await fetch(`/users/${user}/credits`);
const data = await res.json(); // { address, credits }
```

### GET `/users/:address/xp`
- Purpose: read user XP balance (on-chain). XP is automatically awarded when credits are awarded for engagement actions (XP = Credits * 2).
- Frontend :
```js
const res = await fetch(`/users/${user}/xp`);
const data = await res.json(); // { address, xp }
```

### GET `/users/:address/credits/pending`
- Purpose: fetch pending (off-chain) engagement credits + events for UI display.
- Response: `{ address, pendingCredits, pendingEvents: [{ id, action, credits, metadata, createdAt }] }`
- Frontend :
```js
const res = await fetch(`/users/${user}/credits/pending`);
const data = await res.json();
```

### GET `/users/:address/credits/calculated`
- Purpose: fetch accumulated calculated credits stored in Neo4j (social_quest, prompt_streak, referral, ai_inference).
- Response: `{ address, totalCalculatedCredits }`
- Frontend :
```js
const res = await fetch(`/users/${user}/credits/calculated`);
const data = await res.json(); // { address, totalCalculatedCredits }
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

### POST `/credits/calculate`
- Purpose: calculate credits for a given reason and parameter (does not store, just calculates).
- Body params (JSON):
  - `reason` (string): e.g., `ai_inference`, `prompt_streak`, `referral`, `social_quest`, or any action name
  - `parameter` (number): parameter value for calculation
- Response: `{ credits }`
- Frontend :
```js
const res = await fetch('/credits/calculate', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ reason: 'ai_inference', parameter: 30 })
});
const { credits } = await res.json();
```

### POST `/credits/calculate-and-store`
- Purpose: calculate credits and store them in Neo4j (accumulating for each user). Used for calculated credits like `social_quest`, `prompt_streak`, `referral`, `ai_inference`.
- Body params (JSON):
  - `address` (string, 0x-address)
  - `reason` (string): e.g., `ai_inference`, `prompt_streak`, `referral`, `social_quest`
  - `parameter` (number): parameter value for calculation
- Response: `{ address, reason, parameter, credits, totalCalculatedCredits }`
- The calculation is stored in Neo4j with status `'pending'` and will be batch-settled on-chain.
- Frontend :
```js
const res = await fetch('/credits/calculate-and-store', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ 
    address: '0x...', 
    reason: 'social_quest', 
    parameter: 3 
  })
});
const data = await res.json(); // { address, reason, parameter, credits, totalCalculatedCredits }
```

### POST `/engagement`
- Purpose: record an off-chain engagement action (like, comment, repost, yap, etc.) and add the action's fixed credits to the user's pending balance. XP is automatically calculated (XP = Credits * 2) and will be awarded on-chain when credits are settled.
- Body params (JSON):
  - `address` (string, 0x-address)
  - `action` (string): `new_user_bonus`, `referral_you_refer`, `referral_you_are_referred`, `like`, `comment`, `repost`, `yap`
  - `metadata` (optional object)
- Response: `{ engagementId, address, action, credits, xp, pendingCredits }`
- The event is stored in Neo4j with status `'pending'`; pending credits aggregate until batch-settled on-chain. When settled, XP is automatically awarded on-chain (XP = Credits * 2) for engagement actions only.
- Frontend :
```js
const res = await fetch('/engagement', {
  method: 'POST', headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ address: '0x...', action: 'like', metadata: {} })
});
const data = await res.json(); // { engagementId, address, action, credits, xp, pendingCredits }
```

### POST `/referral/code`
- Purpose: generate (or fetch) a short referral code for a given user address, stored in Neo4j.
- Body params (JSON):
  - `address` (string, 0x-address)
- Response: `{ address, code }`
- The frontend can build referral links like: `https://yourapp.xyz/?rc=<code>`.

### POST `/referral/redeem`
- Purpose: redeem a referral code when a new user signs up. This creates a `REFERRED` relationship in Neo4j and credits both the referrer and the new user via the engagement pipeline (`referral_you_refer` and `referral_you_are_referred` actions).
- Body params (JSON):
  - `code` (string): referral code (e.g. `ASV-3F9K2`)
  - `newUser` (string, 0x-address): wallet of the user who is joining with this code
- Response:
  - On success: 
    ```json
    {
      "referrer": { "address": "...", "credits": 15, "xp": 30, "pendingCredits": 15 },
      "referred": { "address": "...", "credits": 5, "xp": 10, "pendingCredits": 5 }
    }
    ```
  - On error: `{ error: "invalid_code_or_already_referred" | "self_referral_not_allowed" | ... }`

### POST `/credits/initial-grant`  (Only oracle/owner or trusted backend)
- Purpose: record a one-time initial credit grant (50 credits) when the user has no credits and no active subscription. The grant is stored as a pending calculated credit in Neo4j and immediately counted towards the user’s effective credits for `/inference/authorize` (even before on-chain settlement).
- Body params (JSON):
  - `user` (string, 0x-address)
- Response: `{ status: 'ok', cached: true }` on success, or `{ error }` if the user is not eligible.

### GET `/credits/pending`
- Purpose: diagnostic snapshot of all addresses with outstanding pending credits and their engagement events.
- Response: `{ pendingCredits: [{ address, credits }], pendingEngagements: [...] }`

### POST `/credits/settle`  (Requires oracle signer)
- Purpose: force an immediate settlement batch. In normal operation you do **not** need to call this; the server will run the batch automatically every `BATCH_INTERVAL_MS` (e.g. hourly) as long as `ORACLE_PRIVATE_KEY` is configured. This endpoint is mainly for admin/debug tools.
- Processes both engagement credits and calculated credits:
  - Fetches all pending engagements (like, comment, repost, yap, etc.)
  - Fetches all pending credit calculations (social_quest, prompt_streak, referral, ai_inference)
  - Groups by reason/action and user address
  - Executes `awardCreditsBatch` per reason/action
  - Marks records as `'settled'` in Neo4j with transaction hash
- Response: `{ ok, trigger: 'manual', txResults: [{ type: 'engagement'|'calculated', reason, txHash, addresses, totalCredits }] }`
- Frontend :
```js
const res = await fetch('/credits/settle', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }
});
const result = await res.json();
```

## Credit & XP Rewards

### Engagement Actions (Credits + XP)
| Action | Credits | XP (Credits × 2) |
|--------|---------|-------------------|
| `new_user_bonus` | 50 | 100 |
| `referral_you_refer` | 15 | 30 |
| `referral_you_are_referred` | 5 | 10 |
| `like` | 2 | 4 |
| `comment` | 3 | 6 |
| `repost` | 5 | 10 |
| `yap` | 6 | 12 |

**Note**: XP is only awarded for engagement actions, not for calculated credits (social_quest, prompt_streak, etc.).

### Subscription Usage Rewards
- Every 2 successful inference calls billed to an active subscription grant 1 credit (e.g., consuming an entire 3000-request plan yields 1500 credits).
- These credits are tracked off-chain immediately, surface via `/users/:address/summary` as `pendingCalculatedCredits`, and count toward the reported `effectiveCredits`.
- Pending subscription rewards are batch-settled on-chain together with other calculated credits, so the contract balance eventually matches the effective view.

## Credit Flow

The system tracks two types of credits that are stored in Neo4j and eventually settled on-chain:

### 1. Engagement Credits (Action-based)
- **Endpoint**: `POST /engagement`
- **Actions**: `like`, `comment`, `repost`, `yap`, `new_user_bonus`, `referral_you_refer`, `referral_you_are_referred`
- **Storage**: Stored as `Engagement` nodes in Neo4j with status `'pending'`
- **Credits**: Fixed amounts from `ACTION_CREDITS` table
- **XP**: Automatically calculated as Credits * 2 and awarded on-chain when credits are settled

### 2. Calculated Credits (Reason-based)
- **Endpoint**: `POST /credits/calculate-and-store`
- **Reasons**: `social_quest`, `prompt_streak`, `referral`, `ai_inference`
- **Storage**: Stored as `CreditCalculation` nodes in Neo4j with status `'pending'`
- **Credits**: Calculated via `calculateCredits(reason, parameter)` function. Pending calculated credits immediately contribute to `effectiveCredits` and can be spent by `/inference/authorize` even before they are minted on-chain.
- **XP**: Not awarded for calculated credits (only for engagement actions)

### XP System
- **XP Award**: XP is automatically awarded on-chain when credits are awarded for **engagement actions only**
- **XP Formula**: XP = Credits × 2
- **Eligible Actions**: `like`, `comment`, `repost`, `yap`, `new_user_bonus`, `referral_you_refer`, `referral_you_are_referred`
- **Read XP**: Use `GET /users/:address/xp` to read on-chain XP balance
- **Smart Contract**: The `awardCreditsBatch()` function automatically checks if the reason is an engagement action and awards XP accordingly

### Settlement Process
Both types of credits are automatically batch-settled on-chain:
- **Automatic**: Runs every hour (configurable via `BATCH_INTERVAL_MS`)
- **Manual**: Call `POST /credits/settle` to trigger immediate settlement
- **Process**:
  1. Fetches all pending engagements and credit calculations
  2. Groups by reason/action and user address
  3. Calls `awardCreditsBatch()` on-chain for each group
  4. For engagement actions, XP is automatically awarded (XP = Credits * 2)
  5. Marks records as `'settled'` with transaction hash

## Configuration
Set env vars (Vercel → Project → Settings → Environment Variables):
- `RPC_URL` = Sepolia RPC
- `RAVEN_ACCESS_ADDRESS` = deployed Access contract address
- `NEO4J_URI` = Neo4j connection string (e.g. `neo4j+s://hosted.instance:7687`)
- `NEO4J_USERNAME` / `NEO4J_PASSWORD` = credentials (example username `neo4j`, password the one you provided)
- `ORACLE_PRIVATE_KEY` = signer allowed to call `awardCreditsBatch` (needed for automatic settlement)
- `BATCH_INTERVAL_MS` (optional) = how often to flush pending credits (default 3600000 ms = 1 hour)

Local `.env` example (for `npm start`):
```
RPC_URL=https://sepolia.infura.io/v3/<your-infura-key>
RAVEN_ACCESS_ADDRESS=0xd9270B0AB2f49E44A7aE3F92363B3A51C3D13f29
PORT=8080
NEO4J_URI=neo4j+s://<your-neo4j-host>:7687
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=GvvDuPnpTTfr0mOVgKhINbbstnztdzqAaSfrCxuHKeI
ORACLE_PRIVATE_KEY=<hex private key of oracle signer>
BATCH_INTERVAL_MS=3600000
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
