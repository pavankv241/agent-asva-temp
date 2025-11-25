require('dotenv').config();
const express = require('express');
const { ethers } = require('ethers');
const { randomUUID } = require('crypto');
const neo4j = require('neo4j-driver');
const RavenOracle = require('./ravenOracle');

const app = express();
app.use(express.json());

// Basic CORS (allow localhost dev and browsers)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

function normalizeHexAddress(address) {
  try {
    if (!address || typeof address !== 'string') return null;
    return ethers.getAddress(address.trim());
  } catch (_err) {
    return null;
  }
}

// Env config
const PORT = process.env.PORT || 8080;
const RPC_URL = process.env.RPC_URL || 'https://sepolia.infura.io/v3/YOUR_INFURA_KEY';
const RAVEN_ACCESS_ADDRESS = process.env.RAVEN_ACCESS_ADDRESS || '0x0000000000000000000000000000000000000000';
const ORACLE_PRIVATE_KEY = process.env.ORACLE_PRIVATE_KEY || null;
const BATCH_INTERVAL_MS = Number(process.env.BATCH_INTERVAL_MS || 60 * 60 * 1000);
const NEO4J_URI = process.env.NEO4J_URI || process.env.NEO4J_URL || 'neo4j://localhost:7687';
const NEO4J_USERNAME = process.env.NEO4J_USERNAME || process.env.NEO4J_USER || 'neo4j';
const NEO4J_PASSWORD = process.env.NEO4J_PASSWORD || null;

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
let _signer = null;
let _treasuryContract = null;
let _neo4jDriver = undefined;

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

function getSigner() {
  if (!ORACLE_PRIVATE_KEY) return null;
  if (_signer) return _signer;
  _signer = new ethers.Wallet(ORACLE_PRIVATE_KEY, getProvider());
  return _signer;
}

function getTreasuryContract() {
  if (_treasuryContract) return _treasuryContract;
  const signer = getSigner();
  if (!signer) return null;
  const iface = getOracle().getAccessABI();
  _treasuryContract = new ethers.Contract(RAVEN_ACCESS_ADDRESS, iface, signer);
  return _treasuryContract;
}

function getNeo4jDriver() {
  if (_neo4jDriver !== undefined) return _neo4jDriver;
  if (!NEO4J_URI || !NEO4J_USERNAME || !NEO4J_PASSWORD) {
    _neo4jDriver = null;
    return _neo4jDriver;
  }
  try {
    _neo4jDriver = neo4j.driver(
      NEO4J_URI,
      neo4j.auth.basic(NEO4J_USERNAME, NEO4J_PASSWORD),
      { disableLosslessIntegers: true }
    );
    console.log('[engagement-store] Connected to Neo4j');
  } catch (err) {
    console.error('[engagement-store] Failed to init Neo4j driver:', err.message);
    _neo4jDriver = null;
  }
  return _neo4jDriver;
}

// ------------------------------
// Pending engagement persistence (Neo4j-backed with in-memory fallback)
// ------------------------------
function normalizeAddress(addr) {
  return ethers.getAddress(addr);
}

class MemoryEngagementStore {
  constructor() {
    this.engagements = [];
    this.pendingTotals = new Map();
    this.calculatedCredits = new Map();
    this.pendingCalculations = [];
  }

  _getTotal(address) {
    return this.pendingTotals.get(address) || 0;
  }

  async recordEngagement(event) {
    const engagement = { ...event, status: 'pending' };
    this.engagements.push(engagement);
    this.pendingTotals.set(engagement.address, this._getTotal(engagement.address) + engagement.credits);
    return {
      engagement,
      pendingCredits: this._getTotal(engagement.address)
    };
  }

  async getPendingForUser(address) {
    const normalized = normalizeAddress(address);
    const events = this.engagements
      .filter(evt => evt.address === normalized && evt.status === 'pending')
      .map(evt => ({
        id: evt.id,
        action: evt.action,
        credits: evt.credits,
        metadata: evt.metadata,
        createdAt: evt.createdAt
      }));
    return {
      address: normalized,
      pendingCredits: this._getTotal(normalized),
      pendingEvents: events
    };
  }

  async getAllPending() {
    const pendingCredits = Array.from(this.pendingTotals.entries()).map(([address, credits]) => ({ address, credits }));
    const pendingEngagements = this.engagements
      .filter(evt => evt.status === 'pending')
      .map(evt => ({
        id: evt.id,
        address: evt.address,
        action: evt.action,
        credits: evt.credits,
        metadata: evt.metadata,
        createdAt: evt.createdAt
      }));
    return { pendingCredits, pendingEngagements };
  }

