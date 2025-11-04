require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const RavenOracle = require('./ravenOracle');

const app = express();
app.use(express.json());

// Env config
const PORT = process.env.PORT || 8080;
const RPC_URL = process.env.RPC_URL || 'https://sepolia.infura.io/v3/YOUR_INFURA_KEY';
const RAVEN_ACCESS_ADDRESS = process.env.RAVEN_ACCESS_ADDRESS || '0x0000000000000000000000000000000000000000';

// Helper: JSON-safe serializer for BigInt
function serialize(value) {
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = serialize(v);
    return out;
  }
  return value;
}

// Lazy provider/oracle to avoid crashing when env is missing
let _provider = null;
let _oracle = null;

function getProvider() {
  if (!_provider) {
    _provider = new ethers.JsonRpcProvider(RPC_URL);
  }
  return _provider;
}

function getOracle() {
  if (_oracle) return _oracle;
  if (!ethers.isAddress(RAVEN_ACCESS_ADDRESS) || RAVEN_ACCESS_ADDRESS === '0x0000000000000000000000000000000000000000') {
    throw new Error('RAVEN_ACCESS_ADDRESS not configured');
  }
  _oracle = new RavenOracle(getProvider(), RAVEN_ACCESS_ADDRESS);
  return _oracle;
}

// Health
app.get('/health', (_req, res) => {
  res.json(serialize({ status: 'ok' }));
});

// Root
app.get('/', (_req, res) => {
  res.json(serialize({
    status: 'ok',
    service: 'Raven Oracle API',
    hint: 'Use /health or documented endpoints',
    endpoints: [
      'GET /health',
      'POST /inference/estimate',
      'POST /inference/authorize',
      'GET /users/:address/credits',
      'GET /users/:address/subscription',
      'GET /users/:address/has-active-subscription',
      'POST /memory/update',
      'POST /credits/initial-grant'
    ]
  }));
});

// Estimate credits for arbitrary reason
// body: { reason: string, parameter: number }
app.post('/credits/calculate', (req, res) => {
  try {
    const { reason, parameter } = req.body || {};
    if (typeof reason !== 'string') return res.status(400).json({ error: 'reason required' });
    if (!Number.isFinite(parameter)) return res.status(400).json({ error: 'parameter must be number' });
    const credits = getOracle().calculateCredits(reason, Number(parameter));
    return res.json(serialize({ credits }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Estimate inference cost
// body: { mode: string, quantity?: number }
app.post('/inference/estimate', (req, res) => {
  try {
    const { mode, quantity = 1 } = req.body || {};
    if (typeof mode !== 'string') return res.status(400).json({ error: 'mode required' });
    const cost = getOracle().getInferenceCost(mode, Number(quantity));
    return res.json(serialize({ cost }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// Authorization helper (reads on-chain state)
// body: { user: string, mode: string, quantity?: number }
app.post('/inference/authorize', async (req, res) => {
  try {
    const { user, mode, quantity = 1 } = req.body || {};
    if (!ethers.isAddress(user)) return res.status(400).json({ error: 'valid user address required' });
    const result = await getOracle().authorizeInference(user, mode, Number(quantity));
    return res.json(serialize(result));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

/*  Front-end example:
import { ethers } from 'ethers';

const resp = await fetch('/memory/update', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ user, memoryHash }),
});
const { to, data } = await resp.json();

const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner(); // must be oracle or owner()
const tx = await signer.sendTransaction({ to, data });
await tx.wait();

*/
// Only oracle/owner can update the on-chain user memory pointer.
// This endpoint does NOT sign transactions. It returns calldata so the
// frontend oracle/owner wallet can sign & send directly.
// body: { user: string, memoryHash: string }
app.post('/memory/update', async (req, res) => {
  try {
    const { user, memoryHash } = req.body || {};
    if (!ethers.isAddress(user)) return res.status(400).json({ error: 'valid user address required' });
    if (typeof memoryHash !== 'string' || memoryHash.length === 0) return res.status(400).json({ error: 'memoryHash required' });

    const iface = new ethers.Interface(getOracle().getAccessABI());
    const data = iface.encodeFunctionData('updateUserMemoryPointer', [user, memoryHash]);
    return res.json(serialize({ to: RAVEN_ACCESS_ADDRESS, data }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// Read helpers
app.get('/users/:address/credits', async (req, res) => {
  try {
    const addr = req.params.address;
    if (!ethers.isAddress(addr)) return res.status(400).json({ error: 'invalid address' });
    const credits = await getOracle().getUserCredits(addr);
    return res.json(serialize({ address: addr, credits }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/users/:address/subscription', async (req, res) => {
  try {
    const addr = req.params.address;
    if (!ethers.isAddress(addr)) return res.status(400).json({ error: 'invalid address' });
    const sub = await getOracle().getUserSubscription(addr);
    return res.json(serialize(sub || {}));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Check if a user has an active subscription (boolean)
app.get('/users/:address/has-active-subscription', async (req, res) => {
  try {
    const addr = req.params.address;
    if (!ethers.isAddress(addr)) return res.status(400).json({ error: 'invalid address' });
    const has = await getOracle().hasActiveSubscription(addr);
    return res.json(serialize({ address: addr, hasActiveSubscription: !!has }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

/* Front-end example:
const { to, data } = await (await fetch('/credits/initial-grant',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user})})).json();
const provider = new ethers.BrowserProvider(window.ethereum);
const signer = await provider.getSigner(); // oracle/owner
const tx = await signer.sendTransaction({ to, data });
await tx.wait();
*/
// Prepare calldata for initial 50-credit grant (oracle/owner must sign & send)
// body: { user: string }
app.post('/credits/initial-grant', async (req, res) => {
  try {
    const { user } = req.body || {};
    if (!ethers.isAddress(user)) return res.status(400).json({ error: 'valid user address required' });

    const [creditsStr, subscription] = await Promise.all([
      getOracle().getUserCredits(user),
      getOracle().getUserSubscription(user)
    ]);

    const hasCredits = BigInt(creditsStr) > 0n;
    const isSubscribed = !!subscription && Number(subscription.planId) > 0 && subscription.plan.active;
    if (hasCredits || isSubscribed) {
      return res.status(400).json({ error: 'not eligible (has credits or active subscription)' });
    }

    const iface = new ethers.Interface(getOracle().getAccessABI());
    const data = iface.encodeFunctionData('awardCredits', [user, 50, 'initial_grant']);
    return res.json(serialize({ to: RAVEN_ACCESS_ADDRESS, data }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});



// Export app for serverless (Vercel) usage
module.exports = app;

// Start local server only when run directly (not in Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Raven Oracle API listening on :${PORT}`);
  });
}