  async fetchPendingEngagements() {
    return this.engagements
      .filter(evt => evt.status === 'pending')
      .map(evt => ({
        id: evt.id,
        address: evt.address,
        action: evt.action,
        credits: evt.credits
      }));
  }

  async markEngagementsSettled(ids, txHash) {
    if (!ids.length) return;
    const now = Date.now();
    const idSet = new Set(ids);
    for (const evt of this.engagements) {
      if (evt.status === 'pending' && idSet.has(evt.id)) {
        evt.status = 'settled';
        evt.txHash = txHash;
        evt.settledAt = now;
        const newTotal = Math.max(this._getTotal(evt.address) - evt.credits, 0);
        if (newTotal === 0) {
          this.pendingTotals.delete(evt.address);
        } else {
          this.pendingTotals.set(evt.address, newTotal);
        }
      }
    }
  }

  async recordCalculatedCredits(address, reason, parameter, credits) {
    const normalized = normalizeAddress(address);
    const currentTotal = this.calculatedCredits.get(normalized) || 0;
    const newTotal = currentTotal + credits;
    this.calculatedCredits.set(normalized, newTotal);
    // Store pending calculations for settlement
    if (!this.pendingCalculations) {
      this.pendingCalculations = [];
    }
    this.pendingCalculations.push({
      id: randomUUID(),
      address: normalized,
      reason,
      parameter,
      credits,
      status: 'pending'
    });
    return { totalCalculatedCredits: newTotal };
  }

  async getCalculatedCreditsForUser(address) {
    const normalized = normalizeAddress(address);
    const totalCalculatedCredits = this.calculatedCredits.get(normalized) || 0;
    return { address: normalized, totalCalculatedCredits };
  }

  async fetchPendingCreditCalculations() {
    if (!this.pendingCalculations) return [];
    return this.pendingCalculations
      .filter(c => c.status === 'pending')
      .map(c => ({
        id: c.id,
        address: c.address,
        reason: c.reason,
        credits: c.credits
      }));
  }

  async markCreditCalculationsSettled(ids, txHash) {
    if (!ids.length || !this.pendingCalculations) return;
    const idSet = new Set(ids);
    const now = Date.now();
    for (const calc of this.pendingCalculations) {
      if (calc.status === 'pending' && idSet.has(calc.id)) {
        calc.status = 'settled';
        calc.txHash = txHash;
        calc.settledAt = now;
      }
    }
  }
}

class Neo4jEngagementStore {
  constructor(driver) {
    this.driver = driver;
  }

  async recordEngagement(event) {
    const session = this.driver.session();
    const metadataJson = event.metadata && Object.keys(event.metadata).length > 0 ? JSON.stringify(event.metadata) : null;
    try {
      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {address: $address})
          ON CREATE SET u.pendingCredits = 0
          CREATE (u)-[:HAS_ENGAGEMENT]->(e:Engagement {
            id: $id,
            action: $action,
            credits: $credits,
            metadataJson: $metadataJson,
            createdAtMs: $createdAt,
            status: 'pending'
          })
          SET u.pendingCredits = coalesce(u.pendingCredits, 0) + $credits
          RETURN u.pendingCredits AS pendingCredits
          `,
          {
            address: event.address,
            id: event.id,
            action: event.action,
            credits: event.credits,
            metadataJson,
            createdAt: event.createdAt
          }
        )
      );
      const pendingCredits = result.records[0]?.get('pendingCredits') ?? event.credits;
      return { pendingCredits: Number(pendingCredits || 0) };
    } finally {
      await session.close();
    }
  }

  async getPendingForUser(address) {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          OPTIONAL MATCH (u:User {address: $address})
          WITH u
          OPTIONAL MATCH (u)-[:HAS_ENGAGEMENT]->(e:Engagement {status:'pending'})
          WITH u, collect(e) AS engagements
          RETURN
            CASE WHEN u IS NULL THEN 0 ELSE coalesce(u.pendingCredits, 0) END AS pendingCredits,
            engagements
          `,
          { address }
        )
      );
      const record = result.records[0];
      const pendingCredits = record ? Number(record.get('pendingCredits') || 0) : 0;
      const engagementNodes = record ? record.get('engagements') : [];
      const pendingEvents = (engagementNodes || [])
        .filter(Boolean)
        .map(node => ({
          id: node.properties.id,
          action: node.properties.action,
          credits: Number(node.properties.credits || 0),
          metadata: node.properties.metadataJson ? safeJsonParse(node.properties.metadataJson) : {},
          createdAt: Number(node.properties.createdAtMs || 0)
        }));
      return { address, pendingCredits, pendingEvents };
    } finally {
      await session.close();
    }
  }

  async getAllPending() {
    const session = this.driver.session();
    try {
      const [creditsResult, engagementsResult] = await Promise.all([
        session.executeRead(tx =>
          tx.run(
            `
            MATCH (u:User)
            WHERE coalesce(u.pendingCredits, 0) > 0
            RETURN u.address AS address, u.pendingCredits AS credits
            `
          )
        ),
        session.executeRead(tx =>
          tx.run(
            `
            MATCH (u:User)-[:HAS_ENGAGEMENT]->(e:Engagement {status:'pending'})
            RETURN e.id AS id,
                   u.address AS address,
                   e.action AS action,
                   e.credits AS credits,
                   e.metadataJson AS metadataJson,
                   e.createdAtMs AS createdAt
            `
          )
        )
      ]);

      const pendingCredits = creditsResult.records.map(r => ({
        address: r.get('address'),
        credits: Number(r.get('credits') || 0)
      }));

      const pendingEngagements = engagementsResult.records.map(r => ({
        id: r.get('id'),
        address: r.get('address'),
        action: r.get('action'),
        credits: Number(r.get('credits') || 0),
        metadata: r.get('metadataJson') ? safeJsonParse(r.get('metadataJson')) : {},
        createdAt: Number(r.get('createdAt') || 0)
      }));

      return { pendingCredits, pendingEngagements };
    } finally {
      await session.close();
    }
  }

  async fetchPendingEngagements() {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_ENGAGEMENT]->(e:Engagement {status:'pending'})
          RETURN e.id AS id, u.address AS address, e.action AS action, e.credits AS credits
          `
        )
      );
      return result.records.map(r => ({
        id: r.get('id'),
        address: r.get('address'),
        action: r.get('action'),
        credits: Number(r.get('credits') || 0)
      }));
    } finally {
      await session.close();
    }
  }

  async markEngagementsSettled(ids, txHash) {
    if (!ids.length) return;
    const session = this.driver.session();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_ENGAGEMENT]->(e:Engagement)
          WHERE e.id IN $ids
          SET e.status = 'settled',
              e.txHash = $txHash,
              e.settledAtMs = $settledAt
          WITH DISTINCT u
          OPTIONAL MATCH (u)-[:HAS_ENGAGEMENT]->(pending:Engagement {status:'pending'})
          WITH u, coalesce(sum(pending.credits), 0) AS stillPending
          SET u.pendingCredits = stillPending
          `,
          {
            ids,
            txHash,
            settledAt: Date.now()
          }
        )
      );
    } finally {
      await session.close();
    }
  }

  async recordCalculatedCredits(address, reason, parameter, credits) {
    const session = this.driver.session();
    const metadataJson = JSON.stringify({ reason, parameter });
    try {
      const result = await session.executeWrite(tx =>
        tx.run(
          `
          MERGE (u:User {address: $address})
          ON CREATE SET u.calculatedCredits = 0
          CREATE (u)-[:HAS_CREDIT_CALCULATION]->(c:CreditCalculation {
            id: $id,
            reason: $reason,
            parameter: $parameter,
            credits: $credits,
            metadataJson: $metadataJson,
            createdAtMs: $createdAt,
            status: 'pending'
          })
          SET u.calculatedCredits = coalesce(u.calculatedCredits, 0) + $credits
          RETURN u.calculatedCredits AS totalCalculatedCredits
          `,
          {
            address,
            id: randomUUID(),
            reason,
            parameter,
            credits,
            metadataJson,
            createdAt: Date.now()
          }
        )
      );
      const totalCalculatedCredits = result.records[0]?.get('totalCalculatedCredits') ?? credits;
      return { totalCalculatedCredits: Number(totalCalculatedCredits || 0) };
    } finally {
      await session.close();
    }
  }

  async getCalculatedCreditsForUser(address) {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          OPTIONAL MATCH (u:User {address: $address})
          RETURN 
            CASE WHEN u IS NULL THEN 0 ELSE coalesce(u.calculatedCredits, 0) END AS totalCalculatedCredits
          `,
          { address }
        )
      );
      const totalCalculatedCredits = result.records[0] 
        ? Number(result.records[0].get('totalCalculatedCredits') || 0) 
        : 0;
      return { address, totalCalculatedCredits };
    } finally {
      await session.close();
    }
  }

  async fetchPendingCreditCalculations() {
    const session = this.driver.session();
    try {
      const result = await session.executeRead(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_CREDIT_CALCULATION]->(c:CreditCalculation {status:'pending'})
          RETURN c.id AS id, u.address AS address, c.reason AS reason, c.credits AS credits
          `
        )
      );
      return result.records.map(r => ({
        id: r.get('id'),
        address: r.get('address'),
        reason: r.get('reason'),
        credits: Number(r.get('credits') || 0)
      }));
    } finally {
      await session.close();
    }
  }

  async markCreditCalculationsSettled(ids, txHash) {
    if (!ids.length) return;
    const session = this.driver.session();
    try {
      await session.executeWrite(tx =>
        tx.run(
          `
          MATCH (u:User)-[:HAS_CREDIT_CALCULATION]->(c:CreditCalculation)
          WHERE c.id IN $ids
          SET c.status = 'settled',
              c.txHash = $txHash,
              c.settledAtMs = $settledAt
          WITH DISTINCT u
          OPTIONAL MATCH (u)-[:HAS_CREDIT_CALCULATION]->(pending:CreditCalculation {status:'pending'})
          WITH u, coalesce(sum(pending.credits), 0) AS stillPending
          SET u.calculatedCredits = stillPending
          `,
          {
            ids,
            txHash,
            settledAt: Date.now()
          }
        )
      );
    } finally {
      await session.close();
    }
  }
}

function safeJsonParse(value) {
  try {
    return JSON.parse(value);
  } catch (_err) {
    return {};
  }
}

const engagementStore = (() => {
  const driver = getNeo4jDriver();
  if (driver) {
    return new Neo4jEngagementStore(driver);
  }
  console.warn('[engagement-store] Neo4j not configured, using in-memory store (non-persistent)');
  return new MemoryEngagementStore();
})();

async function ClearPendingCredits(trigger = 'timer') {
  const [pendingEngagements, pendingCalculations] = await Promise.all([
    engagementStore.fetchPendingEngagements(),
    engagementStore.fetchPendingCreditCalculations()
  ]);

  if (!pendingEngagements.length && !pendingCalculations.length) {
    return { ok: true, trigger, message: 'no pending credits' };
  }

  const signer = getSigner();
  const contract = getTreasuryContract();
  if (!signer || !contract) {
    console.warn('[ClearPendingCredits] signer not configured; skipping batch');
    return { ok: false, trigger, message: 'signer not configured' };
  }

  const txResults = [];

  // Process engagement credits (like, comment, repost, yap, etc.)
  if (pendingEngagements.length) {
    const grouped = new Map(); // reason -> Map(address -> { amount, ids })
    for (const evt of pendingEngagements) {
      if (!grouped.has(evt.action)) {
        grouped.set(evt.action, new Map());
      }
      const perReason = grouped.get(evt.action);
      if (!perReason.has(evt.address)) {
        perReason.set(evt.address, { amount: 0, ids: [] });
      }
      const bucket = perReason.get(evt.address);
      bucket.amount += evt.credits;
      bucket.ids.push(evt.id);
    }

    for (const [reason, perAddress] of grouped.entries()) {
      const addresses = [];
      const amounts = [];
      const ids = [];

      for (const [address, info] of perAddress.entries()) {
        addresses.push(address);
        amounts.push(info.amount);
        ids.push(...info.ids);
      }

      try {
        const tx = await contract.awardCreditsBatch(addresses, amounts, reason);
        const receipt = await tx.wait();
        txResults.push({
          type: 'engagement',
          reason,
          txHash: receipt.hash,
          addresses: addresses.length,
          totalCredits: amounts.reduce((sum, val) => sum + val, 0)
        });
        await engagementStore.markEngagementsSettled(ids, receipt.hash);
      } catch (err) {
        console.error(`[ClearPendingCredits] failed for engagement reason=${reason}`, err);
        return { ok: false, trigger, reason, message: err.message || 'tx failed' };
      }
    }
  }

  // Process calculated credits (social_quest, prompt_streak, referral, etc.)
  if (pendingCalculations.length) {
    const grouped = new Map(); // reason -> Map(address -> { amount, ids })
    for (const calc of pendingCalculations) {
      if (!grouped.has(calc.reason)) {
        grouped.set(calc.reason, new Map());
      }
      const perReason = grouped.get(calc.reason);
      if (!perReason.has(calc.address)) {
        perReason.set(calc.address, { amount: 0, ids: [] });
      }
      const bucket = perReason.get(calc.address);
      bucket.amount += calc.credits;
      bucket.ids.push(calc.id);
    }

    for (const [reason, perAddress] of grouped.entries()) {
      const addresses = [];
      const amounts = [];
      const ids = [];

      for (const [address, info] of perAddress.entries()) {
        addresses.push(address);
        amounts.push(info.amount);
        ids.push(...info.ids);
      }

      try {
        const tx = await contract.awardCreditsBatch(addresses, amounts, reason);
        const receipt = await tx.wait();
        txResults.push({
          type: 'calculated',
          reason,
          txHash: receipt.hash,
          addresses: addresses.length,
          totalCredits: amounts.reduce((sum, val) => sum + val, 0)
        });
        await engagementStore.markCreditCalculationsSettled(ids, receipt.hash);
      } catch (err) {
        console.error(`[ClearPendingCredits] failed for calculated reason=${reason}`, err);
        return { ok: false, trigger, reason, message: err.message || 'tx failed' };
      }
    }
  }

  return { ok: true, trigger, txResults };
}

// Periodic batch settlement
if (BATCH_INTERVAL_MS > 0) {
  setInterval(() => {
    ClearPendingCredits('interval').catch(err => console.error('batch interval error', err));
  }, BATCH_INTERVAL_MS);
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
      'GET /users/:address/xp',
      'GET /users/:address/credits/pending',
      'GET /users/:address/credits/calculated',
      'GET /users/:address/subscription',
      'GET /users/:address/inference/remaining?mode=<mode>',
      'GET /users/:address/has-active-subscription',
      'POST /memory/update',
      'POST /credits/initial-grant',
      'POST /credits/calculate',
      'POST /credits/calculate-and-store',
      'POST /engagement',
      'GET /credits/pending',
      'POST /credits/settle'
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

// Calculate credits and store in Neo4j (accumulating for each user)
// body: { address: string, reason: string, parameter: number }
app.post('/credits/calculate-and-store', async (req, res) => {
  try {
    const { address, reason, parameter } = req.body || {};
    const checksumAddress = normalizeHexAddress(address);
    if (!checksumAddress) return res.status(400).json({ error: 'valid address required' });
    if (typeof reason !== 'string') return res.status(400).json({ error: 'reason required' });
    if (!Number.isFinite(parameter)) return res.status(400).json({ error: 'parameter must be number' });

    const normalizedAddress = normalizeAddress(checksumAddress);
    const credits = getOracle().calculateCredits(reason, Number(parameter));
    
    if (credits <= 0) {
      return res.status(400).json({ error: 'calculated credits must be greater than 0' });
    }

    const { totalCalculatedCredits } = await engagementStore.recordCalculatedCredits(
      normalizedAddress,
      reason,
      Number(parameter),
      credits
    );

    return res.json(serialize({
      address: normalizedAddress,
      reason,
      parameter: Number(parameter),
      credits,
      totalCalculatedCredits
    }));
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
    const checksumUser = normalizeHexAddress(user);
    if (!checksumUser) return res.status(400).json({ error: 'valid user address required' });
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
    const checksumUser = normalizeHexAddress(user);
    if (!checksumUser) return res.status(400).json({ error: 'valid user address required' });
    if (typeof memoryHash !== 'string' || memoryHash.length === 0) return res.status(400).json({ error: 'memoryHash required' });

    const iface = new ethers.Interface(getOracle().getAccessABI());
    const data = iface.encodeFunctionData('updateUserMemoryPointer', [checksumUser, memoryHash]);
    return res.json(serialize({ to: RAVEN_ACCESS_ADDRESS, data }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// Record an engagement action (pending credits, stored off-chain)
// body: { address: string, action: string, metadata?: object }
app.post('/engagement', async (req, res) => {
  try {
    const { address, action, metadata = {} } = req.body || {};
    const checksumAddress = normalizeHexAddress(address);
    if (!checksumAddress) return res.status(400).json({ error: 'valid address required' });
    if (typeof action !== 'string' || action.length === 0) return res.status(400).json({ error: 'action required' });

    const credits = getOracle().getActionCredit(action);
    if (credits === null) {
      return res.status(400).json({ error: 'unsupported action' });
    }

    // Calculate XP:XP = Credits * 2 (only for engagement Actions)
    const xp = credits * 2;

    const normalizedAddress = normalizeAddress(checksumAddress);
    const evt = {
      id: randomUUID(),
      address: normalizedAddress,
      action: action.toLowerCase(),
      credits,
      xp,
      metadata,
      createdAt: Date.now()
    };

    const { pendingCredits } = await engagementStore.recordEngagement(evt);

    return res.json(serialize({
      engagementId: evt.id,
      address: normalizedAddress,
      action: evt.action,
      credits,
      xp,
      pendingCredits
    }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Read helpers
app.get('/users/:address/credits', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const credits = await getOracle().getUserCredits(checksumAddr);
    return res.json(serialize({ address: checksumAddr, credits }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/users/:address/xp', async (req , res) => {
try{
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if(!checksumAddr) return res.status(400).json({error: 'Invalid Address'});
    const oracle = getOracle();
    const contract = new ethers.Contract(RAVEN_ACCESS_ADDRESS , oracle.getAccessABI() , getProvider());
    const xp = await contract.getUserXP(checksumAddr);
    return res.json(serialize({address: checksumAddr , xp: xp.toString()}));
  } catch (e){
    return res.status(500).json({error: e.message});
  }
});

// Pending (off-chain) credits for UI preview
app.get('/users/:address/credits/pending', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const normalizedAddress = normalizeAddress(checksumAddr);
    const data = await engagementStore.getPendingForUser(normalizedAddress);
    return res.json(serialize(data));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Get calculated credits (accumulated) for a user
app.get('/users/:address/credits/calculated', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const normalizedAddress = normalizeAddress(checksumAddr);
    const data = await engagementStore.getCalculatedCreditsForUser(normalizedAddress);
    return res.json(serialize(data));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

app.get('/users/:address/subscription', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const sub = await getOracle().getUserSubscription(checksumAddr);
    return res.json(serialize(sub || {}));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Get remaining inference count for a user
// Query param: mode (required) - "basic", "tags", "price_accuracy", or "full"
app.get('/users/:address/inference/remaining', async (req, res) => {
  try {
    const addr = req.params.address;
    const mode = req.query.mode;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    if (!mode || typeof mode !== 'string') return res.status(400).json({ error: 'mode query parameter required (basic, tags, price_accuracy, or full)' });
    const remaining = await getOracle().getRemainingInference(checksumAddr, mode);
    return res.json(serialize({ address: checksumAddr, mode, remaining }));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Check if a user has an active subscription (boolean)
app.get('/users/:address/has-active-subscription', async (req, res) => {
  try {
    const addr = req.params.address;
    const checksumAddr = normalizeHexAddress(addr);
    if (!checksumAddr) return res.status(400).json({ error: 'invalid address' });
    const has = await getOracle().hasActiveSubscription(checksumAddr);
    return res.json(serialize({ address: checksumAddr, hasActiveSubscription: !!has }));
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
    const checksumUser = normalizeHexAddress(user);
    if (!checksumUser) return res.status(400).json({ error: 'valid user address required' });

    const [creditsStr, subscription] = await Promise.all([
      getOracle().getUserCredits(checksumUser),
      getOracle().getUserSubscription(checksumUser)
    ]);

    const hasCredits = BigInt(creditsStr) > 0n;
    const isSubscribed = !!subscription && Number(subscription.planId) > 0 && subscription.plan.active;
    if (hasCredits || isSubscribed) {
      return res.status(400).json({ error: 'not eligible (has credits or active subscription)' });
    }

    const iface = new ethers.Interface(getOracle().getAccessABI());
    const data = iface.encodeFunctionData('awardCredits', [checksumUser, 50, 'initial_grant']);
    return res.json(serialize({ to: RAVEN_ACCESS_ADDRESS, data }));
  } catch (e) {
    return res.status(400).json({ error: e.message });
  }
});

// List all pending credits (diagnostic)
app.get('/credits/pending', async (_req, res) => {
  try {
    const snapshot = await engagementStore.getAllPending();
    return res.json(serialize(snapshot));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// Force a settlement batch immediately (returns tx summary or reason skipped)
app.post('/credits/settle', async (_req, res) => {
  try {
    const result = await ClearPendingCredits('manual');
    return res.json(serialize(result));
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});



// Export app for serverless (Vercel) usage
module.exports = app;

process.on('exit', () => {
  if (_neo4jDriver) {
    _neo4jDriver.close().catch(() => {});
  }
});

// Start local server only when run directly (not in Vercel)
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Raven Oracle API listening on :${PORT}`);
  });
}
